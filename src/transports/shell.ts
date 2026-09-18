/**
 * Transport that shells out to an authenticated `gh`. This is what the CLI
 * uses: no token handling of our own, no rate-limit bookkeeping — `gh` already
 * holds the credentials the user logged in with.
 *
 * Importing this module pulls in `node:child_process`, so it is a separate
 * entry point (`@vercel-labs/issue-graph/transport/shell`) and never reachable from the core.
 */

import { execFile, execFileSync } from "node:child_process";
import { type GhTransport, GhTransportError, paginate, type SeedRef } from "../transport.js";

/**
 * Run `gh` and return stdout. Throws on non-zero exit.
 *
 * stderr is captured rather than inherited: a reference to a deleted issue
 * makes `gh` print "Could not resolve…", which is expected during a crawl and
 * should not leak into the caller's output. It stays on the thrown error.
 */
export function gh(args: string[]): string {
  return execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function ghAsync(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      args,
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

interface SearchItem {
  number?: number;
  html_url?: string;
  repository_url?: string;
}

/**
 * Recover `owner/repo` from a search hit. The REST search payload gives an API
 * URL (`.../repos/o/r`) rather than the owner and name as fields.
 */
function ownerRepoFromItem(item: SearchItem): { owner: string; repo: string } | null {
  const api = item.repository_url?.match(/\/repos\/([^/]+)\/([^/]+)$/);
  if (api) return { owner: api[1], repo: api[2] };
  const html = item.html_url?.match(/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/\d+/);
  if (html) return { owner: html[1], repo: html[2] };
  return null;
}

/** `gh`'s own diagnosis, which is more useful than the exit-code message. */
export function describe(err: unknown): string {
  const stderr = (err as { stderr?: Buffer | string } | null)?.stderr?.toString().trim();
  return stderr || (err as Error).message;
}

/**
 * Recover the JSON body from a failed `gh` invocation, or null if it did not
 * print one (auth failure, no network, `gh` missing).
 */
export function decodeStdout(err: unknown): unknown | null {
  const stdout = (err as { stdout?: Buffer | string } | null)?.stdout;
  if (!stdout) return null;
  try {
    const parsed = JSON.parse(stdout.toString());
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function shellTransport(): GhTransport {
  return {
    async graphql(query, variables = {}) {
      const args = ["api", "graphql", "-f", `query=${query}`];
      for (const [k, v] of Object.entries(variables)) {
        args.push(typeof v === "number" ? "-F" : "-f", `${k}=${v}`);
      }
      try {
        return JSON.parse(await ghAsync(args));
      } catch (err) {
        // `gh api graphql` exits non-zero for a GraphQL-level error too, and
        // "Could not resolve to an issue with the number of N" is an ordinary
        // fact about a reference to a deleted node — not a transport failure.
        // It still prints the `{data, errors}` body, so hand that back and let
        // the caller degrade that one node instead of failing the crawl.
        const body = decodeStdout(err);
        if (body) return body;
        throw new GhTransportError(`gh api graphql failed: ${describe(err)}`);
      }
    },

    async search(query, limit) {
      const q = encodeURIComponent(query);
      const items = await paginate(limit, async (page, perPage) => {
        try {
          const raw = await ghAsync([
            "api",
            `search/issues?q=${q}&per_page=${perPage}&page=${page}`,
          ]);
          return (JSON.parse(raw) as { items?: SearchItem[] }).items ?? [];
        } catch (err) {
          throw new GhTransportError(`gh api search failed: ${describe(err)}`);
        }
      });
      const out: SeedRef[] = [];
      for (const item of items) {
        const or = ownerRepoFromItem(item);
        if (or && item.number != null) out.push({ ...or, number: item.number });
      }
      return out;
    },
  };
}
