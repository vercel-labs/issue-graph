import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  fingerprintEvaluation,
  SEMANTIC_CACHE_EPOCH,
  SEMANTIC_CACHE_TTL_MS,
  validateEvaluation,
} from "./semantic-evaluation.js";
import { createSemanticCacheStore, createSemanticReceiptStore } from "./semantic-store.js";
import {
  type GatewayEvaluationRequest,
  type SemanticCacheContext,
  SemanticError,
  type SemanticPendingReceipt,
  type SemanticReceiptResult,
} from "./semantic-types.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    lstat: vi.fn(actual.lstat),
    link: vi.fn(actual.link),
    rename: vi.fn(actual.rename),
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const NOW = "2026-09-21T12:00:00.000Z";
const PRIVATE = "PRIVATE-SENTINEL-never-persist";
let sandbox: string;
let home: string;
let context: SemanticCacheContext;
let time: string;
let receiptStore: ReturnType<typeof createSemanticReceiptStore> | undefined;
let receiptHome: string | undefined;

function request(): GatewayEvaluationRequest {
  return {
    model: "typesafe-ai/jev",
    state: {
      issue: {
        key: "issue:acme/widgets#1",
        id: "I_1",
        url: "https://example.test/1",
        state: "OPEN",
        title: `${PRIVATE}-title`,
        body: `${PRIVATE}-body`,
        updatedAt: NOW,
        comments: [
          {
            id: "C_1",
            url: "https://example.test/1#comment",
            author: "reader",
            updatedAt: NOW,
            body: `${PRIVATE}-comment`,
          },
        ],
        commentsCoverage: { captured: 1, total: 1, hasNextPage: false, complete: true },
      },
    },
    questions: {
      kind: {
        type: "choice",
        instructions: `${PRIVATE}-instructions`,
        criteria: { bug: `${PRIVATE}-bug`, feature: `${PRIVATE}-feature` },
      },
      impact: {
        type: "score",
        instructions: `${PRIVATE}-score-instructions`,
        criteria: [`${PRIVATE}-low`, `${PRIVATE}-high`],
      },
      regression: { type: "boolean", instructions: `${PRIVATE}-boolean-instructions` },
    },
    providerOptions: { gateway: { only: ["typesafe-ai"] } },
  };
}

async function fingerprint(value: SemanticCacheContext): Promise<SemanticCacheContext> {
  return {
    ...value,
    inputHash: await fingerprintEvaluation(
      value.request,
      value.taxonomy,
      value.adapterVersion,
      value.cacheEpoch,
    ),
  };
}

function evaluation() {
  return validateEvaluation(context.request, {
    model: "typesafe-ai/jev",
    answers: {
      kind: {
        type: "choice",
        choice: "bug",
        probabilities: { bug: 0.8, feature: 0.2 },
        confidence: 0.9,
      },
      impact: { type: "score", score: 0.25, probabilities: { "0": 0.75, "1": 0.25 } },
      regression: { type: "boolean", probability: 0.4 },
    },
    usage: { inputTokens: 101, outputTokens: 12 },
    providerMetadata: { gateway: { cost: 0.002 } },
  });
}

function cache() {
  return createSemanticCacheStore({ home, now: () => time });
}

function receipts() {
  if (!receiptStore || receiptHome !== home) {
    receiptStore = createSemanticReceiptStore({ home, now: () => time });
    receiptHome = home;
  }
  return receiptStore;
}

function begin() {
  return receipts().begin({
    inputHash: context.inputHash,
    modelRequested: context.request.model,
    adapterVersion: context.adapterVersion,
  });
}

function result(): SemanticReceiptResult {
  const value = evaluation();
  return {
    status: "succeeded",
    evaluatedAt: NOW,
    tokenUsage: value.tokenUsage,
    reportedCostUsd: value.reportedCostUsd,
    errorCode: null,
    outcomeUnknown: false,
  };
}

function paths(pending: SemanticPendingReceipt) {
  const bucket = join(home, "classify", "cache", pending.inputHash);
  const receipt = join(
    home,
    "classify",
    "receipts",
    pending.createdAt.slice(0, 10),
    pending.requestId,
  );
  return {
    bucket,
    entry: join(bucket, `${pending.requestId}.json`),
    pointer: join(bucket, "current.json"),
    pending: join(receipt, "pending", "receipt.json"),
    final: join(receipt, "final", "receipt.json"),
    lock: join(home, "classify", "locks", `${pending.inputHash}.json`),
  };
}

async function published(finish = true) {
  const pending = await begin();
  await cache().write(context, { evaluation: evaluation(), evaluatedAt: NOW }, pending);
  if (finish) await receipts().finish(pending, result());
  return pending;
}

async function json(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function save(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function set(value: unknown, path: string[], replacement: unknown): void {
  const [key, ...rest] = path;
  const record = value as Record<string, unknown>;
  if (rest.length) set(record[key], rest, replacement);
  else record[key] = replacement;
}

async function corruptEntry(
  pending: SemanticPendingReceipt,
  path: string[],
  replacement: unknown,
  checksum = true,
) {
  const disk = await json(paths(pending).entry);
  set(disk, path, replacement);
  if (checksum) {
    const { checksum: _, ...payload } = disk;
    disk.checksum = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  }
  await save(paths(pending).entry, disk);
}

async function blocked(operation: Promise<unknown>, code = "cache-invalid") {
  const error = await operation.then(
    () => null,
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(SemanticError);
  expect(error).toMatchObject({
    code,
    message: "Semantic cache operation blocked.",
    hint: "Inspect classify cache, receipts and locks manually before taking action. Do not rerun a paid request.",
  });
  expect(String(error)).not.toContain(sandbox);
  expect(String(error)).not.toContain(PRIVATE);
}

async function snapshot(root = sandbox): Promise<unknown[]> {
  const entries: unknown[] = [];
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name);
    const stat = await actualFs.lstat(path);
    entries.push({
      path,
      mode: stat.mode,
      uid: stat.uid,
      ino: stat.ino,
      mtime: stat.mtimeMs,
      ctime: stat.ctimeMs,
      value: stat.isDirectory() ? await snapshot(path) : await readFile(path, "utf8"),
    });
  }
  return entries;
}

beforeEach(async () => {
  vi.clearAllMocks();
  receiptStore = undefined;
  receiptHome = undefined;
  vi.mocked(open).mockImplementation(actualFs.open);
  vi.mocked(lstat).mockImplementation(actualFs.lstat);
  vi.mocked(link).mockImplementation(actualFs.link);
  vi.mocked(rename).mockImplementation(actualFs.rename);
  sandbox = await mkdtemp(join(await realpath(tmpdir()), "semantic-cache-"));
  home = join(sandbox, "home");
  time = NOW;
  context = await fingerprint({
    inputHash: "",
    request: request(),
    taxonomy: null,
    adapterVersion: "gateway-http-v1",
    cacheEpoch: SEMANTIC_CACHE_EPOCH,
  });
  vi.mocked(homedir).mockClear().mockReturnValue(sandbox);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(sandbox, { recursive: true, force: true });
});

describe("semantic cache storage", () => {
  test("factory does not inspect options, environment, home, clock or filesystem", async () => {
    const getHome = vi.fn(() => home);
    const now = vi.fn(() => time);
    const before = await snapshot();
    const reads = vi.mocked(lstat).mock.calls.length;
    const store = createSemanticCacheStore({
      get home() {
        return getHome();
      },
      now,
    });
    expect(getHome).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(homedir).not.toHaveBeenCalled();
    expect(vi.mocked(lstat).mock.calls.length).toBe(reads);
    await expect(store.read(context)).resolves.toEqual({ status: "miss" });
    expect(getHome).toHaveBeenCalledOnce();
    expect(now).toHaveBeenCalledOnce();
    expect(await snapshot()).toEqual(before);
  });

  test("environment and default home are resolved only at the first method", async () => {
    vi.stubEnv("ISSUE_GRAPH_HOME", join(sandbox, "old"));
    const store = createSemanticCacheStore({ now: () => time });
    vi.stubEnv("ISSUE_GRAPH_HOME", home);
    await published();
    await expect(store.read(context)).resolves.toMatchObject({ status: "hit" });
    vi.stubEnv("ISSUE_GRAPH_HOME", undefined);
    home = join(sandbox, ".issue-graph");
    const fallback = createSemanticCacheStore({ now: () => time });
    expect(homedir).not.toHaveBeenCalled();
    await expect(fallback.read(context)).resolves.toEqual({ status: "miss" });
    expect(homedir).toHaveBeenCalledOnce();
  });

  test.each([
    "missing-home",
    "missing-parent",
    "home",
    "classify",
    "cache",
    "bucket",
  ])("cold %s read and refresh never write", async (state) => {
    if (state === "missing-parent") home = join(home, "nested", "home");
    if (["home", "classify", "cache", "bucket"].includes(state)) await mkdir(home, { mode: 0o700 });
    if (["classify", "cache", "bucket"].includes(state))
      await mkdir(join(home, "classify"), { mode: 0o700 });
    if (["cache", "bucket"].includes(state))
      await mkdir(join(home, "classify", "cache"), { mode: 0o700 });
    if (state === "bucket")
      await mkdir(join(home, "classify", "cache", context.inputHash), { mode: 0o700 });
    const before = await snapshot();
    await expect(cache().read(context)).resolves.toEqual({ status: "miss" });
    await expect(cache().read(context, { refresh: true })).resolves.toEqual({ status: "refresh" });
    expect(await snapshot()).toEqual(before);
    for (const [, flags] of vi.mocked(open).mock.calls)
      expect(Number(flags) & (constants.O_CREAT | constants.O_WRONLY | constants.O_RDWR)).toBe(0);
  });

  test("published entry is blocked until finish and then reconstructs normalized evaluation without writes", async () => {
    const pending = await published(false);
    const before = await snapshot();
    await blocked(cache().read(context), "in-flight-or-unknown");
    expect(await snapshot()).toEqual(before);
    await receipts().finish(pending, result());
    const finished = await snapshot();
    await expect(cache().read(context)).resolves.toEqual({
      status: "hit",
      entry: {
        schemaVersion: 1,
        inputHash: context.inputHash,
        requestId: pending.requestId,
        adapterVersion: context.adapterVersion,
        cacheEpoch: context.cacheEpoch,
        evaluatedAt: NOW,
        expiresAt: "2026-09-22T12:00:00.000Z",
        evaluation: evaluation(),
      },
    });
    expect(await snapshot()).toEqual(finished);
  });

  test.each([
    false,
    true,
  ])("pending and unknown locks block with refresh=%s even without cache and after years", async (refresh) => {
    const pending = await begin();
    await blocked(cache().read(context, { refresh }), "in-flight-or-unknown");
    await receipts().finish(pending, {
      ...result(),
      status: "failed",
      outcomeUnknown: true,
      errorCode: "gateway-timeout",
    });
    time = "2036-09-21T12:00:00.000Z";
    await blocked(cache().read(context, { refresh }), "in-flight-or-unknown");
    await blocked(
      cache().read(context, { refresh, ownedRequestId: pending.requestId }),
      "in-flight-or-unknown",
    );
  });

  test("a pending lock with an unpublished pending receipt still blocks", async () => {
    const pending = await begin();
    await unlink(paths(pending).pending);
    await blocked(cache().read(context), "in-flight-or-unknown");
    await blocked(cache().read(context, { refresh: true }), "in-flight-or-unknown");
    await blocked(cache().read(context, { ownedRequestId: pending.requestId }));
  });

  test.each([
    "requestId",
    "inputHash",
    "adapterVersion",
    "modelRequested",
    "phase",
    "durable",
    "extra",
  ])("invalid lock %s is sanitized even on refresh", async (field) => {
    const pending = await begin();
    const lock = await json(paths(pending).lock);
    lock[field] = `${PRIVATE}-bad`;
    await save(paths(pending).lock, lock);
    await blocked(cache().read(context, { refresh: true }));
  });

  test.each([-1, 0, 1])("fixed TTL boundary offset %s does not extend on read", async (offset) => {
    const pending = await published();
    time = new Date(Date.parse(NOW) + SEMANTIC_CACHE_TTL_MS + offset).toISOString();
    const before = await snapshot();
    await expect(cache().read(context)).resolves.toMatchObject({
      status: offset < 0 ? "hit" : "expired",
    });
    expect(await snapshot()).toEqual(before);
    expect((await json(paths(pending).entry)).expiresAt).toBe("2026-09-22T12:00:00.000Z");
  });

  test("future evaluation and future write timestamps are invalid", async () => {
    await published();
    time = "2026-09-21T11:59:59.999Z";
    await blocked(cache().read(context));
    const other = await fingerprint({ ...context, cacheEpoch: "2" });
    context = other;
    const pending = await begin();
    const before = await snapshot();
    await blocked(cache().write(context, { evaluation: evaluation(), evaluatedAt: NOW }, pending));
    expect(await snapshot()).toEqual(before);
  });

  test.each([
    ["schemaVersion", 2],
    ["inputHash", "a".repeat(64)],
    ["requestId", randomUUID()],
    ["cacheEpoch", "2"],
    ["adapterVersion", "other"],
    ["modelRequested", "other/model"],
    ["createdAt", "2026-09-22T12:00:00.000Z"],
    ["evaluatedAt", "not-a-date"],
    ["expiresAt", "2026-09-22T12:00:00.001Z"],
    ["extra", PRIVATE],
    ["response.answers.kind.probabilities.bug", 0.6],
    ["response.answers.kind.probabilities.extra", 0],
    ["response.answers.kind.choice", "unknown"],
    ["response.answers.kind.confidence", 2],
    ["response.answers.kind.topProbability", 0.8],
    ["response.answers.impact.levels", [PRIVATE]],
    ["response.answers.impact.score", 2],
    ["response.answers.regression.probability", -1],
    ["response.model", "other/model"],
    ["response.usage.inputTokens", -1],
    ["response.usage.extra", PRIVATE],
    ["response.providerMetadata.gateway.cost", "0.002"],
    ["response.providerMetadata.gateway.cost", 0.004],
    ["response.providerMetadata.gateway.extra", PRIVATE],
    ["response.providerMetadata.extra", PRIVATE],
    ["response.request", PRIVATE],
  ])("rejects strict schema or metadata corruption at %s", async (field, value) => {
    const pending = await published();
    await corruptEntry(pending, String(field).split("."), value);
    await blocked(cache().read(context));
    time = "2036-09-21T12:00:00.000Z";
    await blocked(cache().read(context));
  });

  test("checksum detects valid JSON distribution corruption with otherwise valid probabilities", async () => {
    const pending = await published();
    await corruptEntry(
      pending,
      ["response", "answers", "kind", "probabilities"],
      { bug: 0.6, feature: 0.4 },
      false,
    );
    await blocked(cache().read(context));
  });

  test.each([
    ["phase", "pending"],
    ["requestId", randomUUID()],
    ["inputHash", "b".repeat(64)],
    ["adapterVersion", "other"],
    ["modelRequested", "other/model"],
    ["createdAt", "2026-09-20T12:00:00.000Z"],
    ["completedAt", "2026-09-20T12:00:00.000Z"],
    ["result.status", "failed"],
    ["result.outcomeUnknown", true],
    ["result.errorCode", "gateway-rejected"],
    ["result.evaluatedAt", "2026-09-21T11:00:00.000Z"],
    ["result.tokenUsage.inputTokens", 0],
    ["result.tokenUsage.outputTokens", 0],
    ["result.tokenUsage.extra", 0],
    ["result.reportedCostUsd", 0],
    ["result.extra", PRIVATE],
    ["extra", PRIVATE],
  ])("requires matching immutable final receipt %s", async (field, value) => {
    const pending = await published();
    const final = await json(paths(pending).final);
    set(final, String(field).split("."), value);
    await save(paths(pending).final, final);
    await blocked(cache().read(context));
  });

  test.each([
    "pending",
    "final",
  ] as const)("requires corresponding %s receipt even after lock disappears", async (part) => {
    const pending = await published();
    await unlink(paths(pending)[part]);
    await blocked(cache().read(context));
  });

  test("entry whose pending lock was lost cannot become a hit without final", async () => {
    const pending = await published(false);
    await unlink(paths(pending).lock);
    await blocked(cache().read(context));
  });

  test("source pending record must match, not just the final", async () => {
    const pending = await published();
    await save(paths(pending).pending, { ...pending, adapterVersion: "different" });
    await blocked(cache().read(context));
  });

  test.each([
    "epoch",
    "body",
    "comment",
    "rubric",
    "taxonomy",
    "adapter",
  ])("changed %s fingerprint misses without touching old history", async (change) => {
    await published();
    const changed = structuredClone(context);
    if (change === "epoch") changed.cacheEpoch = "2";
    if (change === "body") changed.request.state.issue.body += "changed";
    if (change === "comment") changed.request.state.issue.comments[0].body += "changed";
    if (change === "rubric") changed.request.questions.kind.instructions += "changed";
    if (change === "adapter") changed.adapterVersion = "gateway-v2";
    if (change === "taxonomy")
      changed.taxonomy = {
        schemaVersion: 1,
        repo: "acme/widgets",
        version: "2",
        components: [{ id: "api", description: PRIVATE, examples: [PRIVATE] }],
      };
    const updated = await fingerprint(changed);
    expect(updated.inputHash).not.toBe(context.inputHash);
    const before = await snapshot();
    await expect(cache().read(updated)).resolves.toEqual({ status: "miss" });
    expect(await snapshot()).toEqual(before);
  });

  test.each([
    ["inputHash", "../escape"],
    ["inputHash", "a".repeat(64)],
    ["cacheEpoch", ""],
    ["cacheEpoch", "v".repeat(65)],
    ["adapterVersion", "../escape"],
    ["request.model", "other/model"],
    ["request.providerOptions.gateway.only", ["other"]],
    ["request.providerOptions.gateway.extra", PRIVATE],
    ["request.questions.impact.criteria", ["only"]],
    ["request.questions.kind.instructions", ""],
    ["request.state.issue.comments", null],
    ["policy", "never-part-of-cache"],
    ["captureTime", NOW],
  ])("invalid context %s is rejected before filesystem and options access", async (field, value) => {
    const changed = structuredClone(context);
    set(changed, String(field).split("."), value);
    const getHome = vi.fn(() => home);
    const store = createSemanticCacheStore({
      get home() {
        return getHome();
      },
    });
    vi.mocked(lstat).mockClear();
    vi.mocked(open).mockClear();
    await blocked(store.read(changed));
    expect(getHome).not.toHaveBeenCalled();
    expect(lstat).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  test("fingerprint mutation and invalid projected response reject writes before IO", async () => {
    const pending = await begin();
    const before = await snapshot();
    const bad = evaluation();
    bad.answers.regression = { type: "boolean", probability: 5, providerConfidence: null };
    vi.mocked(lstat).mockClear();
    await blocked(cache().write(context, { evaluation: bad, evaluatedAt: NOW }, pending));
    await blocked(
      cache().write(
        { ...context, inputHash: "a".repeat(64) },
        { evaluation: evaluation(), evaluatedAt: NOW },
        pending,
      ),
    );
    expect(lstat).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  test("refresh skips corrupt responses and pointer JSON but preserves immutable history", async () => {
    const first = await published();
    await writeFile(paths(first).entry, `${PRIVATE}-bad-json`);
    await writeFile(paths(first).pointer, `${PRIVATE}-bad-pointer`);
    const before = await snapshot();
    await expect(cache().read(context, { refresh: true })).resolves.toEqual({ status: "refresh" });
    expect(await snapshot()).toEqual(before);
    const second = await begin();
    await blocked(cache().read(context, { refresh: true }), "in-flight-or-unknown");
    await expect(
      cache().read(context, { refresh: true, ownedRequestId: second.requestId }),
    ).resolves.toEqual({ status: "refresh" });
    await cache().write(context, { evaluation: evaluation(), evaluatedAt: NOW }, second);
    await receipts().finish(second, result());
    expect(await readFile(paths(first).entry, "utf8")).toBe(`${PRIVATE}-bad-json`);
    expect(await readdir(paths(second).bucket)).toEqual(
      expect.arrayContaining([
        `${first.requestId}.json`,
        `${second.requestId}.json`,
        "current.json",
      ]),
    );
    await expect(cache().read(context)).resolves.toMatchObject({
      status: "hit",
      entry: { requestId: second.requestId },
    });
  });

  test("stores only minimal raw distributions and provenance, never private input or derived fields", async () => {
    const value = evaluation();
    const impact = value.answers.impact;
    if (impact.type !== "score") throw new Error("fixture");
    impact.levels = [`${PRIVATE}-untrusted-level`];
    impact.topProbability = 0;
    impact.margin = -10;
    const pending = await begin();
    await cache().write(context, { evaluation: value, evaluatedAt: NOW }, pending);
    await receipts().finish(pending, result());
    const all = JSON.stringify(await snapshot(home));
    expect(all).not.toContain(PRIVATE);
    const disk = await json(paths(pending).entry);
    expect(Object.keys(disk).sort()).toEqual(
      [
        "schemaVersion",
        "inputHash",
        "requestId",
        "adapterVersion",
        "cacheEpoch",
        "createdAt",
        "modelRequested",
        "evaluatedAt",
        "expiresAt",
        "response",
        "checksum",
      ].sort(),
    );
    expect(disk.response.answers.impact).toEqual({
      type: "score",
      score: 0.25,
      probabilities: { "0": 0.75, "1": 0.25 },
    });
    for (const field of [
      "levels",
      "instructions",
      "criteria",
      "topProbability",
      "margin",
      "state",
      "questions",
      "comments",
      "headers",
    ])
      expect(Object.keys(disk.response.answers.impact)).not.toContain(field);
    await expect(cache().read(context)).resolves.toMatchObject({
      status: "hit",
      entry: { evaluation: evaluation() },
    });
  });

  test("supports absent model alias, usage and cost provenance without inventing values", async () => {
    const pending = await begin();
    const value = evaluation();
    value.modelResolved = null;
    value.tokenUsage = { inputTokens: null, outputTokens: null };
    value.reportedCostUsd = null;
    await cache().write(context, { evaluation: value, evaluatedAt: NOW }, pending);
    await receipts().finish(pending, {
      ...result(),
      tokenUsage: value.tokenUsage,
      reportedCostUsd: null,
    });
    const disk = await json(paths(pending).entry);
    expect(disk.response).not.toHaveProperty("model");
    expect(disk.response).not.toHaveProperty("providerMetadata");
    await expect(cache().read(context)).resolves.toMatchObject({
      status: "hit",
      entry: { evaluation: value },
    });
  });

  test("write requires durable matching owned pending receipt and lock before creating cache", async () => {
    const pending = await begin();
    const before = await snapshot();
    for (const changed of [
      { ...pending, durable: false },
      { ...pending, requestId: randomUUID() },
      { ...pending, adapterVersion: "other" },
      { ...pending, createdAt: "2026-09-20T12:00:00.000Z" },
    ]) {
      const operation = cache().write(
        context,
        { evaluation: evaluation(), evaluatedAt: NOW },
        changed,
      );
      await expect(operation).rejects.toBeInstanceOf(SemanticError);
      expect(await snapshot()).toEqual(before);
    }
    await unlink(paths(pending).pending);
    const missing = await snapshot();
    await blocked(cache().write(context, { evaluation: evaluation(), evaluatedAt: NOW }, pending));
    expect(await snapshot()).toEqual(missing);
  });

  test("does not overwrite an immutable entry or finalize or unlock after duplicate publication", async () => {
    const pending = await published(false);
    const before = await snapshot();
    await blocked(cache().write(context, { evaluation: evaluation(), evaluatedAt: NOW }, pending));
    expect(await snapshot()).toEqual(before);
    expect(await json(paths(pending).lock)).toEqual(pending);
    await expect(lstat(paths(pending).final)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("exclusive entry publication refuses a file introduced during the write", async () => {
    const pending = await begin();
    vi.mocked(link).mockImplementationOnce(async (source, destination) => {
      await writeFile(destination, "existing", { mode: 0o600 });
      return actualFs.link(source, destination);
    });
    await blocked(cache().write(context, { evaluation: evaluation(), evaluatedAt: NOW }, pending));
    expect(await readFile(paths(pending).entry, "utf8")).toBe("existing");
    expect(await json(paths(pending).lock)).toEqual(pending);
    await expect(lstat(paths(pending).pointer)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("concurrent reads during publication never observe a reusable partial entry", async () => {
    const pending = await begin();
    let resume: () => void = () => {};
    let reached: () => void = () => {};
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      reached = resolve;
    });
    vi.mocked(link).mockImplementationOnce(async (source, destination) => {
      reached();
      await paused;
      return actualFs.link(source, destination);
    });
    const writing = cache().write(context, { evaluation: evaluation(), evaluatedAt: NOW }, pending);
    await ready;
    try {
      await blocked(cache().read(context), "in-flight-or-unknown");
      await blocked(cache().read(context, { refresh: true }), "in-flight-or-unknown");
    } finally {
      resume();
    }
    await writing;
    await blocked(cache().read(context), "in-flight-or-unknown");
    await receipts().finish(pending, result());
    await expect(cache().read(context)).resolves.toMatchObject({ status: "hit" });
  });

  test("pointer publication failure leaves immutable entry, pending and lock untouched", async () => {
    const pending = await begin();
    const lock = await readFile(paths(pending).lock, "utf8");
    vi.mocked(rename).mockRejectedValueOnce(
      Object.assign(new Error(`${PRIVATE} ${sandbox}`), { code: "EIO" }),
    );
    await blocked(cache().write(context, { evaluation: evaluation(), evaluatedAt: NOW }, pending));
    expect(await readFile(paths(pending).lock, "utf8")).toBe(lock);
    expect(await json(paths(pending).pending)).toEqual(pending);
    expect(await json(paths(pending).entry)).toMatchObject({ requestId: pending.requestId });
    await expect(lstat(paths(pending).final)).rejects.toMatchObject({ code: "ENOENT" });
    await blocked(cache().read(context), "in-flight-or-unknown");
  });

  test("post-begin owned recheck sees the first worker's finished cache after an earlier miss", async () => {
    const secondReader = cache();
    await expect(secondReader.read(context)).resolves.toEqual({ status: "miss" });
    const first = await published();
    const second = await begin();
    const before = await snapshot();
    await blocked(secondReader.read(context), "in-flight-or-unknown");
    await blocked(
      secondReader.read(context, { ownedRequestId: first.requestId }),
      "in-flight-or-unknown",
    );
    await expect(
      secondReader.read(context, { ownedRequestId: second.requestId }),
    ).resolves.toMatchObject({ status: "hit", entry: { requestId: first.requestId } });
    expect(await snapshot()).toEqual(before);
    await receipts().finish(second, { ...result(), status: "not-sent", evaluatedAt: null });
    await blocked(
      secondReader.read(context, { ownedRequestId: second.requestId }),
      "in-flight-or-unknown",
    );
  });

  test("owned recheck allows a genuinely current pending miss but not a finalized unknown lock", async () => {
    const pending = await begin();
    await expect(cache().read(context, { ownedRequestId: pending.requestId })).resolves.toEqual({
      status: "miss",
    });
    await receipts().finish(pending, { ...result(), outcomeUnknown: true });
    await blocked(
      cache().read(context, { ownedRequestId: pending.requestId }),
      "in-flight-or-unknown",
    );
  });

  test("read rechecks foreign lock after validating the final receipt", async () => {
    const first = await published();
    let acquired = false;
    vi.mocked(open).mockImplementation(async (...args) => {
      if (args[0] === paths(first).final && !acquired) {
        acquired = true;
        await begin();
      }
      return actualFs.open(...args);
    });
    await blocked(cache().read(context), "in-flight-or-unknown");
    expect(acquired).toBe(true);
  });

  test("owned recheck cannot use a lock that became final while reading", async () => {
    const first = await published();
    const second = await begin();
    let finished = false;
    vi.mocked(open).mockImplementation(async (...args) => {
      if (args[0] === paths(first).final && !finished) {
        finished = true;
        await receipts().finish(second, { ...result(), outcomeUnknown: true });
      }
      return actualFs.open(...args);
    });
    await blocked(
      cache().read(context, { ownedRequestId: second.requestId }),
      "in-flight-or-unknown",
    );
    expect(finished).toBe(true);
  });

  test.each([
    "home",
    "root",
    "locks",
    "cache",
    "bucket",
    "pointer",
    "entry",
    "receipts",
    "pending",
    "final",
  ])("rejects unsafe %s permissions without repairing them", async (part) => {
    const pending = await published();
    const disk = paths(pending);
    const target =
      part === "home"
        ? home
        : part === "root"
          ? join(home, "classify")
          : part === "locks"
            ? dirname(disk.lock)
            : part === "cache"
              ? dirname(disk.bucket)
              : part === "receipts"
                ? join(home, "classify", "receipts")
                : disk[part as "bucket" | "pointer" | "entry" | "pending" | "final"];
    const stat = await lstat(target);
    await chmod(target, stat.isDirectory() ? 0o755 : 0o644);
    const before = await snapshot();
    await blocked(cache().read(context));
    expect(await snapshot()).toEqual(before);
    if (["home", "root", "locks", "cache", "bucket", "pointer"].includes(part))
      await blocked(cache().read(context, { refresh: true }));
  });

  test.each([
    "pointer",
    "entry",
    "lock",
  ] as const)("rejects symlink %s without following it", async (part) => {
    const pending = await published(part !== "lock");
    const target = paths(pending)[part];
    const moved = join(sandbox, "original");
    await rename(target, moved);
    await symlink(moved, target);
    await blocked(cache().read(context));
    if (part !== "entry") await blocked(cache().read(context, { refresh: true }));
  });

  test.each([
    "symlink",
    "directory",
    "hardlink",
  ])("write refuses %s current pointer without changing history", async (kind) => {
    const first = await published();
    const second = await begin();
    const pointer = paths(first).pointer;
    await unlink(pointer);
    if (kind === "symlink") await symlink(paths(first).entry, pointer);
    if (kind === "directory") await mkdir(pointer, { mode: 0o700 });
    if (kind === "hardlink") await link(paths(first).entry, pointer);
    const before = await snapshot();
    await blocked(cache().write(context, { evaluation: evaluation(), evaluatedAt: NOW }, second));
    expect(await snapshot()).toEqual(before);
  });

  test("rejects wrong ownership and hardlinked entry metadata", async () => {
    const pending = await published();
    vi.mocked(lstat).mockImplementation((async (path) => {
      const stat = await actualFs.lstat(path);
      if (String(path) === paths(pending).pointer) stat.uid = (process.getuid?.() ?? 0) + 1;
      return stat;
    }) as typeof lstat);
    await blocked(cache().read(context));
    vi.mocked(lstat).mockImplementation(actualFs.lstat);
    await link(paths(pending).entry, join(sandbox, "alias"));
    await blocked(cache().read(context));
  });

  test.each([
    "pointer",
    "entry",
  ] as const)("rejects oversized or invalid JSON %s safely", async (part) => {
    const pending = await published();
    await writeFile(paths(pending)[part], "x".repeat(128 * 1024 + 1));
    await blocked(cache().read(context));
    await writeFile(paths(pending)[part], `${PRIVATE}-not-json`);
    await blocked(cache().read(context));
  });

  test("owned current lock does not make its own unfinalized published entry reusable", async () => {
    const pending = await published(false);
    const before = await snapshot();
    await blocked(
      cache().read(context, { ownedRequestId: pending.requestId }),
      "in-flight-or-unknown",
    );
    expect(await snapshot()).toEqual(before);
  });

  test("undefined optional lookup flags have the same read-only semantics as omitted flags", async () => {
    const before = await snapshot();
    await expect(
      cache().read(context, { refresh: undefined, ownedRequestId: undefined }),
    ).resolves.toEqual({ status: "miss" });
    expect(await snapshot()).toEqual(before);
  });

  test.each([
    "miss",
    "refresh",
  ])("%s rechecks a newly acquired lock before returning", async (mode) => {
    const first = mode === "refresh" ? await published() : await begin();
    if (mode === "miss")
      await receipts().finish(first, { ...result(), status: "not-sent", evaluatedAt: null });
    const target = mode === "refresh" ? paths(first).pointer : dirname(paths(first).bucket);
    let acquired = false;
    vi.mocked(lstat).mockImplementation((async (path) => {
      if (String(path) === target && !acquired) {
        acquired = true;
        await begin();
      }
      return actualFs.lstat(path);
    }) as typeof lstat);
    await blocked(cache().read(context, { refresh: mode === "refresh" }), "in-flight-or-unknown");
    expect(acquired).toBe(true);
  });

  test("expired cache remains blocked by a subsequent pending or unknown lock", async () => {
    await published();
    time = "2026-09-23T12:00:00.000Z";
    const pending = await begin();
    await blocked(cache().read(context), "in-flight-or-unknown");
    await receipts().finish(pending, { ...result(), evaluatedAt: time, outcomeUnknown: true });
    await blocked(cache().read(context), "in-flight-or-unknown");
  });

  test.each([
    "home",
    "classify",
    "cache",
    "bucket",
  ])("rejects symlink %s directories even during refresh", async (part) => {
    const pending = await published();
    const path =
      part === "home"
        ? home
        : part === "classify"
          ? join(home, "classify")
          : part === "cache"
            ? dirname(paths(pending).bucket)
            : paths(pending).bucket;
    const moved = join(sandbox, "moved");
    await rename(path, moved);
    await symlink(moved, path);
    await blocked(cache().read(context));
    await blocked(cache().read(context, { refresh: true }));
  });

  test.each([
    "pointer",
    "entry",
  ] as const)("rejects %s swapped between lstat and open", async (part) => {
    const pending = await published();
    const target = paths(pending)[part];
    let replaced = false;
    vi.mocked(open).mockImplementation(async (...args) => {
      if (args[0] === target && !replaced) {
        replaced = true;
        const bytes = await readFile(target);
        await actualFs.rename(target, join(sandbox, "old"));
        await writeFile(target, bytes, { mode: 0o600 });
      }
      return actualFs.open(...args);
    });
    await blocked(cache().read(context));
    expect(replaced).toBe(true);
  });

  test.each([
    "",
    "bad\0home",
    "x".repeat(4097),
  ])("invalid home configuration is sanitized", async (configured) => {
    const store = createSemanticCacheStore({ home: configured, now: () => time });
    const before = await snapshot();
    await blocked(store.read(context));
    expect(await snapshot()).toEqual(before);
  });

  test("expiry outside the bounded timestamp format is rejected before any writes", async () => {
    time = "9999-12-31T12:00:00.000Z";
    const pending = await begin();
    const before = await snapshot();
    vi.mocked(lstat).mockClear();
    await blocked(cache().write(context, { evaluation: evaluation(), evaluatedAt: time }, pending));
    expect(lstat).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  test("context getters are rejected without execution or I/O", async () => {
    const getRequest = vi.fn(() => context.request);
    const input = {
      ...context,
      get request() {
        return getRequest();
      },
    };
    vi.mocked(lstat).mockClear();
    await blocked(cache().read(input));
    expect(getRequest).not.toHaveBeenCalled();
    expect(lstat).not.toHaveBeenCalled();
  });

  test("normalized response extras are discarded rather than persisted", async () => {
    const pending = await begin();
    const value = { ...evaluation(), headers: { authorization: PRIVATE }, request: PRIVATE };
    Object.assign(value.answers.kind, { instructions: PRIVATE, evidence: PRIVATE });
    await cache().write(context, { evaluation: value, evaluatedAt: NOW }, pending);
    await receipts().finish(pending, result());
    expect(await readFile(paths(pending).entry, "utf8")).not.toContain(PRIVATE);
    await expect(cache().read(context)).resolves.toMatchObject({
      status: "hit",
      entry: { evaluation: evaluation() },
    });
  });

  test("all persisted cache directories and files have owned 700/600 permissions", async () => {
    const pending = await published();
    for (const path of [
      home,
      join(home, "classify"),
      dirname(paths(pending).bucket),
      paths(pending).bucket,
      paths(pending).entry,
      paths(pending).pointer,
    ]) {
      const stat = await lstat(path);
      expect(stat.mode & 0o7777).toBe(stat.isDirectory() ? 0o700 : 0o600);
      expect(stat.uid).toBe(process.getuid?.());
      if (stat.isFile()) expect(stat.nlink).toBe(1);
    }
  });
});
