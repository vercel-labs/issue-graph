import type { Model, ProviderDescriptor } from "./html.js";
import { dashboardModel } from "./html.js";
import type { Edge, GraphNode, NodeKey } from "./types.js";

const PAGE_SIZE = 100;
const MAX_ACTIVITY_PAGES = 100;
const ISSUE_FIELDS =
  "id,idReadable,summary,resolved,reporter(login),project(shortName),customFields(name,value(name,isResolved))";
const FOCUSED_ISSUE_FIELDS = `${ISSUE_FIELDS},description,links(id,direction,linkType(id,name,sourceToTarget,targetToSource,directed),issues(id,idReadable,summary,resolved,project(shortName)))`;
const LINK_FIELDS = "id,direction,linkType(id,name,sourceToTarget,targetToSource,directed)";
const LINKED_ISSUE_FIELDS = "id,idReadable,summary,resolved,project(shortName)";
const ACTIVITY_CATEGORIES = "VcsChangeCategory,PullRequestChangeCategory";
const ACTIVITY_FIELDS =
  "activities(id,$type,timestamp,added($type,urls,pullRequest($type,idExternal,idReadable,title,url,branch,date),state(id)),removed($type,urls,pullRequest($type,idExternal,idReadable,title,url,branch,date),state(id))),hasAfter,afterCursor";

export const YOUTRACK_PROVIDER: ProviderDescriptor = {
  id: "youtrack",
  name: "YouTrack",
  logo: '<svg aria-hidden="true" viewBox="0 0 16 16"><path d="M2 2h5.2c3.7 0 6.8 2.3 6.8 6s-3.1 6-6.8 6H2V2zm3 3v6h2.2C9.5 11 11 9.8 11 8s-1.5-3-3.8-3H5z" fill="currentColor"/></svg>',
  repoUrl: "https://www.jetbrains.com/youtrack/",
  signals: [],
  views: ["explore", "impact", "swarm"],
  metrics: ["links", "blast", "depth"],
  filters: [],
};

interface Project {
  id: string;
  name: string;
  shortName: string;
}

interface StateValue {
  name?: string;
  isResolved?: boolean;
}

interface Issue {
  id: string;
  idReadable: string;
  summary: string;
  resolved: number | null | undefined;
  description?: string;
  reporter?: { login?: string };
  project?: { shortName?: string };
  customFields?: Array<{ name?: string; value?: StateValue | null }>;
  links?: IssueLink[];
}

interface LinkType {
  id?: string;
  name?: string;
  sourceToTarget?: string;
  targetToSource?: string;
  directed?: boolean;
}

interface IssueLink {
  id?: string;
  direction?: string;
  linkType?: LinkType;
  issues?: LinkedIssue[];
}

interface LinkedIssue {
  id: string;
  idReadable: string;
  summary?: string;
  resolved?: number | null;
  project?: { shortName?: string };
}

interface IssueActivity {
  $type?: string;
  timestamp?: number;
  added?: unknown[];
  removed?: unknown[];
}

interface GitHubPullRequest {
  key: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  state: string;
  timestamp: number;
}

interface Collection<T> {
  items: T[];
  complete: boolean;
  message?: string;
}

export interface YouTrackOptions {
  baseUrl?: string;
  token?: string;
  state?: "open" | "all";
  maxNodes?: number;
  maxDepth?: number;
  issueId?: string;
  fetcher?: typeof fetch;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeBaseUrl(value: string): {
  url: string;
  origin: string;
  path: string;
  key: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("YOUTRACK_URL must be an absolute HTTP or HTTPS URL");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("YOUTRACK_URL must be an HTTP or HTTPS base URL without credentials or query");
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  const url = `${parsed.origin}${path}`;
  return { url, origin: parsed.origin, path, key: `${parsed.host}${path}` };
}

function validIssue(value: unknown): value is Issue {
  return (
    record(value) &&
    typeof value.id === "string" &&
    typeof value.idReadable === "string" &&
    typeof value.summary === "string" &&
    Object.hasOwn(value, "resolved") &&
    (value.resolved === null ||
      (typeof value.resolved === "number" && Number.isFinite(value.resolved)))
  );
}

function readableNumber(identifier: string, fallback: number): number {
  const match = identifier.match(/(\d+)$/);
  return match ? Number(match[1]) : fallback;
}

function githubPullRequest(value: unknown, timestamp: number): GitHubPullRequest | undefined {
  if (!record(value) || !record(value.pullRequest)) return;
  const pullRequest = value.pullRequest;
  if (typeof pullRequest.url !== "string") return;
  let url: URL;
  try {
    url = new URL(pullRequest.url);
  } catch {
    return;
  }
  if (url.protocol !== "https:" || !["github.com", "www.github.com"].includes(url.hostname)) return;
  const match = url.pathname.match(/^\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:\/|$)/i);
  if (!match) return;
  const [, owner, repo, numberText] = match;
  const number = Number(numberText);
  if (!Number.isSafeInteger(number) || number < 1) return;
  const state =
    record(value.state) && typeof value.state.id === "string" ? value.state.id : "UNKNOWN";
  return {
    key: `${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`,
    owner,
    repo,
    number,
    title:
      typeof pullRequest.title === "string" && pullRequest.title
        ? pullRequest.title
        : `Pull request #${number}`,
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
    state: state.toUpperCase(),
    timestamp,
  };
}

function githubCommitUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  if (url.protocol !== "https:" || !["github.com", "www.github.com"].includes(url.hostname)) return;
  const match = url.pathname.match(/^\/([\w.-]+)\/([\w.-]+)\/commit\/([\da-f]{7,64})(?:\/|$)/i);
  if (!match) return;
  const [, owner, repo, hash] = match;
  return `https://github.com/${owner}/${repo}/commit/${hash}`;
}

function pullRequestState(state: string): string {
  switch (state) {
    case "OPEN":
      return "OPEN";
    case "MERGED":
      return "MERGED";
    case "CLOSED":
    case "DECLINED":
      return "CLOSED";
    default:
      return "UNKNOWN";
  }
}

export async function collectYouTrack(
  shortName: string,
  options: YouTrackOptions = {},
): Promise<Model> {
  const rawBaseUrl = options.baseUrl ?? process.env.YOUTRACK_URL;
  const token = options.token ?? process.env.YOUTRACK_TOKEN;
  if (!rawBaseUrl || !token) throw new Error("YOUTRACK_URL and YOUTRACK_TOKEN are required");

  const base = normalizeBaseUrl(rawBaseUrl);
  const fetcher = options.fetcher ?? fetch;
  const limit = Math.max(1, Math.min(options.maxNodes ?? 1000, 1000));
  const state = options.state ?? "open";
  const maxDepth = options.maxDepth ?? 2;
  if (options.issueId && (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 5))
    throw new Error("YouTrack issue depth must be an integer from 0 to 5");

  const endpoint = (path: string) =>
    new URL(`${base.path}/api/${path.replace(/^\/+/, "")}`, base.origin);
  const getJson = async (url: URL): Promise<unknown> => {
    const response = await fetcher(url, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`YouTrack API request failed (${response.status})`);
    try {
      return await response.json();
    } catch {
      throw new Error("YouTrack API returned invalid JSON");
    }
  };
  const readCollection = async <T>(
    path: string,
    fields: string,
    query: string,
    maxRows: number,
    failOnPartial: boolean,
  ): Promise<Collection<T>> => {
    const items: T[] = [];
    let offset = 0;
    const page = async (top: number, skip: number): Promise<T[]> => {
      const url = endpoint(path);
      url.searchParams.set("fields", fields);
      url.searchParams.set("$top", String(top));
      url.searchParams.set("$skip", String(skip));
      if (query) url.searchParams.set("query", query);
      const value = await getJson(url);
      if (!Array.isArray(value)) throw new Error("YouTrack API returned an invalid collection");
      return value as T[];
    };

    while (offset < maxRows) {
      const top = Math.min(PAGE_SIZE, maxRows - offset);
      let rows: T[];
      try {
        rows = await page(top, offset);
      } catch (error) {
        if (failOnPartial || offset === 0) throw error;
        return { items, complete: false, message: "A later API page could not be read" };
      }
      if (rows.length > top) throw new Error("YouTrack API exceeded the requested page size");
      items.push(...rows);
      offset += rows.length;
      if (rows.length < top) return { items, complete: true };
    }

    try {
      const extra = await page(1, offset);
      if (extra.length) return { items, complete: false, message: "The read limit was reached" };
      return { items, complete: true };
    } catch (error) {
      if (failOnPartial) throw error;
      return { items, complete: false, message: "The read limit could not be checked" };
    }
  };

  const projectPages = await readCollection<Project>(
    "admin/projects",
    "id,name,shortName",
    shortName,
    1000,
    true,
  );
  if (!projectPages.complete) throw new Error("YouTrack project lookup was incomplete");
  const projectMatches = projectPages.items.filter(
    (project) =>
      record(project) &&
      typeof project.id === "string" &&
      typeof project.name === "string" &&
      typeof project.shortName === "string" &&
      project.shortName.toLowerCase() === shortName.toLowerCase(),
  );
  if (!projectMatches.length) throw new Error(`YouTrack project not found: ${shortName}`);
  if (projectMatches.length > 1)
    throw new Error(`YouTrack project short name is ambiguous: ${shortName}`);
  const project = projectMatches[0];

  const issuePages = options.issueId
    ? await (async (): Promise<Collection<Issue>> => {
        const url = endpoint(`issues/${encodeURIComponent(options.issueId as string)}`);
        url.searchParams.set("fields", FOCUSED_ISSUE_FIELDS);
        const issue = await getJson(url);
        if (!validIssue(issue)) throw new Error("YouTrack API returned an invalid issue");
        if (
          issue.idReadable.toLowerCase() !== options.issueId?.toLowerCase() ||
          issue.project?.shortName?.toLowerCase() !== project.shortName.toLowerCase()
        ) {
          throw new Error(
            `YouTrack issue ${options.issueId} does not belong to project ${shortName}`,
          );
        }
        return { items: [issue], complete: true };
      })()
    : await readCollection<Issue>(
        `admin/projects/${encodeURIComponent(project.id)}/issues`,
        ISSUE_FIELDS,
        state === "open" ? "#Unresolved" : "",
        limit,
        false,
      );
  if (issuePages.items.some((issue) => !validIssue(issue)))
    throw new Error("YouTrack API returned an invalid issue");
  const warnings: string[] = [];
  if (!issuePages.complete) warnings.push(issuePages.message ?? "The issue list was incomplete");

  const identity = `youtrack:${base.key}`;
  const issueById = new Map<string, Issue>();
  for (const issue of issuePages.items as Issue[]) issueById.set(issue.id, issue);
  const seedIssue = options.issueId ? (issueById.values().next().value as Issue) : undefined;
  const projectRepo = `${identity}/${project.shortName}`;
  const modelId = seedIssue ? `${projectRepo}/${seedIssue.idReadable}` : projectRepo;

  const nodes = new Map<NodeKey, GraphNode>();
  const keysById = new Map<string, NodeKey>();
  const stateByKey = new Map<NodeKey, { label: string; type: string }>();
  const placeholders = new Set<NodeKey>();
  const seedKeys: NodeKey[] = [];
  const keyFor = (id: string, issueProject = project.shortName) =>
    `${identity}/${encodeURIComponent(issueProject)}#${encodeURIComponent(id)}`;
  const addIssue = (
    issue: Issue,
    fetched: boolean,
    fallbackNumber: number,
    depth = fetched ? 0 : 1,
  ) => {
    const key = keyFor(issue.id, issue.project?.shortName ?? project.shortName);
    const resolved = issue.resolved === null || typeof issue.resolved === "number";
    const stateLabel =
      issue.customFields?.find((field) => field.name?.toLowerCase() === "state")?.value?.name ??
      (issue.resolved === null
        ? "Unresolved"
        : typeof issue.resolved === "number"
          ? "Resolved"
          : "Unknown");
    const stateType =
      issue.resolved === null
        ? "unresolved"
        : typeof issue.resolved === "number"
          ? "resolved"
          : "unknown";
    const existing = nodes.get(key);
    if (existing) {
      if (fetched) {
        existing.title = issue.summary || issue.idReadable;
        existing.state = resolved ? (issue.resolved === null ? "OPEN" : "CLOSED") : "UNKNOWN";
        existing.depth = depth;
        existing.fetched = true;
        existing.author = issue.reporter?.login;
        placeholders.delete(key);
        stateByKey.set(key, { label: stateLabel, type: stateType });
      }
      keysById.set(issue.id, key);
      return key;
    }
    nodes.set(key, {
      key,
      owner: identity,
      repo: issue.project?.shortName ?? project.shortName,
      number: readableNumber(issue.idReadable, fallbackNumber),
      identifier: issue.idReadable,
      kind: "Issue",
      title: issue.summary || issue.idReadable,
      state: resolved ? (issue.resolved === null ? "OPEN" : "CLOSED") : "UNKNOWN",
      url: `${base.url}/issue/${encodeURIComponent(issue.idReadable)}`,
      depth,
      edges: [],
      externalLinks: [],
      fetched,
      author: issue.reporter?.login,
    });
    stateByKey.set(key, { label: stateLabel, type: stateType });
    if (!fetched) placeholders.add(key);
    keysById.set(issue.id, key);
    return key;
  };

  let ordinal = 0;
  for (const issue of issueById.values()) {
    const key = addIssue(issue, true, ++ordinal);
    seedKeys.push(key);
  }

  const edges = new Set<string>();
  let failedLinkReads = 0;
  let partialLinkReads = 0;
  let unknownDirections = 0;
  const addLink = (fromKey: NodeKey, toKey: NodeKey, link: IssueLink) => {
    if (!link.linkType) {
      failedLinkReads++;
      return;
    }
    const linkType = link.linkType;
    const directed = linkType.directed ?? linkType.sourceToTarget !== linkType.targetToSource;
    let source = fromKey;
    let destination = toKey;
    const direction = link.direction?.toUpperCase();
    const undirected = !directed || direction === "BOTH";
    if (directed && !undirected) {
      if (direction === "INWARD") [source, destination] = [toKey, fromKey];
      else if (direction !== "OUTWARD") {
        unknownDirections++;
        return;
      }
    }
    const via = linkType.sourceToTarget || linkType.name || "connected";
    if (undirected && source > destination) [source, destination] = [destination, source];
    const dedupeKey = `${undirected ? "u" : "d"}:${linkType.id ?? via}:${source}:${destination}`;
    if (edges.has(dedupeKey)) return;
    edges.add(dedupeKey);
    const edge: Edge = { to: destination, via, undirected: undirected || undefined };
    nodes.get(source)?.edges.push(edge);
  };

  let failedIssueReads = 0;
  const truncatedIssues = new Set<string>();
  if (seedIssue) {
    const expanded = new Set<string>();
    let frontier: Array<{ issue: Issue; depth: number }> = [{ issue: seedIssue, depth: 0 }];
    while (frontier.length) {
      const candidates = new Map<string, { issue: Issue; depth: number }>();
      for (const current of frontier) {
        if (expanded.has(current.issue.id)) continue;
        expanded.add(current.issue.id);
        const fromKey = addIssue(current.issue, true, ++ordinal, current.depth);
        const links = current.issue.links;
        if (!Array.isArray(links)) {
          failedLinkReads++;
          continue;
        }
        for (const rawLink of links) {
          if (!record(rawLink) || !record(rawLink.linkType)) {
            failedLinkReads++;
            continue;
          }
          const link = rawLink as unknown as IssueLink & { linkType: LinkType };
          const direction = link.direction?.toUpperCase();
          const linkName = link.linkType.name?.trim().toLowerCase();
          const sourceLabel = link.linkType.sourceToTarget?.trim().toLowerCase();
          const isChildLink =
            direction === "OUTWARD" &&
            (linkName === "subtask" || linkName === "epic" || sourceLabel === "epic for");
          for (const target of Array.isArray(link.issues) ? link.issues : []) {
            if (
              !record(target) ||
              typeof target.id !== "string" ||
              typeof target.idReadable !== "string"
            ) {
              failedLinkReads++;
              continue;
            }
            if (target.id === current.issue.id) continue;
            let toKey = keysById.get(target.id);
            if (!toKey) {
              if (nodes.size >= limit) {
                truncatedIssues.add(target.idReadable);
                continue;
              }
              const resolved = target.resolved;
              const linked: Issue = {
                id: target.id,
                idReadable: target.idReadable,
                summary: typeof target.summary === "string" ? target.summary : target.idReadable,
                resolved:
                  resolved === null || (typeof resolved === "number" && Number.isFinite(resolved))
                    ? resolved
                    : undefined,
                project: target.project,
              };
              toKey = addIssue(linked, false, 0, current.depth + 1);
            }
            addLink(fromKey, toKey, link);
            if (isChildLink && current.depth < maxDepth && !expanded.has(target.id)) {
              const existing = candidates.get(target.id);
              if (!existing || current.depth + 1 < existing.depth) {
                candidates.set(target.id, {
                  issue: {
                    id: target.id,
                    idReadable: target.idReadable,
                    summary:
                      typeof target.summary === "string" ? target.summary : target.idReadable,
                    resolved:
                      target.resolved === null ||
                      (typeof target.resolved === "number" && Number.isFinite(target.resolved))
                        ? target.resolved
                        : undefined,
                    project: target.project,
                  },
                  depth: current.depth + 1,
                });
              }
            }
          }
        }
      }

      const queued = [...candidates.entries()];
      const next: Array<{ issue: Issue; depth: number }> = [];
      for (let start = 0; start < queued.length; start += 8) {
        const results = await Promise.allSettled(
          queued.slice(start, start + 8).map(async ([id, candidate]) => {
            const url = endpoint(`issues/${encodeURIComponent(id)}`);
            url.searchParams.set("fields", FOCUSED_ISSUE_FIELDS);
            const issue = await getJson(url);
            if (!validIssue(issue) || issue.id !== id)
              throw new Error("YouTrack returned an invalid linked issue");
            return { issue, depth: candidate.depth };
          }),
        );
        for (const result of results) {
          if (result.status === "rejected") {
            failedIssueReads++;
            continue;
          }
          issueById.set(result.value.issue.id, result.value.issue);
          addIssue(result.value.issue, true, ++ordinal, result.value.depth);
          next.push(result.value);
        }
      }
      frontier = next;
    }
  } else {
    const issues = [...issueById.values()];
    for (let start = 0; start < issues.length; start += 8) {
      const batch = await Promise.allSettled(
        issues.slice(start, start + 8).map(async (issue) => {
          const fromKey = keysById.get(issue.id);
          if (!fromKey) throw new Error("YouTrack issue identity was lost while collecting links");
          const links = await readCollection<IssueLink>(
            `issues/${encodeURIComponent(issue.id)}/links`,
            LINK_FIELDS,
            "",
            1000,
            false,
          );
          if (!links.complete) partialLinkReads++;
          for (const link of links.items) {
            if (!record(link) || typeof link.id !== "string" || !record(link.linkType))
              throw new Error("YouTrack API returned an invalid issue link");
            const related = await readCollection<LinkedIssue>(
              `issues/${encodeURIComponent(issue.id)}/links/${encodeURIComponent(link.id)}/issues`,
              LINKED_ISSUE_FIELDS,
              "",
              1000,
              false,
            );
            if (!related.complete) partialLinkReads++;
            for (const target of related.items) {
              if (
                !record(target) ||
                typeof target.id !== "string" ||
                typeof target.idReadable !== "string"
              ) {
                throw new Error("YouTrack API returned an invalid linked issue");
              }
              if (target.id === issue.id) continue;
              let toKey = keysById.get(target.id);
              if (!toKey) {
                if (nodes.size >= limit) {
                  truncatedIssues.add(target.idReadable);
                  continue;
                }
                const linked: Issue = {
                  id: target.id,
                  idReadable: target.idReadable,
                  summary: typeof target.summary === "string" ? target.summary : target.idReadable,
                  resolved:
                    target.resolved === null ||
                    (typeof target.resolved === "number" && Number.isFinite(target.resolved))
                      ? target.resolved
                      : undefined,
                  project: target.project,
                };
                toKey = addIssue(linked, false, 0);
              }
              addLink(fromKey, toKey, link);
            }
          }
        }),
      );
      for (const result of batch) if (result.status === "rejected") failedLinkReads++;
    }
  }
  if (failedIssueReads)
    warnings.push(`Linked issue details could not be read for ${failedIssueReads} issues`);
  if (truncatedIssues.size)
    warnings.push(
      `The node limit was reached (${limit}); ${truncatedIssues.size} linked issues were omitted`,
    );
  if (failedLinkReads) warnings.push(`Link data could not be read for ${failedLinkReads} issues`);
  if (partialLinkReads)
    warnings.push(`Link collections were truncated or incomplete: ${partialLinkReads}`);
  if (unknownDirections) warnings.push(`Skipped ${unknownDirections} links with unknown direction`);

  let failedActivityReads = 0;
  let partialActivityReads = 0;
  const partialActivityMessages = new Set<string>();
  const skippedPullRequests = new Set<string>();
  if (seedIssue) {
    const readActivities = async (issueId: string): Promise<Collection<IssueActivity>> => {
      const items: IssueActivity[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      let malformedItems = 0;
      for (let page = 0; page < MAX_ACTIVITY_PAGES; page++) {
        const url = endpoint(`issues/${encodeURIComponent(issueId)}/activitiesPage`);
        url.searchParams.set("categories", ACTIVITY_CATEGORIES);
        url.searchParams.set("reverse", "false");
        url.searchParams.set("$top", String(PAGE_SIZE));
        url.searchParams.set("fields", ACTIVITY_FIELDS);
        if (cursor) url.searchParams.set("cursor", cursor);

        let value: unknown;
        try {
          value = await getJson(url);
        } catch (error) {
          if (page === 0) throw error;
          return { items, complete: false, message: "A later activity page could not be read" };
        }
        if (
          !record(value) ||
          !Array.isArray(value.activities) ||
          typeof value.hasAfter !== "boolean"
        )
          throw new Error("YouTrack API returned an invalid activity page");
        for (const activity of value.activities) {
          if (record(activity) && typeof activity.$type === "string")
            items.push(activity as unknown as IssueActivity);
          else malformedItems++;
        }
        if (!value.hasAfter)
          return {
            items,
            complete: malformedItems === 0,
            ...(malformedItems ? { message: "Malformed activity items were skipped" } : {}),
          };
        if (!value.activities.length)
          return { items, complete: false, message: "An activity page was empty before the end" };
        const nextCursor = value.afterCursor;
        if (typeof nextCursor !== "string" || !nextCursor)
          return { items, complete: false, message: "An activity page had no continuation cursor" };
        if (seenCursors.has(nextCursor))
          return { items, complete: false, message: "An activity page repeated its cursor" };
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
      return { items, complete: false, message: "The activity page limit was reached" };
    };

    const linkedIssues = [...issueById.values()];
    const references: Array<{ issueKey: string; pullRequest: GitHubPullRequest }> = [];
    for (let start = 0; start < linkedIssues.length; start += 8) {
      const results = await Promise.allSettled(
        linkedIssues
          .slice(start, start + 8)
          .map(async (issue) => ({ issue, activities: await readActivities(issue.id) })),
      );
      for (const result of results) {
        if (result.status === "rejected") {
          failedActivityReads++;
          continue;
        }
        const { issue, activities } = result.value;
        if (!activities.complete) {
          partialActivityReads++;
          if (activities.message) partialActivityMessages.add(activities.message);
        }
        const issueKey = keysById.get(issue.id);
        if (!issueKey) continue;
        const pullRequests = new Map<string, GitHubPullRequest>();
        const commits = new Set<string>();
        for (const activity of activities.items) {
          const timestamp =
            typeof activity.timestamp === "number" && Number.isFinite(activity.timestamp)
              ? activity.timestamp
              : 0;
          if (activity.$type === "PullRequestChangeActivityItem") {
            for (const removed of activity.removed ?? []) {
              const pullRequest = githubPullRequest(removed, timestamp);
              if (pullRequest) pullRequests.delete(pullRequest.key);
            }
            for (const added of activity.added ?? []) {
              const pullRequest = githubPullRequest(added, timestamp);
              if (pullRequest) pullRequests.set(pullRequest.key, pullRequest);
            }
          } else if (activity.$type === "VcsChangeActivityItem") {
            for (const removed of activity.removed ?? []) {
              if (!record(removed) || !Array.isArray(removed.urls)) continue;
              for (const value of removed.urls) {
                const url = githubCommitUrl(value);
                if (url) commits.delete(url);
              }
            }
            for (const added of activity.added ?? []) {
              if (!record(added) || !Array.isArray(added.urls)) continue;
              for (const value of added.urls) {
                const url = githubCommitUrl(value);
                if (url) commits.add(url);
              }
            }
          }
        }
        const issueNode = nodes.get(issueKey);
        if (issueNode)
          issueNode.externalLinks = [...new Set([...issueNode.externalLinks, ...commits])];
        for (const pullRequest of pullRequests.values()) references.push({ issueKey, pullRequest });
      }
    }
    const latestTimestamp = new Map<string, number>();
    const prEdges = new Set<string>();
    references.sort((a, b) => a.pullRequest.timestamp - b.pullRequest.timestamp);
    for (const { issueKey, pullRequest } of references) {
      const { key, owner, repo, number, title, url, state, timestamp } = pullRequest;
      let node = nodes.get(key);
      if (!node) {
        if (nodes.size >= limit) {
          skippedPullRequests.add(key);
          continue;
        }
        node = {
          key,
          owner,
          repo,
          number,
          identifier: `${owner}/${repo}#${number}`,
          kind: "PullRequest",
          title,
          state: pullRequestState(state),
          url,
          depth: (nodes.get(issueKey)?.depth ?? 0) + 1,
          edges: [],
          externalLinks: [],
          fetched: true,
        };
        nodes.set(key, node);
        latestTimestamp.set(key, timestamp);
        stateByKey.set(key, { label: state.toLowerCase(), type: state.toLowerCase() });
      } else if (timestamp >= (latestTimestamp.get(key) ?? -1)) {
        node.title = title;
        node.url = url;
        node.state = pullRequestState(state);
        latestTimestamp.set(key, timestamp);
        stateByKey.set(key, { label: state.toLowerCase(), type: state.toLowerCase() });
      }
      const edgeKey = `${issueKey}->${key}`;
      if (!prEdges.has(edgeKey)) {
        prEdges.add(edgeKey);
        nodes.get(issueKey)?.edges.push({ to: key, via: "pull request" });
      }
    }
    if (failedActivityReads)
      warnings.push(
        `PR and commit history could not be read for ${failedActivityReads} issues; check YouTrack activity visibility access`,
      );
    if (partialActivityReads)
      warnings.push(
        `Activity history was incomplete for ${partialActivityReads} issues${
          partialActivityMessages.size ? `: ${[...partialActivityMessages].join("; ")}` : ""
        }`,
      );
    if (skippedPullRequests.size)
      warnings.push(
        `The node limit was reached (${limit}); ${skippedPullRequests.size} GitHub pull requests were omitted`,
      );
  }

  const projectUrl = `${base.url}/projects/${encodeURIComponent(project.shortName)}`;
  const provider: ProviderDescriptor = {
    ...YOUTRACK_PROVIDER,
    repoUrl: `${base.url}/projects/{repo}`,
  };
  const model = dashboardModel(nodes, seedKeys, projectRepo, undefined, 0, provider);
  model.id = modelId;
  model.label = seedIssue
    ? `${seedIssue.idReadable} · ${seedIssue.summary}`
    : `${project.shortName} · YouTrack`;
  model.url = seedIssue
    ? `${base.url}/issue/${encodeURIComponent(seedIssue.idReadable)}`
    : projectUrl;
  if (seedIssue && model.groups.length === 1) {
    model.groups[0].label = `${seedIssue.idReadable} · issue hierarchy graph`;
    model.groups[0].subtitle = `${issueById.size} expanded issues through depth ${maxDepth}`;
  }
  for (const node of Object.values(model.nodes)) delete node.heat;
  for (const [key, stateInfo] of stateByKey) {
    const node = model.nodes[key];
    if (node) {
      node.stateLabel = stateInfo.label;
      node.stateType = stateInfo.type;
    }
  }
  for (const key of placeholders) {
    const node = model.nodes[key];
    if (node)
      node.read = { fetched: false, error: "Only linked issue metadata was read", coverage: [] };
  }
  if (unknownDirections) warnings.push("Some links may be missing from the graph");
  model.coverage = {
    complete: warnings.length === 0,
    generatedAt: new Date().toISOString(),
    maxDepth: seedIssue ? maxDepth : 1,
    messages: warnings,
    ...(warnings.length ? { warnings } : {}),
  };
  return model;
}
