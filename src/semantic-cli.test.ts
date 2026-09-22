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
import { SEMANTIC_MAX_TAXONOMY_BYTES } from "./semantic.js";
import {
  parseSemanticArgs,
  runSemanticCli,
  SEMANTIC_USAGE,
  type SemanticIO,
} from "./semantic-cli.js";
import { SemanticError, type SemanticPreview } from "./semantic-types.js";
import type { GhTransport } from "./transport.js";

const TIME = "2026-09-20T00:00:00Z";
const ARGS = ["--repo", "o/r", "--dry-run"];
const SECRET = "external-body-secret-do-not-print";
const ESC = String.fromCharCode(27);
const INCOMPLETE =
  "INCOMPLETE_PREVIEW: inspect coverage and deferred items; no inference was performed.\n";
const fetchSentinel = vi.fn(() => {
  throw new Error("Provider and external fetches are forbidden");
});

function fixture(total = 1, respond?: (call: Call, response: unknown) => unknown) {
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
        node.title = `Synthetic issue ${node.number}`;
        if ("body" in node) node.body = `${SECRET} https://example.invalid/evidence`;
        for (const value of record(node.comments).nodes as unknown[]) {
          const comment = record(value);
          comment.id = `C_${node.number}`;
          comment.author = { login: "synthetic" };
          if ("body" in comment) comment.body = SECRET;
        }
      }
      return respond ? respond(call, response) : response;
    },
  });
}

async function capture(
  transport: GhTransport,
  argv = ARGS,
  options: Partial<Omit<SemanticIO, "stdout" | "stderr">> = {},
) {
  let stdout = "";
  let stderr = "";
  const exit = await runSemanticCli(argv, transport, {
    isTTY: false,
    now: () => TIME,
    evidenceStore: { read: async () => null, write: async () => {} },
    cacheStore: {
      read: async () => ({ status: "miss" }),
      write: async () => {
        throw new Error("Preview cache must remain read-only");
      },
    },
    ...options,
    stdout: (value) => {
      stdout += value;
    },
    stderr: (value) => {
      stderr += value;
    },
  });
  return { exit, stdout, stderr };
}

function preview(result: Awaited<ReturnType<typeof capture>>): SemanticPreview {
  const report = JSON.parse(result.stdout);
  expect(report).toMatchObject({ schemaVersion: 1, kind: "classification-preview" });
  expect(result.stdout + result.stderr).not.toContain(ESC);
  return report;
}

function expectError(result: Awaited<ReturnType<typeof capture>>, code: string, exit = 2) {
  expect(result.exit).toBe(exit);
  expect(JSON.parse(result.stdout)).toMatchObject({
    schemaVersion: 1,
    kind: "classification-error",
    error: { code, message: expect.any(String), hint: expect.any(String) },
  });
  expect(result.stderr).toContain(`${code}: `);
  expect(result.stdout + result.stderr).not.toContain(ESC);
  expect(result.stdout + result.stderr).not.toContain(SECRET);
}

function taxonomy() {
  return {
    schemaVersion: 1,
    repo: "o/r",
    version: "v1",
    components: [{ id: "cli", description: "Command-line café", examples: ["Résumé output"] }],
  };
}

async function withTempDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "issue-graph-semantic-cli-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function directorySnapshot(root: string) {
  const entries: Array<{ path: string; mode: number; mtimeMs: number; content: string | null }> =
    [];
  async function visit(relative: string) {
    const path = join(root, relative);
    const info = await stat(path);
    entries.push({
      path: relative,
      mode: info.mode,
      mtimeMs: info.mtimeMs,
      content: info.isDirectory() ? null : (await readFile(path)).toString("hex"),
    });
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(relative, name));
    }
  }
  await visit("");
  return entries;
}

async function withoutCredentials(run: () => Promise<void>) {
  const original = process.env;
  const reads = vi.fn((key: string) => {
    throw new Error(`Credential access forbidden: ${key}`);
  });
  process.env = new Proxy(original, {
    get(target, key) {
      if (
        typeof key === "string" &&
        /GATEWAY|JEV|VERCEL_OIDC_TOKEN|^(GH_TOKEN|GITHUB_TOKEN)$/.test(key)
      ) {
        return reads(key);
      }
      return Reflect.get(target, key);
    },
  });
  try {
    await run();
    expect(reads).not.toHaveBeenCalled();
  } finally {
    process.env = original;
  }
}

beforeEach(() => {
  fetchSentinel.mockClear();
  vi.stubGlobal("fetch", fetchSentinel);
});

afterEach(() => {
  try {
    expect(fetchSentinel).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

describe("parseSemanticArgs", () => {
  const expectedDefaults = {
    repo: "o/r",
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

  test.each([
    ["explicit dry-run", ARGS, { dryRun: true }],
    ["help without a repository", ["--help"], { repo: "", help: true }],
    ["default inference", ["--repo", "o/r"], {}],
  ])("preserves %s defaults", (_name, argv, overrides) => {
    expect(parseSemanticArgs(argv)).toEqual({ ...expectedDefaults, ...overrides });
  });

  test("refresh is a boolean and composes with dry-run and no-snapshot", () => {
    expect(parseSemanticArgs([...ARGS, "--refresh", "--no-snapshot"])).toMatchObject({
      refresh: true,
      dryRun: true,
      noSnapshot: true,
    });
  });

  test("parses all supported overrides without consuming a JSON filename", () => {
    expect(
      parseSemanticArgs([
        ...ARGS,
        "--taxonomy",
        "a taxonomy.json",
        "--limit",
        "500",
        "--max-calls",
        "0",
        "--format",
        "auto",
        "--json",
        "--no-snapshot",
      ]),
    ).toEqual({
      ...expectedDefaults,
      taxonomy: "a taxonomy.json",
      limit: 500,
      maxCalls: 0,
      format: "json",
      dryRun: true,
      noSnapshot: true,
    });
    expect(parseSemanticArgs([...ARGS, "--format", "json", "--json"]).format).toBe("json");
    expect(parseSemanticArgs([...ARGS, "--format", "markdown"]).format).toBe("markdown");
  });

  test.each([
    ["1", "0"],
    ["500", "500"],
    ["001", "050"],
  ])("accepts decimal bounds limit=%s maxCalls=%s", (limit, maxCalls) => {
    expect(parseSemanticArgs([...ARGS, "--limit", limit, "--max-calls", maxCalls])).toMatchObject({
      limit: Number(limit),
      maxCalls: Number(maxCalls),
    });
  });

  const invalid: Array<[string, string[], string]> = [
    ["missing repo", ["--dry-run"], "invalid-repository"],
    ...["--unknown", "--save", "--apply", "--repo=o/r"].map((flag): [string, string[], string] => [
      flag,
      [...ARGS, flag],
      "invalid-arguments",
    ]),
    ["positional issue", [...ARGS, "123"], "invalid-arguments"],
    ["JSON filename", [...ARGS, "--json", "out.json"], "invalid-arguments"],
    ["JSON value", [...ARGS, "--json", "false"], "invalid-arguments"],
    ["dry-run value", [...ARGS, "false"], "invalid-arguments"],
    ["refresh value", [...ARGS, "--refresh", "false"], "invalid-arguments"],
    ["format type", [...ARGS, "--format", "xml"], "invalid-arguments"],
    ["JSON conflict", [...ARGS, "--json", "--format", "markdown"], "invalid-arguments"],
    ["reversed conflict", [...ARGS, "--format", "markdown", "--json"], "invalid-arguments"],
    ...[
      "o",
      "o/r/x",
      "o/.",
      "o/..",
      "o/r,other/repo",
      "https://github.com/o/r",
      "-o/r",
      "o/r?x",
      "o/r#1",
      "o/r\n",
    ].map((repo): [string, string[], string] => [
      `repo ${JSON.stringify(repo)}`,
      ["--repo", repo, "--dry-run"],
      repo.startsWith("-") ? "invalid-arguments" : "invalid-repository",
    ]),
    ...["--repo", "--taxonomy", "--limit", "--max-calls", "--format"].flatMap(
      (flag): Array<[string, string[], string]> => [
        [`missing ${flag}`, ["--dry-run", flag], "invalid-arguments"],
        [`flag as ${flag} value`, ["--dry-run", flag, "--json"], "invalid-arguments"],
        [`empty ${flag}`, ["--dry-run", flag, ""], "invalid-arguments"],
      ],
    ),
    ...["--limit", "--max-calls"].flatMap((flag) =>
      ["-1", "501", "1.5", "NaN", "Infinity", "1e2", "0x10", "true", " 1", "9007199254740992"].map(
        (value): [string, string[], string] => [
          `${flag} ${value}`,
          [...ARGS, flag, value],
          "invalid-arguments",
        ],
      ),
    ),
    ["zero limit", [...ARGS, "--limit", "0"], "invalid-arguments"],
    ...[
      ["--repo", "o/r"],
      ["--taxonomy", "taxonomy.json"],
      ["--limit", "2"],
      ["--max-calls", "1"],
      ["--format", "json"],
      ["--json"],
      ["--dry-run"],
      ["--no-snapshot"],
      ["--refresh"],
      ["--help"],
      ["-h"],
    ].map((option): [string, string[], string] => [
      `duplicate ${option[0]}`,
      ["--repo", "o/r", ...option, ...option, "--dry-run"],
      "invalid-arguments",
    ]),
  ];

  test.each(invalid)("rejects %s before taxonomy or GitHub access", async (_label, argv, code) => {
    let error: unknown;
    try {
      parseSemanticArgs(argv);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SemanticError);
    expect(error).toMatchObject({ code, exitCode: 2 });
    const { transport } = fixture();
    const readTaxonomy = vi.fn(async () => {
      throw new Error(SECRET);
    });
    expectError(await capture(transport, argv, { readTaxonomy }), code);
    expect(transport.graphql).not.toHaveBeenCalled();
    expect(transport.search).not.toHaveBeenCalled();
    expect(readTaxonomy).not.toHaveBeenCalled();
  });
});

describe("runSemanticCli output and boundaries", () => {
  test.each([
    "--help",
    "-h",
  ])("%s needs no auth, repository, taxonomy read or network", async (flag) => {
    await withoutCredentials(async () => {
      const { transport } = fixture();
      const readTaxonomy = vi.fn(async () => {
        throw new Error(SECRET);
      });
      const argv = [flag, "--taxonomy", "missing-explicit-taxonomy.json"];
      for (const options of [{ readTaxonomy }, {}]) {
        const result = await capture(transport, argv, options);
        expect(result).toEqual({ exit: 0, stdout: `${SEMANTIC_USAGE}\n`, stderr: "" });
        expect(result.stdout).not.toContain(ESC);
      }
      expect(readTaxonomy).not.toHaveBeenCalled();
      expect(transport.graphql).not.toHaveBeenCalled();
      expect(transport.search).not.toHaveBeenCalled();
    });
  });

  test.each([
    { label: "automatic pipe", flags: [], isTTY: false },
    { label: "JSON alias TTY", flags: ["--json"], isTTY: true },
    { label: "explicit JSON TTY", flags: ["--format", "json"], isTTY: true },
  ])("$label has clean JSON stdout and no progress", async ({ flags, isTTY }) => {
    const { transport } = fixture();
    const result = await capture(transport, [...ARGS, ...flags], { isTTY });
    const report = preview(result);
    expect(result.exit).toBe(0);
    expect(result.stderr).toBe("");
    expect(report).toMatchObject({
      scope: { repo: "o/r", state: "OPEN", limit: 50, maxCalls: 50 },
      captureWindow: { startedAt: TIME, completedAt: TIME },
      coverageComplete: true,
      taxonomy: null,
      modelRequested: "typesafe-ai/jev",
      modelResolved: null,
      execution: { dryRun: true, gatewayCalls: 0, localWrites: 0, cache: "read-only" },
      totals: {
        captured: 1,
        eligible: 1,
        plannedCalls: 1,
        deferred: 0,
        reportedCostUsd: 0,
        hasUnknownCost: false,
      },
    });
    expect(report.items[0]).toMatchObject({
      key: "o/r#1",
      plannedCall: true,
      outcome: "needs-review",
      reviewRequired: true,
      componentStatus: "unavailable",
      reasonCodes: ["taxonomy-missing", "preview-only"],
      inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      inputBytes: expect.any(Number),
      questionIds: [
        "requestType",
        "reproStepsPresent",
        "expectedActualPresent",
        "regressionReported",
        "impactReported",
      ],
      evidence: { commentsCoverage: { captured: 1, total: 1, complete: true } },
    });
    expect(report.items[0].evidence.comments[0]).not.toHaveProperty("body");
    expect(result.stdout).not.toContain(SECRET);
    expect(transport.search).not.toHaveBeenCalled();
  });

  test("TTY markdown keeps progress on stderr and NO_COLOR changes nothing", async () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    vi.stubEnv("NO_COLOR", undefined);
    const normal = await capture(fixture().transport, ARGS, { isTTY: true });
    vi.stubEnv("NO_COLOR", "1");
    const plain = await capture(fixture().transport, ARGS, { isTTY: true });
    expect(plain).toEqual(normal);
    expect(plain.exit).toBe(0);
    expect(plain.stdout).toContain("# Classification preview: o/r\n");
    expect(plain.stdout).toContain("| Issue | Preview outcome | Planned call |");
    expect(plain.stdout).toContain("Human review required.");
    expect(plain.stderr).toBe(
      "issue-graph classify: read-only evidence preview; no inference\n" +
        "Captured 1 issues from 1 issue pages; collecting and rechecking comments.\n",
    );
    expect(plain.stdout).not.toContain("Captured 1 issues");
    expect(plain.stdout).not.toContain("issue-graph classify: read-only");
    expect(plain.stdout + plain.stderr).not.toContain(ESC);
    expect(plain.stdout + plain.stderr).not.toContain(SECRET);
  });

  test("explicit markdown works in a pipe without progress or ANSI", async () => {
    const result = await capture(fixture().transport, [...ARGS, "--format", "markdown"]);
    expect(result.exit).toBe(0);
    expect(result.stdout).toContain("# Classification preview: o/r");
    expect(result.stdout).toContain("| o/r\\#1 | needs\\-review | yes |");
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain(ESC);
  });

  test("max-calls 0 defers eligible work, preserves evidence and exits 1", async () => {
    const { transport, calls } = fixture();
    const result = await capture(transport, [...ARGS, "--max-calls", "0"]);
    const report = preview(result);
    expect(result.exit).toBe(1);
    expect(result.stderr).toBe(INCOMPLETE);
    expect(report.coverageComplete).toBe(true);
    expect(report.totals).toMatchObject({ captured: 1, eligible: 1, plannedCalls: 0, deferred: 1 });
    expect(report.items[0]).toMatchObject({
      plannedCall: false,
      outcome: "needs-review",
      reasonCodes: ["taxonomy-missing", "max-calls-reached"],
    });
    expect(calls.filter(({ operation }) => operation === "Issues")).toHaveLength(1);
    expect(calls.find(({ operation }) => operation === "Issues")?.query).toMatch(/\bbody\b/);
    expect(calls.filter(({ operation }) => operation === "Versions")).toHaveLength(1);
    expect(report.items[0].evidence.commentsCoverage).toMatchObject({
      captured: 1,
      complete: true,
    });
    expect(report.execution.gatewayCalls).toBe(0);
  });

  test("a limited inventory remains partial rather than claiming complete coverage", async () => {
    const result = await capture(fixture(2).transport, [...ARGS, "--limit", "1"]);
    const report = preview(result);
    expect(result.exit).toBe(1);
    expect(result.stderr).toBe(INCOMPLETE);
    expect(report.coverage).toMatchObject({
      captured: 1,
      total: 2,
      hasNextPage: true,
      complete: false,
      reasonCodes: ["issue-limit"],
    });
    expect(report.items).toHaveLength(1);
  });

  test.each([
    "json",
    "markdown",
  ])("%s distinguishes failed capture from actual empty", async (format) => {
    const flags = [...ARGS, "--format", format, "--max-calls", "0"];
    const empty = await capture(fixture(0).transport, flags);
    const partial = await capture(
      fixture(0, (call, response) => {
        if (call.operation === "Issues") throw new Error(SECRET);
        return response;
      }).transport,
      flags,
    );
    expect(empty.exit).toBe(0);
    expect(empty.stderr).toBe("");
    expect(partial.exit).toBe(1);
    expect(partial.stderr).toBe(INCOMPLETE);
    expect(partial.stdout + partial.stderr).not.toContain(SECRET);
    if (format === "json") {
      expect(preview(empty)).toMatchObject({
        coverageComplete: true,
        items: [],
        coverage: { captured: 0, total: 0, hasNextPage: false, complete: true, reasonCodes: [] },
        totals: { captured: 0, plannedCalls: 0, deferred: 0 },
      });
      expect(preview(partial)).toMatchObject({
        coverageComplete: false,
        items: [],
        coverage: {
          captured: 0,
          hasNextPage: null,
          complete: false,
          reasonCodes: ["github-read-failed"],
        },
      });
    } else {
      expect(empty.stdout).toContain("No open issues observed in the captured scope.");
      expect(partial.stdout).toContain("No verified issue inventory is available.");
      expect(partial.stdout).not.toContain("No open issues observed.");
    }
  });

  test.each([
    "transport",
    "graphql",
    "loader",
  ])("sanitizes %s exceptions and external bodies", async (source) => {
    const { transport } = fixture(1, (call, response) => {
      if (call.operation !== "Repository") return response;
      if (source === "transport") throw new Error(`${SECRET}\n${ESC}[31m`);
      if (source === "graphql") return { ...record(response), errors: [{ message: SECRET }] };
      return response;
    });
    const result = await capture(
      transport,
      source === "loader" ? [...ARGS, "--taxonomy", "explicit.json"] : ARGS,
      source === "loader"
        ? {
            readTaxonomy: async () => {
              throw new Error(SECRET);
            },
          }
        : {},
    );
    expectError(
      result,
      source === "transport"
        ? "github-read-failed"
        : source === "graphql"
          ? "github-graphql-error"
          : "preview-failed",
      1,
    );
    expect(JSON.parse(result.stdout).error).not.toHaveProperty("stack");
    if (source === "loader") expect(transport.graphql).not.toHaveBeenCalled();
  });

  test("dry-run never reads Gateway credentials or fetches providers or evidence URLs", async () => {
    await withoutCredentials(async () => {
      const result = await capture(fixture().transport);
      expect(result.exit).toBe(0);
      expect(preview(result).execution).toEqual({
        dryRun: true,
        gatewayCalls: 0,
        localWrites: 0,
        cache: "read-only",
      });
      expect(fetchSentinel).not.toHaveBeenCalled();
    });
  });

  test("final dry-run recheck excludes an issue that closed after comments", async () => {
    const { transport, calls } = fixture(1, (call, response) => {
      if (call.operation === "Versions") record(repoData(response).i0).state = "CLOSED";
      return response;
    });
    const result = await capture(transport);
    const report = preview(result);
    expect(result.exit).toBe(1);
    expect(result.stderr).toBe(INCOMPLETE);
    expect(report.coverageComplete).toBe(false);
    expect(report.totals).toMatchObject({
      captured: 1,
      eligible: 0,
      plannedCalls: 0,
      deferred: 0,
      excluded: 1,
    });
    expect(report.items[0]).toMatchObject({
      outcome: "skipped",
      plannedCall: false,
      inputHash: null,
      inputBytes: null,
      questionIds: [],
      reasonCodes: expect.arrayContaining(["state-changed"]),
      evidence: { state: "CLOSED", commentsCoverage: { complete: true, captured: 1 } },
    });
    expect(calls.map(({ operation }) => operation)).toEqual([
      "Repository",
      "Issues",
      "Repository",
      "Versions",
      "Repository",
    ]);
    expect(
      calls.filter(({ operation }) => operation === "Versions").map(({ variables }) => variables),
    ).toEqual([{ owner: "o", repo: "r", number0: 1, first0: 10 }]);
    const versionQuery = calls.find(({ operation }) => operation === "Versions")?.query;
    expect(versionQuery).toContain("i0: issue(number: $number0)");
    expect(versionQuery).toContain("comments(first: $first0, after: $after0)");
    expect(versionQuery).toContain("updatedAt");
    expect(versionQuery).not.toMatch(/\bbody\b/);
    for (const call of calls) expect(call.query).not.toMatch(/\b(mutation|search|pullRequests)\b/);
    expect(transport.search).not.toHaveBeenCalled();
  });
});

describe("explicit taxonomy files and local state", () => {
  test.each([
    ["wrong repo", { ...taxonomy(), repo: "other/repo" }],
    ["wrong schema type", { ...taxonomy(), schemaVersion: "1" }],
    ["wrong components type", { ...taxonomy(), components: {} }],
    [
      "duplicate IDs",
      { ...taxonomy(), components: [taxonomy().components[0], taxonomy().components[0]] },
    ],
    [
      "reserved ID",
      { ...taxonomy(), components: [{ id: "constructor", description: "Reserved" }] },
    ],
    ["unknown taxonomy field", { ...taxonomy(), gateway: SECRET }],
  ])("rejects %s before any network", async (_label, value) => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, "taxonomy.json");
      await writeFile(path, JSON.stringify(value));
      const { transport } = fixture();
      expectError(await capture(transport, [...ARGS, "--taxonomy", path]), "invalid-taxonomy");
      expect(transport.graphql).not.toHaveBeenCalled();
      expect(transport.search).not.toHaveBeenCalled();
    });
  });

  test.each([
    "UTF-8",
    "exact byte cap",
  ])("loads valid explicit JSON at %s with the actual loader", async (variant) => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, "taxonomy with spaces.json");
      let contents = JSON.stringify(taxonomy());
      if (variant === "exact byte cap") {
        contents += " ".repeat(SEMANTIC_MAX_TAXONOMY_BYTES - Buffer.byteLength(contents));
        expect(Buffer.byteLength(contents)).toBe(SEMANTIC_MAX_TAXONOMY_BYTES);
      }
      await writeFile(path, contents);
      const result = await capture(fixture().transport, [...ARGS, "--taxonomy", path]);
      const report = preview(result);
      expect(result.exit).toBe(0);
      expect(report.taxonomy).toEqual({ version: "v1", components: ["cli"] });
      expect(report.items[0].componentStatus).toBe("available");
      expect(report.items[0].questionIds).toContain("component");
      expect(report.items[0].reasonCodes).not.toContain("taxonomy-missing");
      expect(await readFile(path, "utf8")).toBe(contents);
    });
  });

  test.each([
    "malformed",
    "oversized ASCII",
    "oversized UTF-8",
    "invalid UTF-8",
    "directory",
    "missing",
  ])("rejects %s through the real file loader before GitHub", async (variant) => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, `${SECRET}.json`);
      if (variant === "directory") await mkdir(path);
      else if (variant === "malformed") await writeFile(path, `{"secret":"${SECRET}"`);
      else if (variant === "invalid UTF-8")
        await writeFile(
          path,
          Buffer.concat([
            Buffer.from(
              '{"schemaVersion":1,"repo":"o/r","version":"v1","components":[{"id":"cli","description":"',
            ),
            Buffer.from([0xc3, 0x28]),
            Buffer.from('"}]}'),
          ]),
        );
      else if (variant === "oversized ASCII") {
        const contents = JSON.stringify({
          ...taxonomy(),
          components: [{ id: "cli", description: "Command-line output" }],
        }).padEnd(SEMANTIC_MAX_TAXONOMY_BYTES + 1);
        expect(Buffer.byteLength(contents)).toBe(SEMANTIC_MAX_TAXONOMY_BYTES + 1);
        await writeFile(path, contents);
      } else if (variant === "oversized UTF-8") {
        const contents = JSON.stringify({
          ...taxonomy(),
          components: Array.from({ length: 18 }, (_, index) => ({
            id: `component-${index}`,
            description: "é".repeat(1900),
          })),
        });
        expect(contents.length).toBeLessThan(SEMANTIC_MAX_TAXONOMY_BYTES);
        expect(Buffer.byteLength(contents)).toBeGreaterThan(SEMANTIC_MAX_TAXONOMY_BYTES);
        await writeFile(path, contents);
      }
      const { transport } = fixture();
      expectError(await capture(transport, [...ARGS, "--taxonomy", path]), "taxonomy-read-failed");
      expect(transport.graphql).not.toHaveBeenCalled();
      expect(transport.search).not.toHaveBeenCalled();
    });
  });

  test.each([
    false,
    true,
  ])("ignores implicit config and makes no local writes, no-snapshot=%s", async (noSnapshot) => {
    await withTempDirectory(async (directory) => {
      const originalCwd = process.cwd();
      const originalHome = process.env.ISSUE_GRAPH_HOME;
      const home = join(directory, "home");
      await mkdir(join(home, "semantic"), { recursive: true });
      await mkdir(join(home, "status"));
      await writeFile(join(home, "semantic", "cache.json"), SECRET);
      await writeFile(join(home, "status", "snapshot.json"), SECRET);
      await writeFile(
        join(home, "config.json"),
        JSON.stringify({ unknown: true, taxonomy: "missing.json", maxCalls: 0 }),
      );
      await writeFile(join(home, "taxonomy.json"), SECRET);
      await writeFile(join(directory, ".issue-graph.json"), SECRET);
      await writeFile(join(directory, "taxonomy.json"), SECRET);
      const before = await directorySnapshot(directory);
      try {
        process.env.ISSUE_GRAPH_HOME = home;
        process.chdir(directory);
        const result = await capture(fixture().transport, [
          ...ARGS,
          ...(noSnapshot ? ["--no-snapshot"] : []),
        ]);
        expect(result.exit).toBe(0);
        expect(preview(result)).toMatchObject({
          taxonomy: null,
          scope: { maxCalls: 50 },
          execution: { localWrites: 0, cache: noSnapshot ? "disabled" : "read-only" },
          totals: { plannedCalls: 1 },
        });
        expect(await directorySnapshot(directory)).toEqual(before);
      } finally {
        process.chdir(originalCwd);
        if (originalHome === undefined) delete process.env.ISSUE_GRAPH_HOME;
        else process.env.ISSUE_GRAPH_HOME = originalHome;
      }
    });
  });
});
