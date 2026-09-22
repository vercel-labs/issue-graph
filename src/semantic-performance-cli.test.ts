import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type Call, fixture, record, repoData, TIME } from "../tests/semantic-github-fixture.js";
import { buildEvaluationInput } from "./semantic.js";
import { parseSemanticArgs, runSemanticCli, type SemanticIO } from "./semantic-cli.js";
import { buildEvaluationRequest, fingerprintEvaluation } from "./semantic-evaluation.js";
import { createSemanticEvidenceStore as nativeEvidenceStore } from "./semantic-evidence-store.js";
import { collectSemanticEvidence } from "./semantic-github.js";
import { createSemanticCacheStore, createSemanticReceiptStore } from "./semantic-store.js";
import type {
  GatewayEvaluationRequest,
  SemanticPreview,
  SemanticReport,
  SemanticTaxonomy,
} from "./semantic-types.js";
import type { GhTransport } from "./transport.js";

const LATER = "2026-09-20T01:00:00Z";
const KEY = "synthetic-performance-key-not-a-credential";
const BODY = "Synthetic public issue body retained only in private evidence";
const COMMENT = "Synthetic public comment retained only in private evidence";
const COMPONENTS = ["windows", "settings", "cli", "renderer", "storage"];
const taxonomy: SemanticTaxonomy = {
  schemaVersion: 1,
  repo: "o/r",
  version: "synthetic-performance-1",
  components: COMPONENTS.map((id) => ({ id, description: `Synthetic ${id} component` })),
};
const forbidden = vi.fn((): never => {
  throw new Error("Unexpected network, key or write access");
});
let root: string;
let home: string;
let clock: string;
let modelFixture: {
  model: string;
  answers: Record<string, unknown>;
  usage: unknown;
  providerMetadata: unknown;
};

function nodes(call: Call, response: unknown): Record<string, unknown>[] {
  const repository = repoData(response);
  if (call.operation === "Repository") return [];
  return call.operation === "Issues"
    ? (record(repository.issues).nodes as Record<string, unknown>[])
    : Object.entries(repository)
        .filter(([key]) => /^i\d+$/.test(key))
        .map(([, value]) => record(value));
}

function github(
  total = 1,
  options: {
    comments?: Record<number, number>;
    change?: (node: Record<string, unknown>, call: Call) => void;
    respond?: (call: Call, response: unknown) => unknown;
  } = {},
) {
  return fixture(total, {
    comments:
      options.comments ?? Object.fromEntries(Array.from({ length: total }, (_, i) => [i + 1, 1])),
    respond(call, response) {
      expect(call.query).not.toMatch(/\b(mutation|search|pullRequests|issueOrPullRequest)\b/);
      for (const node of nodes(call, response)) {
        if ("body" in node) node.body = BODY;
        for (const comment of record(node.comments).nodes as Record<string, unknown>[]) {
          if ("body" in comment) comment.body = `${COMMENT} ${comment.id}`;
        }
        options.change?.(node, call);
      }
      return options.respond?.(call, response) ?? response;
    },
  });
}

function evaluation(request: GatewayEvaluationRequest) {
  const answers = structuredClone(modelFixture.answers);
  const component = request.questions.component;
  if (component?.type === "choice") {
    answers.component = {
      type: "choice",
      choice: "windows",
      probabilities: Object.fromEntries(
        Object.keys(component.criteria).map((id) => [id, id === "windows" ? 1 : 0]),
      ),
    };
  }
  return { ...structuredClone(modelFixture), answers };
}

function gateway(
  respond: (request: GatewayEvaluationRequest, attempt: number) => Response | Promise<Response> = (
    request,
  ) => Response.json(evaluation(request)),
) {
  const requests: GatewayEvaluationRequest[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    expect(url).toBe("https://ai-gateway.vercel.sh/v1/evaluate");
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    expect(init?.signal?.aborted).toBe(false);
    expect(typeof init?.body).toBe("string");
    const request = JSON.parse(init?.body as string) as GatewayEvaluationRequest;
    expect(Buffer.byteLength(init?.body as string)).toBeLessThanOrEqual(24000);
    expect(request.model).toBe("typesafe-ai/jev");
    expect(request.providerOptions).toEqual({ gateway: { only: ["typesafe-ai"] } });
    expect(Object.keys(request.questions).sort()).toEqual([
      "component",
      "expectedActualPresent",
      "impactReported",
      "regressionReported",
      "reproStepsPresent",
      "requestType",
    ]);
    expect(request.questions.component).toMatchObject({
      type: "choice",
      criteria: Object.fromEntries(COMPONENTS.map((id) => [id, expect.any(String)])),
    });
    requests.push(request);
    return respond(request, requests.length);
  });
  return { fetch, requests };
}

async function run(
  flags: string[] = [],
  source: { transport: GhTransport } = github(),
  io: Partial<SemanticIO> = {},
  repo = "o/r",
) {
  let stdout = "";
  let stderr = "";
  const getGatewayApiKey = vi.fn(() => KEY);
  const result = await runSemanticCli(
    ["--repo", repo, "--taxonomy", "synthetic-taxonomy.json", ...flags],
    source.transport,
    {
      snapshotHome: home,
      now: () => clock,
      readTaxonomy: async () => structuredClone({ ...taxonomy, repo }),
      isTTY: false,
      getGatewayApiKey,
      gatewayFetch: forbidden,
      ...io,
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    },
  );
  expect(stdout + stderr).not.toContain(KEY);
  expect(stdout + stderr).not.toContain(BODY);
  expect(stdout + stderr).not.toContain(COMMENT);
  expect(stdout + stderr).not.toContain("\u001b");
  expect(source.transport.search).not.toHaveBeenCalled();
  return { exit: result, stdout, stderr, getGatewayApiKey };
}

function report(result: Awaited<ReturnType<typeof run>>) {
  const value = JSON.parse(result.stdout) as SemanticReport;
  expect(value.kind).toBe("classification-report");
  expect(value.items.every((item) => item.reviewRequired)).toBe(true);
  expect(value.performance).toBeDefined();
  for (const metric of Object.values(value.performance ?? {})) {
    expect(Number.isFinite(metric)).toBe(true);
    expect(metric).toBeGreaterThanOrEqual(0);
  }
  return value;
}

async function tree(directory = root) {
  const entries: Array<{
    path: string;
    mode: number;
    uid: number;
    nlink: number;
    mtimeNs: string;
    content: string | null;
  }> = [];
  async function visit(relative: string) {
    const path = join(directory, relative);
    const info = await lstat(path, { bigint: true });
    expect(info.isSymbolicLink()).toBe(false);
    entries.push({
      path: relative,
      mode: Number(info.mode & 0o7777n),
      uid: Number(info.uid),
      nlink: Number(info.nlink),
      mtimeNs: String(info.mtimeNs),
      content: info.isDirectory() ? null : await readFile(path, "utf8"),
    });
    if (info.isDirectory())
      for (const name of (await readdir(path)).sort()) await visit(join(relative, name));
  }
  await visit("");
  return entries;
}

function readOnlyIO(): Partial<SemanticIO> {
  const options = { home, now: () => new Date(clock).toISOString() };
  const evidence = nativeEvidenceStore(options);
  const cache = createSemanticCacheStore(options);
  return {
    evidenceStore: { read: vi.fn(evidence.read), write: forbidden },
    cacheStore: { read: vi.fn(cache.read), write: forbidden },
    receiptStore: { begin: forbidden, finish: forbidden },
    getGatewayApiKey: forbidden,
    gatewayFetch: forbidden,
    isInferenceDisabled: forbidden,
  };
}

function offline() {
  return { transport: { graphql: forbidden, search: forbidden } satisfies GhTransport };
}

function timer(onSleep?: () => void | Promise<void>) {
  let elapsed = 0;
  const sleep = vi.fn(async (ms: number) => {
    elapsed += ms;
    await onSleep?.();
  });
  return {
    wait: { now: () => elapsed, sleep },
    nowMs: () => Date.parse(clock) + elapsed,
    elapsed: () => elapsed,
  };
}

function throttle(retryAfter = "2") {
  return Response.json(
    {
      error: {
        type: "rate_limit",
        code: "synthetic_throttle",
        requestId: "fixture-request",
        message: `<b>pause</b> | [link](https://example.test) \u001b[31msecret=${KEY}\u001b[0m`,
      },
    },
    { status: 429, headers: { "retry-after": retryAfter, "x-untrusted-secret": KEY } },
  );
}

beforeEach(async () => {
  forbidden.mockClear();
  root = await realpath(await mkdtemp(join(tmpdir(), "issue-graph-performance-cli-")));
  await chmod(root, 0o700);
  home = join(root, "private-home");
  await mkdir(home, { mode: 0o700 });
  const host = join(root, "host-home");
  await mkdir(host, { mode: 0o700 });
  vi.stubEnv("HOME", host);
  vi.stubEnv("ISSUE_GRAPH_HOME", join(host, "must-stay-absent"));
  vi.stubEnv("XDG_CONFIG_HOME", join(host, "config"));
  vi.stubEnv("AI_GATEWAY_API_KEY", "");
  vi.stubGlobal("fetch", forbidden);
  clock = TIME;
  modelFixture = JSON.parse(
    await readFile(
      new URL("../tests/fixtures/classify/jev-rounded-score.json", import.meta.url),
      "utf8",
    ),
  );
});

afterEach(async () => {
  try {
    expect(forbidden).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }
});

describe("performance CLI with native private storage and synthetic services", () => {
  test("cold capture saves raw public evidence before inference, separate from evaluated answers and receipts", async () => {
    const source = github();
    const api = gateway(async (request) => {
      const saved = await nativeEvidenceStore({ home }).read("o/r", 50);
      expect(saved?.items[0]).toMatchObject({
        body: BODY,
        comments: [{ body: `${COMMENT} C_1_1` }],
      });
      const files = await tree(home);
      expect(files.filter((file) => file.path.endsWith("pending/receipt.json"))).toHaveLength(1);
      expect(files.filter((file) => file.path.includes("cache/") && file.content)).toHaveLength(0);
      return Response.json(evaluation(request));
    });
    const result = await run([], source, { gatewayFetch: api.fetch });
    expect(result.exit).toBe(0);
    expect(result.getGatewayApiKey).toHaveBeenCalledOnce();
    const value = report(result);
    expect(value.execution).toMatchObject({
      gatewayCalls: 1,
      receiptRecordsWritten: 2,
      cacheEntriesWritten: 1,
    });
    expect(value.items[0].answers?.impactReported).toMatchObject({
      score: 2.23,
      probabilities: { "0": 0, "1": 0.05, "2": 0.66, "3": 0.28 },
    });
    const files = await tree(home);
    for (const file of files) {
      expect(file.mode).toBe(file.content === null ? 0o700 : 0o600);
      expect(file.uid).toBe(process.getuid?.());
      if (file.content !== null) expect(file.nlink).toBe(1);
      expect(file.content ?? "").not.toContain(KEY);
      if (!file.path.startsWith("classify/evidence/")) {
        expect(file.content ?? "").not.toContain(BODY);
        expect(file.content ?? "").not.toContain(COMMENT);
      }
    }
    const answers = files.filter(
      (file) =>
        file.path.startsWith("classify/cache/") &&
        !file.path.endsWith("current.json") &&
        file.content !== null,
    );
    expect(answers).toHaveLength(1);
    const stored = JSON.parse(answers[0].content ?? "");
    expect(stored.response.answers).toEqual(evaluation(api.requests[0]).answers);
    expect(stored).toMatchObject({
      inputHash: value.items[0].inputHash,
      requestId: value.items[0].receipt?.pending.requestId,
      response: { model: "typesafe-ai/jev", usage: modelFixture.usage },
    });
    expect(value.performance?.githubCalls).toBe(source.calls.length);
  });

  test("76 complete issues capture in 11 calls; warm fresh uses 15 metadata calls with no key, model or tree changes", async () => {
    const comments = Object.fromEntries(Array.from({ length: 76 }, (_, i) => [i + 1, i % 11]));
    const source = github(76, { comments });
    const evidence = nativeEvidenceStore({ home, now: () => clock });
    const write = vi.fn(async (...args: Parameters<typeof evidence.write>) => {
      expect(source.calls).toHaveLength(11);
      await evidence.write(...args);
    });
    const api = gateway();
    const cold = await run(["--limit", "100", "--max-calls", "76"], source, {
      gatewayFetch: api.fetch,
      evidenceStore: { read: evidence.read, write },
    });
    expect(cold.exit).toBe(0);
    expect(write).toHaveBeenCalledOnce();
    expect(report(cold).totals.evaluated).toBe(76);
    expect(report(cold).performance?.githubCalls).toBe(source.calls.length);
    const before = await tree();
    clock = LATER;
    const checked = new Set<string>();
    const warm = github(76, {
      comments,
      change(node, call) {
        expect(call.query).not.toMatch(/\bbody\b/);
        for (const comment of record(node.comments).nodes as Record<string, unknown>[]) {
          expect(comment).toHaveProperty("updatedAt");
          expect(comment).toHaveProperty("author");
          expect(comment).toHaveProperty("url");
          checked.add(String(comment.id));
        }
      },
    });
    const result = await run(["--limit", "100"], warm, {
      getGatewayApiKey: forbidden,
      gatewayFetch: forbidden,
      receiptStore: { begin: forbidden, finish: forbidden },
      cacheStore: {
        read: createSemanticCacheStore({ home, now: () => new Date(clock).toISOString() }).read,
        write: forbidden,
      },
    });
    expect(result.exit).toBe(0);
    const value = report(result);
    expect(value.totals).toMatchObject({ cacheHits: 76, evaluated: 0, failed: 0, deferred: 0 });
    expect(value.execution).toMatchObject({
      gatewayCalls: 0,
      cacheEntriesWritten: 0,
      receiptRecordsWritten: 0,
    });
    expect(value.evidenceSource).toMatchObject({
      mode: "live",
      liveRevalidated: true,
      reusedIssues: 76,
    });
    expect(warm.calls).toHaveLength(15);
    expect(value.performance?.githubCalls).toBe(warm.calls.length);
    expect(warm.calls.filter((call) => call.operation === "Versions")).toHaveLength(8);
    expect(checked.size).toBe(Object.values(comments).reduce((sum, count) => sum + count, 0));
    expect(await tree()).toEqual(before);
  }, 30_000);

  test("native evidence round-trip preserves the fingerprint used for saved answers and locks", async () => {
    const capture = await collectSemanticEvidence(github().transport, {
      repo: "o/r",
      limit: 50,
      now: () => clock,
    });
    const store = nativeEvidenceStore({ home, now: () => clock });
    await store.write("o/r", 50, capture);
    const saved = await nativeEvidenceStore({ home }).read("o/r", 50);
    expect(saved).toEqual(capture);
    if (!saved) throw new Error("Missing saved evidence");
    const liveRequest = buildEvaluationRequest(buildEvaluationInput(capture.items[0], taxonomy));
    const savedRequest = buildEvaluationRequest(buildEvaluationInput(saved.items[0], taxonomy));
    expect(savedRequest).toEqual(liveRequest);
    expect(await fingerprintEvaluation(savedRequest, taxonomy)).toBe(
      await fingerprintEvaluation(liveRequest, taxonomy),
    );
  });

  test("cached fresh-instance reads 76 saved answers, then TTL-deferred evidence, without any external I/O or writes", async () => {
    const api = gateway();
    expect(
      (await run(["--limit", "100", "--max-calls", "76"], github(76), { gatewayFetch: api.fetch }))
        .exit,
    ).toBe(0);
    const before = await tree();
    clock = LATER;
    const fresh = readOnlyIO();
    const result = await run(["--cached", "--limit", "100"], offline(), fresh);
    const value = report(result);
    expect(result.exit).toBe(1);
    expect(value.scope.maxCalls).toBe(0);
    expect(value.evidenceSource).toEqual({
      mode: "cached",
      capturedAt: TIME,
      ageMs: 3600000,
      liveRevalidated: false,
      reusedIssues: 76,
    });
    expect(value.coverageComplete).toBe(false);
    expect.soft(value.totals).toMatchObject({ cacheHits: 76, evaluated: 0, deferred: 0 });
    expect(value.performance?.githubCalls).toBe(0);
    expect(fresh.evidenceStore?.read).toHaveBeenCalledExactlyOnceWith("o/r", 100);
    for (const item of value.items)
      expect(item.reasonCodes).toContain("cached-evidence-not-revalidated");
    clock = "2026-09-21T00:00:01Z";
    const expired = report(await run(["--cached", "--limit", "100"], offline(), readOnlyIO()));
    expect(expired.totals).toMatchObject({ cacheHits: 0, evaluated: 0, deferred: 76 });
    expect
      .soft(expired.items.every((item) => item.cacheStatus === "expired" && item.answers === null))
      .toBe(true);
    expect(await tree()).toEqual(before);
  }, 30_000);

  test("comment-free cached control reuses a response only until its exact TTL boundary", async () => {
    const cold = await run([], github(1, { comments: {} }), { gatewayFetch: gateway().fetch });
    expect(cold.exit).toBe(0);
    const before = await tree();
    for (const expired of [false, true]) {
      clock = expired ? "2026-09-21T00:00:00Z" : LATER;
      const result = await run(["--cached"], offline(), readOnlyIO());
      const value = report(result);
      expect(result.exit).toBe(1);
      expect(value.items[0].cacheStatus).toBe(expired ? "expired" : "hit");
      expect(value.totals).toMatchObject({ cacheHits: expired ? 0 : 1, deferred: expired ? 1 : 0 });
      expect(value.execution).toMatchObject({
        gatewayCalls: 0,
        cacheEntriesWritten: 0,
        receiptRecordsWritten: 0,
      });
      expect(value.performance?.githubCalls).toBe(0);
      expect(value.evidenceSource?.liveRevalidated).toBe(false);
      expect(await tree()).toEqual(before);
    }
  });

  test("cached missing evidence and wrong repo/limit scopes fail explicitly without network fallback", async () => {
    const before = await tree();
    const missing = await run(["--cached"], offline(), readOnlyIO());
    expect(missing.exit).toBe(1);
    expect(JSON.parse(missing.stdout).error.code).toBe("evidence-snapshot-missing");
    expect(await tree()).toEqual(before);
    await run(["--max-calls", "0"], github());
    const saved = await nativeEvidenceStore({ home }).read("o/r", 50);
    expect(saved).not.toBeNull();
    const after = await tree();
    for (const scope of ["limit", "repo"]) {
      const io = readOnlyIO();
      const repo = scope === "repo" ? "other/repo" : "o/r";
      const result = await run(
        ["--cached", ...(scope === "limit" ? ["--limit", "49"] : [])],
        offline(),
        io,
        repo,
      );
      expect(JSON.parse(result.stdout).error.code).toBe("evidence-snapshot-missing");
      expect(io.evidenceStore?.read).toHaveBeenCalledExactlyOnceWith(
        repo,
        scope === "limit" ? 49 : 50,
      );
    }
    expect(await tree()).toEqual(after);
  });

  test("cached changed taxonomy defers rather than reusing another fingerprint or obtaining a key", async () => {
    const api = gateway();
    const cold = report(await run([], github(), { gatewayFetch: api.fetch }));
    const before = await tree();
    const result = await run(["--cached"], offline(), {
      ...readOnlyIO(),
      readTaxonomy: async () => ({ ...taxonomy, version: "synthetic-performance-2" }),
    });
    const value = report(result);
    expect(result.exit).toBe(1);
    expect(value.items[0].inputHash).not.toBe(cold.items[0].inputHash);
    expect(value.items[0]).toMatchObject({ answers: null, cacheStatus: "miss" });
    expect(value.totals).toMatchObject({ cacheHits: 0, deferred: 1 });
    expect(await tree()).toEqual(before);
  });

  test("cached pending and unknown leases remain locked even when a successful answer exists", async () => {
    const api = gateway();
    const cold = report(await run([], github(), { gatewayFetch: api.fetch }));
    const prior = cold.items[0].receipt?.pending;
    expect(prior).toBeDefined();
    if (!prior) throw new Error("Missing durable receipt");
    const store = createSemanticReceiptStore({ home, now: () => new Date(clock).toISOString() });
    const pending = await store.begin({
      inputHash: prior.inputHash,
      modelRequested: prior.modelRequested,
      adapterVersion: prior.adapterVersion,
    });
    for (const state of ["pending", "unknown"]) {
      if (state === "unknown")
        await store.finish(pending, {
          status: "failed",
          evaluatedAt: null,
          tokenUsage: { inputTokens: null, outputTokens: null },
          reportedCostUsd: null,
          errorCode: "gateway-network-error",
          outcomeUnknown: true,
        });
      const before = await tree();
      const value = report(await run(["--cached"], offline(), readOnlyIO()));
      expect.soft(value.items[0], state).toMatchObject({
        cacheStatus: "blocked",
        answers: null,
        reasonCodes: expect.arrayContaining(["in-flight-or-unknown"]),
      });
      expect(value.totals.cacheHits).toBe(0);
      expect(await tree()).toEqual(before);
    }
  });

  test("dry-run never gets a key or writes, with or without previous evidence", async () => {
    for (const saved of [false, true]) {
      if (saved) await run(["--max-calls", "0"], github());
      const before = await tree();
      const result = await run(["--dry-run"], github(), readOnlyIO());
      expect(result.exit).toBe(0);
      const value = JSON.parse(result.stdout) as SemanticPreview;
      expect(value.kind).toBe("classification-preview");
      expect(value.execution).toMatchObject({ gatewayCalls: 0, localWrites: 0 });
      expect(value.evidenceSource?.reusedIssues).toBe(saved ? 1 : 0);
      expect(await tree()).toEqual(before);
    }
  });

  test("no-snapshot bypasses evidence/cache/receipt reads and writes without hidden host-home files", async () => {
    await run(["--max-calls", "0"], github());
    const before = await tree();
    const api = gateway();
    const io: Partial<SemanticIO> = {
      evidenceStore: { read: forbidden, write: forbidden },
      cacheStore: { read: forbidden, write: forbidden },
      receiptStore: { begin: forbidden, finish: forbidden },
      gatewayFetch: api.fetch,
    };
    const result = await run(["--no-snapshot"], github(), io);
    expect(result.exit).toBe(0);
    expect(report(result).execution).toMatchObject({
      gatewayCalls: 1,
      receipts: "memory-only",
      cache: "disabled",
      receiptRecordsWritten: 0,
      cacheEntriesWritten: 0,
    });
    expect(
      (
        await run(["--no-snapshot", "--dry-run"], github(), {
          ...io,
          getGatewayApiKey: forbidden,
          gatewayFetch: forbidden,
        })
      ).exit,
    ).toBe(0);
    expect(await tree()).toEqual(before);
  });

  test("partial comment capture cannot replace an older complete evidence snapshot", async () => {
    await run(["--max-calls", "0"], github());
    const before = await tree();
    const saved = await nativeEvidenceStore({ home }).read("o/r", 50);
    clock = LATER;
    const partial = github(1, { comments: { 1: 301 } });
    const result = await run(["--max-calls", "0"], partial, { getGatewayApiKey: forbidden });
    expect(result.exit).toBe(1);
    expect(report(result).coverageComplete).toBe(false);
    expect(await nativeEvidenceStore({ home }).read("o/r", 50)).toEqual(saved);
    expect(await tree()).toEqual(before);
  });

  test("an explicit issue-limit cohort persists without becoming complete in live or cached mode", async () => {
    const result = await run(["--limit", "1", "--max-calls", "0"], github(2));
    expect(result.exit).toBe(1);
    const saved = await nativeEvidenceStore({ home }).read("o/r", 1);
    expect(saved?.coverage).toMatchObject({
      captured: 1,
      total: 2,
      complete: false,
      reasonCodes: ["issue-limit"],
    });
    expect(saved?.items[0].commentsCoverage.complete).toBe(true);
    const before = await tree();
    const cached = report(await run(["--cached", "--limit", "1"], offline(), readOnlyIO()));
    expect(cached.coverageComplete).toBe(false);
    expect(cached.coverage).toEqual(saved?.coverage);
    expect(await tree()).toEqual(before);
  });

  test.each([
    "comment-version",
    "addition",
    "deletion",
    "author",
    "url",
    "body-version",
  ])("%s drift changes only the affected fingerprint and causes one new inference", async (change) => {
    const counts = { 1: 11, 2: 1 };
    const coldApi = gateway();
    const cold = report(
      await run([], github(2, { comments: counts }), { gatewayFetch: coldApi.fetch }),
    );
    expect(cold.totals.evaluated).toBe(2);
    clock = LATER;
    const api = gateway();
    const source = github(2, {
      comments: { ...counts, 1: change === "addition" ? 12 : change === "deletion" ? 10 : 11 },
      change(node) {
        if (node.number !== 1) return;
        if (change === "body-version") {
          node.updatedAt = LATER;
          if ("body" in node) node.body = `${BODY} edited`;
        }
        for (const comment of record(node.comments).nodes as Record<string, unknown>[]) {
          if (comment.id !== "C_1_11") continue;
          if (change === "comment-version") {
            comment.updatedAt = LATER;
            if ("body" in comment) comment.body = `${COMMENT} edited`;
          }
          if (change === "author") comment.author = { login: "changed-author" };
          if (change === "url") comment.url = "https://github.com/o/r/issues/1#issuecomment-999";
        }
      },
    });
    const result = await run([], source, { gatewayFetch: api.fetch });
    expect(result.exit).toBe(0);
    const value = report(result);
    expect(value.totals).toMatchObject({ cacheHits: 1, evaluated: 1 });
    expect(api.requests.map((request) => request.state.issue.key)).toEqual(["o/r#1"]);
    expect(value.items[0].inputHash).not.toBe(cold.items[0].inputHash);
    expect(value.items[1].inputHash).toBe(cold.items[1].inputHash);
    expect(value.evidenceSource?.reusedIssues).toBe(1);
    if (change !== "body-version") expect(value.items[0].evidence.updatedAt).toBe(TIME);
    expect(value.performance?.githubCalls).toBe(source.calls.length);
  });

  test("warm reuse checks all comment-version pages, including metadata after comment 100", async () => {
    const comments = { 1: 111 };
    await run(["--max-calls", "0"], github(1, { comments }));
    const before = await tree();
    clock = LATER;
    const observed = new Set<string>();
    const source = github(1, {
      comments,
      change(node, call) {
        expect(call.query).not.toMatch(/\bbody\b/);
        for (const comment of record(node.comments).nodes as Record<string, unknown>[])
          observed.add(String(comment.id));
      },
    });
    const value = report(await run(["--max-calls", "0"], source, { getGatewayApiKey: forbidden }));
    expect(value.evidenceSource?.reusedIssues).toBe(1);
    expect(observed.size).toBe(111);
    expect(observed.has("C_1_111")).toBe(true);
    expect(await tree()).toEqual(before);
  });

  test("fresh verification failure never falls back to saved responses", async () => {
    const api = gateway();
    await run([], github(), { gatewayFetch: api.fetch });
    const before = await tree();
    const source = github(1, {
      respond(call, response) {
        if (call.operation === "Versions") throw new Error("Synthetic metadata outage");
        return response;
      },
    });
    const result = await run([], source, { getGatewayApiKey: forbidden, gatewayFetch: forbidden });
    expect(result.exit).toBe(1);
    const value = JSON.parse(result.stdout);
    expect(
      value.kind === "classification-error" ||
        (value.totals.cacheHits === 0 && value.coverageComplete === false),
    ).toBe(true);
    expect(await tree()).toEqual(before);
  });

  test("refresh bypasses body and answer reuse while preserving snapshot history", async () => {
    await run([], github(), { gatewayFetch: gateway().fetch });
    const before = await tree(home);
    clock = LATER;
    const source = github(1, {
      change(node) {
        node.updatedAt = LATER;
        if ("body" in node) node.body = `${BODY} refreshed`;
      },
    });
    const api = gateway();
    const value = report(await run(["--refresh"], source, { gatewayFetch: api.fetch }));
    expect(value.evidenceSource?.reusedIssues).toBe(0);
    expect(value.totals).toMatchObject({ evaluated: 1, cacheHits: 0 });
    expect(source.calls.some((call) => /\bbody\b/.test(call.query))).toBe(true);
    const after = await tree(home);
    for (const file of before.filter(
      (file) =>
        file.content &&
        file.path.startsWith("classify/evidence/") &&
        !file.path.endsWith("current.json"),
    ))
      expect(after).toContainEqual(file);
  });

  test("mode conflicts and numeric bounds reject before any I/O; valid endpoints preserve defaults", async () => {
    const invalid = [
      ...["--dry-run", "--refresh", "--no-snapshot"].map((flag) => ["--cached", flag]),
      ["--cached", "--max-calls", "1"],
      ["--json", "--format", "markdown"],
      ...[
        ["--concurrency", "0", "5"],
        ["--max-retries", "-1", "4"],
        ["--min-interval-ms", "-1", "60001"],
        ["--limit", "0", "501"],
        ["--max-calls", "-1", "501"],
      ].flatMap(([flag, min, max]) => [
        [flag, min],
        [flag, max],
        [flag, "1.5"],
      ]),
    ];
    const before = await tree();
    for (const flags of invalid) {
      const result = await run(flags, offline(), { ...readOnlyIO(), readTaxonomy: forbidden });
      expect(result.exit).toBe(2);
      expect(JSON.parse(result.stdout).error.code).toBe("invalid-arguments");
    }
    expect(parseSemanticArgs(["--repo", "o/r"])).toMatchObject({
      concurrency: 1,
      maxRetries: 0,
      minIntervalMs: 0,
    });
    for (const flags of [
      [
        "--concurrency",
        "1",
        "--max-retries",
        "0",
        "--min-interval-ms",
        "0",
        "--limit",
        "1",
        "--max-calls",
        "0",
      ],
      [
        "--concurrency",
        "4",
        "--max-retries",
        "3",
        "--min-interval-ms",
        "60000",
        "--limit",
        "500",
        "--max-calls",
        "500",
      ],
    ])
      expect(() => parseSemanticArgs(["--repo", "o/r", ...flags])).not.toThrow();
    expect(parseSemanticArgs(["--repo", "o/r", "--cached", "--max-calls", "0"]).maxCalls).toBe(0);
    expect(await tree()).toEqual(before);
  });

  test("pipe JSON, forced TTY, explicit JSON and NO_COLOR retain saved-evidence warning markers", async () => {
    await run([], github(), { gatewayFetch: gateway().fetch });
    const before = await tree();
    clock = LATER;
    for (const noColor of ["", "1"]) {
      vi.stubEnv("NO_COLOR", noColor);
      for (const mode of ["pipe", "tty", "tty-json", "pipe-markdown"]) {
        const flags = [
          "--cached",
          ...(mode === "tty-json"
            ? ["--json"]
            : mode === "pipe-markdown"
              ? ["--format", "markdown"]
              : []),
        ];
        const result = await run(flags, offline(), {
          ...readOnlyIO(),
          isTTY: mode.startsWith("tty"),
        });
        expect(result.exit).toBe(1);
        if (mode === "pipe" || mode === "tty-json") {
          expect(report(result).evidenceSource).toMatchObject({
            mode: "cached",
            liveRevalidated: false,
            ageMs: 3600000,
          });
          expect(result.stderr).not.toContain("issue-graph classify:");
        } else {
          expect(result.stdout).toContain("Saved evidence, NOT live revalidated.");
          expect(result.stdout).toContain("age 3600000ms");
          expect(result.stdout).toContain("Human review required");
          if (mode === "tty")
            expect(result.stderr).toContain("saved evidence, not live revalidated");
        }
      }
    }
    expect(await tree()).toEqual(before);
  });

  test.each([
    "numeric",
    "http-date",
  ])("429 then 200 honors %s Retry-After with two durable attempts, lazy key and retained unknown cost", async (kind) => {
    const timing = timer();
    const source = github();
    const getGatewayApiKey = vi.fn(() => {
      expect(source.calls.length).toBeGreaterThan(0);
      expect(api.fetch).not.toHaveBeenCalled();
      return KEY;
    });
    const api = gateway((request, attempt) =>
      attempt === 1
        ? throttle(kind === "numeric" ? "2" : new Date(Date.parse(TIME) + 2000).toUTCString())
        : Response.json(evaluation(request)),
    );
    const result = await run(["--max-retries", "1", "--max-calls", "2"], source, {
      gatewayFetch: api.fetch,
      getGatewayApiKey,
      wait: timing.wait,
      nowMs: timing.nowMs,
    });
    expect(result.exit).toBe(0);
    const value = report(result);
    expect(getGatewayApiKey).toHaveBeenCalledOnce();
    expect(timing.elapsed()).toBe(2000);
    expect(api.requests).toHaveLength(2);
    expect(api.requests[1]).toEqual(api.requests[0]);
    expect(value.execution).toMatchObject({
      gatewayCalls: 2,
      receiptRecordsWritten: 4,
      cacheEntriesWritten: 1,
    });
    expect(value.totals).toMatchObject({
      evaluated: 1,
      failed: 0,
      hasUnknownCost: true,
      reportedCostUsd: 0,
    });
    const attempts = value.items[0].attempts ?? [];
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts.map((attempt) => attempt.receipt.pending.requestId)).size).toBe(2);
    expect(attempts[0].receipt.final?.result).toMatchObject({
      status: "failed",
      outcomeUnknown: false,
      reportedCostUsd: null,
    });
    expect(attempts[1].receipt.final?.result.status).toBe("succeeded");
    expect(attempts[0].providerError).toMatchObject({
      status: 429,
      diagnostic: {
        trust: "untrusted",
        availability: "available",
        code: "synthetic_throttle",
        requestId: "fixture-request",
      },
    });
    expect(attempts[0].providerError?.diagnostic).not.toHaveProperty("providerReported");
    expect(attempts[0].providerError?.diagnostic).not.toHaveProperty("message");
    expect(value.items[0].providerError).toBeNull();
    for (const attempt of attempts) {
      expect(Number.isFinite(attempt.gatewayTiming?.totalMs)).toBe(true);
      const pending = attempt.receipt.pending;
      const final = join(
        home,
        "classify",
        "receipts",
        pending.createdAt.slice(0, 10),
        pending.requestId,
        "final",
        "receipt.json",
      );
      expect(JSON.parse(await readFile(final, "utf8"))).toEqual(attempt.receipt.final);
    }
    expect(JSON.stringify(await tree())).not.toContain(KEY);
  });

  test("default retry policy stops after one 429 and omits arbitrary provider prose", async () => {
    const timing = timer();
    const api = gateway(() => throttle());
    const result = await run([], github(), {
      gatewayFetch: api.fetch,
      isTTY: true,
      wait: timing.wait,
    });
    expect(result.exit).toBe(1);
    expect(api.fetch).toHaveBeenCalledOnce();
    expect(timing.wait.sleep).not.toHaveBeenCalled();
    expect(result.stdout).toContain("provider diagnostic (untrusted)");
    expect(result.stdout).toContain("retries\\-disabled");
    expect(result.stdout).toContain("synthetic\\_throttle");
    expect(result.stdout).toContain("fixture\\-request");
    expect(result.stdout).not.toContain("&lt;b&gt;pause&lt;/b&gt;");
    expect(result.stdout).not.toContain("example.test");
    expect(result.stdout).not.toContain("<b>");
    expect(result.stdout).not.toContain("[link](https://example.test)");
  });

  test.each([
    "STOP",
    "abort",
  ])("%s during injected retry wait prevents the next attempt and pending receipt", async (stop) => {
    const controller = new AbortController();
    const timing = timer(async () => {
      if (stop === "abort") controller.abort("synthetic-private-abort-reason");
      else await writeFile(join(home, "classify", "STOP"), "", { mode: 0o600 });
    });
    const api = gateway(() => throttle());
    const result = await run(["--max-retries", "1", "--max-calls", "2"], github(), {
      gatewayFetch: api.fetch,
      signal: controller.signal,
      wait: timing.wait,
    });
    expect(result.exit).toBe(1);
    expect(api.fetch).toHaveBeenCalledOnce();
    expect(timing.wait.sleep).toHaveBeenCalledOnce();
    const value = report(result);
    expect(value.execution).toMatchObject({ gatewayCalls: 1, receiptRecordsWritten: 2 });
    expect(value.items[0].attempts).toHaveLength(1);
    expect(value.items[0].reasonCodes).toContain(
      stop === "STOP" ? "inference-disabled" : "run-aborted",
    );
    expect(result.stdout + result.stderr).not.toContain("synthetic-private-abort-reason");
    expect(
      (await tree(home)).filter((file) => file.path.endsWith("pending/receipt.json")),
    ).toHaveLength(1);
  });

  test("concurrency two shares a small attempt budget, including retries, while retaining useful work", async () => {
    const timing = timer();
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    let peak = 0;
    const api = gateway(async (request, attempt) => {
      active++;
      peak = Math.max(peak, active);
      if (attempt === 2) release();
      if (attempt <= 2) await bothStarted;
      active--;
      return attempt <= 2 ? throttle("0") : Response.json(evaluation(request));
    });
    const result = await run(
      ["--concurrency", "2", "--max-calls", "3", "--max-retries", "1"],
      github(4),
      { gatewayFetch: api.fetch, wait: timing.wait },
    );
    const value = report(result);
    expect(result.exit).toBe(1);
    expect(peak).toBe(2);
    expect(api.requests).toHaveLength(3);
    expect(value.execution).toMatchObject({
      gatewayCalls: 3,
      receiptRecordsWritten: 6,
      cacheEntriesWritten: 1,
    });
    expect(value.totals).toMatchObject({ evaluated: 1, hasUnknownCost: true });
    const attempts = value.items.flatMap((item) => item.attempts ?? []);
    expect(attempts).toHaveLength(3);
    expect(new Set(attempts.map((attempt) => attempt.receipt.pending.requestId)).size).toBe(3);
    expect(
      value.items
        .slice(2)
        .every((item) => item.answers === null && item.reasonCodes.includes("max-calls-reached")),
    ).toBe(true);
  });

  test("excessive Retry-After defers without shortening the wait or sending another request", async () => {
    const timing = timer();
    const api = gateway(() => throttle("31"));
    const result = await run(["--max-retries", "1", "--max-calls", "2"], github(), {
      gatewayFetch: api.fetch,
      wait: timing.wait,
    });
    expect(result.exit).toBe(1);
    const value = report(result);
    expect(api.fetch).toHaveBeenCalledOnce();
    expect(timing.wait.sleep).not.toHaveBeenCalled();
    expect(value.items[0].attempts).toHaveLength(1);
    expect(value.items[0].providerError).toMatchObject({
      status: 429,
      retryAfterSeconds: 31,
      retryRefusalReason: "retry-wait-exceeds-limit",
    });
    expect(value.totals.hasUnknownCost).toBe(true);
  });
});
