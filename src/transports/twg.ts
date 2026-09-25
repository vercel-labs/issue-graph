import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { isAbsolute } from "node:path";
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

function summaryOutputFiles(stdout: string): Map<string, string> {
  const files = new Map<string, string>();
  let inOutputFiles = false;
  for (const line of stdout.split(/\r?\n/)) {
    if (line === "output_files:") {
      inOutputFiles = true;
      continue;
    }
    if (!inOutputFiles) continue;
    const match = line.match(/^ {2}([a-zA-Z0-9_]+):\s*(.+?)\s*$/);
    if (!match) {
      if (line.trim() && !line.startsWith("  ")) break;
      continue;
    }
    let value = match[2];
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        continue;
      }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1).replaceAll("''", "'");
    }
    if (isAbsolute(value)) files.set(match[1], value);
  }
  return files;
}

async function decodeTwgOutput(stdout: string): Promise<unknown> {
  try {
    return JSON.parse(stdout);
  } catch {
    // Some customer builds expose JSON through an agent summary file instead.
  }
  const files = summaryOutputFiles(stdout);
  const primary = files.get("stdout");
  if (primary) {
    try {
      return JSON.parse(await readFile(primary, "utf8"));
    } catch {
      // Report one stable transport error below; do not expose a private payload or path.
    } finally {
      await Promise.allSettled([...files.values()].map((file) => rm(file, { force: true })));
    }
  }
  throw new TwgCliError("twg jira workitem get returned neither raw JSON nor summary output data");
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
        result = await invoke([...globalArgs, "--output-summary=stats", ...commandArgs]);
      }
      return await decodeTwgOutput(result.stdout);
    },
  };
}
