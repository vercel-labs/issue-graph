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
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createSemanticReceiptStore } from "./semantic-store.js";
import {
  SemanticError,
  type SemanticPendingReceipt,
  type SemanticReceiptResult,
  type SemanticReceiptStore,
} from "./semantic-types.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const NOW = "2026-09-21T23:59:59.000Z";
const LATER = "2026-09-22T00:00:01.000Z";
const input = {
  inputHash: "a".repeat(64),
  modelRequested: "typesafe-ai/jev",
  adapterVersion: "gateway-v2",
};
const success: SemanticReceiptResult = {
  status: "succeeded",
  evaluatedAt: NOW,
  tokenUsage: { inputTokens: 25, outputTokens: 7 },
  reportedCostUsd: 0.003,
  errorCode: null,
  outcomeUnknown: false,
};
let sandbox: string;
let home: string;

beforeEach(async () => {
  vi.mocked(open).mockImplementation(actualFs.open);
  vi.mocked(rename).mockImplementation(actualFs.rename);
  sandbox = await mkdtemp(join(await realpath(tmpdir()), "semantic-store-"));
  home = join(sandbox, "home");
  vi.mocked(homedir).mockClear().mockReturnValue(sandbox);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(sandbox, { recursive: true, force: true });
});

function store(now: () => string = () => NOW): SemanticReceiptStore {
  return createSemanticReceiptStore({ home, now });
}

function paths(pending: SemanticPendingReceipt) {
  const directory = join(
    home,
    "classify",
    "receipts",
    pending.createdAt.slice(0, 10),
    pending.requestId,
  );
  return {
    directory,
    pending: join(directory, "pending", "receipt.json"),
    final: join(directory, "final", "receipt.json"),
    claim: join(directory, "finalizing.json"),
    lock: join(home, "classify", "locks", `${pending.inputHash}.json`),
  };
}

async function json(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function missing(path: string) {
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

async function blocked(operation: Promise<unknown>, code: string) {
  const error = await operation.then(
    () => null,
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(SemanticError);
  expect(error).toMatchObject({ code, hint: expect.stringContaining("Inspect classify receipts") });
  expect((error as SemanticError).hint).toContain("Do not rerun a paid request");
  return error as SemanticError;
}

async function files(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const stat = await lstat(path);
    expect(stat.mode & 0o777).toBe(stat.isDirectory() ? 0o700 : 0o600);
    if (stat.isDirectory()) found.push(...(await files(path)));
    else found.push(path);
  }
  return found;
}

describe("durable semantic receipt store", () => {
  test("factory is lazy, including options, clock, filesystem, and environment selection", async () => {
    const getHome = vi.fn(() => home);
    const now = vi.fn(() => NOW);
    const factory = createSemanticReceiptStore({
      get home() {
        return getHome();
      },
      now,
    });
    expect(getHome).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    await missing(home);
    vi.stubEnv("ISSUE_GRAPH_HOME", join(sandbox, "unused"));
    const pending = await factory.begin(input);
    expect(getHome).toHaveBeenCalledOnce();
    expect(now).toHaveBeenCalledOnce();
    expect(await json(paths(pending).pending)).toEqual(pending);
    await missing(join(sandbox, "unused"));
  });

  test("environment is resolved at begin, not factory construction", async () => {
    vi.stubEnv("ISSUE_GRAPH_HOME", join(sandbox, "old"));
    const factory = createSemanticReceiptStore({ now: () => NOW });
    vi.stubEnv("ISSUE_GRAPH_HOME", home);
    const pending = await factory.begin(input);
    expect(await json(paths(pending).pending)).toEqual(pending);
    await missing(join(sandbox, "old"));
  });

  test("default root resolves homedir lazily and stays inside its issue-graph directory", async () => {
    vi.stubEnv("ISSUE_GRAPH_HOME", undefined);
    home = join(sandbox, ".issue-graph");
    const receipts = createSemanticReceiptStore({ now: () => NOW });
    expect(homedir).not.toHaveBeenCalled();
    const pending = await receipts.begin(input);
    expect(homedir).toHaveBeenCalledOnce();
    expect(await json(paths(pending).pending)).toEqual(pending);
  });

  test("pending is durable before simulated HTTP; final correlates across UTC midnight", async () => {
    let time = NOW;
    const receipts = store(() => time);
    const pending = await receipts.begin(input);
    const disk = paths(pending);
    const http = vi.fn(async () => {
      expect(await json(disk.pending)).toEqual(pending);
      expect(await json(disk.lock)).toEqual(pending);
      await missing(disk.final);
      return success;
    });
    const result = await http();
    time = LATER;
    const final = await receipts.finish(pending, result);
    expect(http).toHaveBeenCalledOnce();
    expect(pending).toMatchObject({ ...input, durable: true, phase: "pending", createdAt: NOW });
    expect(pending.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(final).toEqual({ ...pending, phase: "final", completedAt: LATER, result });
    expect(await json(disk.final)).toEqual(final);
    expect(await json(disk.pending)).toEqual(pending);
    await missing(disk.lock);
    await missing(join(home, "classify", "receipts", "2026-09-22"));
    expect((await lstat(home)).mode & 0o777).toBe(0o700);
    expect(await files(home)).toHaveLength(3);
  });

  test("excludes concurrent duplicate begin across independent factories", async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, () => store().begin(input)),
    );
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of attempts) {
      if (result.status === "rejected")
        expect(result.reason).toMatchObject({ code: "in-flight-or-unknown" });
    }
    expect(await files(home)).toHaveLength(2);
  });

  test("known outcomes release only their lock and allow a distinct immutable request", async () => {
    const receipts = store();
    const first = await receipts.begin(input);
    const firstBytes = await readFile(paths(first).pending, "utf8");
    await receipts.finish(first, success);
    const finalBytes = await readFile(paths(first).final, "utf8");
    const second = await store().begin(input);
    expect(second.requestId).not.toBe(first.requestId);
    await blocked(receipts.finish(first, success), "receipt-invalid");
    expect(await json(paths(second).lock)).toEqual(second);
    expect(await readFile(paths(first).pending, "utf8")).toBe(firstBytes);
    expect(await readFile(paths(first).final, "utf8")).toBe(finalBytes);
  });

  test.each([
    "failed",
    "not-sent",
  ] as const)("known %s outcome releases the lock", async (status) => {
    const receipts = store();
    const pending = await receipts.begin(input);
    await receipts.finish(pending, {
      ...success,
      status,
      evaluatedAt: null,
      errorCode: "gateway-rejected",
    });
    await missing(paths(pending).lock);
    expect((await store().begin(input)).requestId).not.toBe(pending.requestId);
  });

  test("unknown final outcome retains lock even after error receipt and clock advances years", async () => {
    const receipts = store();
    const pending = await receipts.begin(input);
    const result: SemanticReceiptResult = {
      ...success,
      status: "failed",
      errorCode: "gateway-timeout",
      outcomeUnknown: true,
    };
    await receipts.finish(pending, result);
    expect((await json(paths(pending).final)).result).toEqual(result);
    expect(await json(paths(pending).lock)).toEqual(pending);
    await blocked(store(() => "2036-09-21T23:59:59.000Z").begin(input), "in-flight-or-unknown");
    await blocked(receipts.finish(pending, success), "receipt-invalid");
    expect((await json(paths(pending).final)).result.outcomeUnknown).toBe(true);
  });

  test("crashed pending never expires, even for different adapter versions or uppercase hash", async () => {
    const pending = await store().begin(input);
    await blocked(
      store(() => "2036-09-21T23:59:59.000Z").begin({
        ...input,
        inputHash: input.inputHash.toUpperCase(),
        adapterVersion: "gateway-v3",
      }),
      "in-flight-or-unknown",
    );
    expect(await json(paths(pending).pending)).toEqual(pending);
    await missing(paths(pending).final);
  });

  test("different fingerprints can proceed independently", async () => {
    const receipts = store();
    const [a, b] = await Promise.all([
      receipts.begin(input),
      receipts.begin({ ...input, inputHash: "b".repeat(64) }),
    ]);
    await receipts.finish(a, success);
    expect(await json(paths(b).lock)).toEqual(b);
  });

  test.each([
    null,
    { ...input, inputHash: "../escape" },
    { ...input, inputHash: "a".repeat(65) },
    { ...input, modelRequested: "other/model" },
    { ...input, adapterVersion: "Bearer secret" },
    { ...input, adapterVersion: "a".repeat(65) },
    { ...input, body: "private evidence", apiKey: "secret" },
  ])("invalid begin input fails before filesystem creation %#", async (value) => {
    await blocked(
      store().begin(value as Parameters<SemanticReceiptStore["begin"]>[0]),
      "receipt-invalid",
    );
    await missing(home);
  });

  test.each([
    "invalid",
    "2026-02-30T00:00:00.000Z",
    "2026-09-21T23:59:59Z",
  ])("invalid clock %s fails before IO", async (value) => {
    await blocked(store(() => value).begin(input), "receipt-invalid");
    await missing(home);
  });

  test("finish before begin does not resolve home or create files", async () => {
    const pending = await store().begin(input);
    const getHome = vi.fn(() => {
      throw new Error("must not read home");
    });
    const unused = createSemanticReceiptStore({
      get home() {
        return getHome();
      },
      now: () => NOW,
    });
    await blocked(unused.finish(pending, success), "receipt-invalid");
    expect(getHome).not.toHaveBeenCalled();
    expect(await json(paths(pending).lock)).toEqual(pending);
  });

  test("strictly projects result and usage; no body, arguments, credentials, or provider data reach disk", async () => {
    const receipts = store();
    const pending = await receipts.begin(input);
    const result = {
      ...success,
      body: "sensitive-body",
      args: { apiKey: "sensitive-key" },
      headers: { Authorization: "sensitive-authorization" },
      answers: { evidence: "sensitive-evidence" },
      tokenUsage: { ...success.tokenUsage, secret: "sensitive-usage" },
    };
    const final = await receipts.finish(pending, result);
    expect(final.result).toEqual(success);
    for (const file of await files(home))
      expect(await readFile(file, "utf8")).not.toContain("sensitive-");
  });

  test.each([
    { ...success, status: "arbitrary" },
    { ...success, status: { toString: (): string => "succeeded", body: "secret" } },
    { ...success, outcomeUnknown: "false" },
    { ...success, reportedCostUsd: Number.NaN },
    { ...success, reportedCostUsd: -1 },
    { ...success, reportedCostUsd: Number.POSITIVE_INFINITY },
    { ...success, tokenUsage: { inputTokens: 0.5, outputTokens: 0 } },
    { ...success, tokenUsage: { inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 0 } },
    { ...success, errorCode: "Authorization: Bearer secret" },
    { ...success, errorCode: "e".repeat(65) },
    { ...success, evaluatedAt: "bad-date" },
  ])("rejects invalid result without creating final/claim or releasing lock %#", async (value) => {
    const receipts = store();
    const pending = await receipts.begin(input);
    await blocked(receipts.finish(pending, value as SemanticReceiptResult), "receipt-invalid");
    expect(await json(paths(pending).lock)).toEqual(pending);
    await missing(paths(pending).final);
    await missing(paths(pending).claim);
  });

  test("accepts unknown usage/cost without inventing zeros", async () => {
    const receipts = store();
    const pending = await receipts.begin(input);
    const result: SemanticReceiptResult = {
      status: "failed",
      evaluatedAt: null,
      tokenUsage: { inputTokens: null, outputTokens: null },
      reportedCostUsd: null,
      errorCode: "gateway-error",
      outcomeUnknown: true,
    };
    expect((await receipts.finish(pending, result)).result).toEqual(result);
  });

  test.each([
    "requestId",
    "inputHash",
    "adapterVersion",
    "createdAt",
    "durable",
  ] as const)("rejects wrong pending identity: %s", async (field) => {
    const receipts = store();
    const pending = await receipts.begin(input);
    const changed = {
      ...pending,
      [field]:
        field === "durable"
          ? false
          : field === "inputHash"
            ? "b".repeat(64)
            : field === "createdAt"
              ? LATER
              : "wrong",
    };
    await blocked(receipts.finish(changed as SemanticPendingReceipt, success), "receipt-invalid");
    expect(await json(paths(pending).lock)).toEqual(pending);
    await missing(paths(pending).final);
  });

  test.each([
    "lock",
    "pending",
  ] as const)("rejects corrupt, oversized, extra-field and mismatched %s metadata", async (kind) => {
    const receipts = store();
    const pending = await receipts.begin(input);
    for (const data of [
      "{",
      "x".repeat(8193),
      JSON.stringify({ ...pending, body: "secret" }),
      JSON.stringify({ ...pending, adapterVersion: "other" }),
    ]) {
      await writeFile(paths(pending)[kind], data);
      await blocked(receipts.finish(pending, success), "receipt-invalid");
      await missing(paths(pending).final);
      await missing(paths(pending).claim);
    }
    await blocked(store().begin(input), "in-flight-or-unknown");
  });

  test.each([
    "lock",
    "pending",
    "final",
  ] as const)("refuses symlink %s metadata without touching its target", async (kind) => {
    const receipts = store();
    const pending = await receipts.begin(input);
    const target = join(sandbox, "untouched");
    await writeFile(target, JSON.stringify(pending), { mode: 0o600 });
    const original = await readFile(target, "utf8");
    await rm(paths(pending)[kind], { force: true });
    await mkdir(dirname(paths(pending)[kind]), { recursive: true, mode: 0o700 });
    await symlink(target, paths(pending)[kind]);
    await blocked(receipts.finish(pending, success), "receipt-invalid");
    expect(await readFile(target, "utf8")).toBe(original);
    expect(await lstat(paths(pending).lock)).toBeDefined();
  });

  test.each([
    "lock",
    "pending",
    "final",
  ] as const)("refuses nonregular %s metadata", async (kind) => {
    const receipts = store();
    const pending = await receipts.begin(input);
    await rm(paths(pending)[kind], { force: true });
    await mkdir(paths(pending)[kind], { recursive: true, mode: 0o700 });
    await blocked(receipts.finish(pending, success), "receipt-invalid");
    expect(await lstat(paths(pending).lock)).toBeDefined();
  });

  test("rejects hardlinked or permissive metadata", async () => {
    const receipts = store();
    const pending = await receipts.begin(input);
    await link(paths(pending).pending, join(sandbox, "alias"));
    await blocked(receipts.finish(pending, success), "receipt-invalid");
    await rm(join(sandbox, "alias"));
    await chmod(paths(pending).pending, 0o644);
    await blocked(receipts.finish(pending, success), "receipt-invalid");
    expect(await json(paths(pending).lock)).toEqual(pending);
  });

  test.each([
    "home",
    "classify",
    "locks",
    "receipts",
  ])("rejects symlink directory %s", async (part) => {
    const target = join(sandbox, "target");
    await mkdir(target, { mode: 0o700 });
    const path =
      part === "home"
        ? home
        : part === "classify"
          ? join(home, part)
          : join(home, "classify", part);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await symlink(target, path);
    await blocked(store().begin(input), "receipt-invalid");
    expect(await readdir(target)).toEqual([]);
  });

  test("supports trusted parent aliases such as system temporary paths without accepting a symlink home", async () => {
    const target = join(sandbox, "actual-parent");
    const alias = join(sandbox, "parent-alias");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, alias);
    home = join(alias, "nested", "home");
    const receipts = store();
    const pending = await receipts.begin(input);
    expect(await json(paths(pending).pending)).toEqual(pending);
    await receipts.finish(pending, success);
    expect((await lstat(join(target, "nested"))).mode & 0o777).toBe(0o700);
    expect(await files(join(target, "nested"))).toHaveLength(3);
  });

  test("rejects permissive managed directory rather than silently changing permissions", async () => {
    await mkdir(home, { mode: 0o755 });
    await chmod(home, 0o755);
    await blocked(store().begin(input), "receipt-invalid");
    expect((await lstat(home)).mode & 0o777).toBe(0o755);
  });

  test("existing final is never overwritten and lock is retained", async () => {
    const receipts = store();
    const pending = await receipts.begin(input);
    await mkdir(dirname(paths(pending).final), { mode: 0o700 });
    await writeFile(paths(pending).final, "immutable existing bytes", { mode: 0o600 });
    await blocked(receipts.finish(pending, success), "receipt-invalid");
    expect(await readFile(paths(pending).final, "utf8")).toBe("immutable existing bytes");
    expect(await json(paths(pending).lock)).toEqual(pending);
  });

  test("concurrent finish cannot overwrite final even when outcomes disagree", async () => {
    const receipts = store();
    const pending = await receipts.begin(input);
    const results = await Promise.allSettled([
      receipts.finish(pending, { ...success, outcomeUnknown: true }),
      receipts.finish(pending, {
        ...success,
        status: "failed",
        errorCode: "gateway-error",
        outcomeUnknown: true,
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const winner = results.find((result) => result.status === "fulfilled");
    if (winner?.status !== "fulfilled") throw new Error("no final receipt");
    expect(await json(paths(pending).final)).toEqual(winner.value);
    expect(await json(paths(pending).lock)).toEqual(pending);
  });

  test("pending publication failure leaves orphan lock and never permits HTTP", async () => {
    vi.mocked(rename).mockRejectedValueOnce(
      Object.assign(new Error("secret-body and private/path"), { code: "EIO" }),
    );
    const http = vi.fn();
    const error = await blocked(store().begin(input).then(http), "receipt-write-failed");
    expect(http).not.toHaveBeenCalled();
    expect(JSON.stringify(error)).not.toContain("secret-body");
    expect(String(error)).not.toContain("private/path");
    const lock = join(home, "classify", "locks", `${input.inputHash}.json`);
    expect((await json(lock)).phase).toBe("pending");
    await blocked(store().begin(input), "in-flight-or-unknown");
  });

  test("finish publication failure retains pending, lock and finalization claim", async () => {
    const receipts = store();
    const pending = await receipts.begin(input);
    vi.mocked(rename).mockRejectedValueOnce(
      Object.assign(new Error("Authorization: secret"), { code: "ENOSPC" }),
    );
    const error = await blocked(receipts.finish(pending, success), "receipt-write-failed");
    expect(String(error)).not.toContain("secret");
    expect(await json(paths(pending).pending)).toEqual(pending);
    expect(await json(paths(pending).lock)).toEqual(pending);
    expect(await json(paths(pending).claim)).toEqual(pending);
    await missing(paths(pending).final);
    await blocked(store().begin(input), "in-flight-or-unknown");
    await blocked(receipts.finish(pending, success), "in-flight-or-unknown");
  });

  test.each([
    "pending",
    "final",
  ] as const)("atomic %s publication never overwrites a racing receipt", async (phase) => {
    const receipts = store();
    const pending = phase === "final" ? await receipts.begin(input) : null;
    let racedPath = "";
    vi.mocked(rename).mockImplementationOnce(async (from, to) => {
      racedPath = join(String(to), "receipt.json");
      await mkdir(to, { mode: 0o700 });
      await writeFile(racedPath, "immutable racing receipt", { mode: 0o600 });
      await actualFs.rename(from, to);
    });
    await blocked(
      pending ? receipts.finish(pending, success) : receipts.begin(input),
      "receipt-invalid",
    );
    expect(await readFile(racedPath, "utf8")).toBe("immutable racing receipt");
    await blocked(store().begin(input), "in-flight-or-unknown");
  });

  test("an uncertain failure after final rename retains pending and lock", async () => {
    const receipts = store();
    const pending = await receipts.begin(input);
    vi.mocked(rename).mockImplementationOnce(async (from, to) => {
      await actualFs.rename(from, to);
      throw Object.assign(new Error("private filesystem information"), { code: "EIO" });
    });
    await blocked(receipts.finish(pending, success), "receipt-write-failed");
    expect((await json(paths(pending).final)).requestId).toBe(pending.requestId);
    expect(await json(paths(pending).pending)).toEqual(pending);
    expect(await json(paths(pending).lock)).toEqual(pending);
    await blocked(store().begin(input), "in-flight-or-unknown");
  });

  test.each([
    "lock",
    "pending",
    "final",
    "claim",
  ] as const)("corruption of %s after final publication prevents release", async (kind) => {
    const receipts = store();
    const pending = await receipts.begin(input);
    vi.mocked(rename).mockImplementationOnce(async (from, to) => {
      await actualFs.rename(from, to);
      await writeFile(paths(pending)[kind], "corrupt");
    });
    await blocked(receipts.finish(pending, success), "receipt-invalid");
    expect(await lstat(paths(pending).lock)).toBeDefined();
    expect(await lstat(paths(pending).pending)).toBeDefined();
    await blocked(store().begin(input), "in-flight-or-unknown");
  });

  test("a replaced pending directory is rejected before publication", async () => {
    const receipts = store();
    const pending = await receipts.begin(input);
    const pendingDirectory = dirname(paths(pending).pending);
    const moved = join(sandbox, "moved");
    await actualFs.rename(pendingDirectory, moved);
    await symlink(moved, pendingDirectory);
    await blocked(receipts.finish(pending, success), "receipt-invalid");
    expect(await json(paths(pending).lock)).toEqual(pending);
    await missing(paths(pending).final);
  });

  test("a valid but unrelated request UUID is rejected without changing its lock", async () => {
    const receipts = store();
    const pending = await receipts.begin(input);
    await blocked(
      receipts.finish({ ...pending, requestId: "00000000-0000-4000-8000-000000000000" }, success),
      "receipt-invalid",
    );
    expect(await json(paths(pending).lock)).toEqual(pending);
    await missing(paths(pending).final);
  });

  test("closes every opened handle on success and read-validation failure", async () => {
    const closes: ReturnType<typeof vi.spyOn>[] = [];
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await actualFs.open(...args);
      closes.push(vi.spyOn(handle, "close"));
      return handle;
    });
    const receipts = store();
    const pending = await receipts.begin(input);
    await writeFile(paths(pending).pending, "bad json");
    await blocked(receipts.finish(pending, success), "receipt-invalid");
    await writeFile(paths(pending).pending, JSON.stringify(pending));
    await receipts.finish(pending, success);
    expect(closes.length).toBeGreaterThan(5);
    for (const close of closes) expect(close).toHaveBeenCalledOnce();
  });

  test("write failure closes its handle and leaves the exclusive lock blocking retries", async () => {
    const closes: ReturnType<typeof vi.spyOn>[] = [];
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await actualFs.open(...args);
      closes.push(vi.spyOn(handle, "close"));
      if (
        String(args[0]).endsWith(`${input.inputHash}.json`) &&
        typeof args[1] === "number" &&
        args[1] & constants.O_EXCL
      ) {
        vi.spyOn(handle, "writeFile").mockRejectedValueOnce(
          Object.assign(new Error("secret credential"), { code: "EIO" }),
        );
      }
      return handle;
    });
    await blocked(store().begin(input), "receipt-write-failed");
    for (const close of closes) expect(close).toHaveBeenCalledOnce();
    await blocked(store().begin(input), "in-flight-or-unknown");
  });
});
