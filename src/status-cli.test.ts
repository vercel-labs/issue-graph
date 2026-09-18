import { describe, expect, test } from "bun:test";
import { parseArgs } from "./cli.js";
import { parseStatusArgs, runStatus, StatusUsageError } from "./status-cli.js";
import type { GhTransport } from "./transport.js";

const args = ["--repo", "o/r", "--author", "ctate,Railly"];
const empty: GhTransport = {
  search: async () => {
    throw new Error("No search expected");
  },
  graphql: async () => ({
    data: {
      repository: {
        pullRequests: {
          totalCount: 0,
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  }),
};

async function capture(argv = args, isTTY = false, noColor = false, t = empty) {
  let stdout = "";
  let stderr = "";
  const exit = await runStatus(argv, t, {
    isTTY,
    noColor,
    width: 160,
    stdout: (value) => {
      stdout += value;
    },
    stderr: (value) => {
      stderr += value;
    },
  });
  return { stdout, stderr, exit };
}

describe("status arguments", () => {
  test("explicit scope, repeat flags, case-insensitive deduplication, and defaults", () => {
    const a = parseStatusArgs([...args, "--repo", "o/second", "--author", "railly"]);
    expect(a.repos).toEqual(["o/r", "o/second"]);
    expect(a.authors).toEqual(["ctate", "Railly"]);
    expect(a.view).toBe("authors");
    expect(a.format).toBe("auto");
    expect(a.maxPages).toBe(100);
  });

  test("views and formats are explicit; JSON never consumes a path", () => {
    for (const view of ["authors", "projects", "prs"] as const)
      expect(parseStatusArgs([...args, "--view", view]).view).toBe(view);
    for (const format of ["table", "markdown", "json", "auto"] as const)
      expect(parseStatusArgs([...args, "--format", format]).format).toBe(format);
    expect(parseStatusArgs([...args, "--json", "--no-snapshot"]).format).toBe("json");
    expect(() => parseStatusArgs([...args, "--json", "out.json"])).toThrow(StatusUsageError);
    expect(parseArgs(["1", "--repo", "o/r", "--json", "graph.json"]).jsonOut).toBe("graph.json");
  });

  test("rejects missing values, scope, conflicting modes, unsafe bounds, and irrelevant graph flags", () => {
    for (const bad of [
      [],
      ["--repo", "o/r"],
      ["--author", "ctate"],
      [...args, "--view"],
      [...args, "--repo", "--json"],
      [...args, "--author", "ctate,"],
      [...args, "--view", "bogus"],
      [...args, "--format", "xml"],
      [...args, "--json", "--format", "table"],
      [...args, "--concurrency", "0"],
      [...args, "--max-pages", "1001"],
      [...args, "--max-pages", "NaN"],
      [...args, "--depth", "1"],
      [...args, "--unknown"],
    ]) {
      expect(() => parseStatusArgs(bad)).toThrow(StatusUsageError);
    }
    expect(parseStatusArgs(["--help"]).help).toBe(true);
  });
});

describe("status output contract", () => {
  test("pipes automatically get versioned JSON with no diagnostics or ANSI", async () => {
    const result = await capture();
    const report = JSON.parse(result.stdout);
    expect(result.exit).toBe(0);
    expect(result.stderr).toBe("");
    expect(report.schemaVersion).toBe(1);
    expect(report.coverageComplete).toBe(true);
    expect(report.rows).toHaveLength(2);
    expect(report.totals.open).toEqual({ count: 0, prIds: [], unknownIds: [] });
    expect(result.stdout).not.toContain(String.fromCharCode(27));
  });

  test("explicit JSON is clean even on a TTY; selected view does not discard JSON evidence", async () => {
    const result = await capture([...args, "--json", "--view", "prs"], true);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout).rows).toHaveLength(2);
    expect(result.stdout).not.toContain(String.fromCharCode(27));
  });

  test("human TTY uses a table, progress/banner stay on stderr, NO_COLOR preserves content", async () => {
    const colored = await capture(args, true);
    const plain = await capture(args, true, true);
    const normalized = (value: string) => value.replaceAll(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "TIME");
    const esc = String.fromCharCode(27);
    const strip = new RegExp(`${esc}\\[[0-9;]*m`, "g");
    expect(normalized(colored.stdout.replace(strip, ""))).toBe(normalized(plain.stdout));
    expect(colored.stdout).toContain(esc);
    expect(plain.stdout).not.toContain(esc);
    expect(plain.stderr).toContain("read-only inventory");
    expect(plain.stderr).toContain("0 PRs scanned, 1 pages");
    expect(plain.stdout).not.toContain("read-only inventory");
    expect(plain.stdout).toContain("Open");
  });

  test("Markdown can be requested in a pipe without ANSI and preserves zero rows", async () => {
    const result = await capture([...args, "--format", "markdown"]);
    expect(result.stdout).toContain("| Repo | Author |");
    expect(result.stdout).toContain("Railly");
    expect(result.stdout).not.toContain(String.fromCharCode(27));
    expect(result.stderr).toBe("");
  });

  test("partial data remains JSON with a nonzero exit, never success with zero results", async () => {
    const result = await capture(args, false, false, {
      ...empty,
      graphql: async () => {
        throw new Error("access denied");
      },
    });
    expect(result.exit).toBe(1);
    expect(JSON.parse(result.stdout).totals.open.count).toBeNull();
    expect(result.stderr).toContain("INCOMPLETE_INVENTORY");
  });

  test("help performs no API calls", async () => {
    const result = await capture(["--help"], false, false, {
      ...empty,
      graphql: async () => {
        throw new Error("must not run");
      },
    });
    expect(result.exit).toBe(0);
    expect(result.stdout).toContain("--author login[,login]");
    expect(result.stderr).toBe("");
  });

  test("actual binary dispatch advertises status, preserves graph --json PATH, and exits 2 for invalid status", async () => {
    const help = Bun.spawn(["bun", "run", "src/cli.ts", "status", "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await help.exited).toBe(0);
    expect(await new Response(help.stdout).text()).toContain("--view VIEW");
    const schema = Bun.spawn(["bun", "run", "src/cli.ts", "schema"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const data = JSON.parse(await new Response(schema.stdout).text());
    expect(await schema.exited).toBe(0);
    expect(data.commands.status.localWrites).toEqual([
      "immutable snapshots under ISSUE_GRAPH_HOME/status (default ~/.issue-graph/status) only with --save",
    ]);
    const bad = Bun.spawn(["bun", "run", "src/cli.ts", "status", "--repo", "o/r"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await bad.exited).toBe(2);
    expect(await new Response(bad.stdout).text()).toBe("");
    expect(await new Response(bad.stderr).text()).toContain("requires --repo and --author");
  });
});
