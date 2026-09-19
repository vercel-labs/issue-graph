import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { runNode } from "../tests/node-process.js";
import { runSkills } from "./skills-cli.js";

const core = readFileSync(new URL("../skill-data/core/SKILL.md", import.meta.url), "utf8");
const workflows = readFileSync(
  new URL("../skill-data/core/references/workflows.md", import.meta.url),
  "utf8",
);

async function invoke(args: string[], read?: Parameters<typeof runSkills>[2]) {
  let stdout = "";
  let stderr = "";
  const code = await runSkills(
    args,
    {
      stdout: (value) => {
        stdout += value;
      },
      stderr: (value) => {
        stderr += value;
      },
    },
    read,
  );
  return { code, stdout, stderr };
}

describe("bundled skills", () => {
  test.each([[], ["list"]])("lists core without loading content: %j", async (...args) => {
    const read = vi.fn();
    const result = await invoke(args, read);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("core  Status-first routing");
    expect(result.stdout).toContain("issue-graph skills get core");
    expect(read).not.toHaveBeenCalled();
  });

  test("list JSON has the stable catalog envelope and no workflow content", async () => {
    const result = await invoke(["list", "--json"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const json = JSON.parse(result.stdout);
    expect(json).toEqual({
      schemaVersion: 1,
      success: true,
      data: [{ name: "core", description: expect.any(String) }],
      nextSteps: ["issue-graph skills get core"],
    });
    expect(core).toContain(`description: ${json.data[0].description}\n`);
  });

  test("get returns the core bytes, not the discovery stub or references", async () => {
    const result = await invoke(["get", "core"]);
    expect(result).toEqual({ code: 0, stdout: core, stderr: "" });
    expect(result.stdout).not.toContain("--- references/workflows.md ---");
  });

  test("--full appends references with deterministic boundaries", async () => {
    const result = await invoke(["get", "core", "--full"]);
    expect(result).toEqual({
      code: 0,
      stdout: `${core.trimEnd()}\n\n--- references/workflows.md ---\n\n${workflows.trimEnd()}\n`,
      stderr: "",
    });
  });

  test.each([false, true])("get JSON round trips the documents (full=%s)", async (full) => {
    const result = await invoke(["--json", "get", "core", ...(full ? ["--full"] : [])]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      success: true,
      data: [
        {
          name: "core",
          content: core,
          ...(full ? { files: [{ path: "references/workflows.md", content: workflows }] } : {}),
        },
      ],
      nextSteps: [full ? "issue-graph schema" : "issue-graph skills get core --full"],
    });
    expect(result.stdout).not.toContain("\u001b");
  });

  test.each([
    ["--help"],
    ["-h"],
    ["list", "--help"],
    ["get", "--help"],
  ])("help requires no asset reads: %j", async (...args) => {
    const read = vi.fn();
    const result = await invoke(args, read);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("usage: issue-graph skills");
    expect(result.stdout).toContain("including in pipes");
    expect(read).not.toHaveBeenCalled();
  });

  test("JSON help remains JSON", async () => {
    const result = await invoke(["--help", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).data.usage).toContain("usage: issue-graph skills");
  });

  test.each([
    ["get"],
    ["get", "core", "extra"],
    ["list", "core"],
    ["list", "--full"],
    ["--full"],
    ["get", "core", "--typo"],
    ["get", "core", "--json", "out.json"],
    ["install"],
    ["get", "missing"],
    ["get", "../core"],
    ["get", "/tmp/core"],
    ["get", "core\\.."],
    ["get", "core\u0000"],
  ])("rejects misuse before reading files: %j", async (...args) => {
    const read = vi.fn();
    const result = await invoke(args, read);
    expect(result.code).toBe(2);
    if (args.includes("--json")) {
      expect(JSON.parse(result.stdout).error.code).toBe("USAGE_ERROR");
      expect(result.stderr).toBe("");
    } else {
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("issue-graph skills --help");
      expect(result.stderr).not.toContain("\u0000");
    }
    expect(read).not.toHaveBeenCalled();
  });

  test("JSON usage errors are structured, not mixed with diagnostics", async () => {
    const result = await invoke(["get", "unknown", "--json"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      success: false,
      error: {
        code: "USAGE_ERROR",
        message: expect.stringContaining("unknown skill"),
        hint: "Run issue-graph skills --help.",
      },
    });
  });

  test.each([
    false,
    true,
  ])("a failed full read emits no partial success (json=%s)", async (json) => {
    const read = vi.fn(async (_name: string, path: string) => {
      if (path === "SKILL.md") return core;
      throw new Error("missing reference");
    });
    const result = await invoke(["get", "core", "--full", ...(json ? ["--json"] : [])], read);
    expect(result.code).toBe(1);
    expect(read).toHaveBeenCalledTimes(2);
    if (json) {
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: 1,
        success: false,
        error: { code: "SKILL_READ_FAILED", message: "missing reference" },
      });
    } else {
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("missing reference");
    }
  });

  test.each([false, true])("missing core fails before references (json=%s)", async (json) => {
    const read = vi.fn(async () => {
      throw new Error("missing core");
    });
    const result = await invoke(["get", "core", "--full", ...(json ? ["--json"] : [])], read);
    expect(result.code).toBe(1);
    expect(read).toHaveBeenCalledExactlyOnceWith("core", "SKILL.md");
    if (json) {
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: 1,
        success: false,
        error: { code: "SKILL_READ_FAILED", message: "missing core" },
      });
    } else {
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("missing core");
    }
  });

  test("source CLI dispatch is offline without gh or tokens", async () => {
    const result = await runNode(["src/bin.ts", "skills", "get", "core"], {
      env: { ...process.env, PATH: "", GH_TOKEN: "", GITHUB_TOKEN: "", NO_COLOR: "1" },
    });
    expect(result).toEqual({ code: 0, stdout: core, stderr: "" });
  });

  test("source CLI keeps usage exit codes distinct from graph parsing", async () => {
    const result = await runNode(["src/bin.ts", "skills", "get", "missing", "--json"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout).error.code).toBe("USAGE_ERROR");
  });
});
