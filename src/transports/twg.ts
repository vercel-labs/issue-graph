import { type ExecException, execFile } from "node:child_process";
import { JiraReadError, type JiraReader, parseJiraSite } from "../jira.js";

/** Fields requested from `twg jira workitem get`; everything the graph reads and nothing more. */
export const TWG_JIRA_FIELDS = [
  "summary",
  "status",
  "issuetype",
  "project",
  "parent",
  "subtasks",
  "issuelinks",
  "updated",
] as const;

export interface TwgJiraReaderOptions {
  /** Site prefix, domain, or cloud ID. Omit to use the TWG default site. */
  site?: string;
  /** Path or name of the TWG executable (default `twg`). */
  binary?: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
}

const KEY = /^[A-Z][A-Z0-9_]*-[1-9]\d*$/;

function clean(value: string): string {
  return value
    .replace(/\p{Cc}/gu, " ")
    .trim()
    .slice(0, 300);
}

function failure(error: ExecException, stdout: string, stderr: string) {
  if (error.code === "ENOENT")
    return new JiraReadError("TWG_NOT_FOUND", "twg is not installed or not on PATH");
  if (error.killed || error.signal)
    return new JiraReadError("TIMEOUT", "twg did not finish in time");
  try {
    type Failure = { error?: { code?: unknown; message?: unknown } };
    const body = JSON.parse(stdout) as Failure & { data?: Failure | Failure[] };
    const data = Array.isArray(body.data) && body.data.length === 1 ? body.data[0] : body.data;
    const error = body.error ?? (Array.isArray(data) ? undefined : data?.error);
    const code = error?.code;
    const message = error?.message;
    if (typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code))
      return new JiraReadError(code, typeof message === "string" ? clean(message) : undefined);
  } catch {}
  return new JiraReadError("TWG_FAILED", clean(stderr) || clean(error.message));
}

/**
 * Reads Jira work items by running `twg jira workitem get` without a shell.
 * TWG holds the Atlassian session; this reader never sees a token.
 */
export function twgJiraReader(options: TwgJiraReaderOptions = {}): JiraReader {
  const site = options.site === undefined ? undefined : parseJiraSite(options.site);
  const binary = options.binary ?? "twg";
  const timeout = options.timeoutMs ?? 60_000;
  const maxBuffer = options.maxBufferBytes ?? 32 * 1024 * 1024;
  return {
    label: "twg",
    issue(key) {
      if (!KEY.test(key)) return Promise.reject(new JiraReadError("INVALID_KEY"));
      // Explicit --output-summary=none keeps raw JSON on stdout even under TWG agent defaults.
      const args = [
        "jira",
        "workitem",
        "get",
        key,
        "--fields",
        TWG_JIRA_FIELDS.join(","),
        "--remote-links",
        "--output",
        "json",
        "--output-summary=none",
        ...(site ? ["--site", site] : []),
      ];
      return new Promise((resolve, reject) => {
        execFile(
          binary,
          args,
          { encoding: "utf8", timeout, maxBuffer, killSignal: "SIGKILL" },
          (error, stdout, stderr) => {
            if (error) return reject(failure(error, stdout, stderr));
            try {
              resolve(JSON.parse(stdout));
            } catch {
              reject(new JiraReadError("INVALID_PAYLOAD", "twg did not print JSON"));
            }
          },
        );
      });
    },
  };
}
