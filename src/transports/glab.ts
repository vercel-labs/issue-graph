import { type ExecException, execFile } from "node:child_process";
import { GitLabReadError, type GitLabReader, parseGitLabHost } from "../gitlab.js";

export interface GlabGitLabReaderOptions {
  /** GitLab host, with an optional port. Omit to use glab's default host. */
  host?: string;
  /** Path or name of the glab executable (default `glab`). */
  binary?: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
}

const READ_PATH =
  /^projects\/[A-Za-z0-9%._-]+\/(?:issues|merge_requests)\/[1-9]\d*(?:\/[a-z_]+)?(?:\?[a-z_]+=\w+(?:&[a-z_]+=\w+)*)?$/;

const HTTP_CODES: Record<string, string> = {
  "401": "UNAUTHORIZED",
  "403": "FORBIDDEN",
  "404": "NOT_FOUND",
  "429": "RATE_LIMITED",
};

function clean(value: string): string {
  return value
    .replace(/\p{Cc}/gu, " ")
    .trim()
    .slice(0, 300);
}

function failure(error: ExecException, stderr: string) {
  if (error.code === "ENOENT")
    return new GitLabReadError("GLAB_NOT_FOUND", "glab is not installed or not on PATH");
  if (error.killed || error.signal)
    return new GitLabReadError("TIMEOUT", "glab did not finish in time");
  const status = stderr.match(/\(HTTP (\d{3})\)/)?.[1];
  return new GitLabReadError(
    (status && HTTP_CODES[status]) || "GLAB_FAILED",
    clean(stderr) || clean(error.message),
  );
}

/**
 * Reads GitLab REST resources by running `glab api --method GET` without a shell.
 * glab holds the credentials, including `GITLAB_TOKEN`; this reader never sees a token.
 */
export function glabGitLabReader(options: GlabGitLabReaderOptions = {}): GitLabReader {
  const host = options.host === undefined ? undefined : parseGitLabHost(options.host);
  const binary = options.binary ?? "glab";
  const timeout = options.timeoutMs ?? 60_000;
  const maxBuffer = options.maxBufferBytes ?? 32 * 1024 * 1024;
  return {
    label: "glab",
    get(path) {
      if (!READ_PATH.test(path)) return Promise.reject(new GitLabReadError("INVALID_PATH"));
      const args = ["api", "--method", "GET", ...(host ? ["--hostname", host] : []), path];
      return new Promise((resolve, reject) => {
        execFile(
          binary,
          args,
          { encoding: "utf8", timeout, maxBuffer, killSignal: "SIGKILL" },
          (error, stdout, stderr) => {
            if (error) return reject(failure(error, stderr));
            try {
              resolve(JSON.parse(stdout));
            } catch {
              reject(new GitLabReadError("INVALID_PAYLOAD", "glab did not print JSON"));
            }
          },
        );
      });
    },
  };
}
