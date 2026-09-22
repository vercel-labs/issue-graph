import { constants, lstatSync } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { SEMANTIC_MAX_TAXONOMY_BYTES, validateSemanticRepo, validateTaxonomy } from "./semantic.js";
import {
  createSemanticEvidenceStore,
  type SemanticEvidenceStore,
} from "./semantic-evidence-store.js";
import { collectSemanticEvidence } from "./semantic-github.js";
import type { SemanticWaitOptions } from "./semantic-rate.js";
import { renderClassificationPreview, renderClassificationReport } from "./semantic-render.js";
import { runSemanticEvaluation, runSemanticPreview } from "./semantic-run.js";
import { createSemanticCacheStore, createSemanticReceiptStore } from "./semantic-store.js";
import {
  type SemanticCacheStore,
  SemanticError,
  type SemanticPolicy,
  type SemanticReceiptStore,
} from "./semantic-types.js";
import type { GhTransport } from "./transport.js";

export const SEMANTIC_USAGE = `usage: issue-graph classify --repo owner/repo [options]

Suggest classifications for public issues with typesafe-ai/jev through AI Gateway.
Without --dry-run, uncached inference may incur charges and needs AI_GATEWAY_API_KEY.
Every suggestion requires human review. No GitHub mutations or automatic acceptance.

  --repo owner/repo  exactly one public repository (required)
  --dry-run          capture/prepare/read cache; no Gateway keys, calls or local writes
  --cached           local saved-evidence view; no GitHub, Gateway, keys or writes
  --concurrency N    inference workers, 1..4 (default 1; configure against your quota)
  --max-retries N    known HTTP429 retries per issue, 0..3 (default 0)
  --min-interval-ms N minimum request spacing, 0..60000 (default 0)
  --taxonomy PATH    explicit JSON file; no implicit configuration
  --limit N          open issues, 1..500 (default 50)
  --max-calls N      new HTTP attempts, 0..500 (default 50); zero is cache-only
  --refresh         ignore saved responses without deleting history; locks still apply
  --format FORMAT   auto (default), json, markdown
  --json            boolean JSON stdout alias; no filename
  --no-snapshot     no evidence/cache/receipt I/O; memory-only receipts, no crash recovery
  -h, --help        no network, files or authentication

Auto output: Markdown in a terminal, JSON in pipes. No styling, including NO_COLOR.
Exit 0: complete scope, including legitimate abstentions; 1: incomplete/failure/deferred;
2: invalid local input. Defaults are sequential, no retries; no provider/model fallback.
max-calls includes retries across all workers. Only known HTTP429 failures can be retried.
Retry-After is honored up to a 30s wait; longer hints defer instead of retrying early.
STOP/abort are checked during pacing/backoff, outside the provider's 30s deadline.
Live capture and batched revalidation check visibility, issue and comment versions.
--cached is not live verification: saved evidence age is shown; expired/missing answers defer.
--cached conflicts with --dry-run, --refresh, --no-snapshot and positive --max-calls.
Limits: 24,000 UTF-8 request bytes, 30s including response read, 256 KiB response.
Comments: at most 300 per issue (10/100/100/90 pages); incomplete coverage never proves absence.
No text truncation. Complete or explicitly limit-capped public evidence is stored privately
under classify/evidence unless --dry-run or --no-snapshot; unchanged evidence writes nothing.
Taxonomy: schemaVersion 1, repo, version, components [{id, description, examples?}].
Maximum 64 KiB JSON, 1..64 components; IDs [a-z][a-z0-9-]{0,47}, unique;
multiple/new/insufficient/constructor/prototype reserved. Descriptions 1..2000 characters;
up to 5 examples of 1..500 characters. Repo must match --repo; unknown fields fail.
Cache and pending/final receipts: ISSUE_GRAPH_HOME/classify (default ~/.issue-graph/classify).
Alias cache TTL: 24 hours from evaluation; epoch invalidates reuse, not immutable model pinning.
Only validated responses with matching successful final receipts can be reused. Policy reruns.
Pending/unknown outcomes block the same fingerprint, even --refresh; no automatic recovery.
Cache/final persistence failures retain pending state; inspect before another paid request.
Create classify/STOP in that home to disable new inference, including --no-snapshot runs.
Cached historical cost is separate from current spend. max-calls is not a monetary budget.
Reported cost can be unknown. Use an account spending limit; abort does not prove no charge.
Rounded distributions may require review; see schema for the bounded compatibility policy.
Responses are checked at runtime; resolved weights and semantic quality are not independently verified.

Example: issue-graph classify --repo vercel-labs/agent-browser --dry-run --json`;

export interface SemanticArgs {
  repo: string;
  taxonomy: string | null;
  limit: number;
  maxCalls: number;
  format: "auto" | "json" | "markdown";
  dryRun: boolean;
  noSnapshot: boolean;
  refresh: boolean;
  cached: boolean;
  concurrency: number;
  maxRetries: number;
  minIntervalMs: number;
  help: boolean;
}

function usage(message: string): never {
  throw new SemanticError("invalid-arguments", message, "Run issue-graph classify --help.", 2);
}

export function parseSemanticArgs(argv: string[]): SemanticArgs {
  const args: SemanticArgs = {
    repo: "",
    taxonomy: null,
    limit: 50,
    maxCalls: 50,
    format: "auto",
    dryRun: false,
    noSnapshot: false,
    refresh: false,
    cached: false,
    concurrency: 1,
    maxRetries: 0,
    minIntervalMs: 0,
    help: false,
  };
  const seen = new Set<string>();
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (seen.has(flag))
      usage("Options must not be repeated; classify accepts a single repository.");
    seen.add(flag);
    const value = () => {
      const next = argv[++i];
      if (!next || next.startsWith("-")) usage("An option value is missing.");
      return next;
    };
    const integer = () => {
      const raw = value();
      if (!/^\d+$/.test(raw)) usage("Limits must be decimal integers.");
      return Number(raw);
    };
    if (flag === "--help" || flag === "-h") args.help = true;
    else if (flag === "--repo") args.repo = value();
    else if (flag === "--taxonomy") args.taxonomy = value();
    else if (flag === "--limit") args.limit = integer();
    else if (flag === "--max-calls") args.maxCalls = integer();
    else if (flag === "--concurrency") args.concurrency = integer();
    else if (flag === "--max-retries") args.maxRetries = integer();
    else if (flag === "--min-interval-ms") args.minIntervalMs = integer();
    else if (flag === "--cached") args.cached = true;
    else if (flag === "--dry-run") args.dryRun = true;
    else if (flag === "--no-snapshot") args.noSnapshot = true;
    else if (flag === "--refresh") args.refresh = true;
    else if (flag === "--json") json = true;
    else if (flag === "--format") {
      const format = value();
      if (format !== "auto" && format !== "json" && format !== "markdown")
        usage("Invalid output format.");
      args.format = format;
    } else usage("Unknown or positional argument; only documented classify flags are supported.");
  }
  if (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 500)
    usage("--limit must be an integer from 1 to 500.");
  if (!Number.isSafeInteger(args.maxCalls) || args.maxCalls < 0 || args.maxCalls > 500)
    usage("--max-calls must be an integer from 0 to 500.");
  if (!Number.isSafeInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 4)
    usage("--concurrency must be an integer from 1 to 4.");
  if (!Number.isSafeInteger(args.maxRetries) || args.maxRetries < 0 || args.maxRetries > 3)
    usage("--max-retries must be an integer from 0 to 3.");
  if (
    !Number.isSafeInteger(args.minIntervalMs) ||
    args.minIntervalMs < 0 ||
    args.minIntervalMs > 60000
  )
    usage("--min-interval-ms must be an integer from 0 to 60000.");
  if (args.cached) {
    if (
      args.dryRun ||
      args.refresh ||
      args.noSnapshot ||
      (seen.has("--max-calls") && args.maxCalls > 0)
    )
      usage(
        "--cached conflicts with live preview, refresh, disabled snapshots or positive max-calls.",
      );
    args.maxCalls = 0;
  }
  if (json && args.format === "markdown") usage("--json conflicts with --format markdown.");
  if (json) args.format = "json";
  if (!args.help) validateSemanticRepo(args.repo);
  return args;
}

async function readTaxonomy(path: string): Promise<unknown> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > SEMANTIC_MAX_TAXONOMY_BYTES) throw new Error();
      const buffer = new Uint8Array(SEMANTIC_MAX_TAXONOMY_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > SEMANTIC_MAX_TAXONOMY_BYTES) throw new Error();
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)),
      );
    } finally {
      await file.close();
    }
  } catch {
    throw new SemanticError(
      "taxonomy-read-failed",
      "Taxonomy must be a readable UTF-8 JSON file no larger than 64 KiB.",
      "Check the explicit --taxonomy file; no default file is loaded.",
      2,
    );
  }
}

function inferenceDisabled(home?: string): boolean {
  const root = home ?? process.env.ISSUE_GRAPH_HOME ?? join(homedir(), ".issue-graph");
  try {
    lstatSync(join(root, "classify", "STOP"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new SemanticError(
      "inference-guard-unavailable",
      "Inference stop control could not be checked.",
      "Check permissions for ISSUE_GRAPH_HOME/classify/STOP.",
    );
  }
}

export interface SemanticIO {
  isTTY: boolean;
  stdout: (value: string) => void;
  stderr: (value: string) => void;
  readTaxonomy?: (path: string) => Promise<unknown>;
  now?: () => string;
  snapshotHome?: string;
  gatewayFetch?: typeof globalThis.fetch;
  getGatewayApiKey?: () => string | undefined;
  receiptStore?: SemanticReceiptStore;
  cacheStore?: SemanticCacheStore;
  evidenceStore?: SemanticEvidenceStore;
  cacheEpoch?: string;
  policy?: SemanticPolicy;
  isInferenceDisabled?: () => boolean;
  signal?: AbortSignal;
  gatewayTimeoutMs?: number;
  wait?: SemanticWaitOptions;
  nowMs?: () => number;
}

export async function runSemanticCli(
  argv: string[],
  transport: GhTransport,
  io: SemanticIO,
): Promise<number> {
  let machine =
    !io.isTTY ||
    argv.includes("--json") ||
    argv.some((arg, i) => arg === "--format" && argv[i + 1] === "json");
  try {
    const args = parseSemanticArgs(argv);
    if (args.help) {
      io.stdout(`${SEMANTIC_USAGE}\n`);
      return 0;
    }
    const format = args.format === "auto" ? (io.isTTY ? "markdown" : "json") : args.format;
    machine = format === "json";
    const taxonomy = args.taxonomy
      ? validateTaxonomy(await (io.readTaxonomy ?? readTaxonomy)(args.taxonomy), args.repo)
      : null;
    const humanTTY = io.isTTY && !machine;
    if (humanTTY)
      io.stderr(
        args.cached
          ? "issue-graph classify: saved evidence, not live revalidated; no network or inference\n"
          : args.dryRun
            ? "issue-graph classify: read-only evidence preview; no inference\n"
            : "issue-graph classify: review-required suggestions; inference may incur charges\n",
      );
    const started = performance.now();
    const metrics = {
      githubCalls: 0,
      githubRequestMs: 0,
      captureMs: 0,
      evaluationMs: 0,
      totalMs: 0,
    };
    const measuredTransport: GhTransport = {
      graphql: async (query, variables) => {
        if (args.cached)
          throw new SemanticError(
            "cached-network-forbidden",
            "Saved evidence cannot access GitHub.",
            "Use live mode to refresh evidence.",
          );
        metrics.githubCalls++;
        const start = performance.now();
        try {
          return await transport.graphql(query, variables);
        } finally {
          metrics.githubRequestMs += Math.max(0, performance.now() - start);
        }
      },
      search: async () => {
        throw new SemanticError(
          "semantic-search-forbidden",
          "Classification does not use search.",
          "Use the explicit repository scope.",
        );
      },
    };
    const cacheOptions = {
      home: io.snapshotHome,
      now: () => new Date(io.now?.() ?? Date.now()).toISOString(),
    };
    let evidenceStore: SemanticEvidenceStore | undefined;
    const getEvidenceStore = () =>
      (evidenceStore ??= io.evidenceStore ?? createSemanticEvidenceStore(cacheOptions));
    const previousCapture =
      args.noSnapshot || args.refresh ? null : await getEvidenceStore().read(args.repo, args.limit);
    if (args.cached && !previousCapture)
      throw new SemanticError(
        "evidence-snapshot-missing",
        "No saved evidence exists for this repository and limit.",
        "Capture this scope with classify --max-calls 0 first; cached mode never falls back to the network.",
      );
    let reusedIssues = 0;
    const capture =
      args.cached && previousCapture
        ? previousCapture
        : await collectSemanticEvidence(measuredTransport, {
            repo: args.repo,
            limit: args.limit,
            now: io.now,
            previousCapture: previousCapture ?? undefined,
            onEvidenceReuse: () => {
              reusedIssues++;
            },
            onProgress: humanTTY
              ? ({ captured, pages }) =>
                  io.stderr(
                    `Captured ${captured} issues from ${pages} issue pages; collecting and rechecking comments.\n`,
                  )
              : undefined,
          });
    if (!args.cached && !args.dryRun && !args.noSnapshot)
      await getEvidenceStore().write(args.repo, args.limit, capture);
    metrics.captureMs = Math.max(0, performance.now() - started);
    const createCache = () => io.cacheStore ?? createSemanticCacheStore(cacheOptions);
    const options = { ...args, taxonomy, cacheEpoch: io.cacheEpoch };
    const evaluationStarted = performance.now();
    const report = args.dryRun
      ? await runSemanticPreview(capture, options, { transport: measuredTransport, createCache })
      : await runSemanticEvaluation(capture, options, {
          transport: measuredTransport,
          getApiKey: () => {
            if (args.cached)
              throw new SemanticError(
                "cached-key-forbidden",
                "Saved evidence cannot access a Gateway key.",
                "Use live mode for new inference.",
              );
            return (io.getGatewayApiKey ?? (() => process.env.AI_GATEWAY_API_KEY))();
          },
          createStore: () => io.receiptStore ?? createSemanticReceiptStore(cacheOptions),
          createCache,
          policy: io.policy,
          isDisabled: args.cached
            ? () => true
            : (io.isInferenceDisabled ?? (() => inferenceDisabled(io.snapshotHome))),
          fetch: args.cached
            ? async () => {
                throw new Error("Cached inference forbidden");
              }
            : io.gatewayFetch,
          signal: io.signal,
          timeoutMs: io.gatewayTimeoutMs,
          now: io.now,
          nowMs: io.nowMs,
          wait: io.wait,
        });
    metrics.evaluationMs = Math.max(0, performance.now() - evaluationStarted);
    metrics.totalMs = Math.max(0, performance.now() - started);
    report.performance = metrics;
    report.evidenceSource = {
      mode: args.cached ? "cached" : "live",
      capturedAt: capture.captureWindow.completedAt,
      ageMs: Math.max(
        0,
        Date.parse(cacheOptions.now()) - Date.parse(capture.captureWindow.completedAt),
      ),
      liveRevalidated: !args.cached && report.coverageComplete,
      reusedIssues: args.cached ? capture.items.length : reusedIssues,
    };
    io.stdout(
      machine
        ? `${JSON.stringify(report, null, 2)}\n`
        : report.kind === "classification-preview"
          ? renderClassificationPreview(report)
          : renderClassificationReport(report),
    );
    if (!report.coverageComplete || report.totals.deferred > 0 || report.totals.failed > 0) {
      io.stderr(
        args.dryRun
          ? "INCOMPLETE_PREVIEW: inspect coverage and deferred items; no inference was performed.\n"
          : "INCOMPLETE_CLASSIFICATION: inspect coverage, failures and receipts; do not retry unknown outcomes blindly.\n",
      );
      return 1;
    }
    return 0;
  } catch (cause) {
    const error =
      cause instanceof SemanticError
        ? cause
        : new SemanticError(
            "preview-failed",
            "The classification command could not be completed.",
            "Inspect configuration and receipts. Do not retry pending or unknown outcomes blindly.",
          );
    if (machine)
      io.stdout(
        `${JSON.stringify({ schemaVersion: 1, kind: "classification-error", error: { code: error.code, message: error.message, hint: error.hint } }, null, 2)}\n`,
      );
    io.stderr(`${error.code}: ${error.message}\n${error.hint}\n`);
    return error.exitCode;
  }
}
