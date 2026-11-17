import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { JiraReadError } from "../jira.js";
import { TWG_JIRA_FIELDS, twgJiraReader } from "./twg.js";

const dir = mkdtempSync(join(tmpdir(), "issue-graph-twg-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function stub(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

async function failure(promise: Promise<unknown>): Promise<JiraReadError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(JiraReadError);
  return error as JiraReadError;
}

describe("twgJiraReader", () => {
  test("runs one read-only get with raw JSON output and no shell", async () => {
    const log = join(dir, "args.txt");
    const binary = stub(
      "twg-ok",
      `for a in "$@"; do printf '%s\\n' "$a"; done > '${log}'\necho '{"apiVersion":"v2","data":[{"key":"ABC-1"}]}'`,
    );
    const reader = twgJiraReader({ binary, site: "acme.atlassian.net" });
    expect(reader.label).toBe("twg");
    expect(await reader.issue("ABC-1")).toEqual({ apiVersion: "v2", data: [{ key: "ABC-1" }] });
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
      "jira",
      "workitem",
      "get",
      "ABC-1",
      "--fields",
      TWG_JIRA_FIELDS.join(","),
      "--remote-links",
      "--output",
      "json",
      "--output-summary=none",
      "--site",
      "acme.atlassian.net",
    ]);
  });

  test("omits --site when the caller relies on the TWG default site", async () => {
    const log = join(dir, "default.txt");
    const binary = stub("twg-default", `printf '%s ' "$@" > '${log}'\necho '{}'`);
    await twgJiraReader({ binary }).issue("ABC-1");
    expect(readFileSync(log, "utf8")).not.toContain("--site");
  });

  test("rejects keys and sites that could become flags before spawning", async () => {
    const binary = stub("twg-never", "exit 99");
    expect((await failure(twgJiraReader({ binary }).issue("--full"))).code).toBe("INVALID_KEY");
    expect(() => twgJiraReader({ binary, site: "--output=text" })).toThrow(/Jira site/);
  });

  test("reports the TWG error envelope from a failed command", async () => {
    const binary = stub(
      "twg-fail",
      `echo '{"ok":false,"error":{"code":"TWG_COMMAND_FAILED","message":"Issue does not exist\\u0007 or no permission"}}'\nexit 1`,
    );
    const error = await failure(twgJiraReader({ binary }).issue("ABC-1"));
    expect(error.code).toBe("TWG_COMMAND_FAILED");
    expect(error.message).toContain("Issue does not exist  or no permission");
  });

  test("reports a TWG error nested under data", async () => {
    const binary = stub(
      "twg-auth",
      `echo '{"apiVersion":"v2","command":"jira.workitem.get","data":{"ok":false,"error":{"code":"AUTH_INVALID","message":"Authentication failed."}}}'\nexit 77`,
    );
    const error = await failure(twgJiraReader({ binary }).issue("ABC-1"));
    expect(error.code).toBe("AUTH_INVALID");
    expect(error.message).toContain("Authentication failed.");
  });

  test("reports a TWG error inside the data array", async () => {
    const binary = stub(
      "twg-auth-array",
      `echo '{"apiVersion":"v2","command":"jira.workitem.get","data":[{"ok":false,"error":{"code":"AUTH_INVALID","message":"Authentication failed."}}]}'\nexit 1`,
    );
    const error = await failure(twgJiraReader({ binary }).issue("ABC-1"));
    expect(error.code).toBe("AUTH_INVALID");
  });

  test("names a missing binary, a timeout, stderr, and non-JSON output", async () => {
    expect(
      (await failure(twgJiraReader({ binary: join(dir, "absent") }).issue("ABC-1"))).code,
    ).toBe("TWG_NOT_FOUND");
    const slow = stub("twg-slow", "exec sleep 5");
    expect(
      (await failure(twgJiraReader({ binary: slow, timeoutMs: 100 }).issue("ABC-1"))).code,
    ).toBe("TIMEOUT");
    const stderr = stub("twg-stderr", "echo 'Not signed in. Run twg login.' >&2\nexit 3");
    const signedOut = await failure(twgJiraReader({ binary: stderr }).issue("ABC-1"));
    expect(signedOut.code).toBe("TWG_FAILED");
    expect(signedOut.message).toContain("Run twg login");
    const text = stub("twg-text", "echo 'output_files:'");
    expect((await failure(twgJiraReader({ binary: text }).issue("ABC-1"))).code).toBe(
      "INVALID_PAYLOAD",
    );
  });
});
