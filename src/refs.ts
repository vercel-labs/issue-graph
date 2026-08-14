import type { NodeKey, Seed } from "./types.js";

/** Full GitHub issue/PR URL. */
const GH_REF = /\bhttps:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)/g;
/** Cross-repo shorthand `owner/repo#123`. */
const SHORT_REF = /(?:^|[\s(])([\w.-]+)\/([\w.-]+)#(\d+)/g;
/** Same-repo shorthand `#123`. */
const LOCAL_REF = /(?:^|[\s(])#(\d+)\b/g;
/** Any http(s) URL. */
const ANY_URL = /\bhttps?:\/\/[^\s)\]<>"'`]+/g;

/** Resolve a seed from a URL or a bare number (needs `--repo`). */
export function parseSeed(input: string, repoFlag?: string): Seed {
  const url = input.match(/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)/);
  if (url) return { owner: url[1], repo: url[2], number: Number(url[3]) };
  const num = Number(input.replace(/^#/, ""));
  if (!Number.isFinite(num)) throw new Error(`Cannot parse seed: ${input}`);
  if (!repoFlag) throw new Error("--repo owner/repo required when seed is a bare number");
  const [owner, repo] = repoFlag.split("/");
  return { owner, repo, number: num };
}

/**
 * A URL that describes the bug (loopback, localhost, example, private range,
 * tailnet placeholder, or a test fixture host) rather than a resource
 * worth tracing. Kept out of the orphan checklist.
 */
export function isNoiseUrl(raw: string): boolean {
  let host: string;
  try {
    host = new URL(raw).hostname;
  } catch {
    return true;
  }
  if (["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(host)) return true;
  if (host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (/^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/(^|\.)example\.(com|org|net)$/.test(host) || host.endsWith(".example")) return true;
  if (host.endsWith(".ts.net")) return true;
  if (/^(a|b|other-page|admin\.example)\.com$/.test(host)) return true;
  if (/(^|\.)(httpbin\.org|speed\.cloudflare\.com|catbox\.moe)$/.test(host)) return true;
  if (raw.endsWith(".svg") || raw.endsWith(".css") || raw.endsWith(".gif")) return true;
  return false;
}

/**
 * A GitHub closing keyword (`fixes #1`, `closes owner/repo#2`, `resolves <url>`)
 * followed by an issue reference. GitHub only auto-closes an issue when such a
 * phrase appears in the PR *body*; a bare mention or a `#N` in a comment does
 * not. Extracting these lets us flag a PR that *says* it fixes an issue but has
 * no structural closing link — the merge won't auto-close it.
 */
const CLOSING_REF =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s+(?:https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)|([\w.-]+)\/([\w.-]+)#(\d+)|#(\d+))/gi;

/** Issues a PR body claims to close via a closing keyword. */
export function extractClosingRefs(text: string, owner: string, repo: string): NodeKey[] {
  const out = new Set<NodeKey>();
  if (!text) return [];
  for (const m of text.matchAll(CLOSING_REF)) {
    if (m[3]) out.add(`${m[1]}/${m[2]}#${m[3]}`);
    else if (m[6]) out.add(`${m[4]}/${m[5]}#${m[6]}`);
    else if (m[7]) out.add(`${owner}/${repo}#${m[7]}`);
  }
  return [...out];
}

/** Extract node references and traceable external links from a blob of text. */
export function extractRefs(
  text: string,
  owner: string,
  repo: string,
): { refs: NodeKey[]; external: string[] } {
  const refs = new Set<NodeKey>();
  const external = new Set<string>();
  if (!text) return { refs: [], external: [] };
  for (const m of text.matchAll(GH_REF)) refs.add(`${m[1]}/${m[2]}#${m[3]}`);
  for (const m of text.matchAll(SHORT_REF)) refs.add(`${m[1]}/${m[2]}#${m[3]}`);
  for (const m of text.matchAll(LOCAL_REF)) refs.add(`${owner}/${repo}#${m[1]}`);
  for (const m of text.matchAll(ANY_URL)) {
    const clean = m[0].replace(/[.,;:]+$/, "");
    if (!clean.includes("github.com") && !isNoiseUrl(clean)) external.add(clean);
  }
  return { refs: [...refs], external: [...external] };
}
