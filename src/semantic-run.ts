import {
  buildClassificationPreview,
  buildEvaluationInput,
  SEMANTIC_MODEL,
  SEMANTIC_POLICY_VERSION,
  validateTaxonomy,
} from "./semantic.js";
import {
  buildEvaluationRequest,
  decideSuggestion,
  fingerprintEvaluation,
  validateEvaluation,
} from "./semantic-evaluation.js";
import { revalidateSemanticEvidenceBatch } from "./semantic-github.js";
import { evaluateWithJev, JEV_ADAPTER_VERSION, JevError } from "./semantic-jev.js";
import { abortableSleep, retryDelayMs, type SemanticWaitOptions } from "./semantic-rate.js";
import {
  type SemanticCacheContext,
  type SemanticCacheEntry,
  type SemanticCacheLookup,
  type SemanticCacheStore,
  type SemanticCapture,
  SemanticError,
  type SemanticEvaluation,
  type SemanticEvidence,
  type SemanticFinalReceipt,
  type SemanticPendingReceipt,
  type SemanticPolicy,
  type SemanticPreview,
  type SemanticPreviewItem,
  type SemanticReceiptResult,
  type SemanticReceiptStore,
  type SemanticReport,
  type SemanticReportItem,
  type SemanticTaxonomy,
} from "./semantic-types.js";
import type { GhTransport } from "./transport.js";

export type SemanticRunOptions = {
  limit: number;
  maxCalls: number;
  taxonomy: SemanticTaxonomy | null;
  noSnapshot: boolean;
  refresh?: boolean;
  cacheEpoch?: string;
  cached?: boolean;
  concurrency?: number;
  maxRetries?: number;
  minIntervalMs?: number;
};

function validateOptions(options: SemanticRunOptions, capture: SemanticCapture): void {
  const identities = [new Set<string>(), new Set<string>(), new Set<number>()] as const;
  for (const item of capture.items) {
    if (
      identities[0].has(item.key) ||
      identities[1].has(item.id) ||
      identities[2].has(item.number)
    ) {
      throw new SemanticError(
        "issue-identity-unverified",
        "Duplicate issue evidence cannot be evaluated safely.",
        "Capture a unique issue cohort.",
      );
    }
    identities[0].add(item.key);
    identities[1].add(item.id);
    identities[2].add(item.number);
  }
  if (options.cached !== undefined && typeof options.cached !== "boolean") {
    throw new SemanticError("invalid-run-options", "Invalid cached mode.", "Check run options.");
  }
  for (const [value, min, max] of [
    [options.concurrency === undefined ? 1 : options.concurrency, 1, 4],
    [options.maxRetries === undefined ? 0 : options.maxRetries, 0, 3],
    [options.minIntervalMs === undefined ? 0 : options.minIntervalMs, 0, 60000],
    [options.maxCalls, 0, Number.MAX_SAFE_INTEGER],
  ]) {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new SemanticError("invalid-run-options", "Invalid run bounds.", "Check run options.");
    }
  }
  if (options.cached && (options.maxCalls !== 0 || options.noSnapshot || options.refresh)) {
    throw new SemanticError(
      "invalid-run-options",
      "Cached evidence requires zero calls, snapshots and no refresh.",
      "Check cached run options.",
    );
  }
}

function memoryReceipts(now: () => string): SemanticReceiptStore {
  return {
    async begin(input) {
      return {
        ...input,
        schemaVersion: 1,
        requestId: globalThis.crypto.randomUUID(),
        createdAt: now(),
        phase: "pending",
        durable: false,
      };
    },
    async finish(pending, result) {
      return { ...pending, phase: "final", completedAt: now(), result };
    },
  };
}

function code(error: unknown): string {
  return error instanceof SemanticError && /^[a-z][a-z0-9-]{0,63}$/.test(error.code)
    ? error.code
    : "evaluation-failed";
}

function addReason(item: { reasonCodes: string[] }, reason: string): void {
  if (!item.reasonCodes.includes(reason)) item.reasonCodes.push(reason);
}

function clearPlan(item: { reasonCodes: string[] }): void {
  item.reasonCodes = item.reasonCodes.filter(
    (reason) => reason !== "preview-only" && reason !== "max-calls-reached",
  );
}

async function cacheContext(
  evidence: SemanticEvidence,
  taxonomy: SemanticTaxonomy | null,
  cacheEpoch: string,
): Promise<SemanticCacheContext> {
  const request = buildEvaluationRequest(buildEvaluationInput(evidence, taxonomy));
  return {
    request,
    taxonomy,
    cacheEpoch,
    adapterVersion: JEV_ADAPTER_VERSION,
    inputHash: await fingerprintEvaluation(request, taxonomy, JEV_ADAPTER_VERSION, cacheEpoch),
  };
}

async function lookupCache(
  item: SemanticPreviewItem | SemanticReportItem,
  getCache: () => SemanticCacheStore,
  context: SemanticCacheContext,
  refresh?: boolean,
  ownedRequestId?: string,
): Promise<SemanticCacheLookup> {
  try {
    const lookup = await getCache().read(context, { refresh, ownedRequestId });
    item.cacheStatus = lookup.status;
    return lookup;
  } catch (error) {
    const blocked = error instanceof SemanticError && error.code === "in-flight-or-unknown";
    item.cacheStatus = blocked ? "blocked" : "invalid";
    throw new SemanticError(
      blocked ? "in-flight-or-unknown" : "cache-invalid",
      "The semantic cache cannot be reused safely.",
      "Inspect cache integrity and unresolved receipts before retrying.",
    );
  }
}

function creditHit(
  item: SemanticPreviewItem | SemanticReportItem,
  entry: SemanticCacheEntry,
): void {
  item.cacheEvaluatedAt = entry.evaluatedAt;
  item.cacheSourceRequestId = entry.requestId;
  addReason(item, "cache-hit");
}

type CacheInspection = {
  context?: SemanticCacheContext;
  lookup?: SemanticCacheLookup;
  current?: "current" | "state-changed" | "needs-refresh";
  error?: unknown;
};

async function inspectCaches(
  capture: SemanticCapture,
  items: Array<SemanticPreviewItem | SemanticReportItem>,
  options: SemanticRunOptions,
  taxonomy: SemanticTaxonomy | null,
  epoch: string,
  getCache: () => SemanticCacheStore,
  transport: GhTransport,
  signal?: AbortSignal,
): Promise<CacheInspection[]> {
  const inspections: CacheInspection[] = items.map(() => ({}));
  const hits: number[] = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (signal?.aborted) break;
    if (capture.items[index].status !== "ready" || item.reasonCodes.includes("input-too-large"))
      continue;
    const inspection = inspections[index];
    try {
      const context = await cacheContext(capture.items[index], taxonomy, epoch);
      inspection.context = context;
      item.inputHash = context.inputHash;
      if (!options.noSnapshot) {
        inspection.lookup = await lookupCache(item, getCache, context, options.refresh);
        if (inspection.lookup.status === "hit") hits.push(index);
      }
    } catch (error) {
      inspection.error = error;
    }
  }
  if (hits.length && !options.cached && !signal?.aborted) {
    try {
      const current = await revalidateSemanticEvidenceBatch(
        transport,
        capture.repo,
        hits.map((index) => capture.items[index]),
      );
      for (const index of hits)
        inspections[index].current = current.get(capture.items[index].key) ?? "needs-refresh";
    } catch (error) {
      for (const index of hits) inspections[index].error = error;
    }
  }
  return inspections;
}

export async function runSemanticPreview(
  capture: SemanticCapture,
  options: SemanticRunOptions,
  dependencies: {
    transport: GhTransport;
    createCache: () => SemanticCacheStore;
  },
): Promise<SemanticPreview> {
  validateOptions(options, capture);
  const preview = await buildClassificationPreview(capture, options);
  preview.execution.cache = options.noSnapshot ? "disabled" : "read-only";
  if (options.noSnapshot) {
    for (const item of preview.items) item.cacheStatus = "disabled";
    preview.nextSteps[0].description =
      "Review evidence coverage and taxonomy. No inference was performed. Cache is disabled.";
    return preview;
  }
  const taxonomy = options.taxonomy ? validateTaxonomy(options.taxonomy, capture.repo) : null;
  let cache: SemanticCacheStore | undefined;
  const getCache = () => (cache ??= dependencies.createCache());
  let stopReason: string | null = null;
  const inspections = await inspectCaches(
    capture,
    preview.items,
    options,
    taxonomy,
    preview.cacheEpoch,
    getCache,
    dependencies.transport,
  );
  if (options.cached) {
    preview.coverageComplete = false;
    for (const item of preview.items) addReason(item, "cached-evidence-not-revalidated");
  }
  preview.totals.plannedCalls = 0;
  preview.totals.deferred = 0;
  for (let index = 0; index < preview.items.length; index++) {
    const item = preview.items[index];
    const evidence = capture.items[index];
    clearPlan(item);
    item.plannedCall = false;
    if (evidence.status !== "ready" || item.reasonCodes.includes("input-too-large")) continue;
    if (stopReason) {
      item.outcome = "skipped";
      addReason(item, stopReason);
      continue;
    }
    try {
      const inspection = inspections[index];
      if (inspection.error) throw inspection.error;
      const context = inspection.context;
      if (!context) continue;
      if (inspection.lookup?.status === "hit") {
        const current = inspection.current;
        if (!options.cached && current !== "current") {
          item.outcome = "skipped";
          addReason(item, current ?? "needs-refresh");
          preview.coverageComplete = false;
          continue;
        }
        const latest = await lookupCache(item, getCache, context, options.refresh);
        if (latest.status === "hit") {
          creditHit(item, latest.entry);
          preview.totals.cacheHits++;
          continue;
        }
      }
      if (preview.totals.plannedCalls < options.maxCalls) {
        item.plannedCall = true;
        addReason(item, "preview-only");
        preview.totals.plannedCalls++;
      } else {
        addReason(item, "max-calls-reached");
        preview.totals.deferred++;
      }
    } catch (error) {
      const reason = code(error);
      item.outcome =
        item.cacheStatus === "hit" && reason !== "repository-not-public" ? "skipped" : "failed";
      addReason(item, reason);
      if (item.cacheStatus === "hit") preview.coverageComplete = false;
      if (reason === "repository-not-public") stopReason = reason;
    }
  }
  preview.totals.excluded = preview.items.filter((item) => item.outcome === "skipped").length;
  preview.totals.failed = preview.items.filter((item) => item.outcome === "failed").length;
  preview.nextSteps[0].description = options.cached
    ? "Saved evidence was inspected locally, not live revalidated. Review every item; no inference or writes were performed."
    : "Review evidence coverage, taxonomy and cache status. Cache was inspected read-only; no inference or local writes were performed. Reuse reflects the last cache lookup after metadata verification, not an atomic snapshot.";
  return preview;
}

function applyPolicy(
  item: SemanticReportItem,
  evaluation: SemanticEvaluation,
  evidence: SemanticEvidence,
  policy: SemanticPolicy,
): void {
  const suggestion = policy.decide(structuredClone(evaluation), evidence.commentsCoverage.complete);
  item.outcome = suggestion.outcome;
  item.answers = suggestion.answers;
  item.impactReportedStatus = suggestion.impactReportedStatus;
  for (const reason of suggestion.reasonCodes) addReason(item, reason);
}

function reuseEvaluation(
  report: SemanticReport,
  item: SemanticReportItem,
  entry: SemanticCacheEntry,
  evidence: SemanticEvidence,
  policy: SemanticPolicy,
): void {
  applyPolicy(item, entry.evaluation, evidence, policy);
  creditHit(item, entry);
  item.provenance = {
    modelRequested: SEMANTIC_MODEL,
    modelResolved: entry.evaluation.modelResolved,
    adapterVersion: entry.adapterVersion,
    evaluatedAt: entry.evaluatedAt,
    cacheHit: true,
    tokenUsage: entry.evaluation.tokenUsage,
    reportedCostUsd: entry.evaluation.reportedCostUsd,
  };
  report.totals.cacheHits++;
  if (entry.evaluation.reportedCostUsd === null) report.totals.hasUnknownHistoricalCost = true;
  else report.totals.cachedHistoricalCostUsd += entry.evaluation.reportedCostUsd;
}

export async function runSemanticEvaluation(
  capture: SemanticCapture,
  options: SemanticRunOptions,
  dependencies: {
    transport: GhTransport;
    getApiKey: () => string | undefined;
    createStore: () => SemanticReceiptStore;
    createCache: () => SemanticCacheStore;
    isDisabled: () => boolean;
    policy?: SemanticPolicy;
    fetch?: typeof globalThis.fetch;
    signal?: AbortSignal;
    timeoutMs?: number;
    now?: () => string;
    nowMs?: () => number;
    wait?: SemanticWaitOptions;
  },
): Promise<SemanticReport> {
  validateOptions(options, capture);
  const now = () => new Date(dependencies.now?.() ?? Date.now()).toISOString();
  const preview = await buildClassificationPreview(capture, options);
  const taxonomy = options.taxonomy ? validateTaxonomy(options.taxonomy, capture.repo) : null;
  const policy = dependencies.policy ?? {
    version: SEMANTIC_POLICY_VERSION,
    decide: decideSuggestion,
  };
  const items: SemanticReportItem[] = preview.items.map(
    ({ plannedCall: _plannedCall, ...item }) => {
      clearPlan(item);
      return {
        ...item,
        cacheStatus: options.noSnapshot ? "disabled" : item.cacheStatus,
        answers: null,
        impactReportedStatus: "unavailable",
        provenance: null,
        receipt: null,
        providerError: null,
      };
    },
  );
  const report: SemanticReport = {
    ...preview,
    kind: "classification-report",
    policyVersion: policy.version,
    execution: {
      dryRun: false,
      gatewayCalls: 0,
      receiptRecordsWritten: 0,
      receipts: options.noSnapshot ? "memory-only" : "durable",
      cache: options.noSnapshot ? "disabled" : "enabled",
      cacheEntriesWritten: 0,
    },
    items,
    totals: {
      captured: items.length,
      evaluated: 0,
      cacheHits: 0,
      suggested: 0,
      needsReview: 0,
      skipped: 0,
      failed: 0,
      deferred: 0,
      oversized: 0,
      reportedCostUsd: 0,
      hasUnknownCost: false,
      cachedHistoricalCostUsd: 0,
      hasUnknownHistoricalCost: false,
    },
    nextSteps: [
      {
        action: "review-evidence",
        description:
          "Review every suggestion, distribution and evidence reference. No GitHub action was performed. Inspect unresolved receipts before another paid request; semantic quality remains unverified. Reuse reflects the last cache lookup after metadata verification, not an atomic snapshot.",
      },
    ],
  };
  let store: SemanticReceiptStore | undefined;
  let cache: SemanticCacheStore | undefined;
  const getCache = () => (cache ??= dependencies.createCache());
  let apiKey: string | undefined;
  let stopReason: string | null = null;
  let callStopReason: string | null = null;
  let reserved = 0;
  let pauseUntil = 0;
  let nextSendAt = 0;
  const clock = dependencies.wait?.now ?? (() => performance.now());
  const wallClock = dependencies.nowMs ?? Date.now;
  const maxRetries = options.maxRetries ?? 0;
  const skip = (item: SemanticReportItem, reason: string) => {
    item.outcome = "skipped";
    addReason(item, reason);
    report.totals.deferred++;
  };
  const stopped = () =>
    stopReason ??
    (dependencies.signal?.aborted ? "run-aborted" : null) ??
    callStopReason ??
    (dependencies.isDisabled() ? "inference-disabled" : null);
  const waitForDispatch = async (item: SemanticReportItem): Promise<boolean> => {
    while (true) {
      const reason = stopped();
      if (reason) {
        skip(item, reason);
        return false;
      }
      const delay = Math.max(pauseUntil, nextSendAt) - clock();
      if (delay <= 0) return true;
      if (
        !(await abortableSleep(delay, dependencies.signal, () => stopped() !== null, {
          ...dependencies.wait,
          now: clock,
        }))
      ) {
        skip(item, stopped() ?? "run-aborted");
        return false;
      }
    }
  };
  const fail = (item: SemanticReportItem, error: unknown) => {
    const reason = code(error);
    item.outcome = "failed";
    item.answers = null;
    item.impactReportedStatus = "unavailable";
    addReason(item, reason);
    if (reason === "repository-not-public") stopReason = reason;
  };
  const checkCurrent = (item: SemanticReportItem, current: string | undefined): boolean => {
    if (dependencies.signal?.aborted) {
      skip(item, "run-aborted");
      return false;
    }
    if (current !== "current") {
      item.outcome = "skipped";
      addReason(item, current ?? "needs-refresh");
      report.coverageComplete = false;
      return false;
    }
    return true;
  };
  const guard = async (
    item: SemanticReportItem,
    evidence: SemanticEvidence,
    cached = false,
  ): Promise<boolean> => {
    if (dependencies.signal?.aborted) {
      skip(item, "run-aborted");
      return false;
    }
    try {
      const current = await revalidateSemanticEvidenceBatch(dependencies.transport, capture.repo, [
        evidence,
      ]);
      return checkCurrent(item, current.get(evidence.key));
    } catch (error) {
      report.coverageComplete = false;
      if (cached && code(error) !== "repository-not-public") {
        item.outcome = "skipped";
        addReason(item, code(error));
        return false;
      }
      throw error;
    }
  };
  const inspections = await inspectCaches(
    capture,
    items,
    options,
    taxonomy,
    report.cacheEpoch,
    getCache,
    dependencies.transport,
    dependencies.signal,
  );
  const queue: number[] = [];
  if (options.cached) {
    report.coverageComplete = false;
    report.nextSteps[0].description =
      "Saved evidence was inspected locally, not live revalidated. Review every item; no inference or writes were performed.";
  }
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const evidence = capture.items[index];
    if (options.cached) addReason(item, "cached-evidence-not-revalidated");
    if (evidence.status !== "ready") continue;
    if (item.reasonCodes.includes("input-too-large")) {
      report.totals.oversized++;
      report.totals.deferred++;
      continue;
    }
    if (stopReason || dependencies.signal?.aborted) {
      skip(item, stopReason ?? "run-aborted");
      continue;
    }
    const inspection = inspections[index];
    try {
      if (inspection.error) throw inspection.error;
      if (!inspection.context) continue;
      if (inspection.lookup?.status === "hit") {
        if (!options.cached && !checkCurrent(item, inspection.current)) continue;
        const latest = await lookupCache(item, getCache, inspection.context, options.refresh);
        if (dependencies.signal?.aborted) {
          skip(item, "run-aborted");
          continue;
        }
        if (latest.status === "hit") {
          reuseEvaluation(report, item, latest.entry, evidence, policy);
          continue;
        }
      }
      if (options.cached || options.maxCalls === 0) skip(item, "max-calls-reached");
      else queue.push(index);
    } catch (error) {
      if (inspection.lookup?.status === "hit" && inspection.error) {
        report.coverageComplete = false;
        if (code(error) !== "repository-not-public") {
          item.outcome = "skipped";
          addReason(item, code(error));
          continue;
        }
      }
      fail(item, error);
    }
  }
  const processItem = async (index: number) => {
    const item = items[index];
    const evidence = capture.items[index];
    const context = inspections[index].context;
    if (!context) return;
    for (let retryIndex = 0; ; retryIndex++) {
      if (!(await waitForDispatch(item))) return;
      if (report.execution.gatewayCalls + reserved >= options.maxCalls) {
        skip(item, "max-calls-reached");
        return;
      }
      reserved++;
      let reservation = true;
      let pending: SemanticPendingReceipt | null = null;
      let result: SemanticReceiptResult | null = null;
      let attempted = false;
      let preservePending = false;
      let retry = false;
      let httpErrorHandled = false;
      let retryWait: number | null = null;
      const onHttpError = (error: JevError): void => {
        if (httpErrorHandled || error.code !== "gateway-http-error" || !error.attempted) return;
        httpErrorHandled = true;
        if (error.status === 401 || error.status === 403) callStopReason = "provider-unavailable";
        if (error.status !== 429) return;
        retryWait = retryDelayMs(error, retryIndex, {
          maxRetries,
          maxWaitMs: 30000,
          now: wallClock,
        });
        const sharedDelay = retryDelayMs(error, 0, {
          maxRetries: maxRetries > 0 ? 1 : 0,
          maxWaitMs: 30000,
          now: wallClock,
        });
        if (sharedDelay === null) callStopReason = "provider-unavailable";
        else pauseUntil = Math.max(pauseUntil, clock() + (retryWait ?? sharedDelay));
      };
      let attempt: NonNullable<SemanticReportItem["attempts"]>[number] | undefined;
      try {
        if (retryIndex > 0 && !(await guard(item, evidence))) return;
        if (stopped()) {
          skip(item, stopped() ?? "run-aborted");
          return;
        }
        apiKey ??= dependencies.getApiKey();
        if (!apiKey || !/^[A-Za-z0-9._~+/-]+=*$/.test(apiKey)) {
          callStopReason = "gateway-credentials-unavailable";
          throw new SemanticError(
            callStopReason,
            "Gateway credentials are unavailable.",
            "Configure AI_GATEWAY_API_KEY before explicitly requesting inference.",
          );
        }
        store ??= options.noSnapshot ? memoryReceipts(now) : dependencies.createStore();
        pending = await store.begin({
          inputHash: context.inputHash,
          modelRequested: SEMANTIC_MODEL,
          adapterVersion: JEV_ADAPTER_VERSION,
        });
        item.receipt = { pending, final: null };
        attempt = {
          receipt: item.receipt,
          attempted: false,
          gatewayTiming: null,
          providerError: null,
        };
        item.attempts ??= [];
        item.attempts.push(attempt);
        if (pending.durable) report.execution.receiptRecordsWritten++;
        result = {
          status: "not-sent",
          evaluatedAt: null,
          tokenUsage: { inputTokens: null, outputTokens: null },
          reportedCostUsd: null,
          errorCode: null,
          outcomeUnknown: false,
        };
        let underLease = options.noSnapshot
          ? null
          : await lookupCache(item, getCache, context, options.refresh, pending.requestId);
        while (true) {
          if (underLease?.status !== "hit" && !(await waitForDispatch(item))) {
            result.errorCode = item.reasonCodes.at(-1) ?? "run-aborted";
            break;
          }
          if (!(await guard(item, evidence, underLease?.status === "hit"))) {
            result.errorCode = item.reasonCodes.at(-1) ?? "needs-refresh";
            break;
          }
          if (underLease?.status === "hit") {
            underLease = await lookupCache(
              item,
              getCache,
              context,
              options.refresh,
              pending.requestId,
            );
          }
          if (dependencies.signal?.aborted || stopReason) {
            const reason = stopReason ?? "run-aborted";
            skip(item, reason);
            result.errorCode = reason;
            break;
          }
          if (underLease?.status === "hit") {
            reuseEvaluation(report, item, underLease.entry, evidence, policy);
            result.errorCode = "cache-race-hit";
            break;
          }
          const reason = stopped();
          if (reason) {
            skip(item, reason);
            result.errorCode = reason;
            break;
          }
          if (clock() < Math.max(pauseUntil, nextSendAt)) continue;
          const raw = await evaluateWithJev(context.request, {
            apiKey,
            fetch: dependencies.fetch,
            signal: dependencies.signal,
            timeoutMs: dependencies.timeoutMs,
            nowMs: wallClock(),
            onHttpError,
            onTiming: (timing) => {
              if (attempt) attempt.gatewayTiming = timing;
            },
            onAttempt: () => {
              attempted = true;
              if (attempt) attempt.attempted = true;
              reserved--;
              reservation = false;
              report.execution.gatewayCalls++;
              nextSendAt = clock() + (options.minIntervalMs ?? 0);
            },
          });
          const evaluation = validateEvaluation(context.request, raw);
          const evaluatedAt = now();
          report.totals.evaluated++;
          item.providerError = null;
          item.provenance = {
            modelRequested: SEMANTIC_MODEL,
            modelResolved: evaluation.modelResolved,
            adapterVersion: JEV_ADAPTER_VERSION,
            evaluatedAt,
            cacheHit: false,
            tokenUsage: evaluation.tokenUsage,
            reportedCostUsd: evaluation.reportedCostUsd,
          };
          result = {
            status: "succeeded",
            evaluatedAt,
            tokenUsage: evaluation.tokenUsage,
            reportedCostUsd: evaluation.reportedCostUsd,
            errorCode: null,
            outcomeUnknown: false,
          };
          if (!options.noSnapshot) {
            try {
              if (!pending.durable) throw new Error("Non-durable receipt");
              await getCache().write(context, { evaluation, evaluatedAt }, pending);
              report.execution.cacheEntriesWritten++;
            } catch {
              preservePending = true;
              stopReason = "cache-write-failed";
              throw new SemanticError(
                stopReason,
                "The semantic cache could not be persisted safely.",
                "Manually inspect the pending receipt and lock before recovery.",
              );
            }
          }
          if (await guard(item, evidence)) applyPolicy(item, evaluation, evidence, policy);
          break;
        }
      } catch (error) {
        fail(item, error);
        const reason = code(error);
        if (error instanceof JevError) {
          onHttpError(error);
          item.providerError = {
            code: reason,
            status: error.status,
            retryAfterSeconds: Number.isFinite(error.retryAfterSeconds)
              ? error.retryAfterSeconds
              : null,
            ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}),
          };
          if (error.status === 429) {
            retry = error.code === "gateway-http-error" && retryWait !== null;
            if (!retry)
              item.providerError.retryRefusalReason =
                maxRetries === 0
                  ? "retries-disabled"
                  : retryIndex >= maxRetries
                    ? "max-retries-reached"
                    : "retry-wait-exceeds-limit";
          }
          if (attempt) attempt.providerError = item.providerError;
        }
        if (result?.status !== "succeeded") {
          const rejected =
            error instanceof JevError &&
            error.code === "gateway-http-error" &&
            [401, 403, 422, 429].includes(error.status ?? 0);
          result = {
            status: attempted ? "failed" : "not-sent",
            evaluatedAt: null,
            tokenUsage: { inputTokens: null, outputTokens: null },
            reportedCostUsd: null,
            errorCode: reason,
            outcomeUnknown: attempted && !rejected,
          };
        }
      } finally {
        if (reservation) reserved--;
      }
      if (attempted) {
        if (result?.reportedCostUsd == null) report.totals.hasUnknownCost = true;
        else report.totals.reportedCostUsd += result.reportedCostUsd;
      }
      if (pending && store && result && !preservePending) {
        try {
          const final: SemanticFinalReceipt = await store.finish(pending, result);
          item.receipt = { pending, final };
          if (attempt) attempt.receipt = item.receipt;
          if (final.durable) report.execution.receiptRecordsWritten++;
        } catch (error) {
          fail(item, error);
          stopReason = "receipt-finalization-failed";
          retry = false;
        }
      }
      if (!retry || preservePending || !pending || result?.outcomeUnknown) return;
      if (report.execution.gatewayCalls >= options.maxCalls) {
        if (item.providerError) item.providerError.retryRefusalReason = "max-calls-reached";
        addReason(item, "max-calls-reached");
        return;
      }
    }
  };
  const concurrency = options.concurrency ?? 1;
  for (let offset = 0; offset < queue.length; offset += concurrency) {
    const wave = queue.slice(offset, offset + concurrency);
    const eligible: number[] = [];
    for (const index of wave) {
      const item = items[index];
      try {
        if (!(await waitForDispatch(item))) continue;
        if (report.execution.gatewayCalls + eligible.length >= options.maxCalls) {
          skip(item, "max-calls-reached");
          continue;
        }
        eligible.push(index);
      } catch (error) {
        fail(item, error);
      }
    }
    if (!eligible.length) continue;
    try {
      const current = await revalidateSemanticEvidenceBatch(
        dependencies.transport,
        capture.repo,
        eligible.map((index) => capture.items[index]),
      );
      await Promise.all(
        eligible
          .filter((index) => checkCurrent(items[index], current.get(capture.items[index].key)))
          .map((index) => processItem(index).catch((error) => fail(items[index], error))),
      );
    } catch (error) {
      report.coverageComplete = false;
      for (const index of eligible) fail(items[index], error);
    }
  }
  report.totals.suggested = items.filter((item) => item.outcome === "suggested").length;
  report.totals.needsReview = items.filter((item) => item.outcome === "needs-review").length;
  report.totals.skipped = items.filter((item) => item.outcome === "skipped").length;
  report.totals.failed = items.filter((item) => item.outcome === "failed").length;
  return report;
}
