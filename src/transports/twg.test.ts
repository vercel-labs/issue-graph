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

  test("retries without output-summary when an older TWG build rejects none", async () => {
    const calls: string[][] = [];
    const client = twgJiraClient({
      runner: async (args) => {
        calls.push(args);
        if (calls.length === 1)
          throw new TwgCliError(
            "option '--output-summary [level]' argument 'none' is invalid. Expected: stats, auto, inline.",
            1,
          );
        return { stdout: JSON.stringify({ data: { key: "PROJ-1" } }), stderr: "" };
      },
    });
    expect(await client.getIssue("PROJ-1", "demo")).toEqual({ data: { key: "PROJ-1" } });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("--output-summary=none");
    expect(calls[1]).not.toContain("--output-summary=none");
  });

  test("rejects invalid JSON and preserves typed command failures", async () => {
    const invalid = twgJiraClient({ runner: async () => ({ stdout: "warning", stderr: "" }) });
    await expect(invalid.getIssue("PROJ-1")).rejects.toThrow("invalid JSON");

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
