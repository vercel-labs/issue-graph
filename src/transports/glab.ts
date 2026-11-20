import { type ExecException, execFile } from "node:child_process";
import { GitLabReadError, type GitLabReader, parseGitLabHost } from "../gitlab.js";

export interface GlabGitLabReaderOptions {
  /** GitLab host; a port is dropped, since glab configures it per host. Omit for the authenticated host of the current Git directory, or gitlab.com. */
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

const MIN_VERSION = [1, 126] as const;

/** Parses `glab version` output such as `glab 1.126.0 (abc123)`; older releases print `glab version 1.x.y`. */
function parseVersion(output: string): [number, number] | undefined {
  const match = output.trim().match(/^glab (?:version )?v?(\d+)\.(\d+)\.\d+/);
  return match ? [Number(match[1]), Number(match[2])] : undefined;
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
  // glab 1.126 and later send GITLAB_TOKEN only to configured hosts; older ones send it to any --hostname.
  let supported: Promise<void> | undefined;
  const checkVersion = () =>
    new Promise<void>((resolve, reject) => {
      execFile(
        binary,
        ["version"],
        { encoding: "utf8", timeout, maxBuffer: 64 * 1024, killSignal: "SIGKILL" },
        (error, stdout, stderr) => {
          if (error) return reject(failure(error, stderr));
          const version = parseVersion(stdout);
          if (!version)
            return reject(
              new GitLabReadError("GLAB_VERSION_UNKNOWN", "could not read the glab version"),
            );
          const [major, minor] = version;
          if (major < MIN_VERSION[0] || (major === MIN_VERSION[0] && minor < MIN_VERSION[1]))
            return reject(
              new GitLabReadError(
                "GLAB_TOO_OLD",
                `glab ${major}.${minor} is older than ${MIN_VERSION.join(".")}; update glab`,
              ),
            );
          resolve();
        },
      );
    });
  return {
    label: "glab",
    async get(path) {
      if (!READ_PATH.test(path)) throw new GitLabReadError("INVALID_PATH");
      supported ??= checkVersion();
      await supported;
      // glab takes a bare hostname; its host configuration supplies a nondefault API port.
      const hostname = host?.replace(/:\d+$/, "");
      const args = ["api", "--method", "GET", ...(hostname ? ["--hostname", hostname] : []), path];
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
