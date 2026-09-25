import { execFile } from "node:child_process";
import type { JiraReader } from "../jira.js";

export interface TwgRunResult {
  stdout: string;
  stderr: string;
}

export type TwgRunner = (args: string[]) => Promise<TwgRunResult>;

export interface TwgJiraClientOptions {
  binary?: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
  runner?: TwgRunner;
}

export class TwgCliError extends Error {
  constructor(
    message: string,
    readonly exitCode?: number,
  ) {
    super(message);
    this.name = "TwgCliError";
  }
}

function errorMessage(stdout: string, stderr: string, fallback: string): string {
  try {
    const payload = JSON.parse(stdout) as { error?: { message?: unknown }; message?: unknown };
    const message = payload.error?.message ?? payload.message;
    if (typeof message === "string" && message.trim()) return message.trim();
  } catch {
    // TWG can fail before producing a JSON envelope (missing binary, auth, timeout).
  }
  return stderr.trim() || fallback;
}

function defaultRunner(
  options: Required<Pick<TwgJiraClientOptions, "binary" | "timeoutMs" | "maxBufferBytes">>,
): TwgRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(
        options.binary,
        args,
        {
          encoding: "utf8",
          maxBuffer: options.maxBufferBytes,
          timeout: options.timeoutMs,
        },
        (error, stdout, stderr) => {
          if (error) {
            const code = typeof error.code === "number" ? error.code : undefined;
            reject(
              new TwgCliError(
                `twg jira workitem get failed: ${errorMessage(stdout, stderr, error.message)}`,
                code,
              ),
            );
            return;
          }
          resolve({ stdout, stderr });
        },
      );
    });
}

export function twgJiraClient(options: TwgJiraClientOptions = {}): JiraReader {
  const resolved = {
    binary: options.binary ?? "twg",
    timeoutMs: options.timeoutMs ?? 30_000,
    maxBufferBytes: options.maxBufferBytes ?? 64 * 1024 * 1024,
  };
  const run = options.runner ?? defaultRunner(resolved);
  return {
    async getIssue(issueKey, site) {
      if (site?.startsWith("-")) throw new TwgCliError("Jira site cannot start with '-'");
      const globalArgs = [...(site ? ["--site", site] : []), "--output", "json"];
      const commandArgs = ["jira", "workitem", "get", issueKey, "--full"];
      const invoke = async (args: string[]): Promise<TwgRunResult> => {
        try {
          return await run(args);
        } catch (error) {
          if (error instanceof TwgCliError) throw error;
          throw new TwgCliError(
            `twg jira workitem get failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      };
      let result: TwgRunResult;
      try {
        result = await invoke([...globalArgs, "--output-summary=none", ...commandArgs]);
      } catch (error) {
        const unsupportedSummary =
          error instanceof TwgCliError &&
          /(?:invalid[^\n]*output-summary|output-summary[^\n]*invalid|expected:\s*stats,\s*auto,\s*inline)/i.test(
            error.message,
          );
        if (!unsupportedSummary) throw error;
        result = await invoke([...globalArgs, ...commandArgs]);
      }
      try {
        return JSON.parse(result.stdout);
      } catch {
        throw new TwgCliError("twg jira workitem get returned invalid JSON");
      }
    },
  };
}
