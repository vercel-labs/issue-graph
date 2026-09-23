import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fixture, record, repoData, TIME } from "../tests/semantic-github-fixture.js";
import { rawEvaluation } from "../tests/semantic-response-fixture.js";
import { runSemanticCli, type SemanticIO } from "./semantic-cli.js";
import { fingerprintEvaluation, SEMANTIC_CACHE_TTL_MS } from "./semantic-evaluation.js";
import { createSemanticEvidenceStore } from "./semantic-evidence-store.js";
import { collectSemanticEvidence } from "./semantic-github.js";
import { createSemanticCacheStore, createSemanticReceiptStore } from "./semantic-store.js";
import type {
  GatewayEvaluationRequest,
  SemanticPendingReceipt,
  SemanticReport,
} from "./semantic-types.js";
import type { GhTransport } from "./transport.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const native = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const forbidden = vi.fn((): never => {
  throw new Error("Unexpected credential, network or write access");
});
const offline = { transport: { graphql: forbidden, search: forbidden } };
let root: string;
let home: string;
let clock: string;
const settings = () => ({ home, now: () => clock });
const evidence = () => createSemanticEvidenceStore(settings());
const json = async (path: string) => JSON.parse(await fs.readFile(path, "utf8"));
const lockPath = (hash: string) => join(home, "classify", "locks", `${hash}.json`);
const receiptPath = (pending: SemanticPendingReceipt, phase: "pending" | "final") =>
  join(
    home,
    "classify",
    "receipts",
    pending.createdAt.slice(0, 10),
    pending.requestId,
    phase,
    "receipt.json",
  );
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function observe<T>(ready: Promise<T>, running?: Promise<unknown>): Promise<T> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const pending = running
    ? Promise.race([
        ready,
        running.then(() => {
          throw new Error("Operation settled before checkpoint");
        }),
      ])
    : ready;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error("Checkpoint timed out")), 1000);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}
async function tree(directory = home): Promise<unknown[]> {
  const entries: unknown[] = [];
  for (const name of (await fs.readdir(directory)).sort()) {
    const path = join(directory, name);
    const stat = await fs.lstat(path, { bigint: true });
    expect(stat.isSymbolicLink()).toBe(false);
    const { mode, uid, nlink, ino, mtimeNs, ctimeNs } = stat;
    const content = stat.isDirectory()
      ? await tree(path)
      : (await fs.readFile(path)).toString("hex");
    entries.push({ path, mode, uid, nlink, ino, mtimeNs, ctimeNs, content });
  }
  return entries;
}
function gateway(
  respond: (request: GatewayEvaluationRequest) => Response | Promise<Response> = (request) =>
    Response.json(rawEvaluation(request)),
) {
  return vi.fn<typeof fetch>(async (url, init) => {
    expect(url).toBe("https://ai-gateway.vercel.sh/v1/evaluate");
    const request = JSON.parse(String(init?.body)) as GatewayEvaluationRequest;
    const hash = await fingerprintEvaluation(request, null);
    const pending = await json(lockPath(hash));
    expect(pending).toMatchObject({ phase: "pending", durable: true, inputHash: hash });
    expect(await json(receiptPath(pending, "pending"))).toEqual(pending);
    return respond(request);
  });
}
async function run(
  flags: string[] = [],
  io: Partial<SemanticIO> = {},
  source: { transport: GhTransport } = fixture(1, { comments: { 1: 1 } }),
) {
  let stdout = "";
  let stderr = "";
  const exit = await runSemanticCli(["--repo", "o/r", ...flags], source.transport, {
    isTTY: false,
    snapshotHome: home,
    now: () => clock,
    getGatewayApiKey: () => "synthetic-state-only",
    gatewayFetch: forbidden,
    ...io,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  expect(stdout + stderr).not.toContain("synthetic-state-only");
  const report = JSON.parse(stdout) as SemanticReport;
  expect(report.kind).toBe("classification-report");
  expect(report.items.every((item) => item.reviewRequired)).toBe(true);
  return { exit, report, stdout, stderr };
}
function readOnly(): Partial<SemanticIO> {
  return {
    cacheStore: { read: createSemanticCacheStore(settings()).read, write: forbidden },
    receiptStore: { begin: forbidden, finish: forbidden },
    getGatewayApiKey: forbidden,
    gatewayFetch: forbidden,
  };
}
function timer() {
  let time = Date.parse(TIME);
  const now = () => time;
  const sleep = vi.fn(async (ms: number) => {
    time += ms;
  });
  return { nowMs: now, wait: { now, sleep } };
}
const throttle = () =>
  Response.json(
    { error: { code: "rate_limit" } },
    { status: 429, headers: { "retry-after": "2" } },
  );
beforeEach(async () => {
  forbidden.mockClear();
  vi.mocked(fs.rename).mockReset().mockImplementation(native.rename);
  vi.stubGlobal("fetch", forbidden);
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "semantic-state-")));
  await fs.chmod(root, 0o700);
  home = join(root, "home");
  await fs.mkdir(home, { mode: 0o700 });
  vi.stubEnv("HOME", root);
  vi.stubEnv("ISSUE_GRAPH_HOME", join(root, "unused"));
  clock = new Date(TIME).toISOString();
});
afterEach(async () => {
  try {
    expect(forbidden).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cold, live warm and offline reuse preserve receipts, private evidence and fixed TTL", async () => {
  const api = gateway();
  const cold = await run([], { gatewayFetch: api });
  expect(cold.exit).toBe(0);
  expect(cold.report.totals).toMatchObject({
    evaluated: 1,
    reportedCostUsd: 0.125,
    hasUnknownCost: false,
  });
  const item = cold.report.items[0];
  const receipt = item.receipt;
  assert(receipt);
  expect(receipt.final).toMatchObject({
    requestId: receipt.pending.requestId,
    inputHash: item.inputHash,
    result: { status: "succeeded", outcomeUnknown: false, reportedCostUsd: 0.125 },
  });
  for (const phase of ["pending", "final"] as const)
    expect(await json(receiptPath(receipt.pending, phase))).toEqual(receipt[phase]);
  expect(await fs.readdir(join(home, "classify", "locks"))).toEqual([]);
  const saved = await evidence().read("o/r", 50);
  expect(saved?.items[0].body).toContain("Evidence with");
  expect(JSON.stringify(cold.report)).not.toContain(saved?.items[0].body);
  const before = await tree();
  clock = new Date(Date.parse(TIME) + 3600000).toISOString();
  const source = fixture(1, { comments: { 1: 1 } });
  const warm = await run(["--max-calls", "0"], readOnly(), source);
  expect(warm.exit).toBe(0);
  expect(warm.report.totals).toMatchObject({
    cacheHits: 1,
    evaluated: 0,
    reportedCostUsd: 0,
    cachedHistoricalCostUsd: 0.125,
  });
  expect(warm.report.items[0]).toMatchObject({
    answers: item.answers,
    cacheSourceRequestId: receipt.pending.requestId,
  });
  expect(source.calls.every((call) => !/\bbody\b/.test(call.query))).toBe(true);
  expect(warm.report.evidenceSource?.reusedIssues).toBe(1);
  for (const [offset, status] of [
    [SEMANTIC_CACHE_TTL_MS - 1, "hit"],
    [SEMANTIC_CACHE_TTL_MS, "expired"],
  ] as const) {
    clock = new Date(Date.parse(TIME) + offset).toISOString();
    const cached = await run(
      ["--cached"],
      {
        ...readOnly(),
        evidenceStore: { read: evidence().read, write: forbidden },
        isInferenceDisabled: forbidden,
      },
      offline,
    );
    expect(cached.exit).toBe(1);
    expect(cached.report.evidenceSource?.liveRevalidated).toBe(false);
    expect(cached.report.items[0].cacheStatus).toBe(status);
    expect(cached.report.items[0].answers).toEqual(status === "hit" ? item.answers : null);
    expect(cached.report.execution.gatewayCalls).toBe(0);
    expect(await tree()).toEqual(before);
  }
  expect(api).toHaveBeenCalledOnce();
});

test("comment-only version drift invalidates one issue while incomplete evidence cannot replace saved state", async () => {
  const api = gateway();
  const cold = await run([], { gatewayFetch: api }, fixture(2, { comments: { 1: 1, 2: 1 } }));
  clock = new Date(Date.parse(TIME) + 3600000).toISOString();
  const changed = fixture(2, {
    comments: { 1: 1, 2: 1 },
    respond(call, response) {
      const repository = repoData(response);
      const nodes =
        call.operation === "Issues"
          ? (record(repository.issues).nodes as unknown[])
          : Object.entries(repository)
              .filter(([key]) => /^i\d+$/.test(key))
              .map(([, node]) => node);
      for (const node of nodes.map(record))
        if (node.number === 1)
          for (const comment of record(node.comments).nodes as Record<string, unknown>[]) {
            comment.updatedAt = clock;
            if ("body" in comment) comment.body = "Edited public evidence";
          }
      return response;
    },
  });
  const next = await run([], { gatewayFetch: api }, changed);
  expect(next.exit).toBe(0);
  expect(next.report.totals).toMatchObject({ cacheHits: 1, evaluated: 1 });
  expect(next.report.items[0].inputHash).not.toBe(cold.report.items[0].inputHash);
  expect(next.report.items[1].inputHash).toBe(cold.report.items[1].inputHash);
  expect(api).toHaveBeenCalledTimes(3);
  const saved = await evidence().read("o/r", 50);
  assert(saved);
  const incomplete = structuredClone(saved);
  incomplete.items[0].commentsCoverage.complete = false;
  const before = await tree();
  await evidence().write("o/r", 50, incomplete);
  expect(await evidence().read("o/r", 50)).toEqual(saved);
  expect(await tree()).toEqual(before);
  await expect(
    evidence().write("o/r", 50, { ...saved, visibility: "PRIVATE" } as never),
  ).rejects.toMatchObject({ code: "evidence-invalid" });
});

test.each([
  "evidence checksum",
  "cache checksum",
  "permissions",
  "symlink",
  "hardlink",
  "final receipt",
])("rejects unsafe saved state: %s", async (damage) => {
  const cold = await run([], { gatewayFetch: gateway() });
  const pending = cold.report.items[0].receipt?.pending;
  assert(pending);
  const bucket = join(
    home,
    "classify",
    "evidence",
    (await fs.readdir(join(home, "classify", "evidence")))[0],
  );
  const pointer = await json(join(bucket, "current.json"));
  const path =
    damage === "cache checksum"
      ? join(home, "classify", "cache", pending.inputHash, `${pending.requestId}.json`)
      : damage === "final receipt"
        ? receiptPath(pending, "final")
        : join(bucket, pointer.snapshot);
  const original = await fs.readFile(path, "utf8");
  if (damage.endsWith("checksum"))
    await fs.writeFile(path, JSON.stringify({ ...JSON.parse(original), checksum: "0".repeat(64) }));
  else if (damage === "permissions") await fs.chmod(path, 0o644);
  else if (damage === "hardlink") await fs.link(path, join(root, "linked"));
  else if (damage === "symlink") {
    await fs.rename(path, join(root, "target"));
    await fs.symlink(join(root, "target"), path);
  } else {
    const final = JSON.parse(original);
    final.result.reportedCostUsd = 99;
    await fs.writeFile(path, JSON.stringify(final));
  }
  if (damage === "cache checksum" || damage === "final receipt") {
    const blocked = await run(["--cached"], readOnly(), offline);
    expect(blocked.report.items[0]).toMatchObject({ cacheStatus: "invalid", answers: null });
    expect(blocked.report.execution.gatewayCalls).toBe(0);
  } else
    await expect(evidence().read("o/r", 50)).rejects.toMatchObject({ code: "evidence-invalid" });
  if (damage === "symlink") expect(await fs.readFile(join(root, "target"), "utf8")).toBe(original);
});

test.each([
  "pending",
  "network",
  "timeout",
])("%s lease blocks saved hits and refresh, never retries unknown outcomes", async (mode) => {
  const cold = await run([], { gatewayFetch: gateway() });
  const pending = cold.report.items[0].receipt?.pending;
  assert(pending);
  if (mode === "pending") {
    await createSemanticReceiptStore(settings()).begin({
      inputHash: pending.inputHash,
      modelRequested: pending.modelRequested,
      adapterVersion: pending.adapterVersion,
    });
  } else {
    const api = gateway(async () => {
      if (mode === "network") throw new Error("Synthetic disconnected response");
      return new Promise<Response>(() => {});
    });
    const failed = await run(["--refresh", "--max-retries", "3"], {
      gatewayFetch: api,
      gatewayTimeoutMs: 1000,
    });
    expect(failed.exit).toBe(1);
    expect(api).toHaveBeenCalledOnce();
    expect(failed.report.items[0].receipt?.final?.result).toMatchObject({
      status: "failed",
      outcomeUnknown: true,
      reportedCostUsd: null,
    });
    expect(failed.report.totals.hasUnknownCost).toBe(true);
    expect(failed.report.items[0].providerError?.code).toBe(
      mode === "network" ? "gateway-network-error" : "gateway-timeout",
    );
  }
  const before = await tree();
  for (const flags of [[], ["--refresh"], ["--cached"]]) {
    const result = await run(flags, readOnly());
    expect(result.exit).toBe(1);
    expect(result.report.items[0]).toMatchObject({
      cacheStatus: "blocked",
      answers: null,
      receipt: null,
      reasonCodes: expect.arrayContaining(["in-flight-or-unknown"]),
    });
    expect(result.report.execution.gatewayCalls).toBe(0);
  }
  expect(await tree()).toEqual(before);
});

test("concurrent same-key callers cannot duplicate a paid request", async () => {
  const entered = gate();
  const release = gate();
  const api = gateway(async (request) => {
    entered.resolve();
    await release.promise;
    return Response.json(rawEvaluation(request));
  });
  const controller = new AbortController();
  const first = run([], { gatewayFetch: api, signal: controller.signal });
  try {
    await observe(entered.promise, first);
    const second = await run([], readOnly());
    expect(second.report.items[0].cacheStatus).toBe("blocked");
    expect(second.report.execution.gatewayCalls).toBe(0);
    expect(api).toHaveBeenCalledOnce();
    release.resolve();
    expect((await observe(first)).exit).toBe(0);
  } finally {
    controller.abort();
    entered.resolve();
    release.resolve();
    await Promise.allSettled([first]);
  }
  expect(await fs.readdir(join(home, "classify", "locks"))).toEqual([]);
  expect((await run([], readOnly())).report.totals.cacheHits).toBe(1);
});

test("cache publication failure preserves known cost and a blocking durable pending receipt", async () => {
  const cache = createSemanticCacheStore(settings());
  const api = gateway();
  const failed = await run([], {
    gatewayFetch: api,
    cacheStore: {
      read: cache.read,
      write: async () => {
        throw new Error("Synthetic publication failure");
      },
    },
  });
  const item = failed.report.items[0];
  expect(failed.exit).toBe(1);
  expect(item).toMatchObject({
    answers: null,
    receipt: { final: null },
    provenance: { reportedCostUsd: 0.125 },
  });
  const pending = item.receipt?.pending;
  assert(pending);
  expect(await json(lockPath(pending.inputHash))).toEqual(pending);
  expect(await json(receiptPath(pending, "pending"))).toEqual(pending);
  expect((await run(["--refresh"], readOnly())).report.items[0].cacheStatus).toBe("blocked");
  expect(api).toHaveBeenCalledOnce();
});

test.each([
  0, 1,
])("429 retries require opt-in (%i), retain unknown cost and correlate distinct receipts", async (maxRetries) => {
  const timing = timer();
  let attempts = 0;
  const api = gateway((request) =>
    ++attempts === 1 ? throttle() : Response.json(rawEvaluation(request)),
  );
  const flags = maxRetries ? ["--max-retries", "1", "--max-calls", "2"] : [];
  const result = await run(flags, { gatewayFetch: api, ...timing });
  expect(result.exit).toBe(maxRetries ? 0 : 1);
  expect(api).toHaveBeenCalledTimes(1 + maxRetries);
  expect(result.report.totals).toMatchObject({
    reportedCostUsd: maxRetries ? 0.125 : 0,
    hasUnknownCost: true,
  });
  expect(timing.nowMs() - Date.parse(TIME)).toBe(maxRetries ? 2000 : 0);
  const records = result.report.items[0].attempts;
  assert(records);
  expect(new Set(records.map((attempt) => attempt.receipt.pending.requestId)).size).toBe(
    1 + maxRetries,
  );
  for (const attempt of records) {
    expect(await json(receiptPath(attempt.receipt.pending, "final"))).toEqual(
      attempt.receipt.final,
    );
    expect(attempt.receipt.final?.result.outcomeUnknown).toBe(false);
  }
  expect(records.map((attempt) => attempt.receipt.final?.result.status)).toEqual(
    maxRetries ? ["failed", "succeeded"] : ["failed"],
  );
});

test("two workers share the global attempt budget, including retries", async () => {
  const both = gate();
  let attempts = 0;
  let active = 0;
  let peak = 0;
  const api = gateway(async (request) => {
    const ordinal = ++attempts;
    peak = Math.max(peak, ++active);
    if (ordinal === 2) both.resolve();
    if (ordinal <= 2) await both.promise;
    active--;
    return ordinal <= 2 ? throttle() : Response.json(rawEvaluation(request));
  });
  const controller = new AbortController();
  const running = run(
    ["--concurrency", "2", "--max-calls", "3", "--max-retries", "1"],
    { gatewayFetch: api, signal: controller.signal, ...timer() },
    fixture(3),
  );
  try {
    await observe(both.promise, running);
    const result = await observe(running);
    expect(peak).toBe(2);
    expect(api).toHaveBeenCalledTimes(3);
    expect(result.exit).toBe(1);
    expect(result.report.execution).toMatchObject({
      gatewayCalls: 3,
      receiptRecordsWritten: 6,
      cacheEntriesWritten: 1,
    });
    expect(result.report.totals).toMatchObject({ evaluated: 1, hasUnknownCost: true });
    expect(result.report.items[2].reasonCodes).toContain("max-calls-reached");
    expect(result.report.items.map((item) => item.key)).toEqual(["o/r#1", "o/r#2", "o/r#3"]);
  } finally {
    controller.abort();
    both.resolve();
    await Promise.allSettled([running]);
  }
});

test("shared cooldown holds queued work; STOP prevents new attempts without losing in-flight success", async () => {
  const both = gate();
  const other = gate();
  const pause = gate();
  const sleeping = gate();
  const finished = gate();
  const ledger = createSemanticReceiptStore(settings());
  const finish = vi.fn(async (...args: Parameters<typeof ledger.finish>) => {
    const final = await ledger.finish(...args);
    if (final.result.status === "succeeded") finished.resolve();
    return final;
  });
  let attempts = 0;
  let successHash = "";
  const api = gateway(async (request) => {
    const ordinal = ++attempts;
    if (ordinal === 1) {
      await both.promise;
      return throttle();
    }
    both.resolve();
    await other.promise;
    successHash = await fingerprintEvaluation(request, null);
    return Response.json(rawEvaluation(request));
  });
  const timing = timer();
  const sleep = vi.fn(async (ms: number) => {
    sleeping.resolve();
    await pause.promise;
    await timing.wait.sleep(ms);
  });
  const controller = new AbortController();
  const running = run(
    ["--concurrency", "2", "--max-retries", "1"],
    {
      gatewayFetch: api,
      signal: controller.signal,
      receiptStore: { begin: ledger.begin, finish },
      ...timing,
      wait: { ...timing.wait, sleep },
    },
    fixture(3),
  );
  try {
    await observe(both.promise, running);
    await observe(sleeping.promise, running);
    other.resolve();
    await observe(finished.promise, running);
    expect(finish).toHaveBeenCalledTimes(2);
    expect(api).toHaveBeenCalledTimes(2);
    await fs.writeFile(join(home, "classify", "STOP"), "", { mode: 0o600 });
    pause.resolve();
    const result = await observe(running);
    expect(result.report.execution).toMatchObject({ gatewayCalls: 2, receiptRecordsWritten: 4 });
    expect(result.report.totals).toMatchObject({ evaluated: 1, hasUnknownCost: true });
    expect(
      result.report.items.find((item) => item.inputHash === successHash)?.answers,
    ).toBeTruthy();
    for (const item of result.report.items.filter((item) => item.inputHash !== successHash))
      expect(item.reasonCodes).toContain("inference-disabled");
  } finally {
    controller.abort();
    for (const checkpoint of [both, other, pause, sleeping, finished]) checkpoint.resolve();
    await Promise.allSettled([running]);
  }
});

test("atomic evidence publication exposes old or new snapshots and excludes competing writers", async () => {
  const capture = await collectSemanticEvidence(fixture(1, { comments: { 1: 1 } }).transport, {
    repo: "o/r",
    limit: 50,
    now: () => clock,
  });
  await evidence().write("o/r", 50, capture);
  const entered = gate();
  const release = gate();
  vi.mocked(fs.rename).mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    await native.rename(...args);
  });
  const changed = structuredClone(capture);
  changed.items[0].comments[0].body = "New immutable evidence";
  const writer = evidence().write("o/r", 50, changed);
  try {
    await observe(entered.promise, writer);
    expect(await evidence().read("o/r", 50)).toEqual(capture);
    await expect(evidence().write("o/r", 50, changed)).rejects.toMatchObject({
      code: "evidence-store-busy",
    });
    release.resolve();
    await observe(writer);
  } finally {
    entered.resolve();
    release.resolve();
    await Promise.allSettled([writer]);
  }
  expect(await evidence().read("o/r", 50)).toEqual(changed);
  const before = await tree();
  await evidence().write("o/r", 50, changed);
  expect(await tree()).toEqual(before);
});
