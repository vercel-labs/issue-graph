import { describe, expect, test } from "vitest";
import { runNode } from "../tests/node-process.js";
import type { JiraReader } from "./jira.js";
import { JiraUsageError, parseJiraArgs, runJira } from "./jira-cli.js";

function payload(key: string, links: string[] = []) {
  return {
    data: {
      key,
      self: `https://demo.atlassian.net/rest/api/3/issue/${key}`,
      fields: {
        summary: `Title ${key}`,
        status: { name: "Open" },
        issuetype: { name: "Task" },
        issuelinks: links.map((target) => ({
          type: { name: "Relates", outward: "relates to" },
          outwardIssue: { key: target },
        })),
      },
    },
  };
}

function reader(
  fixtures: Record<string, unknown>,
): JiraReader & { calls: Array<[string, string | undefined]> } {
  const calls: Array<[string, string | undefined]> = [];
  return {
    calls,
    async getIssue(key, site) {
      calls.push([key, site]);
      const result = fixtures[key];
      if (!result) throw new Error(`missing fixture ${key}`);
      return result;
    },
  };
}

async function capture(argv: string[], source: JiraReader, isTTY = false) {
  let stdout = "";
  let stderr = "";
  const exit = await runJira(argv, source, {
    isTTY,
    stdout: (value) => {
      stdout += value;
    },
    stderr: (value) => {
      stderr += value;
    },
    now: () => new Date("2026-09-26T00:00:00.000Z"),
  });
  return { stdout, stderr, exit };
}

describe("Jira arguments", () => {
  test("normalizes a key and applies bounded defaults", () => {
    expect(parseJiraArgs(["proj-123", "--site", "demo"])).toEqual({
      issueKey: "PROJ-123",
      site: "demo",
      depth: 2,
      maxNodes: 80,
      hubThreshold: 12,
      concurrency: 4,
      format: "auto",
      help: false,
    });
  });

  test("supports explicit output and crawl controls", () => {
    expect(
      parseJiraArgs([
        "PROJ-1",
        "--depth",
        "0",
        "--max-nodes",
        "4",
        "--hub-threshold",
        "2",
        "--concurrency",
        "1",
        "--json",
      ]),
    ).toMatchObject({ depth: 0, maxNodes: 4, hubThreshold: 2, concurrency: 1, format: "json" });
  });

  test("rejects invalid keys, flags, conflicts, and unsafe bounds", () => {
    for (const argv of [
      [],
      ["not-a-key"],
      ["PROJ-1", "PROJ-2"],
      ["PROJ-1", "--unknown"],
      ["PROJ-1", "--site"],
      ["PROJ-1", "--depth", "11"],
      ["PROJ-1", "--max-nodes", "0"],
      ["PROJ-1", "--hub-threshold", "-1"],
      ["PROJ-1", "--concurrency", "33"],
      ["PROJ-1", "--format", "markdown", "--json"],
    ])
      expect(() => parseJiraArgs(argv)).toThrow(JiraUsageError);
    expect(parseJiraArgs(["--help"]).help).toBe(true);
  });
});

describe("Jira command output", () => {
  test("pipes get versioned JSON and crawl same-project links with cross-project boundaries", async () => {
    const source = reader({
      "PROJ-1": payload("PROJ-1", ["PROJ-2", "TEAM-1"]),
      "PROJ-2": payload("PROJ-2", ["PROJ-3"]),
      "PROJ-3": payload("PROJ-3"),
      "TEAM-1": payload("TEAM-1", ["TEAM-2"]),
    });
    const result = await capture(["PROJ-1", "--site", "demo", "--depth", "2"], source);
    const report = JSON.parse(result.stdout);
    expect(result.exit).toBe(0);
    expect(result.stderr).toBe("");
    expect(report).toMatchObject({
      schemaVersion: 1,
      source: "jira-twg",
      generatedAt: "2026-09-26T00:00:00.000Z",
      site: "demo",
      coverageComplete: true,
    });
    expect(
      report.nodes.map((node: { issueKey: string; depth: number }) => [node.issueKey, node.depth]),
    ).toEqual([
      ["PROJ-1", 0],
      ["PROJ-2", 1],
      ["PROJ-3", 2],
      ["TEAM-1", 2],
    ]);
    expect(source.calls).not.toContainEqual(["TEAM-2", "demo"]);
  });

  test("TTY output is Markdown and keeps progress on stderr", async () => {
    const result = await capture(["PROJ-1"], reader({ "PROJ-1": payload("PROJ-1") }), true);
    expect(result.exit).toBe(0);
    expect(result.stdout).toContain("# Jira issue graph: PROJ-1");
    expect(result.stdout).toContain("Title PROJ-1");
    expect(result.stderr).toContain("read-only TWG crawl");
  });

  test("failed reads remain structured and return incomplete exit status", async () => {
    const result = await capture(
      ["PROJ-1", "--json"],
      { getIssue: async () => Promise.reject(new Error("permission denied")) },
      true,
    );
    const report = JSON.parse(result.stdout);
    expect(result.exit).toBe(1);
    expect(report.coverageComplete).toBe(false);
    expect(report.coverage.failed).toEqual(["PROJ-1"]);
    expect(result.stderr).toContain("INCOMPLETE_JIRA_GRAPH");
    expect(result.stderr).not.toContain("read-only TWG crawl");
  });

  test("help performs no TWG calls", async () => {
    const result = await capture(["--help"], {
      getIssue: async () => Promise.reject(new Error("must not run")),
    });
    expect(result.exit).toBe(0);
    expect(result.stdout).toContain("issue-graph jira ISSUE-KEY");
    expect(result.stderr).toBe("");
  });

  test("the binary dispatches Jira help and returns usage exit 2", async () => {
    const help = await runNode(["src/bin.ts", "jira", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("--site SITE");
    const invalid = await runNode(["src/bin.ts", "jira", "not-a-key"]);
    expect(invalid.code).toBe(2);
    expect(invalid.stdout).toBe("");
    expect(invalid.stderr).toContain("requires an issue key");
  });
});
