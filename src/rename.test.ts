import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { ISSUE_GRAPH_SCHEMA } from "./index.js";
import { reconcileSnapshotDir, snapshotDir } from "./snapshot.js";
import { buildStatusReport } from "./status.js";
import { parseStatusSnapshot, toStatusSnapshot } from "./status-snapshot.js";
import { statusHistoryDir } from "./status-store.js";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));

function run(args: string[]) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(new URL("src/bin.ts", root)), ...args],
    { cwd: fileURLToPath(root) },
  );
  if (result.error) throw result.error;
  return {
    exit: result.status,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("issue-graph identity", () => {
  test("package metadata exposes only the canonical command and repository", () => {
    expect(pkg.name).toBe("issue-graph");
    expect(pkg.version).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
    expect(pkg.private).not.toBe(true);
    expect(pkg.publishConfig.access).toBe("public");
    expect(pkg.bin).toEqual({ "issue-graph": "./dist/bin.js" });
    expect(pkg.repository.url).toBe("git+https://github.com/vercel-labs/issue-graph.git");
    expect(pkg.homepage).toBe("https://issue-graph.dev");
    expect(pkg.bugs.url).toBe("https://github.com/vercel-labs/issue-graph/issues");
  });

  test("help and schema use the canonical command and machine identity", () => {
    for (const args of [["--help"], ["status", "--help"]]) {
      const result = run(args);
      expect(result.exit).toBe(0);
      expect(result.stdout.startsWith("usage: issue-graph ")).toBe(true);
      expect(result.stderr).toBe("");
    }
    const result = run(["schema"]);
    expect(result.exit).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(ISSUE_GRAPH_SCHEMA);
    expect(ISSUE_GRAPH_SCHEMA.name).toBe("issue-graph");
    expect(ISSUE_GRAPH_SCHEMA.schemaVersion).toBe(1);
  });

  test("the discovery stub and bundled guide have distinct canonical identities", () => {
    expect(readdirSync(new URL("skills/", root))).toEqual(["issue-graph"]);
    const skill = readFileSync(new URL("skills/issue-graph/SKILL.md", root), "utf8");
    const metadata = parse(skill.split("---")[1]) as Record<string, unknown>;
    expect(metadata.name).toBe("issue-graph");
    expect(metadata.description).toBeTypeOf("string");
    expect(metadata.compatibility).toBeUndefined();
    expect(skill).toContain("issue-graph skills get core");
    expect(readdirSync(new URL("skill-data/", root))).toEqual(["core"]);
    const core = readFileSync(new URL("skill-data/core/SKILL.md", root), "utf8");
    expect(parse(core.split("---")[1])).toMatchObject({
      name: "core",
      description: expect.any(String),
    });
    expect(core).toContain("Node.js 20 or later");
    expect(pkg.files).toContain("skill-data");
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
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          'import { statusHistoryDir } from "./src/status-store.ts"; console.log(statusHistoryDir({ repos: ["o/r"], authors: ["alice"] }));',
        ],
        { cwd: fileURLToPath(root), env: { ...process.env, ISSUE_GRAPH_HOME: home } },
      );
      if (result.error) throw result.error;
      expect(result.status).toBe(0);
      expect(result.stderr.toString()).toBe("");
      expect(
        result.stdout
          .toString()
          .trim()
          .startsWith(`${join(home || join(homedir(), ".issue-graph"), "status")}/`),
      ).toBe(true);
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
