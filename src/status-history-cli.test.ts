import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStatusReport, type StatusPullRequest } from "./status.js";
import { parseStatusArgs, runStatus } from "./status-cli.js";
import { toStatusSnapshot } from "./status-snapshot.js";
import { latestStatusSnapshot, statusHistoryDir, writeStatusSnapshot } from "./status-store.js";
import type { GhTransport } from "./transport.js";

const scope = { repos: ["o/r"], authors: ["ctate", "Railly"] };
const args = ["--repo", "o/r", "--author", "ctate,Railly"];
const oldTime = "2026-01-01T00:00:00.000Z";
let temp: string;
let home: string;
const pr: StatusPullRequest = {
  id: "o/r#1",
  repo: "o/r",
  number: 1,
  title: "Fix",
  url: "https://github.com/o/r/pull/1",
  author: "Railly",
  headSha: "a".repeat(40),
  updatedAt: oldTime,
  isDraft: false,
  reviewState: "required",
  mergeability: "MERGEABLE",
  assignees: [],
  requestedReviewers: ["ctate"],
};
const connection = (nodes: unknown[]) => ({
  nodes,
  pageInfo: { hasNextPage: false, endCursor: null },
});
const rawPR = {
  number: 1,
  title: "Fix",
  url: pr.url,
  author: { login: "Railly" },
  headRefOid: pr.headSha,
  updatedAt: oldTime,
  isDraft: false,
  reviewDecision: "CHANGES_REQUESTED",
  mergeable: "MERGEABLE",
  assignees: connection([]),
  reviewRequests: connection([]),
};
function transport(nodes: unknown[] = []): GhTransport {
  return {
    search: async () => [],
    graphql: async () => ({
      data: { repository: { pullRequests: { ...connection(nodes), totalCount: nodes.length } } },
    }),
  };
}
function baseline(prs: StatusPullRequest[] = []) {
  return toStatusSnapshot(
    buildStatusReport(
      prs,
      [{ repo: "o/r", complete: true, pages: 1, scanned: prs.length, errors: [] }],
      { ...scope, startedAt: oldTime, generatedAt: oldTime },
    ),
  );
}
async function run(extra: string[], t = transport(), isTTY = false) {
  let stdout = "";
  let stderr = "";
  const exit = await runStatus([...args, ...extra], t, {
    isTTY,
    noColor: true,
    snapshotHome: home,
    stdout: (value) => {
      stdout += value;
    },
    stderr: (value) => {
      stderr += value;
    },
  });
  return { exit, stdout, stderr };
}
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "issue-graph-history-cli-"));
  home = join(temp, "state");
});
afterEach(() => {
  rmSync(temp, { recursive: true, force: true });
});

describe("status history CLI", () => {
  test("history flags are opt-in, explicit, and conflict-safe", () => {
    const parsed = parseStatusArgs([...args, "--since", "last", "--save"]);
    expect(parsed.save).toBe(true);
    expect(parsed.since).toBe("last");
    expect(parseStatusArgs(args).save).toBe(false);
    expect(parseStatusArgs(args).since).toBeNull();
    expect(() => parseStatusArgs([...args, "--since"])).toThrow();
    expect(() => parseStatusArgs([...args, "--save", "--no-snapshot"])).toThrow("conflicts");
    expect(parseStatusArgs([...args, "--since", "capture.json", "--no-snapshot"]).since).toBe(
      "capture.json",
    );
  });

  test("normal status and explicit no-snapshot never create the history directory", async () => {
    for (const extra of [[], ["--no-snapshot"]]) {
      const result = await run(extra);
      const report = JSON.parse(result.stdout);
      expect(result.exit).toBe(0);
      expect(report.history).toBeUndefined();
      expect(report.snapshot).toBeUndefined();
      expect(existsSync(home)).toBe(false);
    }
  });

  test("save produces an immutable receipt and pipeline JSON without diagnostics", async () => {
    const result = await run(["--save"]);
    const report = JSON.parse(result.stdout);
    expect(result.exit).toBe(0);
    expect(result.stderr).toBe("");
    expect(existsSync(report.snapshot.path)).toBe(true);
    expect(latestStatusSnapshot(scope, home)?.snapshot.provenance.kind).toBe("live");
    expect(report.history).toBeUndefined();
  });

  test("since last compares with the prior file before saving the new capture", async () => {
    const before = writeStatusSnapshot(baseline([pr]), home);
    const result = await run(["--since", "last", "--save"], transport([rawPR]));
    const report = JSON.parse(result.stdout);
    expect(result.exit).toBe(0);
    expect(report.history.previousGeneratedAt).toBe(oldTime);
    expect(report.history.changes.map((item: { field: string }) => item.field)).toEqual([
      "requestedReviewers",
      "reviewState",
    ]);
    expect(report.history.totals.changesRequested.delta).toBe(1);
    expect(report.snapshot.path).not.toBe(before);
    expect(readdirSync(statusHistoryDir(scope, home))).toHaveLength(2);
    expect(latestStatusSnapshot(scope, home)?.snapshot.generatedAt).toBe(report.generatedAt);
  });

  test("explicit baseline may be an older exported report and comparison can forbid saving", async () => {
    const file = join(temp, "old-export.json");
    const snapshot = baseline([pr]);
    const report = buildStatusReport(snapshot.pullRequests, snapshot.coverage, {
      ...scope,
      startedAt: oldTime,
      generatedAt: oldTime,
    });
    writeFileSync(file, JSON.stringify(report));
    const result = await run(["--since", file, "--no-snapshot"], transport([rawPR]));
    const output = JSON.parse(result.stdout);
    expect(output.history.previousProvenance.kind).toBe("imported-report");
    expect(output.snapshot).toBeUndefined();
    expect(existsSync(home)).toBe(false);
  });

  test("missing baseline fails before network access or directory creation", async () => {
    let calls = 0;
    const t = transport();
    t.graphql = async () => {
      calls++;
      return {};
    };
    await expect(run(["--since", "last", "--save"], t)).rejects.toThrow(
      "First run: issue-graph status",
    );
    expect(calls).toBe(0);
    expect(existsSync(home)).toBe(false);
  });

  test("corrupt, mismatched, and future snapshots fail before GitHub is queried", async () => {
    let calls = 0;
    const t = transport();
    t.graphql = async () => {
      calls++;
      return {};
    };
    const file = writeStatusSnapshot(baseline(), home);
    writeFileSync(file, "{");
    await expect(run(["--since", "last"], t)).rejects.toThrow("Cannot read");
    writeFileSync(file, JSON.stringify({ ...baseline(), scope: { ...scope, authors: ["other"] } }));
    await expect(run(["--since", file], t)).rejects.toThrow("scope mismatch");
    writeFileSync(
      file,
      JSON.stringify({
        ...baseline(),
        startedAt: "2999-01-01T00:00:00Z",
        generatedAt: "2999-01-01T00:00:00Z",
      }),
    );
    await expect(run(["--since", file], t)).rejects.toThrow("future");
    expect(calls).toBe(0);
  });

  test.each([
    "repos",
    "authors",
  ] as const)("rejects baseline scope.%s control sequences with safe CLI stderr and no network", async (field) => {
    const value = baseline();
    value.scope[field][0] += "\x1b]52;c;c2VjcmV0\x07";
    const file = join(temp, "malformed-scope.json");
    writeFileSync(file, JSON.stringify(value));
    let calls = 0;
    const unexpectedNetwork = async () => {
      calls++;
      throw new Error("Unexpected network access");
    };
    await expect(
      run(["--since", file], { search: unexpectedNetwork, graphql: unexpectedNetwork }),
    ).rejects.toThrow("Invalid status snapshot: scope");
    expect(calls).toBe(0);

    const command = Bun.spawn(
      [process.execPath, "src/cli.ts", "status", ...args, "--since", file],
      {
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, PATH: temp, ISSUE_GRAPH_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exit, stdout, stderr] = await Promise.all([
      command.exited,
      new Response(command.stdout).text(),
      new Response(command.stderr).text(),
    ]);
    expect(exit).toBe(1);
    expect(stdout).toBe("");
    expect(
      [...stderr].some((char) => {
        const code = char.charCodeAt(0);
        return (code < 32 && code !== 10) || (code >= 127 && code <= 159);
      }),
    ).toBe(false);
    expect(stderr).toBe(`Cannot read status snapshot ${file}: Invalid status snapshot: scope\n`);
    expect(existsSync(home)).toBe(false);
  });

  test("disappeared PRs require terminal proof and uncertainty has a nonzero exit", async () => {
    writeStatusSnapshot(baseline([pr]), home);
    const t = transport();
    const original = t.graphql;
    t.graphql = async (query, vars) =>
      vars?.number ? { data: { repository: { pullRequest: null } } } : original(query, vars);
    const result = await run(["--since", "last"], t);
    const output = JSON.parse(result.stdout);
    expect(result.exit).toBe(1);
    expect(output.history.departures[0].state).toBe("UNVERIFIED");
    expect(result.stderr).toContain("INCOMPLETE_HISTORY");
  });

  test("human output appends comparisons and writes snapshot receipts to stderr", async () => {
    writeStatusSnapshot(baseline([pr]), home);
    const result = await run(
      ["--since", "last", "--save", "--format", "markdown"],
      transport([rawPR]),
      true,
    );
    expect(result.exit).toBe(0);
    expect(result.stdout).toContain("## Changes");
    expect(result.stdout).toContain("| PR | Field | Before | After |");
    expect(result.stdout).toContain("changes\\-requested");
    expect(result.stderr).toContain("Snapshot saved:");
    expect(result.stdout).not.toContain("Snapshot saved:");
  });

  test("unknown metadata on an added PR matches human and machine incompleteness", async () => {
    writeStatusSnapshot(baseline(), home);
    const result = await run(["--since", "last"], transport([{ ...rawPR, mergeable: "UNKNOWN" }]));
    const report = JSON.parse(result.stdout);
    expect(report.history.coverageComplete).toBe(false);
    expect(report.history.totals.conflicts.delta).toBeNull();
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain("INCOMPLETE_HISTORY");
  });

  test("actual CLI honors ISSUE_GRAPH_HOME and rejects conflicts before accessing GitHub", async () => {
    const command = Bun.spawn(
      ["bun", "run", "src/cli.ts", "status", ...args, "--since", "last", "--save"],
      { env: { ...process.env, ISSUE_GRAPH_HOME: home }, stdout: "pipe", stderr: "pipe" },
    );
    expect(await command.exited).toBe(1);
    expect(await new Response(command.stderr).text()).toContain("No prior status snapshot");
    expect(await new Response(command.stdout).text()).toBe("");
    expect(existsSync(home)).toBe(false);
  });
});
