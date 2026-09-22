import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { connection, envelope } from "../tests/semantic-github-fixture.js";
import { assertWarmReuse } from "../tests/semantic-report-checks.js";
import {
  buildClassificationPreview,
  buildEvaluationInput,
  SEMANTIC_POLICY_VERSION,
} from "./semantic.js";
import {
  buildEvaluationRequest,
  fingerprintEvaluation,
  SEMANTIC_CACHE_EPOCH,
  SEMANTIC_CACHE_TTL_MS,
  validateEvaluation,
} from "./semantic-evaluation.js";
import { JEV_ADAPTER_VERSION } from "./semantic-jev.js";
import { runSemanticEvaluation, runSemanticPreview } from "./semantic-run.js";
import { createSemanticCacheStore, createSemanticReceiptStore } from "./semantic-store.js";
import {
  type GatewayEvaluationRequest,
  type SemanticCacheContext,
  type SemanticCacheEntry,
  type SemanticCacheStore,
  type SemanticCapture,
  SemanticError,
  type SemanticPendingReceipt,
  type SemanticReceiptStore,
} from "./semantic-types.js";
import type { GhTransport } from "./transport.js";

const TIME = "2026-09-21T12:00:00.000Z";
const options = { limit: 10, maxCalls: 10, taxonomy: null, noSnapshot: false };
const forbiddenNetwork = vi.fn(() => {
  throw new Error("Live network is forbidden");
});
const homes: string[] = [];

beforeEach(() => {
  forbiddenNetwork.mockClear();
  vi.stubGlobal("fetch", forbiddenNetwork);
});

afterEach(async () => {
  try {
    expect(forbiddenNetwork).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
  }
});

function capture(count = 1): SemanticCapture {
  const captureWindow = { startedAt: TIME, completedAt: TIME };
  const coverage = {
    captured: count,
    total: count,
    hasNextPage: false,
    pages: 1,
    complete: true,
    reasonCodes: [],
  };
  return {
    repo: "o/r",
    visibility: "PUBLIC",
    captureWindow,
    coverage,
    items: Array.from({ length: count }, (_, index) => ({
      key: `o/r#${index + 1}`,
      id: `I_${index + 1}`,
      url: `https://github.com/o/r/issues/${index + 1}`,
      number: index + 1,
      state: "OPEN",
      title: "Reported behavior",
      body: "Steps and expected versus actual behavior",
      updatedAt: TIME,
      comments: [],
      commentsCoverage: { ...coverage, captured: 0, total: 0 },
      captureWindow,
      status: "ready",
      reasonCodes: [],
    })),
  };
}

function rawEvaluation(
  request: GatewayEvaluationRequest,
  cost: number | null = 0.125,
  choice = "bug",
) {
  return {
    model: request.model,
    answers: Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => {
        if (question.type === "boolean") return [id, { type: "boolean", probability: 0.2 }];
        if (question.type === "score") {
          return [
            id,
            { type: "score", score: 2, probabilities: { "0": 0, "1": 0, "2": 1, "3": 0 } },
          ];
        }
        return [
          id,
          {
            type: "choice",
            choice,
            probabilities: Object.fromEntries(
              Object.keys(question.criteria).map((key) => [key, key === choice ? 1 : 0]),
            ),
          },
        ];
      }),
    ),
    usage: { inputTokens: 120, outputTokens: 30 },
    ...(cost === null ? {} : { providerMetadata: { gateway: { cost } } }),
  };
}

function harness(input = capture()) {
  const entries = new Map<string, SemanticCacheEntry>();
  const locks = new Map<string, SemanticPendingReceipt>();
  const committed = new Set<string>();
  const events: string[] = [];
  const graphql = vi.fn<GhTransport["graphql"]>(async (query, variables = {}) => {
    const fields: Record<string, unknown> = {};
    for (const match of query.matchAll(/(i\d+): issue\(number: \$(number\d+)\)/g)) {
      const evidence = input.items.find((item) => item.number === variables[match[2]]);
      if (!evidence) throw new Error("Unexpected issue");
      fields[match[1]] = {
        __typename: "Issue",
        id: evidence.id,
        number: evidence.number,
        state: evidence.state,
        title: evidence.title,
        updatedAt: evidence.updatedAt,
        comments: connection(
          evidence.comments.map((comment) => ({
            ...comment,
            __typename: "IssueComment",
            author: comment.author ? { login: comment.author } : null,
          })),
          evidence.comments.length,
        ),
      };
    }
    return envelope(fields);
  });
  const transport: GhTransport = { graphql, search: vi.fn(async () => []) };
  const begin = vi.fn<SemanticReceiptStore["begin"]>(async (value) => {
    events.push("begin");
    if (locks.has(value.inputHash))
      throw new SemanticError("in-flight-or-unknown", "secret", "secret");
    const pending: SemanticPendingReceipt = {
      ...value,
      schemaVersion: 1,
      requestId: globalThis.crypto.randomUUID(),
      createdAt: TIME,
      phase: "pending",
      durable: true,
    };
    locks.set(value.inputHash, pending);
    return pending;
  });
  const finish = vi.fn<SemanticReceiptStore["finish"]>(async (pending, result) => {
    events.push("finish");
    if (result.status === "succeeded") committed.add(pending.requestId);
    locks.delete(pending.inputHash);
    return { ...pending, phase: "final", completedAt: TIME, result };
  });
  const read = vi.fn<SemanticCacheStore["read"]>(async (context, settings) => {
    events.push(settings?.ownedRequestId ? "read-owned" : "read");
    const lock = locks.get(context.inputHash);
    if (lock && lock.requestId !== settings?.ownedRequestId)
      throw new SemanticError("in-flight-or-unknown", "secret", "secret");
    if (settings?.refresh) return { status: "refresh" };
    const entry = entries.get(context.inputHash);
    if (!entry) return { status: "miss" };
    if (!committed.has(entry.requestId))
      throw new SemanticError("cache-invalid", "secret", "secret");
    return { status: "hit", entry };
  });
  const write = vi.fn<SemanticCacheStore["write"]>(async (context, value, pending) => {
    events.push("write");
    expect(locks.get(context.inputHash)).toEqual(pending);
    entries.set(context.inputHash, {
      schemaVersion: 1,
      inputHash: context.inputHash,
      requestId: pending.requestId,
      adapterVersion: context.adapterVersion,
      cacheEpoch: context.cacheEpoch,
      evaluatedAt: value.evaluatedAt,
      expiresAt: new Date(Date.parse(TIME) + SEMANTIC_CACHE_TTL_MS).toISOString(),
      evaluation: structuredClone(value.evaluation),
    });
  });
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    events.push("fetch");
    return Response.json(rawEvaluation(JSON.parse(String(init?.body))));
  });
  const dependencies = {
    transport,
    createCache: vi.fn(() => ({ read, write })),
    createStore: vi.fn(() => ({ begin, finish })),
    getApiKey: vi.fn(() => "fake-test-key"),
    isDisabled: vi.fn(() => false),
    fetch,
    now: () => TIME,
  };
  async function seed(
    index = 0,
    cost: number | null = 0.125,
    choice = "bug",
    epoch = SEMANTIC_CACHE_EPOCH,
  ) {
    const request = buildEvaluationRequest(buildEvaluationInput(input.items[index], null));
    const context: SemanticCacheContext = {
      request,
      taxonomy: null,
      cacheEpoch: epoch,
      adapterVersion: JEV_ADAPTER_VERSION,
      inputHash: await fingerprintEvaluation(request, null, JEV_ADAPTER_VERSION, epoch),
    };
    const entry: SemanticCacheEntry = {
      schemaVersion: 1,
      inputHash: context.inputHash,
      requestId: globalThis.crypto.randomUUID(),
      cacheEpoch: epoch,
      adapterVersion: JEV_ADAPTER_VERSION,
      evaluatedAt: TIME,
      expiresAt: new Date(Date.parse(TIME) + SEMANTIC_CACHE_TTL_MS).toISOString(),
      evaluation: validateEvaluation(request, rawEvaluation(request, cost, choice)),
    };
    entries.set(context.inputHash, entry);
    committed.add(entry.requestId);
    return entry;
  }
  return {
    input,
    dependencies,
    entries,
    locks,
    events,
    graphql,
    begin,
    finish,
    read,
    write,
    fetch,
    seed,
  };
}

type ReuseLane = "preview" | "warm" | "owned";

function runLane(lane: ReuseLane, h: ReturnType<typeof harness>, maxCalls = 1) {
  return lane === "preview"
    ? runSemanticPreview(h.input, { ...options, maxCalls }, h.dependencies)
    : runSemanticEvaluation(h.input, { ...options, maxCalls }, h.dependencies);
}

function duringMetadata(
  h: ReturnType<typeof harness>,
  lane: ReuseLane,
  change: () => void | Promise<void>,
) {
  if (lane === "owned") h.read.mockResolvedValueOnce({ status: "miss" });
  const original = h.graphql.getMockImplementation();
  if (!original) throw new Error("Missing metadata mock");
  let ordinal = 0;
  h.graphql.mockImplementation(async (...args) => {
    const current = ++ordinal;
    const response = await original(...args);
    if (current === (lane === "owned" ? 2 : 1)) await change();
    return response;
  });
}

describe.each<ReuseLane>(["preview", "warm", "owned"])("late %s cache lookup", (lane) => {
  test.each([
    "blocked",
    "invalid",
  ])("%s arriving during metadata verification fails without a call", async (status) => {
    const h = harness();
    const prior = await h.seed();
    duringMetadata(h, lane, () => {
      if (status === "invalid") {
        h.entries.set(prior.inputHash, { ...prior, requestId: globalThis.crypto.randomUUID() });
      } else {
        h.locks.set(prior.inputHash, {
          schemaVersion: 1,
          requestId: globalThis.crypto.randomUUID(),
          inputHash: prior.inputHash,
          modelRequested: "typesafe-ai/jev",
          adapterVersion: JEV_ADAPTER_VERSION,
          createdAt: TIME,
          phase: "pending",
          durable: true,
        });
      }
    });
    const result = await runLane(lane, h);
    expect(result.items[0]).toMatchObject({
      outcome: "failed",
      cacheStatus: status,
      cacheSourceRequestId: null,
      cacheEvaluatedAt: null,
    });
    expect(result.totals).toMatchObject({
      cacheHits: 0,
      failed: 1,
      reportedCostUsd: 0,
      hasUnknownCost: false,
    });
    expect(result.execution.gatewayCalls).toBe(0);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
    expect(h.graphql).toHaveBeenCalledTimes(lane === "owned" ? 2 : 1);
    expect(h.read).toHaveBeenCalledTimes(lane === "owned" ? 3 : 2);
    if (result.kind === "classification-report") {
      expect(result.totals).toMatchObject({
        evaluated: 0,
        cachedHistoricalCostUsd: 0,
        hasUnknownHistoricalCost: false,
      });
      expect(result.items[0].answers).toBeNull();
      expect(result.items[0].provenance).toBeNull();
      if (lane === "owned") {
        expect(result.items[0].receipt?.final?.result).toMatchObject({
          status: "not-sent",
          outcomeUnknown: false,
          reportedCostUsd: null,
        });
        expect(h.read.mock.calls[2][1]?.ownedRequestId).toBe(
          result.items[0].receipt?.pending.requestId,
        );
      }
    } else {
      expect(result.items[0].plannedCall).toBe(false);
    }
    if (lane !== "owned") {
      expect(h.dependencies.getApiKey).not.toHaveBeenCalled();
      expect(h.dependencies.createStore).not.toHaveBeenCalled();
      expect(h.begin).not.toHaveBeenCalled();
      expect(h.finish).not.toHaveBeenCalled();
    }
  });

  test.each([
    "expired",
    "miss",
  ] as const)("%s after the guard returns to the bounded fresh path", async (status) => {
    const h = harness();
    const prior = await h.seed();
    duringMetadata(h, lane, () => {
      h.entries.delete(prior.inputHash);
      if (status === "expired") h.read.mockResolvedValue({ status: "expired" });
    });
    const result = await runLane(lane, h);
    expect(result.items[0]).toMatchObject({
      cacheStatus: status,
      cacheSourceRequestId: null,
      cacheEvaluatedAt: null,
    });
    expect(result.items[0].reasonCodes).not.toContain("cache-hit");
    expect(result.totals.cacheHits).toBe(0);
    if (result.kind === "classification-preview") {
      expect(result.totals).toMatchObject({ plannedCalls: 1, deferred: 0 });
      expect(result.items[0].plannedCall).toBe(true);
      expect(h.fetch).not.toHaveBeenCalled();
      expect(h.graphql).toHaveBeenCalledTimes(1);
    } else {
      expect(result.totals).toMatchObject({
        evaluated: 1,
        reportedCostUsd: 0.125,
        cachedHistoricalCostUsd: 0,
        hasUnknownCost: false,
      });
      expect(result.items[0].provenance?.cacheHit).toBe(false);
      expect(result.items[0].receipt?.final?.result).toMatchObject({
        status: "succeeded",
        outcomeUnknown: false,
      });
      expect(h.fetch).toHaveBeenCalledTimes(1);
      expect(h.begin).toHaveBeenCalledTimes(1);
      expect(h.finish).toHaveBeenCalledTimes(1);
      expect(h.graphql).toHaveBeenCalledTimes(lane === "warm" ? 4 : 3);
      if (lane === "owned") {
        expect(h.read.mock.calls[2][1]?.ownedRequestId).toBe(
          result.items[0].receipt?.pending.requestId,
        );
      }
    }
    expect(h.read).toHaveBeenCalledTimes(lane === "preview" ? 2 : 3);
  });

  test("a completed refresh during the guard uses only the latest source and historical cost", async () => {
    const h = harness();
    const prior = await h.seed(0, null);
    let latest = prior;
    duringMetadata(h, lane, async () => {
      latest = await h.seed(0, 0.75, "feature");
      latest.evaluatedAt = "2026-09-21T12:00:01.000Z";
      latest.evaluation.tokenUsage = { inputTokens: 240, outputTokens: 60 };
    });
    const result = await runLane(lane, h);
    expect(latest.requestId).not.toBe(prior.requestId);
    expect(result.items[0]).toMatchObject({
      cacheStatus: "hit",
      cacheSourceRequestId: latest.requestId,
      cacheEvaluatedAt: latest.evaluatedAt,
    });
    expect(result.totals).toMatchObject({
      cacheHits: 1,
      reportedCostUsd: 0,
      hasUnknownCost: false,
    });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
    expect(h.graphql).toHaveBeenCalledTimes(lane === "owned" ? 2 : 1);
    expect(h.read).toHaveBeenCalledTimes(lane === "owned" ? 3 : 2);
    if (result.kind === "classification-report") {
      expect(result.totals).toMatchObject({
        evaluated: 0,
        cachedHistoricalCostUsd: 0.75,
        hasUnknownHistoricalCost: false,
      });
      expect(result.items[0]).toMatchObject({
        answers: { requestType: { choice: "feature" } },
        provenance: {
          cacheHit: true,
          evaluatedAt: latest.evaluatedAt,
          reportedCostUsd: 0.75,
          tokenUsage: latest.evaluation.tokenUsage,
        },
      });
      if (lane === "owned") {
        expect(result.items[0].receipt?.final?.result).toMatchObject({
          status: "not-sent",
          errorCode: "cache-race-hit",
          reportedCostUsd: null,
          outcomeUnknown: false,
        });
        expect(h.read.mock.calls[2][1]?.ownedRequestId).toBe(
          result.items[0].receipt?.pending.requestId,
        );
      }
    } else {
      expect(result.items[0].plannedCall).toBe(false);
      expect(result.items[0]).not.toHaveProperty("answers");
    }
    if (lane !== "owned") {
      expect(h.dependencies.getApiKey).not.toHaveBeenCalled();
      expect(h.dependencies.createStore).not.toHaveBeenCalled();
    }
  });
});

describe.each<ReuseLane>(["preview", "warm"])("zero-budget %s late lookup", (lane) => {
  test.each([
    "expired",
    "miss",
  ] as const)("%s during the guard defers without keys, calls or receipts", async (status) => {
    const h = harness();
    const prior = await h.seed();
    duringMetadata(h, lane, () => {
      h.entries.delete(prior.inputHash);
      if (status === "expired") h.read.mockResolvedValue({ status: "expired" });
    });
    const result = await runLane(lane, h, 0);
    expect(result.items[0]).toMatchObject({
      cacheStatus: status,
      cacheSourceRequestId: null,
      cacheEvaluatedAt: null,
    });
    expect(result.totals).toMatchObject({
      cacheHits: 0,
      deferred: 1,
      reportedCostUsd: 0,
      hasUnknownCost: false,
    });
    expect(result.items[0].reasonCodes).toContain("max-calls-reached");
    expect(h.graphql).toHaveBeenCalledTimes(1);
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(h.dependencies.getApiKey).not.toHaveBeenCalled();
    expect(h.dependencies.createStore).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
    if (result.kind === "classification-preview") {
      expect(result.totals.plannedCalls).toBe(0);
    } else {
      expect(result.totals).toMatchObject({
        evaluated: 0,
        cachedHistoricalCostUsd: 0,
        hasUnknownHistoricalCost: false,
      });
      expect(result.items[0]).toMatchObject({
        outcome: "skipped",
        answers: null,
        provenance: null,
        receipt: null,
      });
    }
  });
});

describe.each<ReuseLane>(["warm", "owned"])("STOP after %s expiry", (lane) => {
  test("late miss respects STOP without issuing a Gateway call", async () => {
    const h = harness();
    const prior = await h.seed();
    duringMetadata(h, lane, () => {
      h.entries.delete(prior.inputHash);
      h.dependencies.isDisabled.mockReturnValue(true);
    });
    const result = await runSemanticEvaluation(h.input, options, h.dependencies);
    expect(result.totals).toMatchObject({
      cacheHits: 0,
      deferred: 1,
      evaluated: 0,
      reportedCostUsd: 0,
      cachedHistoricalCostUsd: 0,
      hasUnknownCost: false,
    });
    expect(result.items[0]).toMatchObject({ outcome: "skipped", answers: null, provenance: null });
    expect(result.items[0].reasonCodes).toContain("inference-disabled");
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
    if (lane === "owned") {
      expect(result.items[0].receipt?.final?.result).toMatchObject({
        status: "not-sent",
        errorCode: "inference-disabled",
        outcomeUnknown: false,
      });
    } else {
      expect(h.dependencies.getApiKey).not.toHaveBeenCalled();
      expect(h.begin).not.toHaveBeenCalled();
    }
  });
});

describe("semantic reuse orchestration", () => {
  test("pure preview is cache-unchecked and fingerprints the explicit epoch", async () => {
    const input = capture();
    const initial = structuredClone(input);
    const preview = await buildClassificationPreview(input, options);
    const changed = await buildClassificationPreview(input, { ...options, cacheEpoch: "next" });
    expect(input).toEqual(initial);
    expect(preview).toMatchObject({
      cacheEpoch: SEMANTIC_CACHE_EPOCH,
      execution: { dryRun: true, gatewayCalls: 0, localWrites: 0, cache: "not-checked" },
      totals: { cacheHits: 0, plannedCalls: 1 },
      items: [{ cacheStatus: "not-checked", cacheEvaluatedAt: null, cacheSourceRequestId: null }],
    });
    expect(preview.nextSteps[0].description).toContain("Cache was not inspected");
    expect(changed.items[0].inputHash).not.toBe(preview.items[0].inputHash);
  });

  test("cold then hot preserves provenance without double cost, credentials or receipts", async () => {
    const h = harness();
    const cold = await runSemanticEvaluation(h.input, options, h.dependencies);
    expect(cold.policyVersion).toBe(SEMANTIC_POLICY_VERSION);
    expect(cold.execution).toMatchObject({
      gatewayCalls: 1,
      receiptRecordsWritten: 2,
      cache: "enabled",
      cacheEntriesWritten: 1,
    });
    expect(cold.totals).toMatchObject({
      evaluated: 1,
      cacheHits: 0,
      reportedCostUsd: 0.125,
      cachedHistoricalCostUsd: 0,
    });
    expect(h.events).toEqual(["read", "begin", "read-owned", "fetch", "write", "finish"]);
    const hot = await runSemanticEvaluation(h.input, options, h.dependencies);
    expect(h.dependencies.getApiKey).toHaveBeenCalledTimes(1);
    expect(h.dependencies.createStore).toHaveBeenCalledTimes(1);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.finish).toHaveBeenCalledTimes(1);
    expect(hot.execution).toMatchObject({
      gatewayCalls: 0,
      receiptRecordsWritten: 0,
      cacheEntriesWritten: 0,
    });
    expect(hot.totals).toMatchObject({
      evaluated: 0,
      cacheHits: 1,
      reportedCostUsd: 0,
      hasUnknownCost: false,
      cachedHistoricalCostUsd: 0.125,
      hasUnknownHistoricalCost: false,
    });
    expect(hot.items[0]).toMatchObject({
      cacheStatus: "hit",
      cacheEvaluatedAt: TIME,
      cacheSourceRequestId: cold.items[0].receipt?.pending.requestId,
      receipt: null,
      provenance: { ...cold.items[0].provenance, cacheHit: true },
    });
  });

  test("zero budget and STOP still return all warm hits and historical unknown costs", async () => {
    const h = harness(capture(2));
    await h.seed(0, null);
    await h.seed(1);
    h.dependencies.isDisabled.mockReturnValue(true);
    const result = await runSemanticEvaluation(
      h.input,
      { ...options, maxCalls: 0 },
      h.dependencies,
    );
    expect(result.totals).toMatchObject({
      cacheHits: 2,
      evaluated: 0,
      deferred: 0,
      skipped: 0,
      failed: 0,
      reportedCostUsd: 0,
      hasUnknownCost: false,
      cachedHistoricalCostUsd: 0.125,
      hasUnknownHistoricalCost: true,
    });
    expect(h.dependencies.isDisabled).not.toHaveBeenCalled();
    expect(h.dependencies.getApiKey).not.toHaveBeenCalled();
    expect(h.dependencies.createStore).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  test("budget is spent only on misses even with hits after deferred items", async () => {
    const h = harness(capture(4));
    await h.seed(0);
    await h.seed(3);
    const result = await runSemanticEvaluation(
      h.input,
      { ...options, maxCalls: 1 },
      h.dependencies,
    );
    expect(result.totals).toMatchObject({
      cacheHits: 2,
      evaluated: 1,
      deferred: 1,
      reportedCostUsd: 0.125,
      cachedHistoricalCostUsd: 0.25,
    });
    expect(result.items[2].reasonCodes).toContain("max-calls-reached");
    expect(result.items[3].provenance?.cacheHit).toBe(true);
  });

  test("STOP suppresses misses without suppressing later hits", async () => {
    const h = harness(capture(2));
    await h.seed(1);
    h.dependencies.isDisabled.mockReturnValue(true);
    const result = await runSemanticEvaluation(h.input, options, h.dependencies);
    expect(result.items[0].reasonCodes).toContain("inference-disabled");
    expect(result.totals).toMatchObject({ cacheHits: 1, deferred: 1, reportedCostUsd: 0 });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.begin).not.toHaveBeenCalled();
  });

  test("preview inspects every eligible candidate and reassigns budget without distributions or writes", async () => {
    const h = harness(capture(4));
    await h.seed(0);
    await h.seed(3);
    const result = await runSemanticPreview(h.input, { ...options, maxCalls: 1 }, h.dependencies);
    expect(result.execution).toEqual({
      dryRun: true,
      gatewayCalls: 0,
      localWrites: 0,
      cache: "read-only",
    });
    expect(result.totals).toMatchObject({
      eligible: 4,
      cacheHits: 2,
      plannedCalls: 1,
      deferred: 1,
    });
    expect(result.items.map((item) => item.plannedCall)).toEqual([false, true, false, false]);
    expect(h.read).toHaveBeenCalledTimes(6);
    expect(h.graphql).toHaveBeenCalledTimes(1);
    expect(h.dependencies.getApiKey).not.toHaveBeenCalled();
    expect(h.dependencies.createStore).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
    for (const item of result.items) {
      expect(item).not.toHaveProperty("answers");
      expect(item).not.toHaveProperty("provenance");
      expect(item).not.toHaveProperty("receipt");
    }
    expect(JSON.stringify(result)).not.toContain("probabilities");
    expect(result.items[0].reasonCodes).toContain("cache-hit");
    expect(result.items[0].reasonCodes).not.toContain("preview-only");
  });

  test("refresh reads cache before budgeting and rechecks it under the lease", async () => {
    const h = harness();
    const old = await h.seed();
    const preview = await runSemanticPreview(
      h.input,
      { ...options, refresh: true },
      h.dependencies,
    );
    expect(preview.items[0]).toMatchObject({
      cacheStatus: "refresh",
      plannedCall: true,
      cacheSourceRequestId: null,
    });
    const result = await runSemanticEvaluation(
      h.input,
      { ...options, refresh: true },
      h.dependencies,
    );
    expect(result.totals).toMatchObject({ evaluated: 1, cacheHits: 0 });
    expect(h.read.mock.calls.map(([, settings]) => settings?.refresh)).toEqual([true, true, true]);
    expect(h.read.mock.calls[2][1]?.ownedRequestId).toBe(
      result.items[0].receipt?.pending.requestId,
    );
    expect(result.items[0].receipt?.pending.requestId).not.toBe(old.requestId);
  });

  test("expired entries stay eligible for a fresh call and zero-budget previews never plan hits", async () => {
    const h = harness(capture(2));
    await h.seed(0);
    const preview = await runSemanticPreview(h.input, { ...options, maxCalls: 0 }, h.dependencies);
    expect(preview.totals).toMatchObject({ cacheHits: 1, plannedCalls: 0, deferred: 1 });
    h.read.mockResolvedValue({ status: "expired" });
    const result = await runSemanticEvaluation(
      h.input,
      { ...options, maxCalls: 1 },
      h.dependencies,
    );
    expect(result.items[0].cacheStatus).toBe("expired");
    expect(result.totals).toMatchObject({ evaluated: 1, cacheHits: 0, deferred: 1 });
    expect(h.write).toHaveBeenCalledTimes(1);
  });

  test("disabled cache bypasses factory and disk ledger, retaining memory receipts", async () => {
    const h = harness();
    h.dependencies.createCache.mockImplementation(() => {
      throw new Error("Cache must not be created");
    });
    h.dependencies.createStore.mockImplementation(() => {
      throw new Error("Ledger must not be created");
    });
    const disabled = { ...options, noSnapshot: true };
    const preview = await runSemanticPreview(h.input, disabled, h.dependencies);
    expect(preview.execution.cache).toBe("disabled");
    expect(preview.items[0]).toMatchObject({ cacheStatus: "disabled", plannedCall: true });
    expect(h.graphql).not.toHaveBeenCalled();
    const result = await runSemanticEvaluation(h.input, disabled, h.dependencies);
    expect(result.execution).toMatchObject({
      cache: "disabled",
      cacheEntriesWritten: 0,
      receipts: "memory-only",
      receiptRecordsWritten: 0,
    });
    expect(result.items[0].receipt?.pending.durable).toBe(false);
    expect(result.items[0].receipt?.final?.result.status).toBe("succeeded");
    expect(h.dependencies.createCache).not.toHaveBeenCalled();
    expect(h.dependencies.createStore).not.toHaveBeenCalled();
  });

  test.each([
    "state",
    "updatedAt",
    "id",
    "partial",
  ])("warm %s guard rejects stale answers", async (change) => {
    const h = harness();
    await h.seed();
    h.graphql.mockResolvedValue({
      data: {
        repository: {
          nameWithOwner: "o/r",
          visibility: "PUBLIC",
          isPrivate: false,
          i0: {
            __typename: "Issue",
            title: "Reported behavior",
            comments: connection([], 0),
            number: 1,
            id: change === "id" ? "OTHER" : "I_1",
            state: change === "state" ? "CLOSED" : "OPEN",
            updatedAt: change === "updatedAt" ? "2026-09-21T13:00:00.000Z" : TIME,
          },
        },
      },
      ...(change === "partial" ? { errors: [{ message: "untrusted source path" }] } : {}),
    });
    const preview = await runSemanticPreview(h.input, options, h.dependencies);
    expect(preview.totals.cacheHits).toBe(0);
    expect(preview.items[0].plannedCall).toBe(false);
    expect(preview.items[0].outcome).toBe("skipped");
    expect(preview.coverageComplete).toBe(false);
    const result = await runSemanticEvaluation(h.input, options, h.dependencies);
    expect(result.coverageComplete).toBe(false);
    expect(result.totals.cacheHits).toBe(0);
    expect(result.items[0]).toMatchObject({
      outcome: "skipped",
      answers: null,
      provenance: null,
      cacheSourceRequestId: null,
    });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.begin).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("untrusted source path");
  });

  test("private loss stops reuse for the whole batch", async () => {
    const h = harness(capture(2));
    await h.seed(0);
    await h.seed(1);
    h.graphql.mockResolvedValue({
      data: { repository: { nameWithOwner: "o/r", visibility: "PRIVATE", isPrivate: true } },
    });
    const result = await runSemanticEvaluation(h.input, options, h.dependencies);
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(result.items.map((item) => item.answers)).toEqual([null, null]);
    expect(result.items[1].reasonCodes).toContain("repository-not-public");
    expect(result.coverageComplete).toBe(false);
  });

  test("global abort prevents warm reuse including abort during revalidation", async () => {
    const h = harness(capture(2));
    await h.seed(0);
    await h.seed(1);
    const controller = new AbortController();
    const original = h.graphql.getMockImplementation();
    h.graphql.mockImplementation(async (...args) => {
      const response = await original?.(...args);
      controller.abort();
      return response;
    });
    const result = await runSemanticEvaluation(h.input, options, {
      ...h.dependencies,
      signal: controller.signal,
    });
    expect(result.totals).toMatchObject({ cacheHits: 0, deferred: 2 });
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(result.items.every((item) => item.answers === null)).toBe(true);
  });

  test("policy version changes reuse full cached non-bug impact without another call", async () => {
    const h = harness();
    h.fetch.mockImplementation(async (_url, init) =>
      Response.json(rawEvaluation(JSON.parse(String(init?.body)), 0.125, "feature")),
    );
    const cold = await runSemanticEvaluation(h.input, options, h.dependencies);
    expect(cold.items[0].answers).not.toHaveProperty("impactReported");
    expect([...h.entries.values()][0].evaluation.answers).toHaveProperty("impactReported");
    const decide = vi.fn((evaluation) => ({
      outcome: "needs-review" as const,
      reasonCodes: ["new-policy"],
      answers: evaluation.answers,
      impactReportedStatus: "applicable" as const,
    }));
    const hot = await runSemanticEvaluation(h.input, options, {
      ...h.dependencies,
      policy: { version: "trusted-next", decide },
    });
    expect(hot.policyVersion).toBe("trusted-next");
    expect(hot.items[0].inputHash).toBe(cold.items[0].inputHash);
    expect(hot.items[0].answers).toHaveProperty("impactReported");
    expect(hot.items[0].reasonCodes).toContain("new-policy");
    expect(decide).toHaveBeenCalledTimes(1);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  test("miss-to-hit race reuses prior receipt under own new lease and finalizes not-sent", async () => {
    const h = harness();
    const prior = await h.seed();
    h.read.mockResolvedValueOnce({ status: "miss" });
    const result = await runSemanticEvaluation(h.input, options, h.dependencies);
    expect(result.items[0]).toMatchObject({
      cacheSourceRequestId: prior.requestId,
      provenance: { cacheHit: true },
      receipt: {
        final: {
          result: {
            status: "not-sent",
            errorCode: "cache-race-hit",
            reportedCostUsd: null,
            outcomeUnknown: false,
          },
        },
      },
    });
    expect(result.items[0].receipt?.pending.requestId).not.toBe(prior.requestId);
    expect(h.read.mock.calls[1][1]?.ownedRequestId).toBe(
      result.items[0].receipt?.pending.requestId,
    );
    expect(result.totals).toMatchObject({
      evaluated: 0,
      cacheHits: 1,
      reportedCostUsd: 0,
      hasUnknownCost: false,
      cachedHistoricalCostUsd: 0.125,
    });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
    expect(h.finish).toHaveBeenCalledTimes(1);
    expect(h.graphql).toHaveBeenCalledTimes(2);
    expect(h.locks.size).toBe(0);
  });

  test("race hit still requires the fresh guard before reuse", async () => {
    const h = harness();
    await h.seed();
    h.read.mockResolvedValueOnce({ status: "miss" });
    const original = h.graphql.getMockImplementation();
    if (!original) throw new Error("Missing metadata mock");
    h.graphql.mockImplementationOnce((...args) => original(...args));
    h.graphql.mockResolvedValueOnce({
      data: {
        repository: {
          nameWithOwner: "o/r",
          visibility: "PUBLIC",
          isPrivate: false,
          i0: {
            __typename: "Issue",
            id: "I_1",
            number: 1,
            title: "Reported behavior",
            comments: connection([], 0),
            state: "CLOSED",
            updatedAt: TIME,
          },
        },
      },
    });
    const result = await runSemanticEvaluation(h.input, options, h.dependencies);
    expect(result.totals.cacheHits).toBe(0);
    expect(result.items[0]).toMatchObject({
      outcome: "skipped",
      answers: null,
      receipt: { final: { result: { status: "not-sent", errorCode: "state-changed" } } },
    });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  test.each([
    false,
    true,
  ])("blocked and invalid cache fail closed even refresh=%s with safe reasons", async (refresh) => {
    const h = harness(capture(3));
    h.read.mockRejectedValueOnce(
      new SemanticError("in-flight-or-unknown", "/secret/path", "secret"),
    );
    h.read.mockRejectedValueOnce(new Error("/secret/path"));
    h.read.mockResolvedValueOnce({ status: "expired" });
    const preview = await runSemanticPreview(
      h.input,
      { ...options, maxCalls: 1, refresh },
      h.dependencies,
    );
    expect(preview.items.map((item) => item.cacheStatus)).toEqual([
      "blocked",
      "invalid",
      "expired",
    ]);
    expect(preview.items.map((item) => item.plannedCall)).toEqual([false, false, true]);
    expect(preview.totals).toMatchObject({ failed: 2, plannedCalls: 1 });
    expect(JSON.stringify(preview)).not.toContain("/secret/path");
    h.read.mockRejectedValueOnce(
      new SemanticError("in-flight-or-unknown", "/secret/path", "secret"),
    );
    h.read.mockRejectedValueOnce(new Error("/secret/path"));
    const result = await runSemanticEvaluation(
      h.input,
      { ...options, maxCalls: 0, refresh },
      h.dependencies,
    );
    expect(result.totals).toMatchObject({ failed: 2, deferred: 1 });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.begin).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("/secret/path");
  });

  test("write failure retains lock and pending without finalization, stops batch and retains known cost", async () => {
    const h = harness(capture(2));
    h.write.mockRejectedValue(new Error("/secret/cache/path"));
    const result = await runSemanticEvaluation(h.input, options, h.dependencies);
    expect(result.items[0]).toMatchObject({
      outcome: "failed",
      answers: null,
      receipt: { final: null },
    });
    expect(result.items[0].reasonCodes).toContain("cache-write-failed");
    expect(result.items[1].reasonCodes).toContain("cache-write-failed");
    expect(result.totals).toMatchObject({
      evaluated: 1,
      reportedCostUsd: 0.125,
      hasUnknownCost: false,
      failed: 1,
      skipped: 1,
    });
    expect(result.execution).toMatchObject({
      gatewayCalls: 1,
      receiptRecordsWritten: 1,
      cacheEntriesWritten: 0,
    });
    expect(h.finish).not.toHaveBeenCalled();
    expect(h.locks.size).toBe(1);
    expect(h.read).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(result)).not.toContain("/secret/cache/path");
  });

  test("non-durable injected ledger cannot publish cache or finalize a paid response", async () => {
    const h = harness();
    const original = h.begin.getMockImplementation();
    if (!original) throw new Error("Missing ledger mock");
    h.begin.mockImplementation(async (value) => ({ ...(await original(value)), durable: false }));
    const result = await runSemanticEvaluation(h.input, options, h.dependencies);
    expect(result.items[0].reasonCodes).toContain("cache-write-failed");
    expect(h.write).not.toHaveBeenCalled();
    expect(h.finish).not.toHaveBeenCalled();
    expect(result.totals.reportedCostUsd).toBe(0.125);
  });

  test("post-response guard failure preserves validated cache and known cost without stale answers", async () => {
    const h = harness();
    const original = h.graphql.getMockImplementation();
    if (!original) throw new Error("Missing metadata mock");
    h.graphql.mockImplementationOnce((...args) => original(...args));
    h.graphql.mockImplementationOnce((...args) => original(...args));
    h.graphql.mockRejectedValueOnce(new Error("/secret/metadata"));
    const result = await runSemanticEvaluation(h.input, options, h.dependencies);
    expect(result.coverageComplete).toBe(false);
    expect(result.items[0]).toMatchObject({
      outcome: "failed",
      answers: null,
      receipt: { final: { result: { status: "succeeded", reportedCostUsd: 0.125 } } },
    });
    expect(result.totals).toMatchObject({
      evaluated: 1,
      reportedCostUsd: 0.125,
      hasUnknownCost: false,
    });
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(h.finish).toHaveBeenCalledTimes(1);
    expect(h.events.indexOf("write")).toBeLessThan(h.events.indexOf("finish"));
    const hot = await runSemanticEvaluation(h.input, options, h.dependencies);
    expect(hot.totals.cacheHits).toBe(1);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  test("failed finalization leaves the cache uncommitted and blocks the next run", async () => {
    const h = harness();
    h.finish.mockRejectedValue(new SemanticError("receipt-write-failed", "secret", "secret"));
    const first = await runSemanticEvaluation(h.input, options, h.dependencies);
    expect(first.items[0]).toMatchObject({
      outcome: "failed",
      answers: null,
      receipt: { final: null },
    });
    expect(first.execution.cacheEntriesWritten).toBe(1);
    const next = await runSemanticEvaluation(h.input, options, h.dependencies);
    expect(next.items[0]).toMatchObject({
      outcome: "failed",
      cacheStatus: "blocked",
      answers: null,
    });
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.locks.size).toBe(1);
  });

  test.each([
    "invalid",
    "network",
    "rejected",
  ])("%s provider response never writes cache and preserves outcome-unknown semantics", async (kind) => {
    const h = harness();
    h.fetch.mockImplementation(async () => {
      if (kind === "network") throw new Error("transport secret");
      return kind === "rejected"
        ? new Response("private", { status: 422 })
        : Response.json({ answers: {} });
    });
    const result = await runSemanticEvaluation(h.input, options, h.dependencies);
    expect(result.totals).toMatchObject({ evaluated: 0, cacheHits: 0, hasUnknownCost: true });
    expect(result.items[0].receipt?.final?.result).toMatchObject({
      status: "failed",
      outcomeUnknown: kind !== "rejected",
    });
    expect(h.write).not.toHaveBeenCalled();
  });

  test("epoch change misses without changing trusted policy cache identity", async () => {
    const h = harness();
    await h.seed();
    const result = await runSemanticEvaluation(
      h.input,
      { ...options, cacheEpoch: "next" },
      h.dependencies,
    );
    expect(result.cacheEpoch).toBe("next");
    expect(result.totals).toMatchObject({ evaluated: 1, cacheHits: 0 });
    const context = h.write.mock.calls[0][0];
    expect(context.inputHash).toBe(
      await fingerprintEvaluation(context.request, context.taxonomy, JEV_ADAPTER_VERSION, "next"),
    );
  });

  test.each([
    { maxCalls: 0, noSnapshot: false, aborted: false },
    { maxCalls: 1, noSnapshot: true, aborted: false },
    { maxCalls: 1, noSnapshot: false, aborted: true },
  ])("oversized ready items are deferred exactly once with %j", async (settings) => {
    const h = harness(capture(4));
    for (const item of h.input.items) item.body = "x".repeat(30_000);
    h.input.items[2].status = "failed";
    h.input.items[3].status = "excluded";
    const controller = new AbortController();
    if (settings.aborted) controller.abort();
    const selected = { ...options, maxCalls: settings.maxCalls, noSnapshot: settings.noSnapshot };
    const result = await runSemanticEvaluation(h.input, selected, {
      ...h.dependencies,
      signal: controller.signal,
    });
    expect(result.totals).toMatchObject({
      oversized: 2,
      deferred: 2,
      needsReview: 2,
      evaluated: 0,
      cacheHits: 0,
      reportedCostUsd: 0,
      hasUnknownCost: false,
    });
    expect(result.execution).toMatchObject({
      gatewayCalls: 0,
      receiptRecordsWritten: 0,
      cacheEntriesWritten: 0,
    });
    for (const item of result.items.slice(0, 2)) {
      expect(item).toMatchObject({
        outcome: "needs-review",
        reviewRequired: true,
        answers: null,
        receipt: null,
      });
      expect(item.reasonCodes).toContain("input-too-large");
      expect(item.reasonCodes).not.toContain("max-calls-reached");
      expect(item.reasonCodes).not.toContain("run-aborted");
    }
    const preview = await runSemanticPreview(h.input, selected, h.dependencies);
    expect(preview.totals).toMatchObject({ oversized: 2, deferred: 0, plannedCalls: 0 });
    expect(h.dependencies.getApiKey).not.toHaveBeenCalled();
    expect(h.dependencies.createCache).not.toHaveBeenCalled();
    expect(h.dependencies.createStore).not.toHaveBeenCalled();
    expect(h.read).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
    expect(h.begin).not.toHaveBeenCalled();
    expect(h.finish).not.toHaveBeenCalled();
    expect(h.graphql).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  test("oversized and non-ready evidence never reaches cache", async () => {
    const h = harness(capture(3));
    h.input.items[0].body = "x".repeat(30_000);
    h.input.items[1].status = "excluded";
    h.input.items[2].status = "failed";
    const preview = await runSemanticPreview(h.input, options, h.dependencies);
    const result = await runSemanticEvaluation(h.input, options, h.dependencies);
    expect(preview.totals).toMatchObject({ eligible: 0, plannedCalls: 0, oversized: 1 });
    expect(result.execution.gatewayCalls).toBe(0);
    expect(result.totals).toMatchObject({ oversized: 1, deferred: 1, needsReview: 1 });
    expect(result.items[0]).toMatchObject({ reviewRequired: true, outcome: "needs-review" });
    expect(preview.totals.deferred).toBe(0);
    expect(h.dependencies.createCache).not.toHaveBeenCalled();
    expect(h.dependencies.getApiKey).not.toHaveBeenCalled();
    expect(h.dependencies.createStore).not.toHaveBeenCalled();
    expect(h.graphql).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.read).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
    expect(h.begin).not.toHaveBeenCalled();
    expect(h.finish).not.toHaveBeenCalled();
  });

  test("real pending lease survives cache-write failure and blocks the next invocation", async () => {
    const home = await mkdtemp(join(tmpdir(), "semantic-reuse-write-failure-"));
    homes.push(home);
    const h = harness();
    const cache = createSemanticCacheStore({ home, now: () => TIME });
    const ledger = createSemanticReceiptStore({ home, now: () => TIME });
    const failingCache: SemanticCacheStore = {
      read: cache.read,
      write: async () => {
        throw new Error("private cache path");
      },
    };
    const dependencies = {
      ...h.dependencies,
      createCache: () => failingCache,
      createStore: () => ledger,
    };
    const first = await runSemanticEvaluation(h.input, options, dependencies);
    const pending = first.items[0].receipt?.pending;
    if (!pending) throw new Error("Missing durable pending receipt");
    expect(first.items[0]).toMatchObject({
      outcome: "failed",
      answers: null,
      receipt: { final: null },
    });
    expect(
      JSON.parse(
        await readFile(join(home, "classify", "locks", `${pending.inputHash}.json`), "utf8"),
      ),
    ).toEqual(pending);
    await expect(
      readFile(
        join(
          home,
          "classify",
          "receipts",
          TIME.slice(0, 10),
          pending.requestId,
          "final",
          "receipt.json",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const next = await runSemanticEvaluation(h.input, options, dependencies);
    expect(next.items[0]).toMatchObject({
      outcome: "failed",
      cacheStatus: "blocked",
      answers: null,
    });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  test.each([
    0.99, 1.01,
  ])("rounded distribution mass %s survives durable cold/hot replay without a key", async (mass) => {
    const home = await mkdtemp(join(tmpdir(), "semantic-rounded-reuse-"));
    homes.push(home);
    const h = harness();
    const probabilities =
      mass < 1
        ? { "0": 0, "1": 0.05, "2": 0.66, "3": 0.28 }
        : { "0": 0, "1": 0.06, "2": 0.67, "3": 0.28 };
    h.fetch.mockImplementation(async (_url, init) => {
      const raw = rawEvaluation(JSON.parse(String(init?.body)));
      raw.answers.impactReported = { type: "score", score: 2.23, probabilities };
      return Response.json(raw);
    });
    const cache = createSemanticCacheStore({ home, now: () => TIME });
    const ledger = createSemanticReceiptStore({ home, now: () => TIME });
    const dependencies = { ...h.dependencies, createCache: () => cache, createStore: () => ledger };
    const cold = await runSemanticEvaluation(h.input, options, dependencies);
    expect(cold.totals).toMatchObject({ evaluated: 1, needsReview: 1, failed: 0, cacheHits: 0 });
    expect(cold.items[0].reasonCodes).toContain("impactReported-distribution-rounded");
    expect(cold.items[0].answers?.impactReported).toMatchObject({ probabilities });
    const getApiKey = vi.fn((): string => {
      throw new Error("Key must not be read");
    });
    const warm = await runSemanticEvaluation(
      h.input,
      { ...options, maxCalls: 0 },
      {
        ...dependencies,
        getApiKey,
        fetch: forbiddenNetwork,
      },
    );
    expect(warm.policyVersion).toBe(SEMANTIC_POLICY_VERSION);
    expect(warm.totals).toMatchObject({
      evaluated: 0,
      cacheHits: 1,
      needsReview: 1,
      failed: 0,
      reportedCostUsd: 0,
    });
    expect(warm.execution).toMatchObject({ gatewayCalls: 0, receiptRecordsWritten: 0 });
    expect(warm.items[0].answers).toEqual(cold.items[0].answers);
    expect(() => assertWarmReuse(cold.items[0], warm.items[0])).not.toThrow();
    const missingCacheMarker = structuredClone(warm.items[0]);
    missingCacheMarker.reasonCodes = missingCacheMarker.reasonCodes.filter(
      (reason) => reason !== "cache-hit",
    );
    expect(() => assertWarmReuse(cold.items[0], missingCacheMarker)).toThrow();
    const changedPolicyReason = structuredClone(warm.items[0]);
    changedPolicyReason.reasonCodes.push("unexpected-policy-change");
    expect(() => assertWarmReuse(cold.items[0], changedPolicyReason)).toThrow();
    expect(warm.items[0].reasonCodes).toContain("impactReported-distribution-rounded");
    expect(warm.items[0].cacheSourceRequestId).toBe(cold.items[0].receipt?.pending.requestId);
    expect(getApiKey).not.toHaveBeenCalled();
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  test("real cache and receipts support cold/hot and owned-lease race reuse in an owned temp home", async () => {
    const home = await mkdtemp(join(tmpdir(), "semantic-reuse-owned-"));
    homes.push(home);
    const h = harness();
    const cache = createSemanticCacheStore({ home, now: () => TIME });
    const ledger = createSemanticReceiptStore({ home, now: () => TIME });
    const dependencies = { ...h.dependencies, createCache: () => cache, createStore: () => ledger };
    const cold = await runSemanticEvaluation(h.input, options, dependencies);
    expect(cold.totals).toMatchObject({ evaluated: 1, failed: 0 });
    const hot = await runSemanticEvaluation(h.input, { ...options, maxCalls: 0 }, dependencies);
    expect(hot.totals).toMatchObject({ cacheHits: 1, failed: 0, reportedCostUsd: 0 });
    let first = true;
    const raceCache: SemanticCacheStore = {
      read: async (context, settings) => {
        if (first) {
          first = false;
          return { status: "miss" };
        }
        return cache.read(context, settings);
      },
      write: cache.write,
    };
    const race = await runSemanticEvaluation(h.input, options, {
      ...dependencies,
      createCache: () => raceCache,
    });
    expect(race.totals).toMatchObject({ cacheHits: 1, failed: 0 });
    expect(race.items[0].receipt?.final?.result.errorCode).toBe("cache-race-hit");
    expect(race.items[0].cacheSourceRequestId).toBe(cold.items[0].receipt?.pending.requestId);
    const final = race.items[0].receipt?.final;
    expect(final).not.toBeNull();
    if (!final) throw new Error("Missing final receipt");
    expect(
      JSON.parse(
        await readFile(
          join(
            home,
            "classify",
            "receipts",
            TIME.slice(0, 10),
            final.requestId,
            "final",
            "receipt.json",
          ),
          "utf8",
        ),
      ),
    ).toEqual(final);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
});

function virtualClock(start = Date.parse(TIME)) {
  let time = start;
  const sleep = vi.fn(async (delay: number, _signal: AbortSignal) => {
    time += delay;
  });
  return { now: () => time, sleep };
}

function throttle(retryAfter = "1") {
  return Response.json(
    { error: { code: "RATE_LIMIT", message: "Slow down" } },
    {
      status: 429,
      headers: { "retry-after": retryAfter },
    },
  );
}

describe("bounded semantic run scheduling", () => {
  test.each([
    1, 2, 3, 4,
  ])("concurrency %i bounds in-flight requests, budget and stable issue order", async (concurrency) => {
    const h = harness(capture(7));
    const pending: Array<{ key: string; finish: () => void }> = [];
    let active = 0;
    let peak = 0;
    h.fetch.mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as GatewayEvaluationRequest;
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) =>
        pending.push({ key: request.state.issue.key, finish: resolve }),
      );
      active--;
      return Response.json(rawEvaluation(request));
    });
    const running = runSemanticEvaluation(
      h.input,
      { ...options, concurrency, maxCalls: 5 },
      h.dependencies,
    );
    let completed = 0;
    while (completed < 5) {
      const expected = Math.min(concurrency, 5 - completed);
      await vi.waitFor(() => expect(pending.length).toBe(completed + expected));
      for (const call of pending.slice(completed).reverse()) call.finish();
      completed += expected;
    }
    const result = await running;
    expect(peak).toBe(concurrency);
    expect(active).toBe(0);
    expect(result.execution.gatewayCalls).toBe(5);
    expect(result.items.map((item) => item.key)).toEqual(h.input.items.map((item) => item.key));
    expect(result.totals).toMatchObject({ evaluated: 5, deferred: 2, failed: 0 });
    expect(h.begin).toHaveBeenCalledTimes(5);
    expect(
      new Set(
        result.items.flatMap(
          (item) => item.attempts?.map((attempt) => attempt.receipt.pending.requestId) ?? [],
        ),
      ).size,
    ).toBe(5);
  });

  test.each([
    0, 1, 2, 3,
  ])("maxRetries %i bounds known 429 attempts and keeps every unknown cost", async (maxRetries) => {
    const h = harness(capture(2));
    const clock = virtualClock();
    h.fetch.mockImplementation(async () => throttle());
    const result = await runSemanticEvaluation(
      h.input,
      { ...options, maxRetries, maxCalls: 20 },
      {
        ...h.dependencies,
        wait: clock,
        nowMs: clock.now,
      },
    );
    const attempts = result.items[0].attempts ?? [];
    expect(attempts).toHaveLength(1 + maxRetries);
    expect(new Set(attempts.map((attempt) => attempt.receipt.pending.requestId)).size).toBe(
      1 + maxRetries,
    );
    expect(attempts.every((attempt) => attempt.receipt.final?.result.status === "failed")).toBe(
      true,
    );
    expect(
      attempts.every((attempt) => attempt.receipt.final?.result.outcomeUnknown === false),
    ).toBe(true);
    expect(result.totals).toMatchObject({ evaluated: 0, reportedCostUsd: 0, hasUnknownCost: true });
    if (maxRetries === 0) {
      expect(h.fetch).toHaveBeenCalledTimes(1);
      expect(result.items[1].reasonCodes).toContain("provider-unavailable");
      expect(clock.sleep).not.toHaveBeenCalled();
    }
  });

  test("retries consume the same global budget under concurrency", async () => {
    const h = harness(capture(8));
    const clock = virtualClock();
    h.fetch.mockImplementation(async () => throttle());
    const result = await runSemanticEvaluation(
      h.input,
      { ...options, concurrency: 4, maxRetries: 3, maxCalls: 5 },
      {
        ...h.dependencies,
        wait: clock,
        nowMs: clock.now,
      },
    );
    expect(h.fetch).toHaveBeenCalledTimes(5);
    expect(result.execution.gatewayCalls).toBe(5);
    expect(h.begin).toHaveBeenCalledTimes(5);
    expect(h.finish).toHaveBeenCalledTimes(5);
    expect(result.totals.evaluated).toBe(0);
    expect(
      result.items.flatMap((item) => item.attempts ?? []).filter((attempt) => attempt.attempted),
    ).toHaveLength(5);
  });

  test("real durable 429 retry retains distinct correlated receipts, timing and unknown cost after success", async () => {
    const home = await mkdtemp(join(tmpdir(), "semantic-retry-durable-"));
    homes.push(home);
    const h = harness();
    const clock = virtualClock();
    const store = createSemanticReceiptStore({ home, now: () => TIME });
    const cache = createSemanticCacheStore({ home, now: () => TIME });
    const sent: string[] = [];
    h.fetch.mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as GatewayEvaluationRequest;
      const context = await fingerprintEvaluation(
        request,
        null,
        JEV_ADAPTER_VERSION,
        SEMANTIC_CACHE_EPOCH,
      );
      const lock = JSON.parse(
        await readFile(join(home, "classify", "locks", `${context}.json`), "utf8"),
      ) as SemanticPendingReceipt;
      sent.push(lock.requestId);
      expect(lock.phase).toBe("pending");
      expect(
        JSON.parse(
          await readFile(
            join(
              home,
              "classify",
              "receipts",
              TIME.slice(0, 10),
              lock.requestId,
              "pending",
              "receipt.json",
            ),
            "utf8",
          ),
        ),
      ).toEqual(lock);
      return sent.length === 1 ? throttle("2") : Response.json(rawEvaluation(request));
    });
    const result = await runSemanticEvaluation(
      h.input,
      { ...options, maxRetries: 1, maxCalls: 2 },
      {
        ...h.dependencies,
        createStore: () => store,
        createCache: () => cache,
        wait: clock,
        nowMs: clock.now,
      },
    );
    const attempts = result.items[0].attempts ?? [];
    expect(attempts).toHaveLength(2);
    expect(new Set(sent).size).toBe(2);
    expect(attempts.map((attempt) => attempt.receipt.pending.requestId)).toEqual(sent);
    expect(attempts.map((attempt) => attempt.receipt.final?.result.status)).toEqual([
      "failed",
      "succeeded",
    ]);
    expect(result.items[0].receipt).toEqual(attempts[1].receipt);
    expect(result.items[0].providerError).toBeNull();
    expect(attempts[0].providerError).toMatchObject({
      status: 429,
      diagnostic: { trust: "untrusted", code: "RATE_LIMIT" },
    });
    expect(attempts.every((attempt) => typeof attempt.gatewayTiming?.totalMs === "number")).toBe(
      true,
    );
    expect(clock.now() - Date.parse(TIME)).toBe(2000);
    expect(result.totals).toMatchObject({
      evaluated: 1,
      failed: 0,
      reportedCostUsd: 0.125,
      hasUnknownCost: true,
    });
    expect(result.execution).toMatchObject({
      gatewayCalls: 2,
      receiptRecordsWritten: 4,
      cacheEntriesWritten: 1,
    });
    for (const attempt of attempts) {
      const persisted = JSON.parse(
        await readFile(
          join(
            home,
            "classify",
            "receipts",
            TIME.slice(0, 10),
            attempt.receipt.pending.requestId,
            "final",
            "receipt.json",
          ),
          "utf8",
        ),
      );
      expect(persisted).toEqual(attempt.receipt.final);
      expect(JSON.stringify(persisted)).not.toContain("diagnostic");
    }
  });

  test("shared cooldown delays other workers while honest in-flight success survives", async () => {
    const h = harness(capture(3));
    let time = Date.parse(TIME);
    let releaseFirst: () => void = () => {};
    let releaseSecond: () => void = () => {};
    let releaseWait: () => void = () => {};
    const sent: Array<{ key: string; time: number }> = [];
    const sleep = vi.fn(async (delay: number) => {
      await new Promise<void>((resolve) => {
        releaseWait = resolve;
      });
      time += delay;
    });
    h.fetch.mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as GatewayEvaluationRequest;
      sent.push({ key: request.state.issue.key, time });
      if (sent.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        return throttle("5");
      }
      if (sent.length === 2)
        await new Promise<void>((resolve) => {
          releaseSecond = resolve;
        });
      return Response.json(rawEvaluation(request));
    });
    const running = runSemanticEvaluation(
      h.input,
      { ...options, concurrency: 2, maxRetries: 1 },
      {
        ...h.dependencies,
        nowMs: () => time,
        wait: { now: () => time, sleep },
      },
    );
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    releaseFirst();
    await vi.waitFor(() => expect(sleep).toHaveBeenCalled());
    releaseSecond();
    await vi.waitFor(() => expect(h.finish).toHaveBeenCalledTimes(2));
    expect(sent).toHaveLength(2);
    time += 5000;
    releaseWait();
    const result = await running;
    expect(sent.slice(2).every((call) => call.time >= Date.parse(TIME) + 5000)).toBe(true);
    expect(result.totals).toMatchObject({ evaluated: 3, failed: 0, hasUnknownCost: true });
    expect(result.items[1].attempts).toHaveLength(1);
  });

  test.each([
    "stop",
    "abort",
  ])("%s interrupts cooldown before new pending, key or dispatch", async (mode) => {
    const h = harness(capture(2));
    const controller = new AbortController();
    const clock = virtualClock();
    h.fetch.mockImplementation(async () => throttle("30"));
    clock.sleep.mockImplementation(async () => {
      if (mode === "stop") h.dependencies.isDisabled.mockReturnValue(true);
      else controller.abort();
    });
    const result = await runSemanticEvaluation(
      h.input,
      { ...options, maxRetries: 3 },
      {
        ...h.dependencies,
        signal: controller.signal,
        wait: clock,
        nowMs: clock.now,
      },
    );
    expect(result.execution.gatewayCalls).toBe(1);
    expect(h.begin).toHaveBeenCalledTimes(1);
    expect(h.finish).toHaveBeenCalledTimes(1);
    expect(result.items[0].attempts?.[0].receipt.final?.result.status).toBe("failed");
    expect(result.items[0].reasonCodes).toContain(
      mode === "stop" ? "inference-disabled" : "run-aborted",
    );
    expect(h.dependencies.getApiKey).toHaveBeenCalledTimes(1);
  });

  test("abort races a sleep dependency that never settles", async () => {
    const h = harness();
    const controller = new AbortController();
    const sleep = vi.fn(async () => {
      queueMicrotask(() => controller.abort());
      await new Promise<void>(() => {});
    });
    h.fetch.mockImplementation(async () => throttle());
    const result = await runSemanticEvaluation(
      h.input,
      { ...options, maxRetries: 1 },
      {
        ...h.dependencies,
        signal: controller.signal,
        wait: { sleep },
      },
    );
    expect(result.execution.gatewayCalls).toBe(1);
    expect(h.begin).toHaveBeenCalledTimes(1);
    expect(result.items[0].reasonCodes).toContain("run-aborted");
  });

  test.each([
    "date",
    "too-long",
    "infinite",
  ])("Retry-After %s is honored or refused, never shortened or serialized nonfinite", async (mode) => {
    const h = harness(capture(2));
    const clock = virtualClock();
    const hint =
      mode === "date"
        ? new Date(clock.now() + 4000).toUTCString()
        : mode === "too-long"
          ? "31"
          : "9".repeat(1025);
    h.fetch.mockImplementation(async (_url, init) =>
      h.fetch.mock.calls.length === 1
        ? throttle(hint)
        : Response.json(rawEvaluation(JSON.parse(String(init?.body)))),
    );
    const result = await runSemanticEvaluation(
      h.input,
      { ...options, maxRetries: 1 },
      {
        ...h.dependencies,
        wait: clock,
        nowMs: clock.now,
      },
    );
    if (mode === "date") {
      expect(result.execution.gatewayCalls).toBe(3);
      expect(clock.now()).toBe(Date.parse(TIME) + 4000);
      expect(result.totals.evaluated).toBe(2);
    } else {
      expect(result.execution.gatewayCalls).toBe(1);
      expect(clock.sleep).not.toHaveBeenCalled();
      expect(result.items[0].providerError).toMatchObject({
        retryRefusalReason: "retry-wait-exceeds-limit",
      });
      expect(result.items[1].reasonCodes).toContain("provider-unavailable");
      if (mode === "infinite") expect(result.items[0].providerError?.retryAfterSeconds).toBeNull();
    }
    const serialized = JSON.stringify(result, (_key, value) => {
      if (typeof value === "number") expect(Number.isFinite(value)).toBe(true);
      return value;
    });
    expect(serialized).not.toContain("Infinity");
  });

  test.each([
    "network",
    "json",
    "validation",
    "timeout",
    "abort",
  ])("%s outcomes never retry with maxRetries=3", async (mode) => {
    const h = harness();
    const controller = new AbortController();
    const clock = virtualClock();
    h.fetch.mockImplementation(async () => {
      if (mode === "network") throw new Error("untrusted transport detail");
      if (mode === "json") return new Response("{invalid");
      if (mode === "validation") return Response.json({ answers: {} });
      if (mode === "abort") queueMicrotask(() => controller.abort());
      return new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(new TextEncoder().encode("{"));
          },
        }),
      );
    });
    const result = await runSemanticEvaluation(
      h.input,
      { ...options, maxRetries: 3 },
      {
        ...h.dependencies,
        signal: controller.signal,
        timeoutMs: 10,
        wait: clock,
      },
    );
    expect(result.execution.gatewayCalls).toBe(1);
    expect(result.items[0].attempts).toHaveLength(1);
    expect(result.items[0].receipt?.final?.result).toMatchObject({
      status: "failed",
      outcomeUnknown: true,
    });
    expect(result.totals.hasUnknownCost).toBe(true);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  test("pacing stays outside provider timeout and refreshes evidence after a queued wait", async () => {
    const h = harness(capture(3));
    const clock = virtualClock();
    const sent: number[] = [];
    h.fetch.mockImplementation(async (_url, init) => {
      sent.push(clock.now());
      return Response.json(rawEvaluation(JSON.parse(String(init?.body))));
    });
    const original = h.graphql.getMockImplementation();
    h.graphql.mockImplementation(async (...args) => {
      const response = await original?.(...args);
      if (clock.now() >= Date.parse(TIME) + 60000) {
        const repository = (response as { data: { repository: Record<string, unknown> } }).data
          .repository;
        for (const node of Object.values(repository)) {
          if (typeof node === "object" && node && "number" in node && node.number === 2)
            Object.assign(node, { updatedAt: "2026-09-22T00:00:00Z" });
        }
      }
      return response;
    });
    const result = await runSemanticEvaluation(
      h.input,
      { ...options, concurrency: 3, minIntervalMs: 60000 },
      {
        ...h.dependencies,
        wait: clock,
        timeoutMs: 10,
      },
    );
    expect(result.execution.gatewayCalls).toBe(2);
    expect(sent[1] - sent[0]).toBeGreaterThanOrEqual(60000);
    expect(result.items[1].reasonCodes).toContain("needs-refresh");
    expect(result.items[1].attempts?.every((attempt) => !attempt.attempted) ?? true).toBe(true);
    expect(result.totals.evaluated).toBe(2);
  });

  test("provider diagnostics are mapped to attempts, bounded and redacted", async () => {
    const h = harness();
    const clock = virtualClock();
    h.fetch.mockImplementationOnce(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as GatewayEvaluationRequest;
      return Response.json(
        {
          error: {
            code: "TOO_MANY",
            type: "quota",
            message: `fake-test-key Bearer secret-token ${request.state.issue.body} ${"x".repeat(1000)}`,
            provider: "reported-provider",
            requestId: "safe-request",
            unexpected: "do-not-project",
          },
        },
        { status: 429 },
      );
    });
    const result = await runSemanticEvaluation(
      h.input,
      { ...options, maxRetries: 1 },
      {
        ...h.dependencies,
        wait: clock,
      },
    );
    const diagnostic = result.items[0].attempts?.[0].providerError?.diagnostic;
    expect(diagnostic).toMatchObject({
      trust: "untrusted",
      code: "TOO_MANY",
      type: "quota",
      requestId: "safe-request",
      providerReported: { provider: "reported-provider" },
    });
    expect(diagnostic).not.toHaveProperty("message");
    expect(JSON.stringify(result)).not.toContain("fake-test-key");
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(JSON.stringify(result)).not.toContain(h.input.items[0].body);
    expect(JSON.stringify(result)).not.toContain("do-not-project");
    expect(result.items[0].providerError).toBeNull();
    expect(result.totals.evaluated).toBe(1);
  });
});

describe("local cached view and batched warm verification", () => {
  test.each([
    runSemanticPreview,
    runSemanticEvaluation,
  ])("76 warm hits use four batch guards before final rereads", async (run) => {
    const h = harness(capture(76));
    for (let index = 0; index < 76; index++) await h.seed(index);
    const result = await run(h.input, { ...options, limit: 76, maxCalls: 0 }, h.dependencies);
    expect(result.totals.cacheHits).toBe(76);
    expect(h.graphql).toHaveBeenCalledTimes(4);
    expect(h.read).toHaveBeenCalledTimes(152);
    expect(h.dependencies.getApiKey).not.toHaveBeenCalled();
    expect(h.begin).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
    for (const [query] of h.graphql.mock.calls) {
      expect(query).toContain("SemanticVersions");
      expect(query).toContain("comments(");
      expect(query).toContain("updatedAt");
    }
  });

  test.each([
    runSemanticPreview,
    runSemanticEvaluation,
  ])("comment-only version changes invalidate cache hits despite unchanged parent version", async (run) => {
    const h = harness();
    h.input.items[0].comments = [
      {
        id: "C1",
        url: "https://github.com/o/r/issues/1#issuecomment-1",
        author: "alice",
        updatedAt: TIME,
        body: "old comment",
      },
    ];
    h.input.items[0].commentsCoverage = {
      ...h.input.items[0].commentsCoverage,
      captured: 1,
      total: 1,
    };
    await h.seed();
    const original = h.graphql.getMockImplementation();
    h.graphql.mockImplementation(async (...args) => {
      const response = (await original?.(...args)) as {
        data: { repository: { i0: { comments: { nodes: Array<{ updatedAt: string }> } } } };
      };
      response.data.repository.i0.comments.nodes[0].updatedAt = "2026-09-22T00:00:00Z";
      return response;
    });
    const result = await run(h.input, options, h.dependencies);
    expect(result.totals.cacheHits).toBe(0);
    expect(result.items[0].reasonCodes).toContain("needs-refresh");
    expect(result.coverageComplete).toBe(false);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.begin).not.toHaveBeenCalled();
  });

  test.each([
    runSemanticPreview,
    runSemanticEvaluation,
  ])("cached uses local current cache only, with zero GitHub, key, STOP, receipt or write I/O", async (run) => {
    const h = harness(capture(3));
    await h.seed(0);
    await h.seed(2);
    const original = h.read.getMockImplementation();
    h.read.mockImplementation(async (context, settings) => {
      if (context.request.state.issue.key === "o/r#3")
        throw new SemanticError("in-flight-or-unknown", "hidden", "hidden");
      return original?.(context, settings) ?? { status: "miss" };
    });
    const result = await run(h.input, { ...options, maxCalls: 0, cached: true }, h.dependencies);
    expect(result.coverageComplete).toBe(false);
    expect(result.totals).toMatchObject({ cacheHits: 1, deferred: 1, failed: 1 });
    expect(
      result.items.every(
        (item) =>
          item.reviewRequired && item.reasonCodes.includes("cached-evidence-not-revalidated"),
      ),
    ).toBe(true);
    expect(result.nextSteps[0].description).toContain("not live revalidated");
    expect(h.graphql).not.toHaveBeenCalled();
    expect(h.dependencies.isDisabled).not.toHaveBeenCalled();
    expect(h.dependencies.getApiKey).not.toHaveBeenCalled();
    expect(h.dependencies.createStore).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
    expect(h.begin).not.toHaveBeenCalled();
    expect(h.finish).not.toHaveBeenCalled();
  });

  test("cached honors real TTL and current policy without revalidation", async () => {
    const home = await mkdtemp(join(tmpdir(), "semantic-cached-ttl-"));
    homes.push(home);
    const h = harness();
    let time = Date.parse(TIME);
    const now = () => new Date(time).toISOString();
    const cache = createSemanticCacheStore({ home, now });
    const store = createSemanticReceiptStore({ home, now });
    const dependencies = { ...h.dependencies, createCache: () => cache, createStore: () => store };
    await runSemanticEvaluation(h.input, options, dependencies);
    h.graphql.mockClear();
    h.dependencies.getApiKey.mockClear();
    const decide = vi.fn((evaluation) => ({
      outcome: "needs-review" as const,
      reasonCodes: ["current-policy"],
      answers: evaluation.answers,
      impactReportedStatus: "applicable" as const,
    }));
    const cached = await runSemanticEvaluation(
      h.input,
      { ...options, cached: true, maxCalls: 0 },
      { ...dependencies, policy: { version: "current", decide } },
    );
    expect(cached.totals.cacheHits).toBe(1);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(cached.items[0].reasonCodes).toContain("current-policy");
    time += SEMANTIC_CACHE_TTL_MS + 1;
    const expired = await runSemanticEvaluation(
      h.input,
      { ...options, cached: true, maxCalls: 0 },
      dependencies,
    );
    expect(expired.totals).toMatchObject({ cacheHits: 0, deferred: 1 });
    expect(expired.items[0].cacheStatus).toBe("expired");
    expect(h.graphql).not.toHaveBeenCalled();
    expect(h.dependencies.getApiKey).not.toHaveBeenCalled();
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  test.each([
    { concurrency: 0 },
    { concurrency: 5 },
    { concurrency: 1.5 },
    { concurrency: Number.NaN },
    { maxRetries: -1 },
    { maxRetries: 4 },
    { maxRetries: 0.5 },
    { minIntervalMs: -1 },
    { minIntervalMs: 60001 },
    { minIntervalMs: Number.POSITIVE_INFINITY },
    { cached: true, maxCalls: 1 },
    { cached: true, maxCalls: 0, noSnapshot: true },
    { cached: true, maxCalls: 0, refresh: true },
    { maxCalls: -1 },
  ])("invalid library options %j reject before any I/O", async (invalid) => {
    const h = harness();
    for (const run of [runSemanticPreview, runSemanticEvaluation]) {
      await expect(run(h.input, { ...options, ...invalid }, h.dependencies)).rejects.toMatchObject({
        code: "invalid-run-options",
      });
    }
    expect(h.graphql).not.toHaveBeenCalled();
    expect(h.dependencies.createCache).not.toHaveBeenCalled();
    expect(h.dependencies.createStore).not.toHaveBeenCalled();
    expect(h.dependencies.getApiKey).not.toHaveBeenCalled();
    expect(h.dependencies.isDisabled).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

describe("retry persistence and dispatch boundaries", () => {
  test.each([
    "begin",
    "final",
    "cache",
  ])("%s persistence failure never retries or erases pending state", async (phase) => {
    const h = harness(capture(2));
    const clock = virtualClock();
    if (phase === "begin")
      h.begin.mockRejectedValue(new SemanticError("receipt-begin-failed", "hidden", "hidden"));
    if (phase === "final") {
      h.fetch.mockImplementation(async () => throttle());
      h.finish.mockRejectedValue(
        new SemanticError("receipt-finalization-failed", "hidden", "hidden"),
      );
    }
    if (phase === "cache") h.write.mockRejectedValue(new Error("hidden"));
    const result = await runSemanticEvaluation(
      h.input,
      { ...options, maxRetries: 3 },
      {
        ...h.dependencies,
        wait: clock,
      },
    );
    expect(result.execution.gatewayCalls).toBe(phase === "begin" ? 0 : 1);
    expect(clock.sleep).not.toHaveBeenCalled();
    expect(h.locks.size).toBe(phase === "begin" ? 0 : 1);
    expect(result.items[0].receipt?.final ?? null).toBeNull();
    if (phase !== "begin") {
      expect(h.begin).toHaveBeenCalledTimes(1);
      expect(result.items[1].reasonCodes).toContain(
        phase === "cache" ? "cache-write-failed" : "receipt-finalization-failed",
      );
    }
  });

  test("a retry rechecks evidence before creating its fresh pending record", async () => {
    const h = harness();
    const clock = virtualClock();
    h.fetch.mockImplementation(async () => throttle());
    const original = h.graphql.getMockImplementation();
    h.graphql.mockImplementation(async (...args) => {
      const response = (await original?.(...args)) as {
        data: { repository: { i0: { state: string } } };
      };
      if (h.fetch.mock.calls.length > 0) response.data.repository.i0.state = "CLOSED";
      return response;
    });
    const result = await runSemanticEvaluation(
      h.input,
      { ...options, maxRetries: 1 },
      {
        ...h.dependencies,
        wait: clock,
      },
    );
    expect(result.execution.gatewayCalls).toBe(1);
    expect(result.items[0].reasonCodes).toContain("state-changed");
    expect(result.coverageComplete).toBe(false);
    expect(h.begin).toHaveBeenCalledTimes(1);
    expect(result.items[0].receipt?.final?.result.status).toBe("failed");
  });

  test("STOP after retry pending creation finalizes not-sent with a new UUID", async () => {
    const h = harness();
    const clock = virtualClock();
    h.fetch.mockImplementation(async () => throttle());
    const original = h.begin.getMockImplementation();
    if (!original) throw new Error("Missing begin mock");
    h.begin.mockImplementation(async (input) => {
      const pending = await original(input);
      if (h.begin.mock.calls.length === 2) h.dependencies.isDisabled.mockReturnValue(true);
      return pending;
    });
    const result = await runSemanticEvaluation(
      h.input,
      { ...options, maxRetries: 1 },
      {
        ...h.dependencies,
        wait: clock,
      },
    );
    const attempts = result.items[0].attempts ?? [];
    expect(result.execution.gatewayCalls).toBe(1);
    expect(attempts).toHaveLength(2);
    expect(attempts[0].receipt.pending.requestId).not.toBe(attempts[1].receipt.pending.requestId);
    expect(attempts[1].receipt.final?.result).toMatchObject({
      status: "not-sent",
      outcomeUnknown: false,
      errorCode: "inference-disabled",
    });
    expect(h.finish).toHaveBeenCalledTimes(2);
    expect(h.locks.size).toBe(0);
  });

  test("unknown durable outcome remains locked on the next invocation, including cached mode", async () => {
    const home = await mkdtemp(join(tmpdir(), "semantic-retry-unknown-"));
    homes.push(home);
    const h = harness();
    const store = createSemanticReceiptStore({ home, now: () => TIME });
    const cache = createSemanticCacheStore({ home, now: () => TIME });
    const dependencies = { ...h.dependencies, createStore: () => store, createCache: () => cache };
    h.fetch.mockRejectedValue(new Error("untrusted-network-error"));
    const first = await runSemanticEvaluation(h.input, { ...options, maxRetries: 3 }, dependencies);
    expect(first.items[0].receipt?.final?.result.outcomeUnknown).toBe(true);
    const lock = first.items[0].receipt?.pending;
    if (!lock) throw new Error("Missing pending receipt");
    h.graphql.mockClear();
    const next = await runSemanticEvaluation(h.input, { ...options, maxRetries: 3 }, dependencies);
    const cached = await runSemanticEvaluation(
      h.input,
      { ...options, cached: true, maxCalls: 0 },
      dependencies,
    );
    for (const result of [next, cached]) {
      expect(result.items[0].cacheStatus).toBe("blocked");
      expect(result.execution.gatewayCalls).toBe(0);
    }
    expect(
      JSON.parse(await readFile(join(home, "classify", "locks", `${lock.inputHash}.json`), "utf8")),
    ).toEqual(lock);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.graphql).not.toHaveBeenCalled();
  });

  test.each([
    false,
    true,
  ])("duplicate evidence cannot issue duplicate requests, noSnapshot=%s", async (noSnapshot) => {
    const h = harness();
    h.input.items.push(structuredClone(h.input.items[0]));
    await expect(
      runSemanticEvaluation(h.input, { ...options, noSnapshot }, h.dependencies),
    ).rejects.toMatchObject({ code: "issue-identity-unverified" });
    expect(h.dependencies.createCache).not.toHaveBeenCalled();
    expect(h.graphql).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

test("STOP after pending creation still permits freshly verified success-lease cache reuse", async () => {
  const h = harness();
  const prior = await h.seed();
  h.read.mockResolvedValueOnce({ status: "miss" });
  const original = h.begin.getMockImplementation();
  if (!original) throw new Error("Missing begin mock");
  h.begin.mockImplementation(async (input) => {
    const pending = await original(input);
    h.dependencies.isDisabled.mockReturnValue(true);
    return pending;
  });
  const result = await runSemanticEvaluation(h.input, options, h.dependencies);
  expect(result.totals).toMatchObject({ cacheHits: 1, evaluated: 0, failed: 0, deferred: 0 });
  expect(result.items[0].cacheSourceRequestId).toBe(prior.requestId);
  expect(result.items[0].receipt?.final?.result).toMatchObject({
    status: "not-sent",
    errorCode: "cache-race-hit",
    outcomeUnknown: false,
  });
  expect(h.graphql).toHaveBeenCalledTimes(2);
  expect(h.fetch).not.toHaveBeenCalled();
  expect(h.write).not.toHaveBeenCalled();
  expect(h.finish).toHaveBeenCalledTimes(1);
});

function stalledThrottle(retryAfter: string) {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let headersRead: () => void = () => {};
  let closed = false;
  const reading = new Promise<void>((resolve) => {
    headersRead = resolve;
  });
  const body = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value;
      },
      pull() {
        headersRead();
      },
      cancel() {
        closed = true;
      },
    },
    { highWaterMark: 0 },
  );
  return {
    reading,
    response: new Response(body, { status: 429, headers: { "retry-after": retryAfter } }),
    close() {
      if (closed) return;
      closed = true;
      controller.enqueue(new TextEncoder().encode('{"error":{"code":"RATE_LIMIT"}}'));
      controller.close();
    },
  };
}

describe("header-time shared throttle", () => {
  test.each([
    { name: "excessive hint", retryAfter: "31", maxRetries: 1, retry: false },
    { name: "default no retries", retryAfter: "1", maxRetries: 0, retry: false },
    { name: "bounded cooldown", retryAfter: "1", maxRetries: 1, retry: true },
  ])("$name blocks dispatch before the stalled diagnostic body closes", async ({
    retryAfter,
    maxRetries,
    retry,
  }) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(Date.parse(TIME));
    const h = harness(capture(2));
    const controller = new AbortController();
    const stalled = stalledThrottle(retryAfter);
    const sent: number[] = [];
    h.fetch.mockImplementation(async (_url, init) => {
      sent.push(Date.now());
      return sent.length === 1
        ? stalled.response
        : Response.json(rawEvaluation(JSON.parse(String(init?.body))));
    });
    const running = runSemanticEvaluation(
      h.input,
      {
        ...options,
        concurrency: 2,
        minIntervalMs: 100,
        maxCalls: 2,
        maxRetries,
      },
      {
        ...h.dependencies,
        signal: controller.signal,
        nowMs: Date.now,
        wait: { now: Date.now },
      },
    );
    try {
      await stalled.reading;
      await vi.advanceTimersByTimeAsync(150);
      expect(h.fetch).toHaveBeenCalledTimes(1);
      expect(sent).toEqual([Date.parse(TIME)]);
      stalled.close();
      if (retry) {
        await vi.advanceTimersByTimeAsync(849);
        expect(h.fetch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(h.fetch).toHaveBeenCalledTimes(2);
        expect(sent[1]).toBe(Date.parse(TIME) + 1000);
        await vi.advanceTimersByTimeAsync(100);
        expect(h.fetch).toHaveBeenCalledTimes(2);
      }
      const result = await running;
      expect(result.execution.gatewayCalls).toBe(retry ? 2 : 1);
      expect(result.totals).toMatchObject({ evaluated: retry ? 1 : 0, hasUnknownCost: true });
      expect(
        result.items.flatMap((item) => item.attempts ?? []).filter((attempt) => attempt.attempted),
      ).toHaveLength(retry ? 2 : 1);
      expect(result.items[0].attempts?.[0].providerError).toMatchObject({
        status: 429,
        diagnostic: { code: "RATE_LIMIT" },
      });
      if (!retry) {
        expect(result.items[1].reasonCodes).toContain("provider-unavailable");
        expect(result.items[0].providerError?.retryRefusalReason).toBe(
          maxRetries === 0 ? "retries-disabled" : "retry-wait-exceeds-limit",
        );
      }
    } finally {
      controller.abort();
      stalled.close();
      await running;
      vi.useRealTimers();
    }
  });

  test("an excessive header hint stops new launches without discarding an in-flight success", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const h = harness(capture(2));
    const controller = new AbortController();
    const stalled = stalledThrottle("31");
    let releaseFirst: () => void = () => {};
    let releaseSecond: () => void = () => {};
    const firstReady = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondReady = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let secondSent: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => {
      secondSent = resolve;
    });
    h.fetch.mockImplementation(async (_url, init) => {
      if (h.fetch.mock.calls.length === 1) {
        await firstReady;
        return stalled.response;
      }
      secondSent();
      await secondReady;
      return Response.json(rawEvaluation(JSON.parse(String(init?.body))));
    });
    const running = runSemanticEvaluation(
      h.input,
      {
        ...options,
        concurrency: 2,
        maxCalls: 2,
        maxRetries: 1,
      },
      {
        ...h.dependencies,
        signal: controller.signal,
        nowMs: Date.now,
        wait: { now: Date.now },
      },
    );
    try {
      await inFlight;
      releaseFirst();
      await stalled.reading;
      releaseSecond();
      await vi.advanceTimersByTimeAsync(150);
      expect(h.fetch).toHaveBeenCalledTimes(2);
      expect(h.finish).toHaveBeenCalledTimes(1);
      expect(h.finish.mock.calls[0][1].status).toBe("succeeded");
      stalled.close();
      const result = await running;
      expect(result.execution.gatewayCalls).toBe(2);
      expect(result.totals).toMatchObject({
        evaluated: 1,
        failed: 1,
        hasUnknownCost: true,
        reportedCostUsd: 0.125,
      });
      expect(result.items[1].receipt?.final?.result.status).toBe("succeeded");
      expect(h.finish).toHaveBeenCalledTimes(2);
    } finally {
      controller.abort();
      releaseFirst();
      releaseSecond();
      stalled.close();
      await running;
      vi.useRealTimers();
    }
  });
});
