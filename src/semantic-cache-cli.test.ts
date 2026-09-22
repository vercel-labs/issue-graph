import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type Call,
  fixture as githubFixture,
  record,
  repoData,
} from "../tests/semantic-github-fixture.js";
import { rawEvaluation } from "../tests/semantic-response-fixture.js";
import { SEMANTIC_MAX_INPUT_BYTES } from "./semantic.js";
import { runSemanticCli, type SemanticIO } from "./semantic-cli.js";
import { decideSuggestion } from "./semantic-evaluation.js";
import { createSemanticCacheStore, createSemanticReceiptStore } from "./semantic-store.js";
import type {
  GatewayEvaluationRequest,
  SemanticCacheStore,
  SemanticPendingReceipt,
  SemanticPolicy,
  SemanticPreview,
  SemanticReceiptStore,
  SemanticReport,
} from "./semantic-types.js";

const TIME = "2026-09-20T00:00:00.000Z";
const LATER = "2026-09-20T01:00:00.000Z";
const KEY = "fake-cache-cli-key-not-a-credential";
const BODY = "synthetic-private-body-marker-not-for-persistence";
const COMMENT = "synthetic-comment-marker-not-for-persistence";
const network = vi.fn(() => {
  throw new Error("Live network is forbidden");
});
let directory: string;
let home: string;
let clock: string;

function github(
  total = 1,
  options: {
    editedComment?: number;
    changedBody?: boolean;
    body?: string;
    respond?: (call: Call, response: unknown) => unknown;
  } = {},
) {
  return githubFixture(total, {
    comments: Object.fromEntries(Array.from({ length: total }, (_, index) => [index + 1, 1])),
    respond: (call, response) => {
      expect(call.query).not.toMatch(/\b(mutation|search|pullRequests)\b/);
      const repository = repoData(response);
      const nodes =
        call.operation === "Repository"
          ? []
          : call.operation === "Issues"
            ? (record(repository.issues).nodes as unknown[])
            : Object.entries(repository)
                .filter(([key]) => /^i\d+$/.test(key))
                .map(([, node]) => node);
      for (const value of nodes) {
        const node = record(value);
        node.title = `Synthetic cache fixture ${node.number}`;
        node.updatedAt = options.changedBody || options.body !== undefined ? LATER : TIME;
        if ("body" in node)
          node.body = options.body ?? (options.changedBody ? `${BODY} changed input` : BODY);
        for (const value of record(node.comments).nodes as unknown[]) {
          const comment = record(value);
          const edited = options.editedComment === node.number;
          comment.id = `C_${node.number}`;
          comment.url = `https://github.com/o/r/issues/${node.number}#issuecomment-${node.number}`;
          comment.author = { login: "synthetic" };
          comment.updatedAt = edited ? LATER : TIME;
          if ("body" in comment) comment.body = edited ? `${COMMENT} edited` : COMMENT;
        }
      }
      return options.respond ? options.respond(call, response) : response;
    },
  });
}

function evaluation(request: GatewayEvaluationRequest, cost: string | null = "0.125") {
  return rawEvaluation(request, { cost });
}

function gateway(
  respond: (request: GatewayEvaluationRequest) => Response | Promise<Response> = (request) =>
    Response.json(evaluation(request)),
) {
  const requests: GatewayEvaluationRequest[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    expect(url).toBe("https://ai-gateway.vercel.sh/v1/evaluate");
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    if (typeof init?.body !== "string") throw new Error("Missing synthetic request");
    const request = JSON.parse(init.body) as GatewayEvaluationRequest;
    expect(request.providerOptions).toEqual({ gateway: { only: ["typesafe-ai"] } });
    requests.push(request);
    return respond(request);
  });
  return { fetch, requests };
}

async function run(
  api: ReturnType<typeof gateway>,
  flags: string[] = [],
  source = github(),
  options: Partial<SemanticIO> = {},
) {
  let stdout = "";
  let stderr = "";
  const getGatewayApiKey = vi.fn(() => KEY);
  const exit = await runSemanticCli(["--repo", "o/r", ...flags], source.transport, {
    isTTY: false,
    snapshotHome: home,
    now: () => clock,
    getGatewayApiKey,
    gatewayFetch: api.fetch,
    evidenceStore: { read: async () => null, write: async () => {} },
    ...options,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  for (const secret of [KEY, BODY, COMMENT]) expect(stdout + stderr).not.toContain(secret);
  expect(source.transport.search).not.toHaveBeenCalled();
  return { exit, stdout, stderr, getGatewayApiKey };
}

function report(result: Awaited<ReturnType<typeof run>>): SemanticReport {
  const value: SemanticReport = JSON.parse(result.stdout);
  expect(value).toMatchObject({ schemaVersion: 1, kind: "classification-report" });
  for (const item of value.items) {
    expect(item.reviewRequired).toBe(true);
    expect(item).not.toHaveProperty("plannedCall");
  }
  return value;
}

function preview(result: Awaited<ReturnType<typeof run>>): SemanticPreview {
  const value: SemanticPreview = JSON.parse(result.stdout);
  expect(value).toMatchObject({ schemaVersion: 1, kind: "classification-preview" });
  return value;
}

async function snapshot(root = directory) {
  const entries: Array<{
    path: string;
    mode: number;
    mtimeMs: number;
    ctimeMs: number;
    birthtimeMs: number;
    content: string | null;
  }> = [];
  async function visit(relative: string) {
    const path = join(root, relative);
    const info = await stat(path);
    entries.push({
      path: relative,
      mode: info.mode,
      mtimeMs: info.mtimeMs,
      ctimeMs: info.ctimeMs,
      birthtimeMs: info.birthtimeMs,
      content: info.isDirectory() ? null : await readFile(path, "utf8"),
    });
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(relative, name));
    }
  }
  await visit("");
  return entries;
}

function pending(value: SemanticReport) {
  const receipt = value.items[0].receipt?.pending;
  if (!receipt) throw new Error("Expected real durable pending receipt");
  expect(receipt.durable).toBe(true);
  return receipt;
}

function cachePath(receipt: SemanticPendingReceipt) {
  return join(home, "classify", "cache", receipt.inputHash, `${receipt.requestId}.json`);
}

function receiptPath(receipt: SemanticPendingReceipt, phase: "pending" | "final") {
  return join(
    home,
    "classify",
    "receipts",
    receipt.createdAt.slice(0, 10),
    receipt.requestId,
    phase,
    "receipt.json",
  );
}

async function currentPending(): Promise<SemanticPendingReceipt> {
  const locks = join(home, "classify", "locks");
  const names = await readdir(locks);
  expect(names).toHaveLength(1);
  return JSON.parse(await readFile(join(locks, names[0]), "utf8"));
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(async () => {
  network.mockClear();
  vi.stubGlobal("fetch", network);
  directory = await mkdtemp(join(tmpdir(), "issue-graph-semantic-cache-cli-"));
  home = join(directory, "home");
  clock = TIME;
});

afterEach(async () => {
  try {
    expect(network).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  }
});

describe("real CLI cache integration with synthetic responses", () => {
  test.each([
    { label: "default inference", flags: [], dryRun: false },
    { label: "no-snapshot inference", flags: ["--no-snapshot"], dryRun: false },
    { label: "refresh inference", flags: ["--refresh"], dryRun: false },
    { label: "default preview", flags: ["--dry-run"], dryRun: true },
    { label: "no-snapshot preview", flags: ["--dry-run", "--no-snapshot"], dryRun: true },
    { label: "refresh preview", flags: ["--dry-run", "--refresh"], dryRun: true },
  ])("oversized-only $label accounts for unsent input without key, cache or receipt I/O", async ({
    flags,
    dryRun,
  }) => {
    const api = gateway();
    const source = github(1, { body: "界".repeat(10_000) });
    const read = vi.fn<SemanticCacheStore["read"]>();
    const write = vi.fn<SemanticCacheStore["write"]>();
    const begin = vi.fn<SemanticReceiptStore["begin"]>();
    const finish = vi.fn<SemanticReceiptStore["finish"]>();
    const isInferenceDisabled = vi.fn(() => false);
    const before = await snapshot();
    const result = await run(api, flags, source, {
      cacheStore: { read, write },
      receiptStore: { begin, finish },
      isInferenceDisabled,
    });
    expect(result.exit).toBe(dryRun ? 0 : 1);
    expect(result.stderr).toBe(
      dryRun
        ? ""
        : "INCOMPLETE_CLASSIFICATION: inspect coverage, failures and receipts; do not retry unknown outcomes blindly.\n",
    );
    const value = dryRun ? preview(result) : report(result);
    const noSnapshot = flags.includes("--no-snapshot");
    expect(value.coverageComplete).toBe(true);
    expect(value.items).toHaveLength(1);
    expect(value.items[0]).toMatchObject({
      outcome: "needs-review",
      reviewRequired: true,
      reasonCodes: ["taxonomy-missing", "input-too-large"],
      inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      cacheStatus: noSnapshot ? "disabled" : "not-checked",
      cacheEvaluatedAt: null,
      cacheSourceRequestId: null,
      evidence: { commentsCoverage: { complete: true } },
    });
    expect(value.items[0].inputBytes).toBeGreaterThan(SEMANTIC_MAX_INPUT_BYTES);
    if (value.kind === "classification-report") {
      expect(value.execution).toEqual({
        dryRun: false,
        gatewayCalls: 0,
        receiptRecordsWritten: 0,
        receipts: noSnapshot ? "memory-only" : "durable",
        cache: noSnapshot ? "disabled" : "enabled",
        cacheEntriesWritten: 0,
      });
      expect(value.totals).toEqual({
        captured: 1,
        evaluated: 0,
        cacheHits: 0,
        suggested: 0,
        needsReview: 1,
        skipped: 0,
        failed: 0,
        deferred: 1,
        oversized: 1,
        reportedCostUsd: 0,
        hasUnknownCost: false,
        cachedHistoricalCostUsd: 0,
        hasUnknownHistoricalCost: false,
      });
      expect(value.items[0]).toMatchObject({
        answers: null,
        impactReportedStatus: "unavailable",
        provenance: null,
        receipt: null,
        providerError: null,
      });
    } else {
      expect(value.execution).toEqual({
        dryRun: true,
        gatewayCalls: 0,
        localWrites: 0,
        cache: noSnapshot ? "disabled" : "read-only",
      });
      expect(value.totals).toEqual({
        captured: 1,
        eligible: 0,
        plannedCalls: 0,
        cacheHits: 0,
        deferred: 0,
        excluded: 0,
        failed: 0,
        oversized: 1,
        reportedCostUsd: 0,
        hasUnknownCost: false,
      });
      expect(value.items[0].plannedCall).toBe(false);
      expect(value.items[0]).not.toHaveProperty("answers");
    }
    for (const spy of [
      read,
      write,
      begin,
      finish,
      isInferenceDisabled,
      result.getGatewayApiKey,
      api.fetch,
    ]) {
      expect(spy).not.toHaveBeenCalled();
    }
    expect(api.requests).toEqual([]);
    expect(source.calls.map((call) => call.operation)).toEqual([
      "Repository",
      "Issues",
      "Repository",
      "Versions",
      "Repository",
    ]);
    expect(source.calls.find((call) => call.operation === "Issues")?.query).toMatch(/\bbody\b/);
    expect(source.calls.find((call) => call.operation === "Versions")?.query).not.toMatch(
      /\bbody\b/,
    );
    expect(await snapshot()).toEqual(before);
    expect(await readdir(directory)).toEqual([]);
  });

  test("cold then hot separates current spend from historical cost and correlates persisted provenance", async () => {
    const api = gateway();
    const cold = await run(api);
    expect(cold.exit).toBe(0);
    expect(cold.stderr).toBe("");
    expect(cold.getGatewayApiKey).toHaveBeenCalledTimes(1);
    const first = report(cold);
    expect(first.execution).toEqual({
      dryRun: false,
      gatewayCalls: 1,
      receiptRecordsWritten: 2,
      receipts: "durable",
      cache: "enabled",
      cacheEntriesWritten: 1,
    });
    expect(first.totals).toMatchObject({
      evaluated: 1,
      cacheHits: 0,
      reportedCostUsd: 0.125,
      hasUnknownCost: false,
      cachedHistoricalCostUsd: 0,
      hasUnknownHistoricalCost: false,
    });
    expect(first.items[0]).toMatchObject({ cacheStatus: "miss", provenance: { cacheHit: false } });
    const receipt = pending(first);
    const saved = JSON.parse(await readFile(cachePath(receipt), "utf8"));
    expect(saved).toMatchObject({
      requestId: receipt.requestId,
      inputHash: receipt.inputHash,
      evaluatedAt: TIME,
      expiresAt: "2026-09-21T00:00:00.000Z",
    });
    expect(JSON.parse(await readFile(receiptPath(receipt, "final"), "utf8"))).toEqual(
      first.items[0].receipt?.final,
    );
    const before = await snapshot();
    clock = LATER;
    const hot = await run(api);
    const second = report(hot);
    expect(hot.exit).toBe(0);
    expect(hot.stderr).toBe("");
    expect(hot.getGatewayApiKey).not.toHaveBeenCalled();
    expect(api.fetch).toHaveBeenCalledTimes(1);
    expect(second.execution).toMatchObject({
      gatewayCalls: 0,
      receiptRecordsWritten: 0,
      cacheEntriesWritten: 0,
      cache: "enabled",
    });
    expect(second.totals).toMatchObject({
      evaluated: 0,
      cacheHits: 1,
      suggested: 1,
      reportedCostUsd: 0,
      hasUnknownCost: false,
      cachedHistoricalCostUsd: 0.125,
      hasUnknownHistoricalCost: false,
    });
    expect(second.captureWindow).toEqual({ startedAt: LATER, completedAt: LATER });
    expect(second.items[0]).toMatchObject({
      inputHash: first.items[0].inputHash,
      cacheStatus: "hit",
      cacheEvaluatedAt: TIME,
      cacheSourceRequestId: receipt.requestId,
      receipt: null,
      providerError: null,
      answers: first.items[0].answers,
      provenance: { ...first.items[0].provenance, cacheHit: true, evaluatedAt: TIME },
    });
    expect(await snapshot()).toEqual(before);
    const persisted = JSON.stringify(before);
    for (const secret of [KEY, BODY, COMMENT]) expect(persisted).not.toContain(secret);
    expect(api.requests[0].state.issue.body).toBe(BODY);
    expect(api.requests[0].state.issue.comments[0].body).toBe(COMMENT);
  });

  test("unknown historical cost is not unknown current cost or silently reported as a free call", async () => {
    const api = gateway((request) => Response.json(evaluation(request, null)));
    const cold = await run(api);
    expect(cold.exit).toBe(0);
    expect(report(cold).totals).toMatchObject({ reportedCostUsd: 0, hasUnknownCost: true });
    const hot = await run(api, ["--max-calls", "0"]);
    expect(hot.exit).toBe(0);
    expect(hot.getGatewayApiKey).not.toHaveBeenCalled();
    expect(report(hot).totals).toMatchObject({
      cacheHits: 1,
      reportedCostUsd: 0,
      hasUnknownCost: false,
      cachedHistoricalCostUsd: 0,
      hasUnknownHistoricalCost: true,
    });
    expect(report(hot).items[0].provenance?.reportedCostUsd).toBeNull();
    const markdown = await run(api, ["--format", "markdown"]);
    expect(markdown.exit).toBe(0);
    expect(markdown.stdout).toContain("unknown cost: no. Current run only");
    expect(markdown.stdout).toContain("unknown historical cost: yes.");
    expect(api.fetch).toHaveBeenCalledTimes(1);
  });

  test("zero budget reuses every warm issue without reading the key or writing any file", async () => {
    const api = gateway();
    expect((await run(api, [], github(2))).exit).toBe(0);
    const before = await snapshot();
    const key = vi.fn(() => {
      throw new Error("Cache-only must not read credentials");
    });
    const hot = await run(api, ["--max-calls", "0"], github(2), { getGatewayApiKey: key });
    expect(hot.exit).toBe(0);
    expect(report(hot).totals).toMatchObject({ cacheHits: 2, evaluated: 0, deferred: 0 });
    expect(report(hot).execution.gatewayCalls).toBe(0);
    expect(key).not.toHaveBeenCalled();
    expect(api.fetch).toHaveBeenCalledTimes(2);
    expect(await snapshot()).toEqual(before);
  });

  test.each([
    "miss",
    "expired",
    "refresh",
  ] as const)("zero budget defers %s without reading a key, creating a receipt or making HTTP attempts", async (status) => {
    const api = gateway();
    if (status !== "miss") expect((await run(api)).exit).toBe(0);
    if (status === "expired") clock = "2026-09-21T00:00:00.000Z";
    const before = await snapshot();
    const calls = api.fetch.mock.calls.length;
    const result = await run(api, [
      "--max-calls",
      "0",
      ...(status === "refresh" ? ["--refresh"] : []),
    ]);
    expect(result.exit).toBe(1);
    expect(result.getGatewayApiKey).not.toHaveBeenCalled();
    expect(report(result)).toMatchObject({
      execution: { gatewayCalls: 0, receiptRecordsWritten: 0, cacheEntriesWritten: 0 },
      totals: { cacheHits: 0, evaluated: 0, deferred: 1, failed: 0 },
      items: [
        {
          cacheStatus: status,
          receipt: null,
          answers: null,
          reasonCodes: expect.arrayContaining(["max-calls-reached"]),
        },
      ],
    });
    expect(api.fetch).toHaveBeenCalledTimes(calls);
    expect(await snapshot()).toEqual(before);
  });

  test("dry-run reads real cache hits without keys, writes, or changed content and timestamps", async () => {
    const api = gateway();
    const cold = report(await run(api, [], github(2)));
    const before = await snapshot();
    clock = LATER;
    const result = await run(api, ["--dry-run", "--max-calls", "0"], github(2));
    expect(result.exit).toBe(0);
    expect(result.getGatewayApiKey).not.toHaveBeenCalled();
    const value = preview(result);
    expect(value.execution).toEqual({
      dryRun: true,
      gatewayCalls: 0,
      localWrites: 0,
      cache: "read-only",
    });
    expect(value.totals).toMatchObject({
      cacheHits: 2,
      plannedCalls: 0,
      deferred: 0,
      reportedCostUsd: 0,
      hasUnknownCost: false,
    });
    for (const [index, item] of value.items.entries()) {
      expect(item).toMatchObject({
        cacheStatus: "hit",
        plannedCall: false,
        cacheEvaluatedAt: TIME,
        cacheSourceRequestId: cold.items[index].receipt?.pending.requestId,
        reviewRequired: true,
      });
      expect(item).not.toHaveProperty("answers");
      expect(item).not.toHaveProperty("receipt");
    }
    expect(api.fetch).toHaveBeenCalledTimes(2);
    expect(await snapshot()).toEqual(before);
    const refreshed = await run(api, ["--dry-run", "--refresh"], github(2));
    expect(refreshed.exit).toBe(0);
    expect(preview(refreshed).totals).toMatchObject({ cacheHits: 0, plannedCalls: 2 });
    expect(preview(refreshed).items.every((item) => item.cacheStatus === "refresh")).toBe(true);
    expect(refreshed.getGatewayApiKey).not.toHaveBeenCalled();
    expect(api.fetch).toHaveBeenCalledTimes(2);
    expect(await snapshot()).toEqual(before);
  });

  test("refresh performs a full fresh capture and new attempt while preserving immutable response and receipt history", async () => {
    const api = gateway();
    const first = report(await run(api));
    const original = pending(first);
    const history = await snapshot(join(home, "classify", "receipts"));
    const saved = await readFile(cachePath(original), "utf8");
    const savedStat = await stat(cachePath(original));
    clock = LATER;
    const source = github();
    const result = await run(api, ["--refresh"], source);
    const value = report(result);
    expect(result.exit).toBe(0);
    expect(result.getGatewayApiKey).toHaveBeenCalledTimes(1);
    expect(value.execution).toMatchObject({
      gatewayCalls: 1,
      cacheEntriesWritten: 1,
      receiptRecordsWritten: 2,
    });
    expect(value.totals).toMatchObject({
      evaluated: 1,
      cacheHits: 0,
      reportedCostUsd: 0.125,
      cachedHistoricalCostUsd: 0,
    });
    expect(value.items[0]).toMatchObject({
      cacheStatus: "refresh",
      inputHash: original.inputHash,
      provenance: { cacheHit: false, evaluatedAt: LATER },
    });
    const refreshed = pending(value);
    expect(refreshed.requestId).not.toBe(original.requestId);
    expect(source.calls.map((call) => call.operation)).toEqual([
      "Repository",
      "Issues",
      "Repository",
      "Versions",
      "Repository",
      "Versions",
      "Versions",
      "Versions",
    ]);
    expect(source.calls.find((call) => call.operation === "Issues")?.query).toMatch(/\bbody\b/);
    for (const call of source.calls.filter((call) => call.operation === "Versions")) {
      expect(call.query).not.toMatch(/\bbody\b/);
      expect(call.query).toContain("comments(first: $first0, after: $after0)");
      expect(call.variables).toEqual({ owner: "o", repo: "r", number0: 1, first0: 10 });
    }
    expect(api.requests[1]).toEqual(api.requests[0]);
    expect(api.fetch).toHaveBeenCalledTimes(2);
    expect(await readFile(cachePath(original), "utf8")).toBe(saved);
    const afterStat = await stat(cachePath(original));
    expect(afterStat.mtimeMs).toBe(savedStat.mtimeMs);
    expect(afterStat.ctimeMs).toBe(savedStat.ctimeMs);
    const afterHistory = await snapshot(join(home, "classify", "receipts"));
    for (const entry of history.filter((entry) => entry.path.includes(original.requestId))) {
      expect(afterHistory).toContainEqual(entry);
    }
    expect((await readdir(join(home, "classify", "cache", original.inputHash))).sort()).toEqual(
      [`${original.requestId}.json`, `${refreshed.requestId}.json`, "current.json"].sort(),
    );
    const hot = await run(api);
    expect(hot.exit).toBe(0);
    expect(report(hot).items[0]).toMatchObject({
      cacheSourceRequestId: refreshed.requestId,
      cacheEvaluatedAt: LATER,
    });
    expect(api.fetch).toHaveBeenCalledTimes(2);
  });

  test.each([
    false,
    true,
  ])("no-snapshot bypasses warm cache and writes nothing, changed input=%s", async (changedBody) => {
    const api = gateway();
    const cold = report(await run(api));
    const before = await snapshot();
    const read = vi.fn(async () => {
      throw new Error("No cache reads allowed");
    });
    const write = vi.fn(async () => {
      throw new Error("No cache writes allowed");
    });
    const begin = vi.fn(async () => {
      throw new Error("No disk receipts allowed");
    });
    const finish = vi.fn(async () => {
      throw new Error("No disk receipts allowed");
    });
    const evidenceRead = vi.fn(async () => {
      throw new Error("No evidence reads allowed");
    });
    const evidenceWrite = vi.fn(async () => {
      throw new Error("No evidence writes allowed");
    });
    const options = {
      cacheStore: { read, write },
      receiptStore: { begin, finish },
      evidenceStore: { read: evidenceRead, write: evidenceWrite },
    };
    const result = await run(api, ["--no-snapshot"], github(1, { changedBody }), options);
    expect(result.exit).toBe(0);
    const value = report(result);
    expect(value.execution).toEqual({
      dryRun: false,
      gatewayCalls: 1,
      receiptRecordsWritten: 0,
      receipts: "memory-only",
      cache: "disabled",
      cacheEntriesWritten: 0,
    });
    expect(value.items[0]).toMatchObject({
      cacheStatus: "disabled",
      provenance: { cacheHit: false },
      receipt: { pending: { durable: false }, final: { durable: false } },
    });
    if (changedBody) {
      expect(value.items[0].inputHash).not.toBe(cold.items[0].inputHash);
      expect(api.requests[1].state.issue.body).toBe(`${BODY} changed input`);
      expect(api.requests[1].state.issue.updatedAt).toBe(LATER);
    } else {
      expect(value.items[0].inputHash).toBe(cold.items[0].inputHash);
    }
    const zero = await run(api, ["--no-snapshot", "--max-calls", "0"], github(), options);
    expect(zero.exit).toBe(1);
    expect(zero.getGatewayApiKey).not.toHaveBeenCalled();
    expect(report(zero)).toMatchObject({
      execution: { gatewayCalls: 0 },
      totals: { deferred: 1, cacheHits: 0 },
      items: [{ cacheStatus: "disabled", receipt: null, answers: null }],
    });
    const dry = await run(api, ["--dry-run", "--no-snapshot"], github(), options);
    expect(dry.exit).toBe(0);
    expect(preview(dry)).toMatchObject({
      execution: { cache: "disabled", localWrites: 0 },
      totals: { cacheHits: 0, plannedCalls: 1 },
    });
    for (const spy of [read, write, begin, finish, evidenceRead, evidenceWrite])
      expect(spy).not.toHaveBeenCalled();
    expect(api.fetch).toHaveBeenCalledTimes(2);
    expect(await snapshot()).toEqual(before);
  });

  test("TTL hits at 24h minus 1ms, expires at exactly 24h, and does not slide on reads", async () => {
    const api = gateway();
    const original = pending(report(await run(api)));
    const before = await snapshot();
    clock = "2026-09-20T23:59:59.999Z";
    const warm = await run(api, ["--max-calls", "0"]);
    expect(warm.exit).toBe(0);
    expect(report(warm).items[0]).toMatchObject({ cacheStatus: "hit", cacheEvaluatedAt: TIME });
    clock = "2026-09-21T00:00:00.000Z";
    const expired = await run(api, ["--max-calls", "0"]);
    expect(expired.exit).toBe(1);
    expect(report(expired).items[0].cacheStatus).toBe("expired");
    expect(expired.getGatewayApiKey).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
    const renewed = await run(api);
    expect(renewed.exit).toBe(0);
    expect(report(renewed)).toMatchObject({
      execution: { gatewayCalls: 1 },
      items: [{ cacheStatus: "expired", provenance: { evaluatedAt: clock, cacheHit: false } }],
    });
    expect(pending(report(renewed)).requestId).not.toBe(original.requestId);
    expect(api.fetch).toHaveBeenCalledTimes(2);
  });

  test("switching epochs misses and restoring the original epoch reuses its saved response", async () => {
    const api = gateway();
    const first = report(await run(api, [], github(), { cacheEpoch: "synthetic-a" }));
    const secondResult = await run(api, [], github(), { cacheEpoch: "synthetic-b" });
    expect(secondResult.exit).toBe(0);
    const second = report(secondResult);
    expect(second.items[0].cacheStatus).toBe("miss");
    expect(second.items[0].inputHash).not.toBe(first.items[0].inputHash);
    const before = await snapshot();
    const restored = await run(api, ["--max-calls", "0"], github(), { cacheEpoch: "synthetic-a" });
    expect(restored.exit).toBe(0);
    expect(report(restored)).toMatchObject({
      cacheEpoch: "synthetic-a",
      items: [
        {
          cacheStatus: "hit",
          inputHash: first.items[0].inputHash,
          cacheSourceRequestId: pending(first).requestId,
        },
      ],
    });
    expect(restored.getGatewayApiKey).not.toHaveBeenCalled();
    expect(api.fetch).toHaveBeenCalledTimes(2);
    expect(await snapshot()).toEqual(before);
  });

  test("editing one comment invalidates only its issue in a two-issue batch", async () => {
    const api = gateway();
    const first = report(await run(api, [], github(2)));
    const result = await run(api, ["--max-calls", "1"], github(2, { editedComment: 1 }));
    expect(result.exit).toBe(0);
    const value = report(result);
    expect(value.execution.gatewayCalls).toBe(1);
    expect(value.totals).toMatchObject({
      cacheHits: 1,
      evaluated: 1,
      deferred: 0,
      reportedCostUsd: 0.125,
      cachedHistoricalCostUsd: 0.125,
    });
    expect(value.items[0].cacheStatus).toBe("miss");
    expect(value.items[0].inputHash).not.toBe(first.items[0].inputHash);
    expect(value.items[1]).toMatchObject({
      cacheStatus: "hit",
      inputHash: first.items[1].inputHash,
      receipt: null,
    });
    expect(api.requests.map((request) => request.state.issue.key)).toEqual([
      "o/r#1",
      "o/r#2",
      "o/r#1",
    ]);
    expect(api.requests[2].state.issue.updatedAt).toBe(api.requests[0].state.issue.updatedAt);
    expect(api.requests[2].state.issue.updatedAt).toBe(TIME);
    expect(api.requests[2].state.issue.comments[0]).toMatchObject({
      body: `${COMMENT} edited`,
      updatedAt: LATER,
    });
  });

  test("taxonomy version changes miss across actual cache reads even with identical component descriptions", async () => {
    const api = gateway();
    const path = join(directory, "taxonomy.json");
    const taxonomy = (version: string) => ({
      schemaVersion: 1,
      repo: "o/r",
      version,
      components: [{ id: "cli", description: "Synthetic command-line component" }],
    });
    await writeFile(path, JSON.stringify(taxonomy("v1")));
    const first = report(await run(api, ["--taxonomy", path]));
    await writeFile(path, JSON.stringify(taxonomy("v2")));
    const result = await run(api, ["--taxonomy", path]);
    expect(result.exit).toBe(0);
    const second = report(result);
    expect(second.items[0].cacheStatus).toBe("miss");
    expect(second.items[0].inputHash).not.toBe(first.items[0].inputHash);
    expect(api.requests[1]).toEqual(api.requests[0]);
    await writeFile(path, JSON.stringify(taxonomy("v1")));
    const restored = await run(api, ["--taxonomy", path, "--max-calls", "0"]);
    expect(restored.exit).toBe(0);
    expect(report(restored).items[0]).toMatchObject({
      cacheStatus: "hit",
      inputHash: first.items[0].inputHash,
    });
    expect(api.fetch).toHaveBeenCalledTimes(2);
  });

  test("policy v2 reruns saved distributions and changes review-only answers without Gateway or persistence", async () => {
    const api = gateway();
    const first = report(await run(api));
    const before = await snapshot();
    const decide = vi.fn<SemanticPolicy["decide"]>((evaluation, complete) => {
      const decision = decideSuggestion(evaluation, complete);
      const answer = evaluation.answers.requestType;
      if (answer.type !== "choice") throw new Error("Expected saved distribution");
      expect(answer.probabilities).toEqual(
        first.items[0].answers?.requestType.type === "choice"
          ? first.items[0].answers.requestType.probabilities
          : {},
      );
      answer.choice = "feature";
      delete evaluation.answers.impactReported;
      return {
        ...decision,
        outcome: "needs-review" as const,
        reasonCodes: ["synthetic-policy-review"],
        answers: evaluation.answers,
        impactReportedStatus: "not-applicable" as const,
      };
    });
    const result = await run(api, ["--max-calls", "0"], github(), {
      policy: { version: "2", decide },
    });
    expect(result.exit).toBe(0);
    const value = report(result);
    expect(value.policyVersion).toBe("2");
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0][1]).toBe(true);
    expect(value.items[0]).toMatchObject({
      cacheStatus: "hit",
      inputHash: first.items[0].inputHash,
      outcome: "needs-review",
      reviewRequired: true,
      answers: { requestType: { choice: "feature" } },
      reasonCodes: expect.arrayContaining(["synthetic-policy-review", "cache-hit"]),
      impactReportedStatus: "not-applicable",
      receipt: null,
    });
    expect(value.items[0].answers).not.toHaveProperty("impactReported");
    expect(result.getGatewayApiKey).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
    const originalPolicy = await run(api);
    expect(report(originalPolicy).items[0].answers).toEqual(first.items[0].answers);
    expect(api.fetch).toHaveBeenCalledTimes(1);
  });

  test("corrupt cache fails closed without HTTP unless an explicit refresh skips the saved response", async () => {
    const api = gateway();
    const original = pending(report(await run(api)));
    await writeFile(cachePath(original), "{corrupt-response");
    const before = await snapshot();
    for (const flags of [[], ["--dry-run"], ["--max-calls", "0"]]) {
      const result = await run(api, flags);
      expect(result.exit).toBe(1);
      const value = flags.includes("--dry-run") ? preview(result) : report(result);
      expect(value.items[0]).toMatchObject({
        cacheStatus: "invalid",
        outcome: "failed",
        reasonCodes: expect.arrayContaining(["cache-invalid"]),
      });
      expect(value.totals.failed).toBe(1);
      expect(value.execution.gatewayCalls).toBe(0);
      expect(result.getGatewayApiKey).not.toHaveBeenCalled();
    }
    expect(api.fetch).toHaveBeenCalledTimes(1);
    expect(await snapshot()).toEqual(before);
    const refreshed = await run(api, ["--refresh"]);
    expect(refreshed.exit).toBe(0);
    expect(report(refreshed).items[0].cacheStatus).toBe("refresh");
    expect(api.fetch).toHaveBeenCalledTimes(2);
    expect(await readFile(cachePath(original), "utf8")).toBe("{corrupt-response");
    const hot = await run(api);
    expect(hot.exit).toBe(0);
    expect(report(hot).totals.cacheHits).toBe(1);
    expect(api.fetch).toHaveBeenCalledTimes(2);
  });

  test.each([
    "pending",
    "unknown",
  ] as const)("%s lock blocks saved cache and new calls even with refresh", async (kind) => {
    const api = gateway();
    const first = report(await run(api));
    if (kind === "pending") {
      await createSemanticReceiptStore({ home, now: () => clock }).begin({
        inputHash: pending(first).inputHash,
        modelRequested: "typesafe-ai/jev",
        adapterVersion: "gateway-http-v1",
      });
    } else {
      const failure = gateway(() => {
        throw new Error("Synthetic unknown provider outcome");
      });
      const result = await run(failure, ["--refresh"]);
      expect(result.exit).toBe(1);
      expect(report(result).items[0].receipt?.final?.result.outcomeUnknown).toBe(true);
      expect(failure.fetch).toHaveBeenCalledTimes(1);
    }
    const before = await snapshot();
    for (const flags of [[], ["--refresh"], ["--dry-run"], ["--dry-run", "--refresh"]]) {
      const result = await run(api, flags);
      expect(result.exit).toBe(1);
      const value = flags.includes("--dry-run") ? preview(result) : report(result);
      expect(value.items[0]).toMatchObject({
        outcome: "failed",
        cacheStatus: "blocked",
        reasonCodes: expect.arrayContaining(["in-flight-or-unknown"]),
      });
      expect(value.execution.gatewayCalls).toBe(0);
      expect(value.totals.cacheHits).toBe(0);
      expect(result.getGatewayApiKey).not.toHaveBeenCalled();
    }
    expect(api.fetch).toHaveBeenCalledTimes(1);
    expect(await snapshot()).toEqual(before);
  });

  test.each([
    "final",
    "cache",
  ] as const)("failed %s persistence is never reused and retains the real pending lock", async (phase) => {
    let providerReturned = false;
    const blockFinal = vi.fn(async () => {
      const receipt = await currentPending();
      expect(JSON.parse(await readFile(cachePath(receipt), "utf8"))).toMatchObject({
        requestId: receipt.requestId,
      });
      const final = join(
        home,
        "classify",
        "receipts",
        receipt.createdAt.slice(0, 10),
        receipt.requestId,
        "final",
      );
      await mkdir(final, { mode: 0o700 });
      await writeFile(join(final, "receipt.json"), "{incomplete", { mode: 0o600 });
    });
    const source = github(1, {
      respond: async (call, response) => {
        if (phase === "final" && call.operation === "Versions" && providerReturned) {
          await blockFinal();
        }
        return response;
      },
    });
    const api = gateway(async (request) => {
      if (phase === "cache") {
        const receipt = await currentPending();
        await mkdir(join(home, "classify", "cache"), { mode: 0o700 });
        await writeFile(
          join(home, "classify", "cache", receipt.inputHash),
          "blocked cache bucket",
          { mode: 0o600 },
        );
      }
      providerReturned = true;
      return Response.json(evaluation(request));
    });
    const result = await run(api, [], source);
    expect(blockFinal).toHaveBeenCalledTimes(phase === "final" ? 1 : 0);
    expect(result.exit).toBe(1);
    const value = report(result);
    expect(value.items[0]).toMatchObject({
      outcome: "failed",
      answers: null,
      receipt: { final: null },
      provenance: { reportedCostUsd: 0.125 },
    });
    expect(value.items[0].reasonCodes).toContain(
      phase === "final" ? "receipt-invalid" : "cache-write-failed",
    );
    expect(value.totals).toMatchObject({
      reportedCostUsd: 0.125,
      hasUnknownCost: false,
      failed: 1,
      cacheHits: 0,
    });
    expect(value.execution).toMatchObject({
      gatewayCalls: 1,
      receiptRecordsWritten: 1,
      cacheEntriesWritten: phase === "final" ? 1 : 0,
    });
    expect(await currentPending()).toEqual(pending(value));
    const before = await snapshot();
    for (const flags of [[], ["--refresh"]]) {
      const next = await run(api, flags);
      expect(next.exit).toBe(1);
      expect(report(next).items[0]).toMatchObject({
        outcome: "failed",
        cacheStatus: "blocked",
        receipt: null,
        answers: null,
        reasonCodes: expect.arrayContaining(["in-flight-or-unknown"]),
      });
      expect(next.getGatewayApiKey).not.toHaveBeenCalled();
    }
    expect(api.fetch).toHaveBeenCalledTimes(1);
    expect(await snapshot()).toEqual(before);
  });

  test("concurrent same-key callers cannot double-send while a real async Gateway call holds the durable lease", async () => {
    const entered = gate();
    const release = gate();
    const api = gateway(async (request) => {
      entered.resolve();
      await release.promise;
      return Response.json(evaluation(request));
    });
    const first = run(api);
    try {
      await entered.promise;
      const lock = await currentPending();
      const second = await run(api);
      expect(second.exit).toBe(1);
      expect(report(second)).toMatchObject({
        execution: { gatewayCalls: 0 },
        items: [
          { inputHash: lock.inputHash, cacheStatus: "blocked", outcome: "failed", receipt: null },
        ],
      });
      expect(second.getGatewayApiKey).not.toHaveBeenCalled();
      expect(api.fetch).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await first;
    }
    const completed = await first;
    expect(completed.exit).toBe(0);
    expect(report(completed).execution.gatewayCalls).toBe(1);
    expect(await readdir(join(home, "classify", "locks"))).toEqual([]);
    const hot = await run(api);
    expect(hot.exit).toBe(0);
    expect(report(hot).items[0].cacheStatus).toBe("hit");
    expect(api.fetch).toHaveBeenCalledTimes(1);
  });

  test.each([
    {
      label: "private",
      fields: { visibility: "PRIVATE", isPrivate: true },
      metadata: {},
      reason: "repository-not-public",
      outcome: "failed",
    },
    {
      label: "closed",
      fields: {},
      metadata: { state: "CLOSED" },
      reason: "state-changed",
      outcome: "skipped",
    },
    {
      label: "updated",
      fields: {},
      metadata: { updatedAt: LATER },
      reason: "needs-refresh",
      outcome: "skipped",
    },
  ])("cached source becoming $label before reuse blocks answers without calls", async ({
    fields,
    metadata,
    reason,
    outcome,
  }) => {
    const api = gateway();
    expect((await run(api)).exit).toBe(0);
    const before = await snapshot();
    for (const flags of [[], ["--dry-run"]]) {
      let cacheHitRead = false;
      const cache = createSemanticCacheStore({ home, now: () => clock });
      const revalidateHit = vi.fn((response: unknown) => {
        const repository = repoData(response);
        Object.assign(repository, fields);
        Object.assign(record(repository.i0), metadata);
      });
      const source = github(1, {
        respond: (call, response) => {
          if (call.operation === "Versions" && cacheHitRead) revalidateHit(response);
          return response;
        },
      });
      const result = await run(api, flags, source, {
        cacheStore: {
          read: async (...args) => {
            const lookup = await cache.read(...args);
            cacheHitRead ||= lookup.status === "hit";
            return lookup;
          },
          write: async () => {
            throw new Error("Invalidated cache hits must not write");
          },
        },
      });
      expect(revalidateHit).toHaveBeenCalledTimes(1);
      expect(result.exit).toBe(1);
      const value = flags.includes("--dry-run") ? preview(result) : report(result);
      expect(value.coverageComplete).toBe(false);
      expect(value.items[0]).toMatchObject({
        outcome,
        cacheStatus: "hit",
        cacheSourceRequestId: null,
        reasonCodes: expect.arrayContaining([reason]),
      });
      expect(value.totals.cacheHits).toBe(0);
      if (value.kind === "classification-report") {
        expect(value.items[0].answers).toBeNull();
        expect(value.items[0].provenance).toBeNull();
        expect(value.items[0].receipt).toBeNull();
      }
      expect(result.getGatewayApiKey).not.toHaveBeenCalled();
    }
    expect(api.fetch).toHaveBeenCalledTimes(1);
    expect(await snapshot()).toEqual(before);
  });

  test("STOP permits valid cache hits but blocks new attempts and explicit refresh", async () => {
    const api = gateway();
    expect((await run(api)).exit).toBe(0);
    await writeFile(join(home, "classify", "STOP"), "stop synthetic inference\n", { mode: 0o600 });
    const before = await snapshot();
    const hot = await run(api);
    expect(hot.exit).toBe(0);
    expect(report(hot).totals.cacheHits).toBe(1);
    const mixed = await run(api, [], github(2));
    expect(mixed.exit).toBe(1);
    expect(report(mixed)).toMatchObject({
      totals: { cacheHits: 1, deferred: 1 },
      items: [
        { cacheStatus: "hit" },
        {
          cacheStatus: "miss",
          receipt: null,
          reasonCodes: expect.arrayContaining(["inference-disabled"]),
        },
      ],
    });
    const refresh = await run(api, ["--refresh"]);
    expect(refresh.exit).toBe(1);
    expect(report(refresh).items[0]).toMatchObject({
      cacheStatus: "refresh",
      receipt: null,
      reasonCodes: expect.arrayContaining(["inference-disabled"]),
    });
    for (const result of [hot, mixed, refresh])
      expect(result.getGatewayApiKey).not.toHaveBeenCalled();
    expect(api.fetch).toHaveBeenCalledTimes(1);
    expect(await snapshot()).toEqual(before);
  });

  test("Markdown labels current and historical known cost separately and never implies cache hits are new inference", async () => {
    const api = gateway();
    const cold = await run(api, ["--format", "markdown"]);
    expect(cold.exit).toBe(0);
    expect(cold.stdout).toContain(
      "Reported cost known subtotal: USD 0.125; unknown cost: no. Current run only",
    );
    expect(cold.stdout).toContain("Cached historical cost (not current spend): USD 0;");
    const hot = await run(api, ["--format", "markdown"]);
    expect(hot.exit).toBe(0);
    expect(hot.stdout).toContain(
      "Reported cost known subtotal: USD 0; unknown cost: no. Current run only",
    );
    expect(hot.stdout).toContain(
      "Cached historical cost (not current spend): USD 0.125; unknown historical cost: no.",
    );
    expect(hot.stdout).toContain("Gateway attempts: 0/50; evaluated 0;");
    expect(hot.stdout).toContain("Cache: enabled; hits 1; entries written 0;");
    expect(hot.stdout).toContain("Human review required for every suggestion.");
    expect(hot.stdout).toContain("not measured accuracy or permission to act");
    expect(hot.stdout).toContain("cache: hit");
    expect(api.fetch).toHaveBeenCalledTimes(1);
  });
});
