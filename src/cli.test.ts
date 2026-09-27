import { writeFile } from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { nextSteps, parseArgs, runCli, statusArgs, UsageError } from "./cli.js";
import { listSnapshots, writeSnapshot } from "./snapshot.js";
import { shellTransport } from "./transports/shell.js";

vi.mock("./transports/shell.js", () => ({ shellTransport: vi.fn() }));
vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(), writeFile: vi.fn() }));
vi.mock("./snapshot.js", async (original) => ({
  ...(await original<typeof import("./snapshot.js")>()),
  listSnapshots: vi.fn(() => []),
  writeSnapshot: vi.fn(),
  writeReconcileSnapshot: vi.fn(),
  writeDashboardModel: vi.fn(() => "/tmp/model.json"),
  readDashboardModels: vi.fn(() => []),
}));

describe("parseArgs", () => {
  test("parses a seed with repo and depth", () => {
    const a = parseArgs(["352", "--repo", "o/r", "--depth", "3"]);
    expect(a.seed).toBe("352");
    expect(a.repo).toBe("o/r");
    expect(a.depth).toBe(3);
  });

  test("boolean flags are not swallowed as the seed", () => {
    const a = parseArgs(["352", "--repo", "o/r", "--no-snapshot", "--cluster"]);
    expect(a.seed).toBe("352");
    expect(a.noSnapshot).toBe(true);
    expect(a.cluster).toBe(true);
  });

  test("--cluster-run implies --cluster and captures the agent", () => {
    const a = parseArgs(["1", "--repo", "o/r", "--cluster-run", "claude"]);
    expect(a.cluster).toBe(true);
    expect(a.clusterRun).toBe("claude");
  });

  test("--seeds and --label are captured", () => {
    expect(parseArgs(["--seeds", "1,2,3", "--repo", "o/r"]).seedsCsv).toBe("1,2,3");
    expect(parseArgs(["--label", "bug", "--repo", "o/r"]).label).toBe("bug");
  });

  test("parses reconcile and its output format", () => {
    const a = parseArgs(["reconcile", "--repo", "o/r", "--format", "json", "--concurrency", "6"]);
    expect(a.command).toBe("reconcile");
    expect(a.repo).toBe("o/r");
    expect(a.seed).toBe("");
    expect(a.format).toBe("json");
    expect(a.concurrency).toBe(6);
  });

  test("parses plan as a repository backlog command", () => {
    const a = parseArgs(["plan", "--repo", "o/r", "--format", "markdown"]);
    expect(a.command).toBe("plan");
    expect(a.repo).toBe("o/r");
    expect(a.format).toBe("markdown");
  });

  test("rejects HTML output for plan", () => {
    expect(() => parseArgs(["plan", "--repo", "o/r", "--html", "/tmp/plan.html"])).toThrow(
      "plan does not support --html",
    );
  });

  test("parses schema without treating it as a seed", () => {
    const a = parseArgs(["schema"]);
    expect(a.command).toBe("schema");
    expect(a.seed).toBe("");
  });

  test("rejects unsupported formats and limits text to graph/plan", () => {
    expect(() => parseArgs(["reconcile", "--format", "xml"])).toThrow(UsageError);
    // human is reconcile's readable report
    expect(parseArgs(["reconcile", "--format", "human"]).format).toBe("markdown");
    expect(() => parseArgs(["schema", "--format", "text"])).toThrow(UsageError);
    expect(parseArgs(["1", "--repo", "o/r", "--format", "text"]).format).toBe("text");
    expect(parseArgs(["plan", "--repo", "o/r", "--format", "text"]).format).toBe("text");
  });

  // `--help` used to fall through to the seed and die in parseSeed with
  // "Cannot parse seed: --help", which is a poor first impression.
  test("--help and -h ask for usage instead of becoming the seed", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["--help"]).seed).toBe("");
  });

  test("an unknown flag is an error, not a seed", () => {
    expect(() => parseArgs(["--hlep"])).toThrow(UsageError);
    expect(() => parseArgs(["352", "--repo", "o/r", "--depht", "2"])).toThrow(UsageError);
  });

  test("rejects unsafe crawl limits", () => {
    expect(() => parseArgs(["1", "--repo", "o/r", "--max-nodes", "1001"])).toThrow(UsageError);
    expect(() => parseArgs(["1", "--repo", "o/r", "--concurrency", "0"])).toThrow(UsageError);
  });
});

describe("onboarding", () => {
  test("--open parses and is rejected by plan", () => {
    expect(parseArgs(["1", "--repo", "o/r", "--open"]).open).toBe(true);
    expect(() => parseArgs(["plan", "--repo", "o/r", "--open"])).toThrow(/--open/);
    expect(parseArgs(["dashboard", "--open"]).command).toBe("dashboard");
  });

  test("next steps list only the views this run did not use", () => {
    const bare = nextSteps(parseArgs(["--label", "bug", "--repo", "o/r"]), "o", "r");
    expect(bare).toContain("issue-graph open o/r --label bug");
    expect(bare).toContain("issue-graph cluster o/r --label bug --agent claude");
    expect(bare).toContain("issue-graph rank o/r --label bug");
    const all = nextSteps(
      parseArgs([
        "1",
        "--repo",
        "o/r",
        "--open",
        "--cluster-run",
        "claude",
        "--prioritize",
        "--no-snapshot",
      ]),
      "o",
      "r",
    );
    expect(all).toBe("");
    const saved = nextSteps(parseArgs(["1", "--repo", "o/r", "--open", "--prioritize"]), "o", "r");
    expect(saved).toContain("issue-graph dashboard");
  });
});

describe("offline CLI output dispatch", () => {
  const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  let logs: string[];
  let diagnostics: string[];
  const terminal = (isTTY: boolean, width = 100) => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: isTTY });
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: width });
  };
  const invoke = async (command: string[], flags: string[] = []) => {
    logs.length = 0;
    await runCli([...command, "--repo", "o/r", "--no-snapshot", ...flags]);
    return logs.join("\n");
  };
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-23T00:00:00Z"));
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("CI", undefined);
    vi.stubEnv("TERM", "xterm-256color");
    logs = [];
    diagnostics = [];
    vi.spyOn(console, "log").mockImplementation((value) => {
      logs.push(String(value));
    });
    vi.spyOn(process.stderr, "write").mockImplementation((value) => {
      diagnostics.push(String(value));
      return true;
    });
    vi.mocked(shellTransport).mockReturnValue({
      search: async () => [{ owner: "o", repo: "r", number: 3 }],
      graphql: async (_query, variables = {}) => {
        const number = Number(variables.n);
        const pr = number === 2;
        return {
          data: {
            repository: {
              issueOrPullRequest: {
                __typename: pr ? "PullRequest" : "Issue",
                title: pr
                  ? "Merged implementation"
                  : number === 1
                    ? "Closed seed"
                    : "Open follow-up",
                state: pr ? "MERGED" : number === 1 ? "CLOSED" : "OPEN",
                url: `https://github.com/o/r/${pr ? "pull" : "issues"}/${number}`,
                body: number === 1 ? "Related #2 and #3" : "",
                author: { login: "fixture" },
                createdAt: "2026-09-01T00:00:00Z",
                updatedAt: "2026-09-01T00:00:00Z",
                comments: { totalCount: 0, nodes: [] },
                timelineItems: { nodes: [] },
                reactions: { totalCount: 0 },
                participants: { totalCount: 1 },
                ...(pr
                  ? {
                      isDraft: false,
                      reviewDecision: "APPROVED",
                      mergeable: "MERGEABLE",
                      additions: 3,
                      deletions: 1,
                      changedFiles: 1,
                      files: { nodes: [] },
                      closingIssuesReferences: { nodes: [] },
                    }
                  : {}),
              },
            },
          },
        };
      },
    });
    terminal(false);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
    else Reflect.deleteProperty(process.stdout, "isTTY");
    if (columns) Object.defineProperty(process.stdout, "columns", columns);
    else Reflect.deleteProperty(process.stdout, "columns");
  });

  test("graph preserves Markdown/legacy JSON, exports files, and styles only human TTY", async () => {
    const markdown = await invoke(["1"]);
    expect(markdown).toMatch(/^# Reference graph: o\/r#1/);
    expect(markdown).not.toContain("\u001b[");
    expect(await invoke(["1"], ["--format", "markdown"])).toBe(markdown);
    expect(await invoke(["1"], ["--format", "json"])).toBe(markdown);
    const plain = await invoke(["1"], ["--format", "text", "--json", "/unused/graph.json"]);
    expect(plain).toContain("Merged fix");
    expect(plain).toContain("Open follow-ups");
    expect(plain).toContain("Snapshot");
    expect(plain).not.toContain("\u001b[");
    expect(JSON.parse(String(vi.mocked(writeFile).mock.calls[0][1])).nodes).toHaveLength(3);
    expect(writeSnapshot).not.toHaveBeenCalled();
    terminal(true);
    const colored = await invoke(["1"]);
    expect(colored).toContain("\u001b[1m");
    expect(colored).toContain("\u001b[2m");
    expect(stripVTControlCharacters(colored)).toBe(plain);
    expect(await invoke(["1"], ["--format", "markdown"])).toBe(markdown);
    expect(await invoke(["1"], ["--format", "json"])).toBe(markdown);
    expect(diagnostics.join("")).toContain("crawling");
    expect(plain).not.toContain("crawling");
  });

  test("plan pipe JSON and explicit Markdown stay stable; TTY/text selects human", async () => {
    const json = await invoke(["plan"]);
    expect(JSON.parse(json)).toMatchObject({
      schemaVersion: 1,
      repo: "o/r",
      coverageComplete: true,
    });
    const markdown = await invoke(["plan"], ["--format", "markdown"]);
    expect(markdown).toMatch(/^# Backlog plan: o\/r/);
    const plain = await invoke(["plan"], ["--format", "text"]);
    expect(plain).toContain("Next:");
    expect(plain).toContain("Guardrails");
    expect(plain).not.toContain("\u001b[");
    terminal(true);
    expect(stripVTControlCharacters(await invoke(["plan"]))).toBe(plain);
    expect(await invoke(["plan"], ["--format", "json"])).toBe(json);
    expect(await invoke(["plan"], ["--format", "markdown"])).toBe(markdown);
    expect(listSnapshots).not.toHaveBeenCalled();
  });

  test("NO_COLOR presence, CI and TERM=dumb disable ANSI without changing content", async () => {
    terminal(true, 42);
    const styled = await invoke(["1"], ["--format", "text"]);
    const plain = stripVTControlCharacters(styled);
    expect(styled).toContain("\u001b[");
    for (const [name, value] of [
      ["NO_COLOR", ""],
      ["CI", "true"],
      ["TERM", "dumb"],
    ]) {
      vi.stubEnv(name, value);
      expect(await invoke(["1"], ["--format", "text"])).toBe(plain);
      vi.stubEnv(name, name === "TERM" ? "xterm-256color" : undefined);
    }
    terminal(false, 42);
    expect(await invoke(["1"], ["--format", "text"])).toBe(plain);
  });

  test("status dispatch suppresses ANSI for TERM=dumb, NO_COLOR and CI", async () => {
    terminal(true);
    vi.mocked(shellTransport).mockReturnValue({
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
    });
    let stdout = "";
    vi.spyOn(process.stdout, "write").mockImplementation((value) => {
      stdout += String(value);
      return true;
    });
    const previousExitCode = process.exitCode;
    const capture = async () => {
      stdout = "";
      await runCli(["status", "--repo", "o/r", "--author", "fixture", "--no-snapshot"]);
      expect(process.exitCode).toBe(0);
      return stdout;
    };
    try {
      const styled = await capture();
      expect(styled).toContain("\u001b[");
      const plain = stripVTControlCharacters(styled);
      for (const [name, value] of [
        ["TERM", "dumb"],
        ["NO_COLOR", ""],
        ["CI", "true"],
      ]) {
        vi.stubEnv(name, value);
        const output = await capture();
        expect(output).not.toContain("\u001b");
        expect(output).toBe(plain);
        vi.stubEnv(name, name === "TERM" ? "xterm-256color" : undefined);
      }
      expect(diagnostics.join("")).not.toContain("\u001b");
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  test("cluster prompt remains present in human output without running a model", async () => {
    const output = await invoke(["1"], ["--format", "text", "--cluster"]);
    expect(output).toContain("Cluster step");
    expect(output).toContain("o/r#1");
    expect(output).not.toContain("```cluster-prompt");
    expect(output).not.toContain("\u001b[");
  });
});

describe("--all-open", () => {
  test("parses and needs a repository", () => {
    expect(parseArgs(["--all-open", "--repo", "o/r"]).allOpen).toBe(true);
  });

  test("next steps repeat the whole-backlog seed", () => {
    const steps = nextSteps(parseArgs(["--all-open", "--repo", "o/r"]), "o", "r");
    expect(steps).toContain("issue-graph open o/r");
  });
});

describe("command API", () => {
  test("verbs take a scope and repository-wide verbs cover the open backlog", () => {
    const open = parseArgs(["open", "vercel-labs/emulate"]);
    expect(open).toMatchObject({
      command: "open",
      repo: "vercel-labs/emulate",
      allOpen: true,
      maxNodes: 1000,
    });
    expect(parseArgs(["rank"])).toMatchObject({ command: "rank", allOpen: true, prioritize: true });
    expect(parseArgs(["cluster", "o/r"])).toMatchObject({ command: "cluster", cluster: true });
    expect(parseArgs(["open", "o/r", "--label", "bug"]).allOpen).toBe(false);
  });

  test("graph takes several items, with or without a repository", () => {
    expect(parseArgs(["graph", "o/r#1", "2", "--repo", "o/r"]).items).toEqual([
      { repo: "o/r", number: 1 },
      { repo: undefined, number: 2 },
    ]);
  });

  test("shared flags replace the old ones, which still work with a note", () => {
    expect(parseArgs(["open", "-o", "x.html"]).htmlOut).toBe("x.html");
    expect(parseArgs(["graph", "1", "-o", "g.json"]).jsonOut).toBe("g.json");
    expect(() => parseArgs(["open", "-o", "x.txt"])).toThrow(/\.json or \.html/);
    expect(parseArgs(["graph", "1", "--format", "human"]).format).toBe("text");
    const legacy = parseArgs([
      "1",
      "--repo",
      "o/r",
      "--max-nodes",
      "50",
      "--cluster-run",
      "claude",
    ]);
    expect(legacy).toMatchObject({ maxNodes: 50, agent: "claude", cluster: true });
    expect(legacy.deprecations).toEqual([
      "--max-nodes is now --budget",
      "--cluster-run is now --agent",
    ]);
  });

  test("--agent, --open, and --no-save are explicit choices", () => {
    expect(parseArgs(["open", "--agent", "codex"])).toMatchObject({
      clusterRun: "codex",
      cluster: true,
    });
    expect(parseArgs(["open", "--agent", "none"]).clusterRun).toBe("");
    expect(parseArgs(["open", "--no-open"]).openMode).toBe("no");
    expect(parseArgs(["open", "--no-save"]).noSnapshot).toBe(true);
    expect(() => parseArgs(["open", "--agent", "gpt"])).toThrow(/claude, codex, or none/);
  });

  test("scopes name the provider, and unsupported ones fail clearly", () => {
    expect(parseArgs(["open", "github:o/r"]).repo).toBe("o/r");
    expect(() => parseArgs(["open", "linear:ENG"])).toThrow(/not supported yet/);
    expect(() => parseArgs(["open", "a/b", "c/d"])).toThrow(/one repository per run/);
  });

  test("status reads positional or inferred repositories", () => {
    expect(statusArgs(["o/r", "--author", "a"], () => undefined)).toEqual([
      "--repo",
      "o/r",
      "--author",
      "a",
    ]);
    expect(statusArgs(["--author", "a"], () => "x/y")).toEqual(["--author", "a", "--repo", "x/y"]);
    expect(() => statusArgs(["o/r#1"], () => undefined)).toThrow(/repositories, not items/);
  });
});

test("status accepts the shared --no-save and --format human", () => {
  expect(
    statusArgs(["o/r", "--author", "a", "--no-save", "--format", "human"], () => undefined),
  ).toEqual(["--repo", "o/r", "--author", "a", "--no-save", "--format", "human"]);
});
