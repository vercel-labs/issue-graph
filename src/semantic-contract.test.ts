import { afterEach, beforeEach, expect, test, vi } from "vitest";
import taxonomyExample from "../skill-data/core/examples/taxonomy.json";
import { fixture, TIME } from "../tests/semantic-github-fixture.js";
import { rawEvaluation } from "../tests/semantic-response-fixture.js";
import { ISSUE_GRAPH_SCHEMA } from "./schema.js";
import { buildClassificationPreview, buildEvaluationInput, validateTaxonomy } from "./semantic.js";
import { parseSemanticArgs, runSemanticCli, type SemanticIO } from "./semantic-cli.js";
import {
  buildEvaluationRequest,
  decideSuggestion,
  fingerprintEvaluation,
  validateEvaluation,
} from "./semantic-evaluation.js";
import { collectSemanticEvidence } from "./semantic-github.js";
import { evaluateWithJev, JEV_ADAPTER_VERSION, JevError } from "./semantic-jev.js";
import { renderClassificationPreview } from "./semantic-render.js";
import type { GatewayEvaluationRequest, SemanticCapture } from "./semantic-types.js";

const KEY = "synthetic-contract-key";
const forbidden = vi.fn((): never => {
  throw new Error("Unexpected external I/O");
});
const taxonomy = () => ({ ...structuredClone(taxonomyExample), repo: "o/r" });
let capture: SemanticCapture;
let request: GatewayEvaluationRequest;
let evidenceText: string[];

beforeEach(async () => {
  forbidden.mockClear();
  vi.stubGlobal("fetch", forbidden);
  capture = await collectSemanticEvidence(fixture(1, { comments: { 1: 1 } }).transport, {
    repo: "o/r",
    limit: 1,
    now: () => TIME,
  });
  request = buildEvaluationRequest(buildEvaluationInput(capture.items[0], null));
  evidenceText = [capture.items[0].body, capture.items[0].comments[0].body];
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  expect(forbidden).not.toHaveBeenCalled();
});

async function cli(
  flags: string[],
  io: Partial<SemanticIO> = {},
  transport = fixture(1, { comments: { 1: 1 } }).transport,
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exit = await runSemanticCli(["--repo", "o/r", ...flags], transport, {
    isTTY: false,
    now: () => TIME,
    evidenceStore: { read: forbidden, write: forbidden },
    cacheStore: { read: forbidden, write: forbidden },
    receiptStore: { begin: forbidden, finish: forbidden },
    getGatewayApiKey: forbidden,
    gatewayFetch: forbidden,
    isInferenceDisabled: forbidden,
    readTaxonomy: forbidden,
    ...io,
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });
  return { exit, stdout: stdout.join(""), stderr: stderr.join("") };
}

test("parser defaults retain bounded inference and zero-call cached semantics", () => {
  const defaults = parseSemanticArgs(["--repo", "o/r"]);
  expect(defaults).toMatchObject({ limit: 50, maxCalls: 50, concurrency: 1, maxRetries: 0 });
  const cached = parseSemanticArgs(["--repo", "o/r", "--cached"]);
  expect(cached).toEqual({ ...defaults, cached: true, maxCalls: 0 });
});

test.each([
  ["--limit", "0"],
  ["--concurrency", "5"],
  ["--cached", "--dry-run"],
  ["--json", "--format", "markdown"],
])("invalid arguments %j fail before any I/O", async (...flags) => {
  const result = await cli(flags, {}, { graphql: forbidden, search: forbidden });
  expect(result.exit).toBe(2);
  expect(JSON.parse(result.stdout)).toMatchObject({
    schemaVersion: 1,
    kind: "classification-error",
    error: { code: "invalid-arguments" },
  });
});

test.each([
  "scope",
  "reserved-id",
  "description-bound",
])("invalid taxonomy %s fails before remote/storage/key I/O", async (change) => {
  const value = taxonomy();
  if (change === "scope") value.repo = "other/repo";
  if (change === "reserved-id") value.components[0].id = "constructor";
  if (change === "description-bound") value.components[0].description = "x".repeat(2001);
  const readTaxonomy = vi.fn(async () => value);
  const result = await cli(
    ["--taxonomy", "explicit.json"],
    { readTaxonomy },
    { graphql: forbidden, search: forbidden },
  );
  expect(result.exit).toBe(2);
  expect(JSON.parse(result.stdout).error.code).toBe("invalid-taxonomy");
  expect(readTaxonomy).toHaveBeenCalledExactlyOnceWith("explicit.json");
});

test("preview schema and rendering expose references, not raw evidence or requests", async () => {
  const contract = ISSUE_GRAPH_SCHEMA.commands.classify;
  expect(contract).toMatchObject({
    githubMutations: false,
    outputSchemaVersion: 1,
    outputKind: "classification-report",
    dryRunOutputKind: "classification-preview",
  });
  const result = await cli(["--dry-run", "--no-snapshot"]);
  expect(result.exit).toBe(0);
  const preview = JSON.parse(result.stdout);
  expect(preview).toMatchObject({
    schemaVersion: contract.outputSchemaVersion,
    kind: contract.dryRunOutputKind,
    execution: { gatewayCalls: 0, localWrites: 0 },
    items: [{ reviewRequired: true, plannedCall: true }],
  });
  expect(preview.items[0].evidence.comments[0].id).toBe(capture.items[0].comments[0].id);
  preview.nextSteps[0].description = "<script>\u001b[31m untrusted";
  const markdown = renderClassificationPreview(preview);
  expect(markdown).toContain("&lt;script&gt;");
  for (const output of [result.stdout, markdown]) {
    for (const raw of [...evidenceText, "<script>", "\u001b"]) expect(output).not.toContain(raw);
    expect(output).not.toContain('"contexts"');
    expect(output).not.toContain('"providerOptions"');
  }
});

test("inference report is review-only and excludes key, body and arbitrary provider metadata", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) =>
    Response.json({
      ...rawEvaluation(JSON.parse(String(init?.body))),
      internalNote: "PROVIDER_PRIVATE_MARKER",
    }),
  );
  const result = await cli(["--no-snapshot"], {
    gatewayFetch: fetch,
    getGatewayApiKey: () => KEY,
    isInferenceDisabled: () => false,
  });
  expect(result.exit).toBe(0);
  const report = JSON.parse(result.stdout);
  expect(report).toMatchObject({
    kind: "classification-report",
    schemaVersion: 1,
    execution: { gatewayCalls: 1, receipts: "memory-only", cache: "disabled" },
    items: [{ reviewRequired: true, outcome: "suggested" }],
    totals: { reportedCostUsd: 0.125 },
  });
  expect(report.items[0]).not.toHaveProperty("plannedCall");
  expect(fetch).toHaveBeenCalledTimes(1);
  for (const raw of [KEY, ...evidenceText, "PROVIDER_PRIVATE_MARKER"])
    expect(result.stdout + result.stderr).not.toContain(raw);
});

test("original wire bytes/hash ignore capture windows, page counts and review reasons", async () => {
  const wire = JSON.stringify(request);
  const hash = await fingerprintEvaluation(request, null, JEV_ADAPTER_VERSION);
  expect(hash).toBe("e4dd7cd1069912583050b5fd88d7c9f3ad4cc1c21ecbf590c88b04d7de50c597");
  expect(Buffer.byteLength(wire)).toBe(3197);
  const changed = structuredClone(capture.items[0]);
  changed.captureWindow.completedAt = "2027-01-01T00:00:00Z";
  changed.commentsCoverage.pages += 1;
  changed.reasonCodes.push("manual-review");
  const next = buildEvaluationRequest(buildEvaluationInput(changed, null));
  expect(JSON.stringify(next)).toBe(wire);
  expect(await fingerprintEvaluation(next, null, JEV_ADAPTER_VERSION)).toBe(hash);
  const preview = await buildClassificationPreview(capture, {
    limit: 1,
    maxCalls: 0,
    taxonomy: null,
  });
  expect(preview.items[0]).toMatchObject({ inputHash: hash, inputBytes: Buffer.byteLength(wire) });
});

test("evidence edits, taxonomy versions and cache epochs invalidate only their fingerprints", async () => {
  const original = await fingerprintEvaluation(request, null);
  const changed = structuredClone(capture.items[0]);
  changed.comments[0].body += " edited";
  expect(
    await fingerprintEvaluation(buildEvaluationRequest(buildEvaluationInput(changed, null)), null),
  ).not.toBe(original);
  expect(await fingerprintEvaluation(request, null, undefined, "next")).not.toBe(original);
  const first = validateTaxonomy(taxonomy(), "o/r");
  const second = { ...first, version: "2" };
  const a = buildEvaluationRequest(buildEvaluationInput(capture.items[0], first));
  const b = buildEvaluationRequest(buildEvaluationInput(capture.items[0], second));
  expect(a).toEqual(b);
  expect(await fingerprintEvaluation(a, first)).not.toBe(await fingerprintEvaluation(b, second));
});

test.each([
  "missing",
  "extra",
  "probability",
  "mass",
  "model",
])("strict validation rejects %s", (change) => {
  const raw = rawEvaluation(request);
  if (change === "missing") delete raw.answers.requestType;
  if (change === "extra") raw.answers.extra = { type: "boolean", probability: 0 };
  if (change === "probability") raw.answers.reproStepsPresent.probability = 1.01;
  if (change === "mass")
    raw.answers.impactReported.probabilities = { "0": 0, "1": 0, "2": 0.9, "3": 0 };
  if (change === "model") raw.model = "other/model";
  expect(() => validateEvaluation(request, raw)).toThrow(
    expect.objectContaining({ code: "invalid-evaluation" }),
  );
});

test("bounded rounded mass preserves raw probabilities and forces review", () => {
  const raw = rawEvaluation(request);
  const probabilities = { "0": 0, "1": 0.05, "2": 0.66, "3": 0.28 };
  raw.answers.impactReported = { type: "score", score: 2.23, probabilities };
  const before = structuredClone(raw);
  const evaluation = validateEvaluation(request, raw);
  expect(evaluation.answers.impactReported).toMatchObject({ probabilities });
  expect(decideSuggestion(evaluation, true)).toMatchObject({
    outcome: "needs-review",
    reasonCodes: expect.arrayContaining(["impactReported-distribution-rounded"]),
  });
  expect(raw).toEqual(before);
});

test("tied probability leaders cannot become unqualified suggestions", () => {
  const raw = rawEvaluation(request);
  raw.answers.requestType.probabilities = Object.fromEntries(
    Object.keys(raw.answers.requestType.probabilities as Record<string, number>).map((key) => [
      key,
      key === "bug" || key === "feature" ? 0.5 : 0,
    ]),
  );
  expect(decideSuggestion(validateEvaluation(request, raw), true)).toMatchObject({
    outcome: "needs-review",
    reasonCodes: expect.arrayContaining(["tied-top-probability"]),
  });
});

test("nonbug impact is filtered without inventing cost or losing incomplete-evidence review", () => {
  const evaluation = validateEvaluation(
    request,
    rawEvaluation(request, { choices: { requestType: "feature" }, cost: null }),
  );
  expect(evaluation.reportedCostUsd).toBeNull();
  const decision = decideSuggestion(evaluation, false);
  expect(decision).toMatchObject({
    outcome: "needs-review",
    impactReportedStatus: "not-applicable",
    reasonCodes: expect.arrayContaining(["evidence-incomplete"]),
  });
  expect(decision.answers).not.toHaveProperty("impactReported");
});

test("Gateway sends the exact 24000-byte request to the fixed endpoint without redirects", async () => {
  const padded = structuredClone(request);
  padded.state.issue.body = "";
  padded.state.issue.body = "x".repeat(24000 - Buffer.byteLength(JSON.stringify(padded)));
  const raw = rawEvaluation(padded);
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    expect(url).toBe("https://ai-gateway.vercel.sh/v1/evaluate");
    expect(init).toMatchObject({ method: "POST", redirect: "error", body: JSON.stringify(padded) });
    expect(Buffer.byteLength(String(init?.body))).toBe(24000);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    return Response.json(raw);
  });
  expect(await evaluateWithJev(padded, { apiKey: KEY, fetch })).toEqual(raw);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("Gateway caps UTF-8 requests before dispatch and streamed responses after dispatch", async () => {
  const oversized = structuredClone(request);
  oversized.state.issue.body = "界".repeat(10000);
  await expect(evaluateWithJev(oversized, { apiKey: KEY, fetch: forbidden })).rejects.toMatchObject(
    { code: "input-too-large", attempted: false },
  );
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("x".repeat(262145)));
  await expect(evaluateWithJev(request, { apiKey: KEY, fetch })).rejects.toMatchObject({
    code: "gateway-response-too-large",
    attempted: true,
  });
});

test("Gateway deadline includes stalled body reads and cancels the stream", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () => new Response(new ReadableStream({ cancel })),
  );
  const result = evaluateWithJev(request, { apiKey: KEY, fetch, timeoutMs: 10 });
  const checked = expect(result).rejects.toMatchObject({
    code: "gateway-timeout",
    attempted: true,
  });
  await vi.advanceTimersByTimeAsync(10);
  await checked;
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
});

test("already-aborted Gateway calls never dispatch", async () => {
  await expect(
    evaluateWithJev(request, { apiKey: KEY, fetch: forbidden, signal: AbortSignal.abort() }),
  ).rejects.toMatchObject({ code: "gateway-aborted", attempted: false });
});

test("429 diagnostics remain untrusted, redact request/key data and never expose provider prose", async () => {
  const onHttpError = vi.fn();
  const diagnostic = {
    code: "RATE_LIMIT",
    requestId: KEY,
    message: "PROVIDER_PRIVATE_PROSE",
    model: request.state.issue.body,
  };
  const response = Response.json(
    { error: diagnostic },
    { status: 429, headers: { "retry-after": "2" } },
  );
  const fetch = vi.fn<typeof globalThis.fetch>(async () => response);
  const error = await evaluateWithJev(request, { apiKey: KEY, fetch, onHttpError }).catch(
    (error) => error,
  );
  if (!(error instanceof JevError)) throw error;
  expect(error).toMatchObject({
    code: "gateway-http-error",
    attempted: true,
    status: 429,
    retryAfterSeconds: 2,
    diagnostic: {
      trust: "untrusted",
      availability: "available",
      code: "RATE_LIMIT",
      requestId: "[redacted]",
    },
  });
  expect(error.diagnostic).not.toHaveProperty("message");
  for (const secret of [KEY, request.state.issue.body, "PROVIDER_PRIVATE_PROSE"])
    expect(JSON.stringify(error)).not.toContain(secret);
  expect(onHttpError).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);
});
