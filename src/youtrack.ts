import { components, crawlGraph } from "./crawl.js";
import type { GraphCrawlOptions } from "./types.js";
import {
  hasUnreadEdges,
  markdownText,
  renderWorkMarkdown,
  validateWorkLimits,
  type WorkCoverage,
  workCoverage,
} from "./work-report.js";
import type { ReadCoverage, WorkEdge, WorkLink, WorkNode } from "./work-types.js";

const ISSUE_ID = /^([A-Za-z][A-Za-z0-9_]*)-([1-9]\d*)$/;
const CODE = /^[A-Z0-9_]{1,64}$/;

/** Entries per page for every offset-paginated list. */
export const YOUTRACK_PAGE_SIZE = 100;

export const YOUTRACK_ISSUE_FIELDS =
  "id,idReadable,summary,resolved,updated,project(shortName),customFields(name,value(name,isResolved))";
export const YOUTRACK_LINK_FIELDS =
  "id,direction,linkType(id,name,sourceToTarget,targetToSource,directed),issues(id)";
export const YOUTRACK_LINKED_ISSUE_FIELDS = "id,idReadable";
export const YOUTRACK_PULL_REQUEST_FIELDS =
  "activities(id,timestamp,added(id,state(id),pullRequest(url,title)),removed(id,pullRequest(url,title))),hasAfter,afterCursor";
export const YOUTRACK_COMMIT_FIELDS =
  "activities(id,timestamp,added(id,urls,version),removed(id,urls,version)),hasAfter,afterCursor";
export const YOUTRACK_PULL_REQUEST_CATEGORY = "PullRequestChangeCategory";
export const YOUTRACK_COMMIT_CATEGORY = "VcsChangeCategory";

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i;

/**
 * Normalizes a YouTrack base URL: absolute https (http only for loopback hosts, because the
 * token is sent in every request), no credentials, query, or fragment. A path prefix such as
 * `/youtrack` is kept and a trailing slash is dropped.
 */
export function parseYouTrackBase(input: string): string {
  try {
    const url = new URL(input.trim());
    if (
      (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.test(url.hostname))) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !input.includes("?") &&
      !input.includes("#")
    )
      return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {}
  throw new Error(
    "Invalid YouTrack URL: use an absolute https base URL (http only for localhost) without credentials, query, or fragment",
  );
}

/** The authority of a base URL: its host and path prefix, such as `acme.youtrack.cloud`. */
export function youTrackAuthority(base: string): string {
  const url = new URL(base);
  return `${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

export interface YouTrackLocator {
  id: string;
  baseUrl?: string;
}

/** An issue ID (`ABC-123`) or an issue URL (`<base>/issue/ABC-123`), which names the base URL. */
export function parseYouTrackLocator(input: string): YouTrackLocator {
  if (ISSUE_ID.test(input)) return { id: input };
  try {
    const url = new URL(input);
    const match = url.pathname.match(/^(.*?)\/issue\/([^/]+)(?:\/[^/]*)?\/?$/);
    if (!url.username && !url.password && match && ISSUE_ID.test(match[2]))
      return { id: match[2], baseUrl: parseYouTrackBase(`${url.origin}${match[1]}`) };
  } catch {}
  throw new Error("Expected a YouTrack issue ID (ABC-123) or a <base-url>/issue/ABC-123 URL");
}

export function youTrackNodeKey(authority: string, id: string): string {
  return `youtrack:${authority}:${id}`;
}

export interface YouTrackReader {
  /** How the data was read, recorded as the report's source. */
  label?: string;
  /** The normalized base URL every read is made against. */
  baseUrl: string;
  /** One GET of `<base>/api/<path>` with these query parameters; resolves to the parsed JSON. */
  get(path: string, query?: Record<string, string>): Promise<unknown>;
}

export class YouTrackReadError extends Error {
  constructor(
    readonly code: string,
    detail?: string,
  ) {
    super(detail ? `YouTrack read failed (${code}): ${detail}` : `YouTrack read failed (${code})`);
    this.name = "YouTrackReadError";
  }
}

export interface YouTrackNode extends WorkNode {
  provider: "youtrack";
  projectKey: string;
}

export interface YouTrackGraphOptions extends Omit<GraphCrawlOptions, "depthForEdge" | "expand"> {
  /** Pages read per list per issue, 1..100 (default 5). */
  maxPages?: number;
  generatedAt?: string;
}

export interface YouTrackReport {
  schemaVersion: 1;
  source: "youtrack";
  generatedAt: string;
  authority: string;
  baseUrl: string;
  readSource?: string;
  seeds: string[];
  scope: {
    relationships: readonly string[];
    crossProject: "one-hop";
    externalLinks: "reported-not-fetched";
    textReferences: "not-collected";
  };
  limits: Required<Omit<YouTrackGraphOptions, "generatedAt">>;
  coverageComplete: boolean;
  coverage: WorkCoverage;
  nodes: YouTrackNode[];
  components: string[][];
}

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function object(value: unknown): RecordValue {
  const found = record(value);
  if (!found) throw new YouTrackReadError("INVALID_PAYLOAD");
  return found;
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new YouTrackReadError("INVALID_PAYLOAD");
  return value;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function projectOf(id: string): string {
  return id.slice(0, id.lastIndexOf("-"));
}

function httpUrl(value: unknown): string | undefined {
  try {
    const url = new URL(text(value));
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password)
      return url.href;
  } catch {}
  return undefined;
}

interface PagedList {
  items: unknown[];
  coverage: ReadCoverage;
}

/** Reads `$top`/`$skip` pages until a short page, the page cap, or a failure. Never throws. */
async function offsetPages(
  reader: YouTrackReader,
  source: string,
  path: string,
  fields: string,
  maxPages: number,
): Promise<PagedList> {
  const items: unknown[] = [];
  const known = new Set<string>();
  let repeated = false;
  const coverage: ReadCoverage = { source, pages: 0, complete: false };
  for (let page = 0; page < maxPages; page++) {
    let rows: unknown;
    try {
      rows = await reader.get(path, {
        fields,
        $top: String(YOUTRACK_PAGE_SIZE),
        $skip: String(page * YOUTRACK_PAGE_SIZE),
      });
    } catch {
      coverage.reason = "read-failed";
      return { items, coverage };
    }
    if (!Array.isArray(rows) || rows.length > YOUTRACK_PAGE_SIZE) {
      coverage.reason = "invalid-page";
      return { items, coverage };
    }
    for (const row of rows) {
      const id = optionalText(record(row)?.id);
      // Offsets shift when the list changes between pages, so a repeated entry means a gap too.
      if (id && known.has(id)) {
        repeated = true;
        continue;
      }
      if (id) known.add(id);
      items.push(row);
    }
    coverage.pages++;
    if (rows.length < YOUTRACK_PAGE_SIZE) {
      coverage.complete = !repeated;
      if (repeated) coverage.reason = "changed-during-read";
      return { items, coverage };
    }
  }
  coverage.reason = repeated ? "changed-during-read" : "page-limit";
  return { items, coverage };
}

/** Folds several lists into one coverage entry: complete only if all were, first reason wins. */
function mergeCoverage(source: string, parts: ReadCoverage[]): ReadCoverage {
  const failed = parts.find((part) => !part.complete);
  return {
    source,
    pages: parts.reduce((sum, part) => sum + part.pages, 0),
    complete: !failed,
    ...(failed?.reason ? { reason: failed.reason } : {}),
  };
}

interface Relation {
  relation: WorkEdge["relation"];
  /** Direction of the stored edge for an OUTWARD link: the type's outward phrase read from this issue. */
  outward: "outgoing" | "incoming";
}

/**
 * Maps the predefined link types by name. Outward names are "is required for" (Depend),
 * "is duplicated by" (Duplicate) and "parent for" (Subtask), so an OUTWARD Duplicate link says
 * the target duplicates this issue. A type is mapped only when its `directed` flag matches.
 */
function relationOf(name: string, directed: boolean): Relation | undefined {
  if (!directed)
    return name === "Relates" ? { relation: "related", outward: "outgoing" } : undefined;
  if (name === "Depend") return { relation: "blocks", outward: "outgoing" };
  if (name === "Duplicate") return { relation: "duplicate_of", outward: "incoming" };
  if (name === "Subtask") return { relation: "parent_of", outward: "outgoing" };
  return undefined;
}

interface Linked {
  id: string;
  link: RecordValue;
}

async function readLinks(
  reader: YouTrackReader,
  databaseId: string,
  maxPages: number,
): Promise<{ linked: Linked[]; coverage: ReadCoverage[] }> {
  const base = `issues/${encodeURIComponent(databaseId)}/links`;
  const list = await offsetPages(reader, "issue links", base, YOUTRACK_LINK_FIELDS, maxPages);
  const coverage = [list.coverage];
  const linked: Linked[] = [];
  const targets: ReadCoverage[] = [];
  let invalid = false;
  for (const value of list.items) {
    const link = record(value);
    const id = optionalText(link?.id);
    const type = record(link?.linkType);
    if (!link || !id || !optionalText(type?.name) || typeof type?.directed !== "boolean") {
      invalid = true;
      continue;
    }
    // The nested list only tells whether a link has targets; the paged resource is complete.
    if (!Array.isArray(link.issues)) {
      invalid = true;
      continue;
    }
    if (!link.issues.length) continue;
    const page = await offsetPages(
      reader,
      "linked issues",
      `${base}/${encodeURIComponent(id)}/issues`,
      YOUTRACK_LINKED_ISSUE_FIELDS,
      maxPages,
    );
    targets.push(page.coverage);
    for (const target of page.items) {
      const found = record(target);
      const readable = optionalText(found?.idReadable);
      if (!readable || !ISSUE_ID.test(readable) || !optionalText(found?.id)) {
        invalid = true;
        continue;
      }
      linked.push({ id: readable, link });
    }
  }
  if (targets.length) coverage.push(mergeCoverage("linked issues", targets));
  if (invalid)
    coverage.push({ source: "link entries", pages: 0, complete: false, reason: "invalid-page" });
  return { linked, coverage };
}

interface Reference {
  url: string;
  title: string;
}

interface ActivityKind {
  source: string;
  category: string;
  fields: string;
  /** The URLs one added or removed change refers to. */
  references(change: RecordValue): Reference[];
}

const PULL_REQUESTS: ActivityKind = {
  source: "pull requests",
  category: YOUTRACK_PULL_REQUEST_CATEGORY,
  fields: YOUTRACK_PULL_REQUEST_FIELDS,
  references(change) {
    const pull = record(change.pullRequest);
    const url = httpUrl(pull?.url);
    if (!url) return [];
    const title = optionalText(pull?.title) ?? url;
    const state = optionalText(record(change.state)?.id);
    return [{ url, title: state ? `${title} (${state.toLowerCase()})` : title }];
  },
};

const COMMITS: ActivityKind = {
  source: "commits",
  category: YOUTRACK_COMMIT_CATEGORY,
  fields: YOUTRACK_COMMIT_FIELDS,
  references(change) {
    const version = optionalText(change.version)?.slice(0, 7);
    return (Array.isArray(change.urls) ? change.urls : []).flatMap((value) => {
      const url = httpUrl(value);
      return url ? [{ url, title: version ? `Commit ${version}` : url }] : [];
    });
  },
};

/**
 * Net URLs of an issue from its activity stream, oldest first. Each change is tracked by its id,
 * a removal drops only the change it names, and a URL shows the latest surviving change. A
 * removal that names no known change, or an entry that is not an object, marks the list partial.
 */
async function readActivityLinks(
  reader: YouTrackReader,
  databaseId: string,
  maxPages: number,
  kind: ActivityKind,
): Promise<{ links: WorkLink[]; coverage: ReadCoverage }> {
  const coverage: ReadCoverage = { source: kind.source, pages: 0, complete: false };
  const changes = new Map<string, Reference[]>();
  const seen = new Set<string>();
  let problem = false;
  let cursor: string | undefined;
  const result = () => {
    const titles = new Map<string, string>();
    for (const references of changes.values())
      for (const { url, title } of references) titles.set(url, title);
    return {
      links: [...titles].map(([url, title]) => ({
        url,
        title,
        evidence: { kind: "remote-link" as const, id: url },
      })),
      coverage,
    };
  };
  const fail = (reason: NonNullable<ReadCoverage["reason"]>) => {
    coverage.reason = reason;
    return result();
  };
  for (let page = 0; page < maxPages; page++) {
    let value: unknown;
    try {
      value = await reader.get(`issues/${encodeURIComponent(databaseId)}/activitiesPage`, {
        categories: kind.category,
        reverse: "false",
        $top: String(YOUTRACK_PAGE_SIZE),
        fields: kind.fields,
        ...(cursor ? { cursor } : {}),
      });
    } catch {
      return fail("read-failed");
    }
    const body = record(value);
    if (!body || !Array.isArray(body.activities) || typeof body.hasAfter !== "boolean")
      return fail("invalid-page");
    coverage.pages++;
    const items = body.activities
      .map(record)
      .sort((a, b) => Number(a?.timestamp ?? 0) - Number(b?.timestamp ?? 0));
    for (const activity of items) {
      if (!activity) return fail("invalid-page");
      for (const name of ["removed", "added"] as const) {
        const listed = activity[name];
        if (listed === undefined || listed === null) continue;
        if (!Array.isArray(listed)) return fail("invalid-page");
        listed.forEach((value, index) => {
          const change = record(value);
          if (!change) {
            problem = true;
            return;
          }
          const named = optionalText(change.id);
          if (name === "removed") {
            if (named && changes.has(named)) changes.delete(named);
            else problem = true;
            return;
          }
          const id = named ?? `${optionalText(activity.id) ?? ""}:added:${index}`;
          const references = kind.references(change);
          if (!references.length) return;
          changes.delete(id);
          changes.set(id, references);
        });
      }
    }
    if (!body.hasAfter) {
      coverage.complete = !problem;
      if (problem) coverage.reason = "invalid-page";
      return result();
    }
    const next = optionalText(body.afterCursor);
    if (!next || seen.has(next)) return fail("invalid-page");
    seen.add(next);
    cursor = next;
  }
  return fail("page-limit");
}

function stateOf(fields: unknown, resolved: boolean): { name: string; type: string } {
  let name: string | undefined;
  if (Array.isArray(fields))
    for (const field of fields) {
      const found = record(field);
      if (typeof found?.name !== "string" || found.name.toLowerCase() !== "state") continue;
      const value = Array.isArray(found.value) ? found.value[0] : found.value;
      name = optionalText(record(value)?.name);
      break;
    }
  return { name: name ?? (resolved ? "Resolved" : "Unresolved"), type: resolved ? "done" : "open" };
}

function edgeKey(edge: WorkEdge): string {
  return `${edge.to}\0${edge.relation}\0${edge.direction}\0${edge.nativeRelation}\0${edge.evidence.id}`;
}

interface Context {
  reader: YouTrackReader;
  base: string;
  authority: string;
  maxPages: number;
}

async function readIssue(
  { reader, base, authority, maxPages }: Context,
  requested: string,
  depth: number,
): Promise<YouTrackNode> {
  const issue = object(
    await reader.get(`issues/${encodeURIComponent(requested)}`, { fields: YOUTRACK_ISSUE_FIELDS }),
  );
  const id = text(issue.idReadable);
  if (!ISSUE_ID.test(id) || id.toLowerCase() !== requested.toLowerCase())
    throw new YouTrackReadError("IDENTITY_MISMATCH");
  const databaseId = text(issue.id);
  if (!Object.hasOwn(issue, "resolved")) throw new YouTrackReadError("INVALID_PAYLOAD");
  const resolved = issue.resolved;
  if (resolved !== null && (typeof resolved !== "number" || !Number.isFinite(resolved)))
    throw new YouTrackReadError("INVALID_PAYLOAD");
  const updated = typeof issue.updated === "number" ? new Date(issue.updated) : undefined;

  const [links, pulls, commits] = await Promise.all([
    readLinks(reader, databaseId, maxPages),
    readActivityLinks(reader, databaseId, maxPages, PULL_REQUESTS),
    readActivityLinks(reader, databaseId, maxPages, COMMITS),
  ]);
  const edges = new Map<string, WorkEdge>();
  let unplaced = false;
  for (const { id: target, link } of links.linked) {
    if (target === id) continue;
    const type = object(link.linkType);
    const name = text(type.name);
    const direction = link.direction;
    const directed = type.directed === true;
    const mapped = relationOf(name, directed);
    if (direction !== "OUTWARD" && direction !== "INWARD" && direction !== "BOTH") {
      unplaced = true;
      continue;
    }
    const undirected = !directed || direction === "BOTH";
    const outgoing = (direction === "OUTWARD") === ((mapped?.outward ?? "outgoing") === "outgoing");
    const [source, end] = undirected ? [id, target].sort() : outgoing ? [id, target] : [target, id];
    const relation = undirected
      ? mapped?.relation === "related"
        ? "related"
        : "provider_specific"
      : (mapped?.relation ?? "provider_specific");
    const edge: WorkEdge = {
      to: youTrackNodeKey(authority, target),
      relation,
      direction: undirected ? "undirected" : outgoing ? "outgoing" : "incoming",
      nativeRelation: name,
      evidence: {
        kind: relation === "parent_of" ? "hierarchy" : "relation",
        id: `${optionalText(type.id) ?? name}:${source}>${end}`,
      },
    };
    edges.set(edgeKey(edge), edge);
  }
  const coverage = [...links.coverage, pulls.coverage, commits.coverage];
  if (unplaced)
    coverage.push({ source: "link direction", pages: 0, complete: false, reason: "invalid-page" });
  const project = optionalText(record(issue.project)?.shortName);
  return {
    key: youTrackNodeKey(authority, id),
    provider: "youtrack",
    authority,
    nativeId: databaseId,
    kind: "issue",
    identifier: id,
    projectKey: project ?? projectOf(id),
    title: optionalText(issue.summary) ?? id,
    url: `${base}/issue/${encodeURIComponent(id)}`,
    state: stateOf(issue.customFields, resolved !== null),
    updatedAt: updated && !Number.isNaN(updated.getTime()) ? updated.toISOString() : "",
    archived: false,
    fetched: true,
    depth,
    edges: [...edges.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, edge]) => edge),
    externalLinks: [...pulls.links, ...commits.links],
    coverage,
  };
}

function unavailable(
  { base, authority }: Context,
  id: string,
  depth: number,
  error: unknown,
): YouTrackNode {
  return {
    key: youTrackNodeKey(authority, id),
    provider: "youtrack",
    authority,
    nativeId: id,
    kind: "issue",
    identifier: id,
    projectKey: projectOf(id),
    title: "Unavailable",
    url: `${base}/issue/${encodeURIComponent(id)}`,
    state: { name: "Unknown", type: "unknown" },
    updatedAt: "",
    archived: false,
    fetched: false,
    error: error instanceof YouTrackReadError && CODE.test(error.code) ? error.code : "READ_FAILED",
    depth,
    edges: [],
    externalLinks: [],
    coverage: [],
  };
}

/**
 * Reads a bounded YouTrack neighborhood. Same-project links recurse to `maxDepth`; links into
 * other projects are read one hop and not expanded.
 */
export async function buildYouTrackGraph(
  reader: YouTrackReader,
  seed: string,
  options: YouTrackGraphOptions,
): Promise<YouTrackReport> {
  const maxPages = options.maxPages ?? 5;
  validateWorkLimits(options, 16, [["maxPages", maxPages, 1, 100]]);
  const locator = parseYouTrackLocator(seed);
  const base = parseYouTrackBase(reader.baseUrl);
  if (locator.baseUrl && locator.baseUrl !== base)
    throw new Error("The issue URL and the reader's base URL disagree");
  const authority = youTrackAuthority(base);
  const context: Context = { reader, base, authority, maxPages };
  const first = await readIssue(context, locator.id, 0);
  const limits = {
    maxDepth: options.maxDepth,
    maxNodes: options.maxNodes,
    hubThreshold: options.hubThreshold,
    concurrency: options.concurrency ?? 4,
    maxPages,
  };
  const prefix = `youtrack:${authority}:`;
  const seedProject = projectOf(first.identifier);
  const expandable = (key: string) => projectOf(key.slice(prefix.length)) === seedProject;
  const { nodes, cappedOut } = await crawlGraph<YouTrackNode>(
    [{ key: first.key }],
    {
      ...limits,
      expand: expandable,
      depthForEdge: ({ sourceDepth }) => sourceDepth + 1,
    },
    async (key, depth) => {
      if (key === first.key) return first;
      const target = key.slice(prefix.length);
      try {
        return await readIssue(context, target, depth);
      } catch (error) {
        return unavailable(context, target, depth, error);
      }
    },
  );
  const { coverage, coverageComplete } = workCoverage(
    nodes,
    cappedOut,
    (node) =>
      (node.depth === limits.maxDepth || !expandable(node.key)) && hasUnreadEdges(node, nodes),
  );
  return {
    schemaVersion: 1,
    source: "youtrack",
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    authority,
    baseUrl: base,
    ...(reader.label ? { readSource: reader.label } : {}),
    seeds: [first.key],
    scope: {
      relationships: ["issue links", "pull requests", "commits"],
      crossProject: "one-hop",
      externalLinks: "reported-not-fetched",
      textReferences: "not-collected",
    },
    limits,
    coverageComplete,
    coverage,
    nodes: [...nodes.values()],
    components: components(nodes),
  };
}

export function renderYouTrack(report: YouTrackReport): string {
  return renderWorkMarkdown(report, {
    title: `YouTrack graph · ${report.authority}`,
    scope:
      "Issue links. Links into other projects are read one hop. Linked pull request and commit URLs are reported without fetching their targets. Text mentions are not collected.",
    links: (node) =>
      node.externalLinks.map(
        (link) => `- Remote link: ${markdownText(link.title)} · ${markdownText(link.url)}`,
      ),
  });
}
