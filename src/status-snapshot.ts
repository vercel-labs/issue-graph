import {
  buildStatusReport,
  normalizeStatusScope,
  type StatusCoverage,
  type StatusPullRequest,
  type StatusReport,
} from "./status.js";
import type { StatusSnapshot } from "./status-history-types.js";

function invalid(field: string): never {
  throw new Error(`Invalid status snapshot: ${field}`);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(field);
  return value as Record<string, unknown>;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) invalid(field);
  return Array.from(value);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") invalid(field);
  return value;
}

function nonempty(value: unknown, field: string): string {
  const result = text(value, field);
  if (!result.trim()) invalid(field);
  return result;
}

function strings(value: unknown, field: string): string[] {
  return array(value, field).map((item) => nonempty(item, field));
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") invalid(field);
  return value;
}

function integer(value: unknown, field: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) invalid(field);
  return value;
}

function timestamp(value: unknown, field: string): string {
  const result = text(value, field);
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(result);
  if (!parts || !Number.isFinite(Date.parse(result))) invalid(field);
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1] ||
    Number(parts[4]) > 23 ||
    Number(parts[5]) > 59 ||
    Number(parts[6]) > 59
  )
    invalid(field);
  return result;
}

function member<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  for (const candidate of allowed) if (value === candidate) return candidate;
  return invalid(field);
}

function scopedName(value: unknown, names: string[], field: string): string {
  const name = nonempty(value, field);
  const canonical = names.find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  if (!canonical) invalid(`${field} is outside scope`);
  return canonical;
}

function pullRequest(value: unknown, scope: StatusReport["scope"]): StatusPullRequest {
  const item = object(value, "pullRequests entry");
  const repo = scopedName(item.repo, scope.repos, "PR repository");
  const author = scopedName(item.author, scope.authors, "PR author");
  const number = integer(item.number, "PR number", 1);
  const id = `${repo.toLowerCase()}#${number}`;
  if (item.id !== id) invalid("PR id does not match repository and number");
  const url = text(item.url, "PR URL");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return invalid("PR URL");
  }
  const path = /^\/[^/]+\/[^/]+\/pull\/([1-9]\d*)\/?$/.exec(parsed.pathname);
  if (
    !url.startsWith("https://") ||
    url !== url.trim() ||
    /[\s\\]/.test(url) ||
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    !path ||
    path[1] !== String(number)
  )
    invalid("PR URL must be credential-free HTTPS with a matching pull request number");
  return {
    id,
    repo,
    number,
    title: text(item.title, "PR title"),
    url,
    author,
    headSha: item.headSha === null ? null : text(item.headSha, "PR headSha"),
    updatedAt: item.updatedAt === null ? null : timestamp(item.updatedAt, "PR updatedAt"),
    isDraft: item.isDraft === null ? null : boolean(item.isDraft, "PR isDraft"),
    reviewState: member(
      item.reviewState,
      ["required", "changes-requested", "approved", "not-required", "unknown"],
      "PR reviewState",
    ),
    mergeability: member(
      item.mergeability,
      ["MERGEABLE", "CONFLICTING", "UNKNOWN"],
      "PR mergeability",
    ),
    assignees: item.assignees === null ? null : strings(item.assignees, "PR assignees"),
    requestedReviewers:
      item.requestedReviewers === null
        ? null
        : strings(item.requestedReviewers, "PR requestedReviewers"),
  };
}

export function parseStatusSnapshot(value: unknown): StatusSnapshot {
  const input = object(value, "expected an object");
  if (input.schemaVersion !== 1) invalid("unsupported schemaVersion");
  const imported = !Object.hasOwn(input, "kind");
  if (!imported && input.kind !== "issue-graph-status-snapshot") invalid("kind");
  const startedAt = timestamp(input.startedAt, "startedAt");
  const generatedAt = timestamp(input.generatedAt, "generatedAt");
  if (Date.parse(startedAt) > Date.parse(generatedAt)) invalid("startedAt is after generatedAt");
  const rawScope = object(input.scope, "scope");
  const repos = strings(rawScope.repos, "scope.repos");
  const authors = strings(rawScope.authors, "scope.authors");
  let scope: StatusReport["scope"];
  try {
    scope = normalizeStatusScope(repos, authors);
  } catch {
    return invalid("scope");
  }
  const seenRepos = new Set<string>();
  const coverage: StatusCoverage[] = array(input.coverage, "coverage").map((value) => {
    const item = object(value, "coverage entry");
    const repo = scopedName(item.repo, scope.repos, "coverage repository");
    if (seenRepos.has(repo)) invalid("duplicate coverage repository");
    seenRepos.add(repo);
    const complete = boolean(item.complete, "coverage complete");
    const errors = array(item.errors, "coverage errors").map((value) => {
      const error = object(value, "coverage error");
      return {
        code: nonempty(error.code, "error code"),
        message: nonempty(error.message, "error message"),
      };
    });
    if (complete && errors.length) invalid("complete coverage has errors");
    return {
      repo,
      complete,
      pages: integer(item.pages, "coverage pages"),
      scanned: integer(item.scanned, "coverage scanned"),
      errors,
    };
  });
  if (seenRepos.size !== scope.repos.length) invalid("coverage omits a scope repository");
  const seenIds = new Set<string>();
  const matched = new Map<string, number>();
  const pullRequests = array(input.pullRequests, "pullRequests").map((value) => {
    const pr = pullRequest(value, scope);
    if (seenIds.has(pr.id)) invalid("duplicate PR identity");
    seenIds.add(pr.id);
    matched.set(pr.repo, (matched.get(pr.repo) ?? 0) + 1);
    return pr;
  });
  for (const item of coverage) {
    if (item.scanned < (matched.get(item.repo) ?? 0))
      invalid(`coverage scanned is below matched PRs for ${item.repo}`);
  }
  let provenance: StatusSnapshot["provenance"];
  if (imported) {
    const declaredComplete = boolean(input.coverageComplete, "report coverageComplete");
    if (declaredComplete !== coverage.every((item) => item.complete))
      invalid("report coverageComplete contradicts repository coverage");
    array(input.rows, "report rows");
    array(input.projects, "report projects");
    object(input.totals, "report totals");
    strings(input.nextSteps, "report nextSteps");
    provenance = {
      kind: "imported-report",
      note: "Imported from a schemaVersion 1 status report; metrics are rebuilt from source evidence.",
      sources: [],
    };
  } else {
    const source = object(input.provenance, "provenance");
    provenance = {
      kind: member(source.kind, ["live", "reconstructed", "imported-report"], "provenance kind"),
      note: nonempty(source.note, "provenance note"),
      sources: strings(source.sources, "provenance sources"),
    };
  }
  return {
    kind: "issue-graph-status-snapshot",
    schemaVersion: 1,
    startedAt,
    generatedAt,
    scope,
    coverage,
    pullRequests,
    provenance,
  };
}

export function toStatusSnapshot(
  report: StatusReport,
  provenance: StatusSnapshot["provenance"] = {
    kind: "live",
    note: "Live status inventory captured from GitHub.",
    sources: [],
  },
): StatusSnapshot {
  return parseStatusSnapshot({ ...report, kind: "issue-graph-status-snapshot", provenance });
}

export function snapshotReport(snapshot: StatusSnapshot): StatusReport {
  const validated = parseStatusSnapshot(snapshot);
  return buildStatusReport(validated.pullRequests, validated.coverage, {
    ...validated.scope,
    startedAt: validated.startedAt,
    generatedAt: validated.generatedAt,
  });
}
