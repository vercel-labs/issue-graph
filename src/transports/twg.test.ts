import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { TwgCliError, twgJiraClient } from "./twg.js";

describe("twgJiraClient", () => {
  test("runs the public TWG Jira get command with direct JSON output", async () => {
    const calls: string[][] = [];
    const client = twgJiraClient({
      runner: async (args) => {
        calls.push(args);
        return { stdout: JSON.stringify({ data: { key: "PROJ-1" } }), stderr: "" };
      },
    });
    expect(await client.getIssue("PROJ-1", "demo")).toEqual({ data: { key: "PROJ-1" } });
    expect(calls).toEqual([
      [
        "--site",
        "demo",
        "--output",
        "json",
        "--output-summary=none",
        "jira",
        "workitem",
        "get",
        "PROJ-1",
        "--full",
      ],
    ]);
  });

  test("does not require a site when TWG has a configured default", async () => {
    let args: string[] = [];
    const client = twgJiraClient({
      runner: async (value) => {
        args = value;
        return { stdout: "{}", stderr: "" };
      },
    });
    await client.getIssue("PROJ-1");
    expect(args).not.toContain("--site");
  });

  test("reads and removes summary files when an older TWG build rejects none", async () => {
    const directory = await mkdtemp(join(tmpdir(), "issue-graph-twg-"));
    const stdoutFile = join(directory, "stdout.json");
    const compactFile = join(directory, "stdout.compact.json");
    await writeFile(stdoutFile, JSON.stringify({ data: { key: "PROJ-1" } }));
    await writeFile(compactFile, JSON.stringify({ data: { key: "PROJ-1" } }));
    const calls: string[][] = [];
    const client = twgJiraClient({
      runner: async (args) => {
        calls.push(args);
        if (calls.length === 1)
          throw new TwgCliError(
            "option '--output-summary [level]' argument 'none' is invalid. Expected: stats, auto, inline.",
            1,
          );
        return {
          stdout: `output_files:\n  stdout: ${JSON.stringify(stdoutFile)}\n  compact: ${JSON.stringify(compactFile)}\ncommand: "jira.workitem.get"\n---END---\n`,
          stderr: "",
        };
      },
    });
    try {
      expect(await client.getIssue("PROJ-1", "demo")).toEqual({ data: { key: "PROJ-1" } });
      expect(calls).toHaveLength(2);
      expect(calls[0]).toContain("--output-summary=none");
      expect(calls[1]).toContain("--output-summary=stats");
      expect(calls[1]).not.toContain("--output-summary=none");
      await expect(access(stdoutFile)).rejects.toThrow();
      await expect(access(compactFile)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects invalid JSON and preserves typed command failures", async () => {
    const invalid = twgJiraClient({ runner: async () => ({ stdout: "warning", stderr: "" }) });
    await expect(invalid.getIssue("PROJ-1")).rejects.toThrow("neither raw JSON nor summary output");

    const failed = twgJiraClient({
      runner: async () => Promise.reject(new TwgCliError("permission denied", 1)),
    });
    await expect(failed.getIssue("PROJ-1")).rejects.toMatchObject({
      name: "TwgCliError",
      message: "permission denied",
      exitCode: 1,
    });
  });

  test("rejects option-shaped site values before invoking TWG", async () => {
    let called = false;
    const client = twgJiraClient({
      runner: async () => {
        called = true;
        return { stdout: "{}", stderr: "" };
      },
    });
    await expect(client.getIssue("PROJ-1", "--help")).rejects.toThrow("cannot start");
    expect(called).toBe(false);
  });
});
