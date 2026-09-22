import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  truncate,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildEvaluationInput } from "./semantic.js";
import { buildEvaluationRequest, fingerprintEvaluation } from "./semantic-evaluation.js";
import { createSemanticEvidenceStore } from "./semantic-evidence-store.js";
import { type SemanticCapture, SemanticError } from "./semantic-types.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: vi.fn(actual.lstat),
    open: vi.fn(actual.open),
    rename: vi.fn(actual.rename),
    mkdir: vi.fn(actual.mkdir),
  };
});
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const NOW = "2026-09-22T12:00:00.000Z";
const EARLIER = "2026-09-22T11:00:00Z";
const LATER = "2026-09-22T13:00:00.000Z";
const REPO = "owner/repo";
let sandbox: string;
let home: string;

function capture(): SemanticCapture {
  const coverage = {
    captured: 1,
    total: 1,
    hasNextPage: false,
    pages: 1,
    complete: true,
    reasonCodes: [],
  };
  const captureWindow = { startedAt: NOW, completedAt: NOW };
  return {
    repo: REPO,
    visibility: "PUBLIC",
    captureWindow: { ...captureWindow },
    coverage: { ...coverage },
    items: [
      {
        key: "owner/repo#1",
        id: "I_1",
        url: "https://github.com/owner/repo/issues/1",
        number: 1,
        state: "OPEN",
        title: "Title",
        body: "Public issue text",
        updatedAt: EARLIER,
        comments: [
          {
            id: "IC_1",
            url: "https://github.com/owner/repo/issues/1#issuecomment-10",
            author: "author[bot]",
            updatedAt: EARLIER,
            body: "Public comment",
          },
        ],
        commentsCoverage: { ...coverage },
        captureWindow: { ...captureWindow },
        status: "ready",
        reasonCodes: [],
      },
    ],
  };
}

function store(now = NOW) {
  return createSemanticEvidenceStore({ home, now: () => now });
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function scopePath(repo = REPO, limit = 10): string {
  return join(home, "classify", "evidence", hash({ repo, limit }));
}

async function json(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function paths() {
  const directory = scopePath();
  const pointer = join(directory, "current.json");
  const value = await json(pointer);
  return { directory, pointer, snapshot: join(directory, value.snapshot) };
}

async function state(path = sandbox): Promise<unknown[]> {
  const result: unknown[] = [];
  for (const name of (await readdir(path)).sort()) {
    const target = join(path, name);
    const stat = await lstat(target);
    result.push({
      path: target,
      mode: stat.mode,
      ino: stat.ino,
      size: stat.size,
      mtime: stat.mtimeMs,
      ctime: stat.ctimeMs,
      data: stat.isDirectory() ? await state(target) : (await readFile(target)).toString("base64"),
    });
  }
  return result;
}

async function history() {
  const names = (await readdir(scopePath())).filter((name) => name !== "current.json").sort();
  return Promise.all(
    names.map(async (name) => ({ name, data: await readFile(join(scopePath(), name), "utf8") })),
  );
}

async function blocked(promise: Promise<unknown>, code = "evidence-invalid") {
  const error = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(SemanticError);
  expect(error).toMatchObject({ code });
  expect(String(error)).not.toContain(home);
}

async function missing(path = home) {
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

async function rewriteSnapshot(change: (value: ReturnType<typeof JSON.parse>) => void) {
  const location = await paths();
  const snapshot = await json(location.snapshot);
  change(snapshot);
  const { checksum: _checksum, ...payload } = snapshot;
  snapshot.checksum = hash(payload);
  await writeFile(location.snapshot, `${JSON.stringify(snapshot)}\n`);
  const pointer = await json(location.pointer);
  pointer.checksum = snapshot.checksum;
  await writeFile(location.pointer, `${JSON.stringify(pointer)}\n`);
}

beforeEach(async () => {
  vi.mocked(lstat).mockReset().mockImplementation(actualFs.lstat);
  vi.mocked(open).mockReset().mockImplementation(actualFs.open);
  vi.mocked(rename).mockReset().mockImplementation(actualFs.rename);
  vi.mocked(mkdir).mockReset().mockImplementation(actualFs.mkdir);
  sandbox = await mkdtemp(join(await realpath(tmpdir()), "evidence-"));
  home = join(sandbox, "home");
  vi.mocked(homedir).mockReset().mockReturnValue(sandbox);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(sandbox, { recursive: true, force: true });
});

describe("private versioned semantic evidence", () => {
  test("factory is lazy, missing reads write nothing and never call the clock", async () => {
    const getHome = vi.fn(() => home);
    const now = vi.fn(() => NOW);
    const evidence = createSemanticEvidenceStore({
      get home() {
        return getHome();
      },
      now,
    });
    expect(getHome).not.toHaveBeenCalled();
    expect(homedir).not.toHaveBeenCalled();
    const before = await state();
    expect(await evidence.read(REPO, 10)).toBeNull();
    expect(getHome).toHaveBeenCalledOnce();
    expect(now).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(await state()).toEqual(before);
  });

  test("resolves environment lazily and pins the selected home without reading provider keys", async () => {
    vi.stubEnv("ISSUE_GRAPH_HOME", join(sandbox, "unused"));
    vi.stubEnv("AI_GATEWAY_API_KEY", "must-not-persist-this-value");
    const evidence = createSemanticEvidenceStore({ now: () => NOW });
    vi.stubEnv("ISSUE_GRAPH_HOME", home);
    await evidence.write(REPO, 10, capture());
    vi.stubEnv("ISSUE_GRAPH_HOME", join(sandbox, "other"));
    expect(await evidence.read(REPO, 10)).toEqual(capture());
    expect(JSON.stringify(await state())).not.toContain("must-not-persist-this-value");
    await missing(join(sandbox, "unused"));
    await missing(join(sandbox, "other"));
  });

  test("default home and explicit home selection are lazy", async () => {
    vi.stubEnv("ISSUE_GRAPH_HOME", undefined);
    const evidence = createSemanticEvidenceStore({ now: () => NOW });
    home = join(sandbox, ".issue-graph");
    expect(homedir).not.toHaveBeenCalled();
    await evidence.write(REPO, 10, capture());
    expect(homedir).toHaveBeenCalledOnce();
    expect(await evidence.read(REPO, 10)).toEqual(capture());
  });

  test.each([
    false,
    true,
  ])("normalizes only scope and preserves mixed-case wire identities (independent casing: %s)", async (independent) => {
    const mixed = capture();
    mixed.repo = "Owner/Repo";
    mixed.items[0].key = independent ? "OWNER/Repo#1" : "Owner/Repo#1";
    mixed.items[0].url = independent
      ? "https://github.com/OWNER/rEPO/issues/1"
      : "https://github.com/Owner/Repo/issues/1";
    mixed.items[0].comments[0].url = independent
      ? "https://github.com/owner/RePo/issues/1#issuecomment-10"
      : "https://github.com/Owner/Repo/issues/1#issuecomment-10";
    const original = structuredClone(mixed);
    const wire = buildEvaluationRequest(buildEvaluationInput(mixed.items[0], null));
    const fingerprint = await fingerprintEvaluation(wire, null);
    await store().write("Owner/Repo", 10, mixed);
    const before = await state();
    const snapshot = await json((await paths()).snapshot);
    expect(snapshot.repo).toBe(REPO);
    expect(snapshot.capture).toEqual(original);
    for (const repo of ["Owner/Repo", "OWNER/REPO", REPO]) {
      const restored = await store().read(repo, 10);
      expect(restored).toEqual(original);
      if (!restored) throw new Error("missing mixed-case capture");
      const restoredWire = buildEvaluationRequest(buildEvaluationInput(restored.items[0], null));
      expect(JSON.stringify(restoredWire)).toBe(JSON.stringify(wire));
      expect(await fingerprintEvaluation(restoredWire, null)).toBe(fingerprint);
      await store(LATER).write(repo, 10, restored);
    }
    expect(mixed).toEqual(original);
    expect(await state()).toEqual(before);
    expect(await store().read(REPO, 11)).toBeNull();
    expect(await store().read("other/repo", 10)).toBeNull();
    expect(await readdir(join(home, "classify"))).toEqual(["evidence"]);
    expect(await readdir(join(home, "classify", "evidence"))).toEqual([
      hash({ repo: REPO, limit: 10 }),
    ]);
  });

  test("case-only projection changes publish new history within the same normalized scope", async () => {
    const original = capture();
    await store().write(REPO, 10, original);
    const previous = await history();
    const mixed = capture();
    mixed.repo = "Owner/Repo";
    mixed.items[0].key = "Owner/Repo#1";
    mixed.items[0].url = "https://github.com/Owner/Repo/issues/1";
    mixed.items[0].comments[0].url = "https://github.com/Owner/Repo/issues/1#issuecomment-10";
    await store(LATER).write(REPO, 10, mixed);
    expect(await store().read(REPO, 10)).toEqual(mixed);
    expect(await history()).toHaveLength(2);
    expect(await history()).toEqual(expect.arrayContaining(previous));
    const oldWire = buildEvaluationRequest(buildEvaluationInput(original.items[0], null));
    const newWire = buildEvaluationRequest(buildEvaluationInput(mixed.items[0], null));
    expect(await fingerprintEvaluation(newWire, null)).not.toBe(
      await fingerprintEvaluation(oldWire, null),
    );
  });

  test("comment URL uniqueness remains case-insensitive without rewriting URLs", async () => {
    const value = capture();
    value.items[0].comments.push({
      ...value.items[0].comments[0],
      id: "IC_2",
      url: "https://github.com/Owner/Repo/issues/1#issuecomment-10",
    });
    value.items[0].commentsCoverage.captured = 2;
    value.items[0].commentsCoverage.total = 2;
    await blocked(store().write(REPO, 10, value));
    await missing();
    expect(mkdir).not.toHaveBeenCalled();
  });

  test("cold read and unchanged write preserve every file, directory, inode, mtime and ctime", async () => {
    await store().write(REPO, 10, capture());
    const before = await state();
    expect(await store().read(REPO, 10)).toEqual(capture());
    const unchanged = capture();
    unchanged.captureWindow = { startedAt: LATER, completedAt: LATER };
    unchanged.coverage.pages = 2;
    unchanged.items[0].captureWindow = { startedAt: LATER, completedAt: LATER };
    unchanged.items[0].commentsCoverage.pages = 3;
    vi.mocked(mkdir).mockClear();
    vi.mocked(open).mockClear();
    await store(LATER).write(REPO, 10, unchanged);
    expect(mkdir).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(open)
        .mock.calls.every(([, flags]) => typeof flags === "number" && !(flags & constants.O_CREAT)),
    ).toBe(true);
    expect(await state()).toEqual(before);
    expect(await store().read(REPO, 10)).toEqual(capture());
  });

  test("comment body edits with unchanged parent timestamp publish immutable history", async () => {
    await store().write(REPO, 10, capture());
    const old = await history();
    const prior = await paths();
    const stat = await lstat(prior.snapshot);
    const changed = capture();
    changed.items[0].comments[0].body = "Edited comment, same issue timestamp";
    await store(LATER).write(REPO, 10, changed);
    expect(await store().read(REPO, 10)).toEqual(changed);
    expect(await history()).toEqual(expect.arrayContaining(old));
    expect(await history()).toHaveLength(2);
    const after = await lstat(prior.snapshot);
    expect([after.ino, after.mtimeMs, after.ctimeMs]).toEqual([
      stat.ino,
      stat.mtimeMs,
      stat.ctimeMs,
    ]);
    const latest = await json((await paths()).snapshot);
    expect(latest.savedAt).toBe(LATER);
    expect(latest.schemaVersion).toBe(1);
    const { checksum, ...payload } = latest;
    expect(checksum).toBe(hash(payload));
  });

  test("legitimate issue-limit-only capture retains incomplete repository coverage", async () => {
    const limited = capture();
    limited.coverage = {
      captured: 1,
      total: 2,
      hasNextPage: true,
      pages: 1,
      complete: false,
      reasonCodes: ["issue-limit"],
    };
    await store().write(REPO, 1, limited);
    expect(await store().read(REPO, 1)).toEqual(limited);
    expect((await store().read(REPO, 1))?.coverage.complete).toBe(false);
  });

  test("empty complete repository and null authors are valid", async () => {
    const empty = capture();
    empty.items = [];
    empty.coverage.captured = 0;
    empty.coverage.total = 0;
    await store().write(REPO, 10, empty);
    expect(await store().read(REPO, 10)).toEqual(empty);
    const anonymous = capture();
    anonymous.items[0].comments[0].author = null;
    await store().write(REPO, 10, anonymous);
    expect(await store().read(REPO, 10)).toEqual(anonymous);
  });

  const ineligible: Array<[string, (value: SemanticCapture) => void]> = [
    [
      "unknown coverage",
      (v) => {
        v.coverage.complete = false;
        v.coverage.total = null;
        v.coverage.hasNextPage = null;
      },
    ],
    [
      "drift",
      (v) => {
        v.coverage.complete = false;
        v.coverage.reasonCodes = ["total-count-drift"];
      },
    ],
    [
      "failed item",
      (v) => {
        v.items[0].status = "failed";
        v.items[0].reasonCodes = ["github-read-failed"];
      },
    ],
    [
      "closed item",
      (v) => {
        v.items[0].state = "CLOSED";
        v.items[0].status = "excluded";
      },
    ],
    [
      "incomplete comments",
      (v) => {
        v.items[0].commentsCoverage.complete = false;
      },
    ],
    [
      "unknown comments",
      (v) => {
        v.items[0].commentsCoverage.complete = false;
        v.items[0].commentsCoverage.total = null;
      },
    ],
    [
      "ready with reasons",
      (v) => {
        v.items[0].reasonCodes = ["needs-refresh"];
      },
    ],
    [
      "unfilled cohort",
      (v) => {
        v.coverage.complete = false;
        v.coverage.reasonCodes = ["issue-limit"];
        v.coverage.total = 12;
        v.coverage.hasNextPage = true;
      },
    ],
    [
      "capped and drift",
      (v) => {
        v.coverage.complete = false;
        v.coverage.reasonCodes = ["issue-limit", "total-count-drift"];
        v.coverage.total = 12;
        v.coverage.hasNextPage = true;
      },
    ],
  ];
  test.each(
    ineligible,
  )("%s creates nothing and leaves prior evidence unchanged", async (_name, change) => {
    const value = capture();
    change(value);
    const getHome = vi.fn(() => home);
    const evidence = createSemanticEvidenceStore({
      get home() {
        return getHome();
      },
    });
    await expect(evidence.write(REPO, 10, value)).resolves.toBeUndefined();
    expect(getHome).not.toHaveBeenCalled();
    await missing();
    await store().write(REPO, 10, capture());
    const before = await state();
    await store().write(REPO, 10, value);
    expect(await state()).toEqual(before);
  });

  const malformed: Array<[string, (value: ReturnType<typeof JSON.parse>) => void]> = [
    [
      "private",
      (v) => {
        v.visibility = "PRIVATE";
      },
    ],
    [
      "wrong repo",
      (v) => {
        v.repo = "other/repo";
      },
    ],
    [
      "unknown properties",
      (v) => {
        v.apiKey = "not-evidence";
      },
    ],
    [
      "unknown nested properties",
      (v) => {
        v.items[0].comments[0].token = "not-evidence";
      },
    ],
    [
      "bad state",
      (v) => {
        v.items[0].state = "open";
      },
    ],
    [
      "bad status",
      (v) => {
        v.items[0].status = "unknown";
      },
    ],
    [
      "zero issue",
      (v) => {
        v.items[0].number = 0;
      },
    ],
    [
      "unsafe issue",
      (v) => {
        v.items[0].number = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
    [
      "bad key",
      (v) => {
        v.items[0].key = "owner/repo#2";
      },
    ],
    [
      "foreign URL",
      (v) => {
        v.items[0].url = "https://example.com/owner/repo/issues/1";
      },
    ],
    [
      "PR URL",
      (v) => {
        v.items[0].url = "https://github.com/owner/repo/pull/1";
      },
    ],
    [
      "URL credentials",
      (v) => {
        v.items[0].url = "https://token@github.com/owner/repo/issues/1";
      },
    ],
    [
      "empty ID",
      (v) => {
        v.items[0].id = "";
      },
    ],
    [
      "numeric ID",
      (v) => {
        v.items[0].id = 1;
      },
    ],
    [
      "bad title",
      (v) => {
        v.items[0].title = null;
      },
    ],
    [
      "bad body",
      (v) => {
        v.items[0].body = {};
      },
    ],
    [
      "invalid unicode",
      (v) => {
        v.items[0].body = "\ud800";
      },
    ],
    [
      "bad date",
      (v) => {
        v.items[0].updatedAt = "2026-02-30T00:00:00Z";
      },
    ],
    [
      "non ISO",
      (v) => {
        v.items[0].updatedAt = "September 20, 2026";
      },
    ],
    [
      "future issue",
      (v) => {
        v.items[0].updatedAt = LATER;
      },
    ],
    [
      "future comment",
      (v) => {
        v.items[0].comments[0].updatedAt = LATER;
      },
    ],
    [
      "reversed window",
      (v) => {
        v.captureWindow.startedAt = LATER;
      },
    ],
    [
      "outside window",
      (v) => {
        v.items[0].captureWindow.completedAt = LATER;
      },
    ],
    [
      "bad author type",
      (v) => {
        v.items[0].comments[0].author = { login: "me" };
      },
    ],
    [
      "empty author",
      (v) => {
        v.items[0].comments[0].author = "";
      },
    ],
    [
      "foreign comment",
      (v) => {
        v.items[0].comments[0].url = "https://github.com/owner/repo/issues/2#issuecomment-10";
      },
    ],
    [
      "comment query",
      (v) => {
        v.items[0].comments[0].url += "?x=1";
      },
    ],
    [
      "bad comment anchor",
      (v) => {
        v.items[0].comments[0].url = "https://github.com/owner/repo/issues/1#issuecomment-0";
      },
    ],
    [
      "duplicate issue",
      (v) => {
        v.items.push(structuredClone(v.items[0]));
        v.coverage.captured = 2;
        v.coverage.total = 2;
      },
    ],
    [
      "duplicate comment ID",
      (v) => {
        const c = structuredClone(v.items[0].comments[0]);
        c.url = c.url.replace("-10", "-11");
        v.items[0].comments.push(c);
      },
    ],
    [
      "duplicate comment URL",
      (v) => {
        const c = structuredClone(v.items[0].comments[0]);
        c.id = "IC_2";
        v.items[0].comments.push(c);
      },
    ],
    [
      "too many comments",
      (v) => {
        v.items[0].comments = Array.from({ length: 301 }, () => v.items[0].comments[0]);
      },
    ],
    [
      "counter mismatch",
      (v) => {
        v.coverage.captured = 2;
      },
    ],
    [
      "negative counter",
      (v) => {
        v.coverage.pages = -1;
      },
    ],
    [
      "fractional counter",
      (v) => {
        v.coverage.pages = 1.5;
      },
    ],
    [
      "unsafe counter",
      (v) => {
        v.coverage.total = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
    [
      "no page",
      (v) => {
        v.coverage.pages = 0;
      },
    ],
    [
      "contradictory full coverage",
      (v) => {
        v.coverage.hasNextPage = true;
      },
    ],
    [
      "full with unknown total",
      (v) => {
        v.coverage.total = null;
      },
    ],
    [
      "invalid reasons",
      (v) => {
        v.coverage.reasonCodes = ["oops", "oops"];
      },
    ],
    [
      "known token shape",
      (v) => {
        v.items[0].body = `Example: ghp_${"a".repeat(36)}`;
      },
    ],
    [
      "private key shape",
      (v) => {
        v.items[0].body = "-----BEGIN PRIVATE KEY-----";
      },
    ],
  ];
  test.each(malformed)("rejects %s before creating directories", async (_name, change) => {
    const value = capture();
    change(value);
    await blocked(store().write(REPO, 10, value));
    await missing();
    expect(mkdir).not.toHaveBeenCalled();
  });

  test("rejects accessors, custom serialization, sparse arrays and symbol properties without invoking them", async () => {
    const value = capture();
    const getter = vi.fn(() => "not read");
    Object.defineProperty(value.items[0], "body", { enumerable: true, get: getter });
    await blocked(store().write(REPO, 10, value));
    expect(getter).not.toHaveBeenCalled();
    const custom = Object.assign(capture(), { toJSON: vi.fn(() => ({})) });
    await blocked(store().write(REPO, 10, custom));
    expect(custom.toJSON).not.toHaveBeenCalled();
    const sparse = capture();
    sparse.items = Array(1);
    await blocked(store().write(REPO, 10, sparse));
    const symbol = Object.assign(capture(), { [Symbol("extra")]: "value" });
    await blocked(store().write(REPO, 10, symbol));
    await missing();
  });

  test.each([
    0,
    -1,
    501,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects limit %s", async (limit) => {
    await blocked(store().read(REPO, limit));
    await blocked(store().write(REPO, limit, capture()));
    await missing();
  });

  test.each([
    "../repo",
    "owner/..",
    "owner/repo/extra",
    " owner/repo",
    "https://github.com/owner/repo",
    "owner/repo\0",
  ])("rejects repo %s", async (repo) => {
    await blocked(store().read(repo, 10));
    await blocked(store().write(repo, 10, capture()));
    await missing();
  });

  test("size bound includes the entire envelope and rejects before directory creation", async () => {
    const value = capture();
    value.items[0].body = "x".repeat(16 * 1024 * 1024);
    await blocked(store().write(REPO, 10, value));
    await missing();
  });

  test("invalid clock cannot create storage", async () => {
    await blocked(store("2026-02-30T00:00:00Z").write(REPO, 10, capture()));
    await blocked(store(EARLIER).write(REPO, 10, capture()));
    await missing();
  });

  test("snapshot and pointer are owned single-link 0600 files in owned 0700 directories", async () => {
    await store().write(REPO, 10, capture());
    const walk = async (path: string): Promise<void> => {
      const stat = await lstat(path);
      expect(stat.uid).toBe(process.getuid?.());
      expect(stat.mode & 0o7777).toBe(stat.isDirectory() ? 0o700 : 0o600);
      if (stat.isDirectory()) for (const name of await readdir(path)) await walk(join(path, name));
      else {
        expect(stat.isFile()).toBe(true);
        expect(stat.nlink).toBe(1);
      }
    };
    await walk(home);
  });

  test.each([
    "home",
    "classify",
    "evidence",
    "scope",
    "pointer",
    "snapshot",
  ])("rejects incompatible %s permissions without chmod", async (target) => {
    await store().write(REPO, 10, capture());
    const p = await paths();
    const path = {
      home,
      classify: join(home, "classify"),
      evidence: join(home, "classify", "evidence"),
      scope: p.directory,
      pointer: p.pointer,
      snapshot: p.snapshot,
    }[target];
    if (!path) throw new Error("missing test path");
    await chmod(path, 0o755);
    const before = await lstat(path);
    await blocked(store().read(REPO, 10));
    await blocked(store().write(REPO, 10, capture()));
    expect((await lstat(path)).mode).toBe(before.mode);
  });

  test.each([
    "home",
    "classify",
    "evidence",
    "scope",
    "pointer",
    "snapshot",
  ])("rejects a %s symlink", async (target) => {
    await store().write(REPO, 10, capture());
    const p = await paths();
    const path = {
      home,
      classify: join(home, "classify"),
      evidence: join(home, "classify", "evidence"),
      scope: p.directory,
      pointer: p.pointer,
      snapshot: p.snapshot,
    }[target];
    if (!path) throw new Error("missing test path");
    const moved = join(sandbox, "moved");
    await actualFs.rename(path, moved);
    await symlink(moved, path);
    await blocked(store().read(REPO, 10));
    await blocked(store().write(REPO, 10, capture()));
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
  });

  test("rejects symlinks above home, including dangling links", async () => {
    const parent = join(sandbox, "alias");
    await symlink(join(sandbox, "missing"), parent);
    home = join(parent, "child");
    await blocked(store().read(REPO, 10));
    await blocked(store().write(REPO, 10, capture()));
  });

  test.each(["pointer", "snapshot"])("rejects %s hard links", async (target) => {
    await store().write(REPO, 10, capture());
    const p = await paths();
    await link(p[target as "pointer" | "snapshot"], join(sandbox, "extra-link"));
    await blocked(store().read(REPO, 10));
    await blocked(store().write(REPO, 10, capture()));
  });

  test("rejects a special file without blocking on open", async () => {
    await store().write(REPO, 10, capture());
    const { pointer } = await paths();
    await rm(pointer);
    execFileSync("mkfifo", ["-m", "600", pointer]);
    vi.mocked(open).mockClear();
    await blocked(store().read(REPO, 10));
    expect(vi.mocked(open).mock.calls.some(([path]) => path === pointer)).toBe(false);
  });

  test.each(["pointer", "snapshot"])("rejects oversized %s before opening", async (target) => {
    await store().write(REPO, 10, capture());
    const p = await paths();
    const path = p[target as "pointer" | "snapshot"];
    await truncate(path, 16 * 1024 * 1024 + 1);
    vi.mocked(open).mockClear();
    await blocked(store().read(REPO, 10));
    expect(vi.mocked(open).mock.calls.some(([name]) => name === path)).toBe(false);
  });

  test.each([
    "pointer",
    "snapshot",
  ])("rejects invalid UTF8 in %s instead of replacement decoding", async (target) => {
    await store().write(REPO, 10, capture());
    const p = await paths();
    const path = p[target as "pointer" | "snapshot"];
    await writeFile(path, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]));
    await blocked(store().read(REPO, 10));
  });

  test.each([
    "schema",
    "scope",
    "checksum",
    "path",
    "json",
  ])("rejects corrupt pointer %s", async (kind) => {
    await store().write(REPO, 10, capture());
    const p = await paths();
    const pointer = await json(p.pointer);
    if (kind === "schema") pointer.schemaVersion = 2;
    if (kind === "scope") pointer.limit = 11;
    if (kind === "checksum") pointer.checksum = "0".repeat(64);
    if (kind === "path") pointer.snapshot = "../current.json";
    await writeFile(p.pointer, kind === "json" ? '{"' : JSON.stringify(pointer));
    const before = await state();
    await blocked(store().read(REPO, 10));
    await blocked(store().write(REPO, 10, capture()));
    expect(await state()).toEqual(before);
  });

  test.each([
    "schema",
    "scope",
    "date",
    "malformed",
    "ineligible",
    "checksum",
  ])("rejects corrupt snapshot %s even with same-source checksum", async (kind) => {
    await store().write(REPO, 10, capture());
    await rewriteSnapshot((snapshot) => {
      if (kind === "schema") snapshot.schemaVersion = 2;
      if (kind === "scope") snapshot.repo = "other/repo";
      if (kind === "date") snapshot.savedAt = "2026-02-30T00:00:00Z";
      if (kind === "malformed") snapshot.capture.items[0].comments[0].author = 123;
      if (kind === "ineligible") snapshot.capture.items[0].status = "failed";
    });
    if (kind === "checksum") {
      const path = (await paths()).snapshot;
      const value = await json(path);
      value.capture.items[0].body = "altered without checksum";
      await writeFile(path, JSON.stringify(value));
    }
    await blocked(store().read(REPO, 10));
  });

  test("dangling pointer is corruption, absent pointer is a cache miss", async () => {
    await store().write(REPO, 10, capture());
    const p = await paths();
    await rm(p.snapshot);
    await blocked(store().read(REPO, 10));
    await rm(p.pointer);
    const before = await state();
    expect(await store().read(REPO, 10)).toBeNull();
    expect(await state()).toEqual(before);
  });

  test("owner mismatch and inode replacement fail closed", async () => {
    await store().write(REPO, 10, capture());
    const path = (await paths()).snapshot;
    vi.mocked(open).mockImplementation(async (...args: Parameters<typeof actualFs.open>) => {
      const handle = await actualFs.open(...args);
      if (args[0] === path) {
        const stat = await handle.stat();
        vi.spyOn(handle, "stat").mockResolvedValue({
          ...stat,
          uid: (process.getuid?.() ?? 0) + 1,
        } as typeof stat);
      }
      return handle;
    });
    await blocked(store().read(REPO, 10));
    vi.mocked(open).mockImplementation(async (...args: Parameters<typeof actualFs.open>) => {
      if (args[0] === path) {
        const content = await readFile(path);
        await actualFs.rename(path, join(sandbox, "old-file"));
        await writeFile(path, content, { mode: 0o600 });
      }
      return actualFs.open(...args);
    });
    await blocked(store().read(REPO, 10));
  });

  test.each([
    "snapshot",
    "temporary",
    "rename",
  ])("failure at %s preserves the old pointer and history", async (stage) => {
    await store().write(REPO, 10, capture());
    const p = await paths();
    const oldPointer = await readFile(p.pointer, "utf8");
    const oldHistory = await history();
    const failure = Object.assign(new Error("private path must not leak"), { code: "EIO" });
    if (stage === "rename") vi.mocked(rename).mockRejectedValueOnce(failure);
    else
      vi.mocked(open).mockImplementation(async (...args: Parameters<typeof actualFs.open>) => {
        const [path, flags] = args;
        if (
          typeof path === "string" &&
          typeof flags === "number" &&
          flags & constants.O_CREAT &&
          (stage === "temporary" ? path.endsWith(".pointer.tmp") : path.endsWith(".capture.tmp"))
        )
          throw failure;
        return actualFs.open(...args);
      });
    const changed = capture();
    changed.items[0].body = "new body";
    await blocked(store().write(REPO, 10, changed), "evidence-write-failed");
    expect(await readFile(p.pointer, "utf8")).toBe(oldPointer);
    expect(await history()).toEqual(expect.arrayContaining(oldHistory));
    expect(await store().read(REPO, 10)).toEqual(capture());
    expect((await readdir(p.directory)).some((name) => name.startsWith("."))).toBe(false);
  });

  test.each([
    "partial-write",
    "file-sync",
    "readback",
  ])("%s failure never publishes incomplete history", async (stage) => {
    await store().write(REPO, 10, capture());
    const previous = await history();
    const failure = Object.assign(new Error("disk failure"), { code: "EIO" });
    vi.mocked(open).mockImplementation(async (...args: Parameters<typeof actualFs.open>) => {
      const handle = await actualFs.open(...args);
      if (typeof args[0] === "string" && args[0].endsWith(".capture.tmp")) {
        if (stage === "file-sync") vi.spyOn(handle, "sync").mockRejectedValueOnce(failure);
        else {
          const write = handle.writeFile.bind(handle);
          vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => {
            await write('{"partial":true}', "utf8");
            if (stage === "partial-write") throw failure;
          });
        }
      }
      return handle;
    });
    const changed = capture();
    changed.items[0].body = "changed";
    await blocked(
      store().write(REPO, 10, changed),
      stage === "readback" ? "evidence-invalid" : "evidence-write-failed",
    );
    expect(await store().read(REPO, 10)).toEqual(capture());
    expect(await history()).toEqual(expect.arrayContaining(previous));
    expect(await history()).toEqual(previous);
    expect((await readdir(scopePath())).some((name) => name.startsWith("."))).toBe(false);
  });

  test("post-rename directory sync failure reports an error without rolling back a valid pointer", async () => {
    await store().write(REPO, 10, capture());
    const previous = await history();
    let published = false;
    vi.mocked(rename).mockImplementationOnce(
      async (...args: Parameters<typeof actualFs.rename>) => {
        await actualFs.rename(...args);
        published = true;
      },
    );
    vi.mocked(open).mockImplementation(async (...args: Parameters<typeof actualFs.open>) => {
      const handle = await actualFs.open(...args);
      if (published && args[0] === scopePath()) {
        vi.spyOn(handle, "sync").mockRejectedValueOnce(
          Object.assign(new Error("sync failure"), { code: "EIO" }),
        );
      }
      return handle;
    });
    const changed = capture();
    changed.items[0].body = "valid new capture";
    await blocked(store().write(REPO, 10, changed), "evidence-write-failed");
    expect(await store().read(REPO, 10)).toEqual(changed);
    expect(await history()).toEqual(expect.arrayContaining(previous));
  });

  test("readers see old evidence until atomic pointer publication; competing writers fail busy", async () => {
    await store().write(REPO, 10, capture());
    const oldHistory = await history();
    let resume = () => {};
    let reached = () => {};
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      reached = resolve;
    });
    vi.mocked(rename).mockImplementationOnce(
      async (...args: Parameters<typeof actualFs.rename>) => {
        reached();
        await gate;
        await actualFs.rename(...args);
      },
    );
    const changed = capture();
    changed.items[0].comments[0].body = "first writer";
    const first = store().write(REPO, 10, changed);
    try {
      await ready;
      expect(await store().read(REPO, 10)).toEqual(capture());
      const competing = capture();
      competing.items[0].body = "competing writer";
      await blocked(store().write(REPO, 10, competing), "evidence-store-busy");
    } finally {
      resume();
      await first;
    }
    expect(await store().read(REPO, 10)).toEqual(changed);
    expect(await history()).toEqual(expect.arrayContaining(oldHistory));
    expect(await history()).toHaveLength(2);
    const before = await state();
    await Promise.all(Array.from({ length: 5 }, () => store().write(REPO, 10, changed)));
    expect(await state()).toEqual(before);
  });

  test("simultaneous initial writers do not overwrite history or leave a broken pointer", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) => {
        const value = capture();
        value.items[0].body = `writer ${index}`;
        return store().write(REPO, 10, value);
      }),
    );
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    for (const result of results) {
      if (result.status === "rejected")
        expect(result.reason).toMatchObject({ code: "evidence-store-busy" });
    }
    const saved = await store().read(REPO, 10);
    expect(saved?.items[0].body).toMatch(/^writer [0-5]$/);
    expect(await history()).toHaveLength(
      results.filter((result) => result.status === "fulfilled").length,
    );
  });

  test("independent Node processes serialize publication with the same private lock", async () => {
    await store().write(REPO, 10, capture());
    const original = await history();
    const moduleUrl = new URL("./semantic-evidence-store.ts", import.meta.url).href;
    const diagnostics: Array<{ index: number; stderr: string }> = [];
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, index) => {
        const value = capture();
        value.items[0].body = `process ${index}`;
        const script = `import { createSemanticEvidenceStore } from ${JSON.stringify(moduleUrl)};
        const store = createSemanticEvidenceStore({home: ${JSON.stringify(home)}, now: () => ${JSON.stringify(NOW)}});
        try { await store.write(${JSON.stringify(REPO)}, 10, ${JSON.stringify(value)}); console.log("written"); }
        catch (error) { console.log(error.code); if (error.code !== "evidence-store-busy") console.error(error.stack); }`;
        return new Promise<string>((resolve, reject) => {
          execFile(
            process.execPath,
            ["--import", import.meta.resolve("tsx"), "--input-type=module", "--eval", script],
            { cwd: sandbox, env: { PATH: process.env.PATH ?? "" } },
            (error, stdout, stderr) => {
              if (stderr) diagnostics.push({ index, stderr });
              if (error) reject(error);
              else resolve(stdout.trim());
            },
          );
        });
      }),
    );
    const diagnostic = JSON.stringify({ results, diagnostics });
    expect(results, diagnostic).toContain("written");
    expect(
      results.every((result) => result === "written" || result === "evidence-store-busy"),
      diagnostic,
    ).toBe(true);
    expect(await history()).toEqual(expect.arrayContaining(original));
    expect(await history()).toHaveLength(
      1 + results.filter((result) => result === "written").length,
    );
    expect((await store().read(REPO, 10))?.items[0].body).toMatch(/^process [0-3]$/);
  });

  test.each(
    ["read", "write"].flatMap((operation) =>
      ["before-open", "before-first-stat", "before-final-stat"].map((stage) => ({
        operation,
        stage,
      })),
    ),
  )("atomic pointer replacement during $operation $stage retries without writes", async ({
    operation,
    stage,
  }) => {
    await store().write(REPO, 10, capture());
    const { pointer } = await paths();
    const original = await history();
    const updated = capture();
    updated.items[0].body = "concurrently published";
    let armed = true;
    let detached = false;
    let publishedState: unknown[] = [];
    const publish = async () => {
      await store().write(REPO, 10, updated);
      publishedState = await state();
    };
    vi.mocked(open).mockImplementation(async (...args: Parameters<typeof actualFs.open>) => {
      if (args[0] !== pointer || !armed) return actualFs.open(...args);
      armed = false;
      if (stage === "before-open") {
        const before = await lstat(pointer);
        await publish();
        expect((await lstat(pointer)).ino).not.toBe(before.ino);
        return actualFs.open(...args);
      }
      const handle = await actualFs.open(...args);
      const stat = handle.stat.bind(handle);
      const replace = async () => {
        await publish();
        const observed = await stat();
        expect(observed.nlink).toBe(0);
        expect((await lstat(pointer)).ino).not.toBe(observed.ino);
        detached = true;
        return observed;
      };
      if (stage === "before-first-stat") await replace();
      else
        vi.spyOn(handle, "stat")
          .mockImplementationOnce(() => stat())
          .mockImplementationOnce(replace);
      return handle;
    });
    if (operation === "read") expect(await store().read(REPO, 10)).toEqual(updated);
    else await expect(store().write(REPO, 10, updated)).resolves.toBeUndefined();
    expect(armed).toBe(false);
    expect(detached).toBe(stage !== "before-open");
    expect(await state()).toEqual(publishedState);
    expect(await history()).toHaveLength(2);
    expect(await history()).toEqual(expect.arrayContaining(original));
  });

  test.each([
    "read",
    "write",
  ])("detached initial lstat during %s retries without reading unlinked data", async (operation) => {
    await store().write(REPO, 10, capture());
    const { pointer } = await paths();
    const updated = capture();
    updated.items[0].body = "published before lstat completes";
    let pointerStats = 0;
    let armed = true;
    let publishedState: unknown[] = [];
    vi.mocked(lstat).mockImplementation(async (...args: Parameters<typeof actualFs.lstat>) => {
      if (args[0] !== pointer || !armed || ++pointerStats !== 2) return actualFs.lstat(...args);
      armed = false;
      const handle = await actualFs.open(pointer, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await store().write(REPO, 10, updated);
        publishedState = await state();
        const detached = await handle.stat();
        expect(detached.nlink).toBe(0);
        expect((await actualFs.lstat(pointer)).ino).not.toBe(detached.ino);
        return detached;
      } finally {
        await handle.close();
      }
    });
    if (operation === "read") expect(await store().read(REPO, 10)).toEqual(updated);
    else await expect(store().write(REPO, 10, updated)).resolves.toBeUndefined();
    expect(armed).toBe(false);
    expect(await state()).toEqual(publishedState);
    expect(await history()).toHaveLength(2);
  });

  test.each(
    ["before-open", "detached"].flatMap((stage) =>
      [
        "permissions",
        "hardlink",
        "symlink",
        "malformed",
        "checksum",
        "scope",
        "version",
        "oversized",
        "missing-snapshot",
      ].map((kind) => ({ stage, kind })),
    ),
  )("pointer replacement $stage with $kind stays evidence-invalid", async ({ stage, kind }) => {
    await store().write(REPO, 10, capture());
    const { pointer } = await paths();
    const replacement = join(sandbox, "replacement.json");
    const value = await json(pointer);
    if (kind === "checksum") value.checksum = "0".repeat(64);
    if (kind === "scope") value.limit = 11;
    if (kind === "version") value.schemaVersion = 2;
    if (kind === "missing-snapshot") value.snapshot = "00000000-0000-4000-8000-000000000000.json";
    if (kind === "symlink") await symlink(pointer, replacement);
    else
      await writeFile(replacement, kind === "malformed" ? "{?" : JSON.stringify(value), {
        mode: 0o600,
      });
    if (kind === "permissions") await chmod(replacement, 0o644);
    if (kind === "hardlink") await link(replacement, join(sandbox, "extra-link"));
    if (kind === "oversized") await truncate(replacement, 4097);
    let armed = true;
    vi.mocked(open).mockImplementation(async (...args: Parameters<typeof actualFs.open>) => {
      if (args[0] !== pointer || !armed) return actualFs.open(...args);
      armed = false;
      if (stage === "before-open") {
        await actualFs.rename(replacement, pointer);
        return actualFs.open(...args);
      }
      const handle = await actualFs.open(...args);
      await actualFs.rename(replacement, pointer);
      expect((await handle.stat()).nlink).toBe(0);
      return handle;
    });
    await blocked(store().read(REPO, 10));
    expect(armed).toBe(false);
    await blocked(store().write(REPO, 10, capture()));
  });

  test.each([
    "read",
    "write",
  ])("continuous pointer replacement during %s is bounded and reports busy", async (operation) => {
    await store().write(REPO, 10, capture());
    const { pointer } = await paths();
    const content = await readFile(pointer);
    const original = await history();
    let replacements = 0;
    vi.mocked(open).mockImplementation(async (...args: Parameters<typeof actualFs.open>) => {
      if (args[0] === pointer) {
        const temporary = join(sandbox, `pointer-${++replacements}.json`);
        await writeFile(temporary, content, { mode: 0o600 });
        await actualFs.rename(temporary, pointer);
      }
      return actualFs.open(...args);
    });
    vi.mocked(mkdir).mockClear();
    const pending =
      operation === "read" ? store().read(REPO, 10) : store().write(REPO, 10, capture());
    await blocked(pending, "evidence-store-busy");
    expect(replacements).toBe(4);
    expect(mkdir).not.toHaveBeenCalled();
    expect(await history()).toEqual(original);
  });

  test("detached pointer without a replacement is not a publication race", async () => {
    await store().write(REPO, 10, capture());
    const { pointer } = await paths();
    let armed = true;
    vi.mocked(open).mockImplementation(async (...args: Parameters<typeof actualFs.open>) => {
      const handle = await actualFs.open(...args);
      if (args[0] === pointer && armed) {
        armed = false;
        await rm(pointer);
      }
      return handle;
    });
    await blocked(store().read(REPO, 10));
  });

  test.each([
    "released",
    "permissions",
    "symlink",
  ])("contended lock %s between mkdir and lstat is classified narrowly", async (kind) => {
    await store().write(REPO, 10, capture());
    const lock = join(scopePath(), ".writing");
    const previous = await history();
    await mkdir(lock, { mode: 0o700 });
    vi.mocked(mkdir).mockImplementation(async (...args: Parameters<typeof actualFs.mkdir>) => {
      try {
        return await actualFs.mkdir(...args);
      } catch (error) {
        if (args[0] === lock) {
          expect(error).toMatchObject({ code: "EEXIST" });
          if (kind === "permissions") await chmod(lock, 0o755);
          else {
            await rm(lock, { recursive: true });
            if (kind === "symlink") await symlink(sandbox, lock);
          }
        }
        throw error;
      }
    });
    const changed = capture();
    changed.items[0].body = "must not publish";
    await blocked(
      store().write(REPO, 10, changed),
      kind === "released" ? "evidence-store-busy" : "evidence-invalid",
    );
    for (const entry of previous)
      expect(await readFile(join(scopePath(), entry.name), "utf8")).toBe(entry.data);
    expect(
      (await readdir(scopePath())).filter(
        (name) => name.endsWith(".json") && name !== "current.json",
      ),
    ).toHaveLength(previous.length);
    expect(await store().read(REPO, 10)).toEqual(capture());
    if (kind === "released") await missing(lock);
    else expect((await lstat(lock)).isSymbolicLink()).toBe(kind === "symlink");
  });

  test("stale lock is not stolen or deleted", async () => {
    await store().write(REPO, 10, capture());
    const lock = join(scopePath(), ".writing");
    await mkdir(lock, { mode: 0o700 });
    const changed = capture();
    changed.items[0].body = "changed";
    const before = await state();
    await blocked(store().write(REPO, 10, changed), "evidence-store-busy");
    expect(await state()).toEqual(before);
    expect(await store().read(REPO, 10)).toEqual(capture());
  });
});
