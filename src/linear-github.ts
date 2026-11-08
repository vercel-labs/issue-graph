import type { GithubTarget } from "./dashboard-types.js";
import type { LinearReport } from "./linear.js";
import type { GhTransport } from "./transport.js";

export const GITHUB_TARGET_QUERY = `query IssueGraphLinkedWork($owner:String!,$repo:String!,$n:Int!){
  repository(owner:$owner,name:$repo){
    nameWithOwner
    issueOrPullRequest(number:$n){
      __typename
      ... on Issue { number title state url }
      ... on PullRequest { number title state url isDraft }
    }
  }
}`;

const NAME = /^[\w.-]+$/;

/** `owner/repo#123` for a GitHub issue or pull request URL, or undefined. */
export function githubTarget(raw: string): { repo: string; number: number } | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.port)
    return undefined;
  const [owner, repo, kind, number] = url.pathname.split("/").filter(Boolean);
  if (
    !owner ||
    !repo ||
    !NAME.test(owner) ||
    !NAME.test(repo) ||
    (kind !== "pull" && kind !== "issues") ||
    !/^[1-9]\d*$/.test(number ?? "")
  )
    return undefined;
  return { repo: `${owner}/${repo}`, number: Number(number) };
}

async function readTarget(
  transport: Pick<GhTransport, "graphql">,
  repo: string,
  number: number,
): Promise<GithubTarget> {
  const observedAt = new Date().toISOString();
  const [owner, name] = repo.split("/");
  try {
    const response = (await transport.graphql(GITHUB_TARGET_QUERY, {
      owner,
      repo: name,
      n: number,
    })) as {
      data?: {
        repository?: {
          nameWithOwner?: string;
          issueOrPullRequest?: {
            __typename?: string;
            number?: number;
            title?: string;
            state?: string;
            url?: string;
            isDraft?: boolean;
          } | null;
        } | null;
      };
      errors?: unknown[];
    };
    const found = response?.data?.repository?.issueOrPullRequest;
    const kind =
      found?.__typename === "PullRequest"
        ? "pull-request"
        : found?.__typename === "Issue"
          ? "issue"
          : undefined;
    const state = found?.state;
    if (
      !found ||
      !kind ||
      found.number !== number ||
      typeof found.title !== "string" ||
      !(state === "OPEN" || state === "CLOSED" || (kind === "pull-request" && state === "MERGED"))
    )
      return { repo, number, observedAt, error: "NOT_FOUND" };
    return {
      repo: response.data?.repository?.nameWithOwner ?? repo,
      number,
      kind,
      state,
      ...(kind === "pull-request" && { draft: found.isDraft === true }),
      title: found.title,
      observedAt,
    };
  } catch {
    return { repo, number, observedAt, error: "READ_FAILED" };
  }
}

/**
 * Read the GitHub issues and pull requests attached to Linear issues, one hop and
 * never expanded. Each target is read once; failures mark the owning issue partial.
 */
export async function resolveGithubAttachments(
  report: LinearReport,
  transport: Pick<GhTransport, "graphql">,
): Promise<LinearReport> {
  const targets = new Map<string, { repo: string; number: number }>();
  for (const node of report.nodes)
    for (const link of node.externalLinks) {
      const target = githubTarget(link.url);
      if (target) targets.set(`${target.repo.toLowerCase()}#${target.number}`, target);
    }
  const entries = [...targets.entries()];
  const results = new Map<string, GithubTarget>();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(report.limits.concurrency ?? 4, entries.length) }, async () => {
      while (next < entries.length) {
        const [id, target] = entries[next++];
        results.set(id, await readTarget(transport, target.repo, target.number));
      }
    }),
  );
  const partial = new Set(report.coverage.partial);
  for (const node of report.nodes) {
    let reads = 0;
    let failed = false;
    for (const link of node.externalLinks) {
      const target = githubTarget(link.url);
      if (!target) continue;
      const result = results.get(`${target.repo.toLowerCase()}#${target.number}`);
      if (!result) continue;
      link.github = result;
      reads++;
      if (result.error) failed = true;
    }
    if (!reads) continue;
    node.coverage.push({
      source: "github attachments",
      pages: reads,
      complete: !failed,
      ...(failed && { reason: "read-failed" as const }),
    });
    if (failed) partial.add(node.key);
  }
  report.coverage.partial = [...partial];
  report.scope.externalLinks = "github-resolved";
  report.coverageComplete &&= !entries.some(([id]) => results.get(id)?.error);
  return report;
}

/** `PR open, draft` style label for an observed GitHub target. */
export function githubTargetLabel(target: GithubTarget): string {
  const name = `${target.repo}#${target.number}`;
  if (target.error) return `${name} unavailable`;
  const kind = target.kind === "pull-request" ? "PR" : "issue";
  const state = target.state?.toLowerCase();
  return `${name} ${kind} ${state}${target.draft ? ", draft" : ""}`;
}
