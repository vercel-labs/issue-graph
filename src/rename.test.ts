import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ISSUE_GRAPH_SCHEMA } from "./index.js";
import { reconcileSnapshotDir, snapshotDir } from "./snapshot.js";
import { buildStatusReport } from "./status.js";
import { parseStatusSnapshot, toStatusSnapshot } from "./status-snapshot.js";
import { statusHistoryDir } from "./status-store.js";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));

function run(args: string[]) {
  const result = Bun.spawnSync([
    process.execPath,
    fileURLToPath(new URL(pkg.bin["issue-graph"], root)),
    ...args,
  ]);
  return {
    exit: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("issue-graph identity", () => {
  test("package metadata exposes only the canonical command and repository", () => {
    expect(pkg.name).toBe("@vercel-labs/issue-graph");
    expect(pkg.private).toBe(true);
    expect(pkg.bin).toEqual({ "issue-graph": "./src/cli.ts" });
    expect(pkg.repository.url).toBe("git+https://github.com/vercel-labs/issue-graph.git");
    expect(pkg.homepage).toBe("https://github.com/vercel-labs/issue-graph#readme");
    expect(pkg.bugs.url).toBe("https://github.com/vercel-labs/issue-graph/issues");
  });

  test("help and schema use the canonical command and machine identity", () => {
    for (const args of [["--help"], ["status", "--help"]]) {
      const result = run(args);
      expect(result.exit).toBe(0);
      expect(result.stdout).toStartWith("usage: issue-graph ");
      expect(result.stderr).toBe("");
    }
    const result = run(["schema"]);
    expect(result.exit).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(ISSUE_GRAPH_SCHEMA);
    expect(ISSUE_GRAPH_SCHEMA.name).toBe("issue-graph");
    expect(ISSUE_GRAPH_SCHEMA.schemaVersion).toBe(1);
  });

  test("the only packaged skill has matching directory and frontmatter names", () => {
    expect(readdirSync(new URL("skills/", root))).toEqual(["issue-graph"]);
    const skill = readFileSync(new URL("skills/issue-graph/SKILL.md", root), "utf8");
    const metadata = Bun.YAML.parse(skill.split("---")[1]) as Record<string, unknown>;
    expect(metadata.name).toBe("issue-graph");
    expect(metadata.description).toBeString();
    expect(metadata.compatibility).toBeString();
  });

  test("graph and reconciliation use the canonical history directory", () => {
    expect(snapshotDir("o", "r", ["o/r#1"])).toBe(join(homedir(), ".issue-graph", "o-r-1"));
    expect(reconcileSnapshotDir("o", "r")).toBe(join(homedir(), ".issue-graph", "reconcile-o-r"));
    expect(statusHistoryDir({ repos: ["o/r"], authors: ["alice"] }, "/tmp/issue-graph")).toMatch(
      /^\/tmp\/issue-graph\/status\/[a-f0-9]{64}$/,
    );
  });

  test("status uses ISSUE_GRAPH_HOME and defaults to the canonical root", () => {
    for (const home of ["/tmp/issue-graph-custom", ""]) {
      const result = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          'import { statusHistoryDir } from "./src/status-store.ts"; console.log(statusHistoryDir({ repos: ["o/r"], authors: ["alice"] }));',
        ],
        { cwd: fileURLToPath(root), env: { ...process.env, ISSUE_GRAPH_HOME: home } },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).toBe("");
      expect(result.stdout.toString().trim()).toStartWith(
        `${join(home || join(homedir(), ".issue-graph"), "status")}/`,
      );
    }
  });

  test("status snapshots round-trip with the canonical discriminator", () => {
    const time = "2026-09-09T13:00:00.000Z";
    const report = buildStatusReport(
      [],
      [{ repo: "o/r", complete: true, pages: 1, scanned: 0, errors: [] }],
      { repos: ["o/r"], authors: ["alice"], startedAt: time, generatedAt: time },
    );
    const saved = toStatusSnapshot(report);
    expect(saved.kind).toBe("issue-graph-status-snapshot");
    expect(parseStatusSnapshot(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
    expect(() => parseStatusSnapshot({ ...saved, kind: "unsupported-status-snapshot" })).toThrow(
      "kind",
    );
  });
});
