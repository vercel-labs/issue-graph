import type { GhTransport } from "./transport.js";

export const STATUS_SCHEMA_VERSION = 1 as const;
export const STATUS_PAGE_SIZE = 50;
export type ReviewState =
  | "required"
  | "changes-requested"
  | "approved"
  | "not-required"
  | "unknown";
export type StatusView = "authors" | "projects" | "prs";
export type StatusFormat = "auto" | "table" | "markdown" | "json";

export interface StatusPullRequest {
  id: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  headSha: string | null;
  updatedAt: string | null;
  isDraft: boolean | null;
  reviewState: ReviewState;
  mergeability: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  assignees: string[] | null;
  requestedReviewers: string[] | null;
}

export interface StatusCoverage {
  repo: string;
  complete: boolean;
  pages: number;
  scanned: number;
  errors: Array<{ code: string; message: string }>;
}

export interface StatusCount {
  count: number | null;
  prIds: string[];
  unknownIds: string[];
}

export const STATUS_METRICS = [
  "open",
  "reviewRequired",
  "changesRequested",
  "approved",
  "notRequired",
  "reviewUnknown",
  "drafts",
  "conflicts",
  "mergeUnknown",
  "unassigned",
] as const;
export type StatusMetric = (typeof STATUS_METRICS)[number];
export type StatusCounts = Record<StatusMetric, StatusCount>;

export interface StatusRow {
  repo: string;
  author: string;
  counts: StatusCounts;
}

export interface StatusProject {
  repo: string;
  counts: StatusCounts;
  authors: Array<{ author: string; count: StatusCount }>;
}

export interface StatusReport {
  schemaVersion: typeof STATUS_SCHEMA_VERSION;
  startedAt: string;
  generatedAt: string;
  scope: { repos: string[]; authors: string[] };
  coverageComplete: boolean;
  coverage: StatusCoverage[];
  pullRequests: StatusPullRequest[];
  rows: StatusRow[];
  projects: StatusProject[];
  totals: StatusCounts;
  nextSteps: string[];
}

export interface StatusOptions {
  repos: string[];
  authors: string[];
  concurrency?: number;
  maxPages?: number;
  onProgress?: (event: { repo: string; pages: number; scanned: number; complete: boolean }) => void;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function normalizeStatusScope(repos: string[], authors: string[]): StatusReport["scope"] {
  if (!repos.length || !authors.length) throw new Error("status requires --repo and --author");
  const normalize = (values: string[], pattern: RegExp, label: string) => {
    const unique = new Map<string, string>();
    for (const value of [...values].sort(compare)) {
      if (!pattern.test(value)) throw new Error(`invalid ${label}: ${value}`);
      const key = value.toLowerCase();
      if (!unique.has(key)) unique.set(key, value);
    }
    return [...unique.values()].sort((a, b) => compare(a.toLowerCase(), b.toLowerCase()));
  };
  return {
    repos: normalize(repos, /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/, "repository"),
    authors: normalize(authors, /^[A-Za-z0-9][A-Za-z0-9-]*$/, "author"),
  };
}

function metricMatch(pr: StatusPullRequest, metric: StatusMetric): boolean | null {
  switch (metric) {
    case "open":
      return true;
    case "reviewRequired":
      return pr.reviewState === "required";
    case "changesRequested":
      return pr.reviewState === "changes-requested";
    case "approved":
      return pr.reviewState === "approved";
    case "notRequired":
      return pr.reviewState === "not-required";
    case "reviewUnknown":
      return pr.reviewState === "unknown";
    case "drafts":
      return pr.isDraft;
    case "conflicts":
      return pr.mergeability === "UNKNOWN" ? null : pr.mergeability === "CONFLICTING";
    case "mergeUnknown":
      return pr.mergeability === "UNKNOWN";
    case "unassigned":
      return pr.assignees === null ? null : pr.assignees.length === 0;
  }
}

function counts(prs: StatusPullRequest[], complete: boolean): StatusCounts {
  return Object.fromEntries(
    STATUS_METRICS.map((metric) => {
      const prIds: string[] = [];
      const unknownIds: string[] = [];
      for (const pr of prs) {
        const match = metricMatch(pr, metric);
        if (match === true) prIds.push(pr.id);
        if (match === null) unknownIds.push(pr.id);
      }
      return [
        metric,
        { count: complete && !unknownIds.length ? prIds.length : null, prIds, unknownIds },
      ];
    }),
  ) as StatusCounts;
}

export function buildStatusReport(
  input: StatusPullRequest[],
  coverage: StatusCoverage[],
  options: Pick<StatusOptions, "repos" | "authors"> & { startedAt: string; generatedAt: string },
): StatusReport {
  const scope = normalizeStatusScope(options.repos, options.authors);
  const repoNames = new Map(scope.repos.map((repo) => [repo.toLowerCase(), repo]));
  const authorNames = new Map(scope.authors.map((author) => [author.toLowerCase(), author]));
  const unique = new Map<string, StatusPullRequest>();
  const conflicting = new Set<string>();
  for (const pr of input) {
    const repo = repoNames.get(pr.repo.toLowerCase());
    const author = authorNames.get(pr.author.toLowerCase());
    if (!repo || !author) continue;
    const id = `${repo.toLowerCase()}#${pr.number}`;
    const normalized: StatusPullRequest = {
      id,
      repo,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      author,
      headSha: pr.headSha,
      updatedAt: pr.updatedAt,
      isDraft: pr.isDraft,
      reviewState: pr.reviewState,
      mergeability: pr.mergeability,
      assignees: pr.assignees === null ? null : [...new Set(pr.assignees)].sort(compare),
      requestedReviewers:
        pr.requestedReviewers === null ? null : [...new Set(pr.requestedReviewers)].sort(compare),
    };
    const previous = unique.get(id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(normalized)) {
      conflicting.add(repo);
      if (compare(JSON.stringify(previous), JSON.stringify(normalized)) > 0) continue;
    }
    unique.set(id, normalized);
  }
  const pullRequests = [...unique.values()].sort(
    (a, b) => compare(a.repo.toLowerCase(), b.repo.toLowerCase()) || a.number - b.number,
  );
  const normalizedCoverage = scope.repos.map((repo) => {
    const source = coverage.find((item) => item.repo.toLowerCase() === repo.toLowerCase());
    const result: StatusCoverage = source
      ? { ...source, repo, errors: [...source.errors] }
      : {
          repo,
          complete: false,
          pages: 0,
          scanned: 0,
          errors: [
            {
              code: "MISSING_REPOSITORY",
              message: "No inventory was returned for this repository.",
            },
          ],
        };
    if (conflicting.has(repo))
      result.errors.push({
        code: "INVENTORY_CHANGED",
        message: "Conflicting versions of a PR were observed in the query window.",
      });
    result.complete = result.complete && result.errors.length === 0;
    return result;
  });
  const projects = normalizedCoverage.map((item) => {
    const prs = pullRequests.filter((pr) => pr.repo === item.repo);
    return {
      repo: item.repo,
      counts: counts(prs, item.complete),
      authors: scope.authors.map((author) => ({
        author,
        count: counts(
          prs.filter((pr) => pr.author === author),
          item.complete,
        ).open,
      })),
    };
  });
  const rows = normalizedCoverage.flatMap((item) =>
    scope.authors.map((author) => ({
      repo: item.repo,
      author,
      counts: counts(
        pullRequests.filter((pr) => pr.repo === item.repo && pr.author === author),
        item.complete,
      ),
    })),
  );
  const coverageComplete = normalizedCoverage.every((item) => item.complete);
  const nextSteps = projects
    .filter((project) => project.counts.open.prIds.length > 0 || project.counts.open.count === null)
    .map(
      (project) =>
        `xref status --repo ${project.repo} --author ${scope.authors.join(",")} --view prs`,
    );
  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    startedAt: options.startedAt,
    generatedAt: options.generatedAt,
    scope,
    coverageComplete,
    coverage: normalizedCoverage,
    pullRequests,
    rows,
    projects,
    totals: counts(pullRequests, coverageComplete),
    nextSteps,
  };
}

export const STATUS_QUERY = `query($owner:String!,$repo:String!,$after:String){
  repository(owner:$owner,name:$repo){
    pullRequests(first:50,after:$after,states:OPEN,orderBy:{field:CREATED_AT,direction:ASC}){
      totalCount pageInfo{hasNextPage endCursor}
      nodes{number title url author{login} headRefOid updatedAt isDraft reviewDecision mergeable
        assignees(first:100){nodes{login} pageInfo{hasNextPage endCursor}}
        reviewRequests(first:100){nodes{requestedReviewer{... on User{login} ... on Bot{login} ... on Team{slug organization{login}}}} pageInfo{hasNextPage endCursor}}
      }
    }
  }
}`;

const ASSIGNEES_QUERY = `query($owner:String!,$repo:String!,$n:Int!,$after:String!){repository(owner:$owner,name:$repo){pullRequest(number:$n){assignees(first:100,after:$after){nodes{login} pageInfo{hasNextPage endCursor}}}}}`;
const REVIEWERS_QUERY = `query($owner:String!,$repo:String!,$n:Int!,$after:String!){repository(owner:$owner,name:$repo){pullRequest(number:$n){reviewRequests(first:100,after:$after){nodes{requestedReviewer{... on User{login} ... on Bot{login} ... on Team{slug organization{login}}}} pageInfo{hasNextPage endCursor}}}}}`;

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : null;
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

function repositoryData(raw: unknown): ObjectValue {
  const envelope = object(raw);
  if (!envelope || (Array.isArray(envelope.errors) && envelope.errors.length > 0))
    throw new Error("GitHub returned GraphQL errors; inventory is incomplete.");
  const repository = object(object(envelope.data)?.repository);
  if (!repository) throw new Error("Repository not accessible or no repository data returned.");
  return repository;
}

function pageData(raw: unknown): {
  nodes: unknown[];
  hasNextPage: boolean;
  endCursor: string | null;
} {
  const connection = object(raw);
  const info = object(connection?.pageInfo);
  if (!Array.isArray(connection?.nodes) || typeof info?.hasNextPage !== "boolean")
    throw new Error("Missing pagination metadata.");
  return {
    nodes: connection.nodes,
    hasNextPage: info.hasNextPage,
    endCursor: text(info.endCursor),
  };
}

function nextCursor(page: ReturnType<typeof pageData>, seen: Set<string>): string | null {
  if (!page.hasNextPage) return null;
  if (!page.endCursor || seen.has(page.endCursor))
    throw new Error("GitHub pagination cursor did not advance.");
  seen.add(page.endCursor);
  return page.endCursor;
}

async function people(
  transport: GhTransport,
  initial: unknown,
  field: "assignees" | "reviewRequests",
  variables: Record<string, string | number>,
  maxPages: number,
): Promise<string[]> {
  let connection = initial;
  const names = new Set<string>();
  const cursors = new Set<string>();
  for (let index = 0; index < maxPages; index++) {
    const page = pageData(connection);
    for (const raw of page.nodes) {
      const node = object(raw);
      const person = field === "assignees" ? node : object(node?.requestedReviewer);
      const login = text(person?.login);
      const slug = text(person?.slug);
      const owner = text(object(person?.organization)?.login);
      const name = login ?? (slug && owner ? `${owner}/${slug}` : null);
      if (!name) throw new Error(`Incomplete ${field} metadata.`);
      names.add(name);
    }
    const after = nextCursor(page, cursors);
    if (!after) return [...names].sort(compare);
    if (index + 1 === maxPages) throw new Error(`${field} pagination limit reached.`);
    const data = repositoryData(
      await transport.graphql(field === "assignees" ? ASSIGNEES_QUERY : REVIEWERS_QUERY, {
        ...variables,
        after,
      }),
    );
    connection = object(data.pullRequest)?.[field];
  }
  throw new Error(`${field} pagination limit reached.`);
}

function reviewState(value: unknown): ReviewState {
  if (value === null) return "not-required";
  if (value === "APPROVED") return "approved";
  if (value === "CHANGES_REQUESTED") return "changes-requested";
  if (value === "REVIEW_REQUIRED") return "required";
  return "unknown";
}

export async function collectStatus(
  transport: GhTransport,
  options: StatusOptions,
): Promise<StatusReport> {
  const scope = normalizeStatusScope(options.repos, options.authors);
  const concurrency = options.concurrency ?? 4;
  const maxPages = options.maxPages ?? 100;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32)
    throw new Error("concurrency must be an integer from 1 to 32");
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000)
    throw new Error("maxPages must be an integer from 1 to 1000");
  const startedAt = new Date().toISOString();
  const results: StatusPullRequest[] = [];
  const coverage: StatusCoverage[] = [];
  let index = 0;
  const wanted = new Set(scope.authors.map((author) => author.toLowerCase()));
  async function inspect(repo: string) {
    const [owner, name] = repo.split("/");
    const report: StatusCoverage = { repo, complete: false, pages: 0, scanned: 0, errors: [] };
    coverage.push(report);
    const seen = new Set<number>();
    const cursors = new Set<string>();
    let after: string | null = null;
    let total: number | null = null;
    try {
      for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
        const variables: Record<string, string | number> = { owner, repo: name };
        if (after) variables.after = after;
        const data = repositoryData(await transport.graphql(STATUS_QUERY, variables));
        const connection = object(data.pullRequests);
        const page = pageData(connection);
        const currentTotal = connection?.totalCount;
        if (typeof currentTotal !== "number" || !Number.isInteger(currentTotal) || currentTotal < 0)
          throw new Error("Missing repository PR count.");
        if (total !== null && currentTotal !== total)
          throw new Error(
            "Open PR inventory changed during pagination; rerun for a fresh capture.",
          );
        total = currentTotal;
        report.pages++;
        for (const raw of page.nodes) {
          const item = object(raw);
          const number = item?.number;
          if (typeof number !== "number" || !Number.isInteger(number) || number < 1)
            throw new Error("Missing PR identity.");
          const author = object(item?.author);
          if (item?.author !== null && !text(author?.login))
            throw new Error("Missing PR author metadata.");
          const login = text(author?.login);
          seen.add(number);
          report.scanned = seen.size;
          if (!login || !wanted.has(login.toLowerCase())) continue;
          const rawUrl = text(item?.url);
          const url = rawUrl ? new URL(rawUrl) : null;
          if (
            url?.protocol !== "https:" ||
            url.username ||
            url.password ||
            !url.pathname.endsWith(`/pull/${number}`)
          )
            throw new Error(`Missing or invalid canonical URL for ${repo}#${number}.`);
          const pr: StatusPullRequest = {
            id: `${repo.toLowerCase()}#${number}`,
            repo,
            number,
            title: text(item?.title) ?? "(title unavailable)",
            url: url.href,
            author: login,
            headSha: text(item?.headRefOid),
            updatedAt: text(item?.updatedAt),
            isDraft: typeof item?.isDraft === "boolean" ? item.isDraft : null,
            reviewState: reviewState(item?.reviewDecision),
            mergeability:
              item?.mergeable === "MERGEABLE" || item?.mergeable === "CONFLICTING"
                ? item.mergeable
                : "UNKNOWN",
            assignees: null,
            requestedReviewers: null,
          };
          for (const field of ["assignees", "reviewRequests"] as const) {
            try {
              const names = await people(
                transport,
                item?.[field],
                field,
                { owner, repo: name, n: number },
                maxPages,
              );
              if (field === "assignees") pr.assignees = names;
              else pr.requestedReviewers = names;
            } catch {
              report.errors.push({
                code: "INCOMPLETE_METADATA",
                message: `Could not completely read ${field} for ${pr.id}.`,
              });
            }
          }
          results.push(pr);
        }
        after = nextCursor(page, cursors);
        options.onProgress?.({
          repo,
          pages: report.pages,
          scanned: report.scanned,
          complete: after === null,
        });
        if (!after) {
          if (seen.size !== total)
            throw new Error("PR count and pagination disagree; inventory may have changed.");
          report.complete = report.errors.length === 0;
          return;
        }
      }
      report.errors.push({
        code: "PAGE_LIMIT",
        message: `PR pagination limit (${maxPages} pages) reached.`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "GitHub inventory request failed.";
      report.errors.push({ code: "FETCH_FAILED", message });
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, scope.repos.length) }, async () => {
      while (index < scope.repos.length) {
        const repo = scope.repos[index++];
        await inspect(repo);
      }
    }),
  );
  return buildStatusReport(results, coverage, {
    ...scope,
    startedAt,
    generatedAt: new Date().toISOString(),
  });
}
