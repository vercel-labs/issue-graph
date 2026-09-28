import { execFileSync } from "node:child_process";

/** Providers the CLI can read today; a scope naming any other is a clear usage error. */
export const PROVIDERS = ["github", "youtrack"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

/** A positional argument: a whole repository, or one item in it. */
export type Scope =
  | { kind: "repo"; provider: ProviderId; repo: string }
  | { kind: "item"; provider: ProviderId; repo?: string; number: number };

export class ScopeError extends Error {}

const REPO = /^[\w.-]+\/[\w.-]+$/;

/**
 * Parse `owner/repo`, `github:owner/repo`, `youtrack:PROJECT`, `owner/repo#123`, `#123`, `123`, or an
 * issue/PR URL. A `provider:` prefix other than a supported one fails with the list
 * of providers, so a future `linear:ENG` reads as "not yet", not as a typo.
 */
export function parseScope(input: string): Scope {
  const url = input.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/(\d+)/);
  if (url) return { kind: "item", provider: "github", repo: url[1], number: Number(url[2]) };
  let rest = input;
  const prefix = input.match(/^([a-z][a-z0-9-]*):(.+)$/);
  if (prefix) {
    if (!(PROVIDERS as readonly string[]).includes(prefix[1])) {
      throw new ScopeError(
        `provider '${prefix[1]}' is not supported yet; supported: ${PROVIDERS.join(", ")}`,
      );
    }
    rest = prefix[2];
    if (prefix[1] === "youtrack") {
      const issue = rest.match(/^([\w.-]+)#(\d+)$/);
      if (issue)
        return {
          kind: "item",
          provider: "youtrack",
          repo: issue[1],
          number: Number(issue[2]),
        };
      if (!/^[\w.-]+$/.test(rest))
        throw new ScopeError(`YouTrack scope must be PROJECT or PROJECT#NUMBER: ${rest}`);
      return { kind: "repo", provider: "youtrack", repo: rest };
    }
  }
  // a repository before the number needs its #, or owner/repo2 would read as item 2 of owner/repo
  const item = rest.match(/^(?:([\w.-]+\/[\w.-]+)#|#)?(\d+)$/);
  if (item) return { kind: "item", provider: "github", repo: item[1], number: Number(item[2]) };
  if (REPO.test(rest)) return { kind: "repo", provider: "github", repo: rest };
  throw new ScopeError(
    `cannot read '${input}' as a repository (owner/repo) or an item (#123, URL)`,
  );
}

/** owner/repo from a GitHub remote URL (https or ssh), or undefined for anything else. */
export function repoFromRemote(url: string): string | undefined {
  const m = url.trim().match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** The GitHub repository of the current directory, from origin or the first remote. */
export function inferRepo(
  git: (args: string[]) => string = (args) =>
    execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }),
): string | undefined {
  try {
    const remotes = git(["remote"]).split("\n").filter(Boolean);
    const name = remotes.includes("origin") ? "origin" : remotes[0];
    if (!name) return undefined;
    return repoFromRemote(git(["remote", "get-url", name]));
  } catch {
    return undefined;
  }
}
