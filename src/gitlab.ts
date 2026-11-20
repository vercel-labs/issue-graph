import { components, crawlGraph } from "./crawl.js";
import type { GraphCrawlOptions } from "./types.js";
import {
  renderWorkMarkdown,
  validateWorkLimits,
  type WorkCoverage,
  workCoverage,
} from "./work-report.js";
import type { ReadCoverage, WorkEdge, WorkNode } from "./work-types.js";

const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/;
const SEGMENT = /^[A-Za-z0-9_][\w.-]*$/;
const REFERENCE = /^(.*?)([#!])([1-9]\d*)$/;
const ITEM_PATH =
  /^\/(groups\/)?(.+?)\/-\/(issues(?:\/incident)?|work_items|merge_requests)\/([1-9]\d*)(?:\/.*)?$/;
const MENTION = /^mentioned in ([a-z ]+?) ((?:[\w.-]+(?:\/[\w.-]+)*)?[#!][1-9]\d*)$/;
const PER_PAGE = 100;
const MAX_PAGES = 10;

export type GitLabItemKind = "issue" | "merge_request";

/** One issue or merge request. `group` marks a group-level work item, such as an epic. */
export interface GitLabItem {
  path: string;
  kind: GitLabItemKind;
  iid: number;
  group?: boolean;
}

export interface GitLabLocator extends GitLabItem {
  host?: string;
}

function validPath(path: string): boolean {
  const segments = path.split("/");
  return segments.length >= 2 && segments.every((segment) => SEGMENT.test(segment));
}

/**
 * A GitLab host name with an optional port, as a bare host or a bare https origin. The default
 * port 443 is dropped and an invalid port is rejected.
 */
export function parseGitLabHost(input: string): string {
  const value = input.trim().toLowerCase();
  let host: string | undefined;
  try {
    const url = new URL(value.startsWith("https://") ? value : `https://${value}`);
    const bare = value.replace(/^https:\/\//, "");
    if (
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password &&
      url.port !== "0" &&
      !bare.endsWith(":")
    )
      host = url.host;
  } catch {}
  if (!host || !HOST.test(host))
    throw new Error(
      "Invalid GitLab host: use a host name such as gitlab.com, with an optional port",
    );
  return host;
}

/** An https issue, work item, or merge request URL; undefined for anything else. */
export function parseGitLabUrl(input: string): (GitLabItem & { host: string }) | undefined {
  try {
    const url = new URL(input);
    const match = url.pathname.match(ITEM_PATH);
    if (url.protocol !== "https:" || url.username || url.password || !match) return undefined;
    const [, group, path, route, iid] = match;
    const host = url.host.toLowerCase();
    if (!HOST.test(host) || (!validPath(path) && !(group && SEGMENT.test(path)))) return undefined;
    if (group && route !== "work_items") return undefined;
    return {
      host,
      path,
      kind: route === "merge_requests" ? "merge_request" : "issue",
      iid: Number(iid),
      ...(group ? { group: true } : {}),
    };
  } catch {
    return undefined;
  }
}

/** An item URL, or a full reference such as `group/project#12` or `group/project!12`. */
export function parseGitLabLocator(input: string): GitLabLocator {
  const fromUrl = parseGitLabUrl(input);
  if (fromUrl && !fromUrl.group) return fromUrl;
  const match = input.match(REFERENCE);
  if (!fromUrl && match && validPath(match[1]))
    return {
      path: match[1],
      kind: match[2] === "!" ? "merge_request" : "issue",
      iid: Number(match[3]),
    };
  throw new Error(
    "Expected a GitLab issue or merge request URL, or a reference such as group/project#12 or group/project!12",
  );
}

/**
 * Resolves a reference as GitLab prints it in a system note on an item in `from`: `#12` is in the
 * same project, `project#12` in the same namespace, and `group/project#12` is a full path.
 */
export function resolveGitLabReference(reference: string, from: string): GitLabItem | undefined {
  const match = reference.match(REFERENCE);
  if (!match) return undefined;
  const [, prefix, sigil, iid] = match;
  const path = !prefix
    ? from
    : prefix.includes("/")
      ? prefix
      : `${from.slice(0, from.lastIndexOf("/"))}/${prefix}`;
  if (!validPath(path)) return undefined;
  return { path, kind: sigil === "!" ? "merge_request" : "issue", iid: Number(iid) };
}

/** Node keys are host-scoped and case-insensitive, with GitLab's `#` for issues and `!` for MRs. */
export function gitlabNodeKey(host: string, item: GitLabItem): string {
  const path = `${item.group ? "groups/" : ""}${item.path.toLowerCase()}`;
  return `gitlab:${host}:${path}${item.kind === "merge_request" ? "!" : "#"}${item.iid}`;
}

export function gitlabReference(item: GitLabItem): string {
  return `${item.path}${item.kind === "merge_request" ? "!" : "#"}${item.iid}`;
}

function itemUrl(host: string, item: GitLabItem): string {
  const route = item.kind === "merge_request" ? "merge_requests" : "issues";
  return `https://${host}/${item.group ? "groups/" : ""}${item.path}/-/${item.group ? "work_items" : route}/${item.iid}`;
}

export interface GitLabReader {
  /** How the data was read, recorded as the report's source. */
  label?: string;
  /** One REST API v4 GET, such as `projects/group%2Fproject/issues/12`, returning the JSON body. */
  get(path: string): Promise<unknown>;
}

export class GitLabReadError extends Error {
  constructor(
    readonly code: string,
    detail?: string,
  ) {
    super(detail ? `GitLab read failed (${code}): ${detail}` : `GitLab read failed (${code})`);
    this.name = "GitLabReadError";
  }
}

export interface GitLabNode extends WorkNode {
  provider: "gitlab";
  projectPath: string;
  draft?: boolean;
}

export interface GitLabGraphOptions extends Omit<GraphCrawlOptions, "depthForEdge" | "expand"> {
  host?: string;
  generatedAt?: string;
}

export interface GitLabReport {
  schemaVersion: 1;
  source: "gitlab";
  generatedAt: string;
  host: string;
  readSource?: string;
  seeds: string[];
  scope: {
    relationships: readonly string[];
    crossProject: "one-hop";
    mentions: "system-notes-incoming";
    groupWorkItems: "listed-not-read";
  };
  limits: Required<Omit<GitLabGraphOptions, "host" | "generatedAt">>;
  coverageComplete: boolean;
  coverage: WorkCoverage & {
    /** Group-level work items that are linked but not read. */
    groupWorkItems: string[];
  };
  nodes: GitLabNode[];
  components: string[][];
}

type RecordValue = Record<string, unknown>;

function object(value: unknown): RecordValue {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as RecordValue;
  throw new GitLabReadError("INVALID_PAYLOAD");
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new GitLabReadError("INVALID_PAYLOAD");
  return value;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new GitLabReadError("INVALID_PAYLOAD");
  return value;
}

function api(item: GitLabItem, suffix = ""): string {
  const route = item.kind === "merge_request" ? "merge_requests" : "issues";
  return `projects/${encodeURIComponent(item.path)}/${route}/${item.iid}${suffix}`;
}

/**
 * The item a payload's `web_url` names, when it is on `host`. Issues from an external tracker,
 * which `closes_issues` can return, have no `web_url`.
 */
function linked(value: unknown, host: string): GitLabItem | undefined {
  const url = object(value).web_url;
  const parsed = typeof url === "string" ? parseGitLabUrl(url) : undefined;
  if (!parsed || parsed.host !== host) return undefined;
  const { host: _, ...item } = parsed;
  return item;
}

interface Listing {
  items: unknown[];
  coverage?: ReadCoverage;
}

/**
 * Reads up to MAX_PAGES pages; a failed or capped listing becomes incomplete coverage. After
 * MAX_PAGES full pages one more page probes for items, so a listing that ends exactly at the cap is
 * complete.
 */
async function list(
  reader: GitLabReader,
  path: string,
  source: string,
  paged: boolean,
): Promise<Listing> {
  const items: unknown[] = [];
  for (let page = 1; page <= (paged ? MAX_PAGES : 1); page++) {
    let body: unknown[];
    try {
      body = array(await reader.get(paged ? `${path}?per_page=${PER_PAGE}&page=${page}` : path));
    } catch {
      return { items, coverage: { source, pages: page, complete: false, reason: "read-failed" } };
    }
    items.push(...body);
    if (!paged || body.length < PER_PAGE) return { items };
  }
  let probe: unknown[];
  try {
    probe = array(await reader.get(`${path}?per_page=${PER_PAGE}&page=${MAX_PAGES + 1}`));
  } catch {
    return {
      items,
      coverage: { source, pages: MAX_PAGES + 1, complete: false, reason: "read-failed" },
    };
  }
  if (!probe.length) return { items };
  return { items, coverage: { source, pages: MAX_PAGES, complete: false, reason: "page-limit" } };
}

/** `is_blocked_by` is the far end of a `blocks` link, so both ends share one native relation. */
const LINK_RELATIONS: Record<
  string,
  Pick<WorkEdge, "relation" | "direction" | "nativeRelation">
> = {
  relates_to: { relation: "related", direction: "undirected", nativeRelation: "relates_to" },
  blocks: { relation: "blocks", direction: "outgoing", nativeRelation: "blocks" },
  is_blocked_by: { relation: "blocks", direction: "incoming", nativeRelation: "blocks" },
};

interface Read {
  node: GitLabNode;
  host: string;
  targets: Map<string, GitLabItem>;
}

/**
 * Reads one item and its edges. `host` is the instance host; for the seed it may be unknown, and
 * the item's `web_url` names it.
 */
async function readItem(
  reader: GitLabReader,
  item: GitLabItem,
  depth: number,
  host: string | undefined,
): Promise<Read> {
  const body = object(await reader.get(api(item)));
  const reported = parseGitLabUrl(text(body.web_url));
  if (
    !reported ||
    reported.group ||
    reported.kind !== item.kind ||
    reported.iid !== item.iid ||
    reported.path.toLowerCase() !== item.path.toLowerCase()
  )
    throw new GitLabReadError("IDENTITY_MISMATCH");
  if (host && reported.host !== host)
    throw new GitLabReadError("HOST_MISMATCH", `${gitlabReference(item)} is on ${reported.host}`);
  const instance = reported.host;
  const self: GitLabItem = { path: reported.path, kind: item.kind, iid: item.iid };
  const key = gitlabNodeKey(instance, self);
  const issue = item.kind === "issue";
  const [links, closing, notes] = await Promise.all([
    issue
      ? list(reader, api(item, "/links"), "issue links", false)
      : Promise.resolve<Listing>({ items: [] }),
    list(
      reader,
      api(item, issue ? "/closed_by" : "/closes_issues"),
      issue ? "closing merge requests" : "closed issues",
      true,
    ),
    list(reader, api(item, "/notes"), "system notes", true),
  ]);
  const targets = new Map<string, GitLabItem>();
  const edges = new Map<string, WorkEdge>();
  const add = (target: GitLabItem, edge: Omit<WorkEdge, "to">) => {
    const to = gitlabNodeKey(instance, target);
    if (to === key) return;
    targets.set(to, target);
    edges.set(`${to}\0${edge.nativeRelation}\0${edge.evidence.id}`, { to, ...edge });
  };
  for (const value of links.items) {
    const link = object(value);
    const target = linked(link, instance);
    const type = text(link.link_type);
    if (!target) continue;
    add(target, {
      ...(LINK_RELATIONS[type] ?? {
        relation: "provider_specific",
        direction: "outgoing",
        nativeRelation: type,
      }),
      evidence: { kind: "relation", id: `link:${String(link.issue_link_id ?? link.id)}` },
    });
  }
  for (const value of closing.items) {
    const target = linked(value, instance);
    if (!target) continue;
    const [mr, closed] = issue ? [target, self] : [self, target];
    add(target, {
      relation: "provider_specific",
      direction: issue ? "incoming" : "outgoing",
      nativeRelation: "closes",
      evidence: {
        kind: "relation",
        id: `closes:${gitlabReference(mr).toLowerCase()}:${gitlabReference(closed).toLowerCase()}`,
      },
    });
  }
  for (const value of notes.items) {
    const note = object(value);
    if (note.system !== true || typeof note.body !== "string") continue;
    const match = note.body.trim().match(MENTION);
    // An epic is a group-level work item, which the project API can't read.
    const target =
      match && match[1] !== "epic" ? resolveGitLabReference(match[2], self.path) : undefined;
    if (!target) continue;
    add(target, {
      relation: "provider_specific",
      direction: "incoming",
      nativeRelation: "mentions",
      evidence: { kind: "relation", id: `note:${String(note.id)}` },
    });
  }
  const state = text(body.state);
  return {
    host: instance,
    targets,
    node: {
      key,
      provider: "gitlab",
      authority: instance,
      nativeId: String(body.id ?? key),
      kind: issue ? "issue" : "pull-request",
      identifier: gitlabReference(self),
      projectPath: self.path,
      title: text(body.title),
      url: text(body.web_url),
      state: { name: state, type: state },
      ...(issue ? {} : { draft: body.draft === true }),
      updatedAt: typeof body.updated_at === "string" ? body.updated_at : "",
      archived: false,
      fetched: true,
      depth,
      edges: [...edges.keys()].sort().map((identity) => edges.get(identity) as WorkEdge),
      externalLinks: [],
      coverage: [links.coverage, closing.coverage, notes.coverage].filter(
        (part): part is ReadCoverage => part !== undefined,
      ),
    },
  };
}

function unavailable(host: string, item: GitLabItem, depth: number, error: unknown): GitLabNode {
  return {
    key: gitlabNodeKey(host, item),
    provider: "gitlab",
    authority: host,
    nativeId: gitlabReference(item),
    kind: item.kind === "merge_request" ? "pull-request" : "issue",
    identifier: gitlabReference(item),
    projectPath: item.path,
    title: "Unavailable",
    url: itemUrl(host, item),
    state: { name: "unknown", type: "unknown" },
    updatedAt: "",
    archived: false,
    fetched: false,
    error:
      error instanceof GitLabReadError && /^[A-Z0-9_]{1,64}$/.test(error.code)
        ? error.code
        : "READ_FAILED",
    depth,
    edges: [],
    externalLinks: [],
    coverage: [],
  };
}

/**
 * Reads a bounded GitLab neighborhood of issues and merge requests. Same-project references
 * recurse to `maxDepth`; references into other projects are read one hop and not expanded.
 */
export async function buildGitLabGraph(
  reader: GitLabReader,
  seed: string,
  options: GitLabGraphOptions,
): Promise<GitLabReport> {
  validateWorkLimits(options, 16);
  const locator = parseGitLabLocator(seed);
  const requested = options.host ? parseGitLabHost(options.host) : undefined;
  if (locator.host && requested && locator.host !== requested)
    throw new Error("GitLab URL and --host disagree");
  const { host: given, ...seedItem } = locator;
  const first = await readItem(reader, seedItem, 0, given ?? requested);
  const host = first.host;
  const limits = {
    maxDepth: options.maxDepth,
    maxNodes: options.maxNodes,
    hubThreshold: options.hubThreshold,
    concurrency: options.concurrency ?? 4,
  };
  const known = new Map<string, GitLabItem>(first.targets);
  const seedProject = first.node.projectPath.toLowerCase();
  const sameProject = (key: string) =>
    known.get(key)?.path.toLowerCase() === seedProject || key === first.node.key;
  const isGroupItem = (key: string) => known.get(key)?.group === true;
  const { nodes, cappedOut } = await crawlGraph<GitLabNode>(
    [{ key: first.node.key }],
    {
      ...limits,
      expand: sameProject,
      depthForEdge: ({ edge, sourceDepth }) => (isGroupItem(edge.to) ? null : sourceDepth + 1),
    },
    async (key, depth) => {
      if (key === first.node.key) return first.node;
      const item = known.get(key) as GitLabItem;
      try {
        const read = await readItem(reader, item, depth, host);
        for (const [target, value] of read.targets)
          if (!known.has(target)) known.set(target, value);
        return read.node;
      } catch (error) {
        return unavailable(host, item, depth, error);
      }
    },
  );
  const values = [...nodes.values()];
  const targets = values.flatMap((node) => node.edges.map((edge) => edge.to));
  const groupWorkItems = [...new Set(targets.filter(isGroupItem))].sort();
  const { coverage: base, coverageComplete } = workCoverage(
    nodes,
    cappedOut,
    (node) =>
      (node.depth === limits.maxDepth || !sameProject(node.key)) &&
      node.edges.some((edge) => !nodes.has(edge.to) && !isGroupItem(edge.to)),
  );
  const coverage = { ...base, groupWorkItems };
  return {
    schemaVersion: 1,
    source: "gitlab",
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    host,
    ...(reader.label ? { readSource: reader.label } : {}),
    seeds: [first.node.key],
    scope: {
      relationships: ["issue links", "closing merge requests", "system note mentions"],
      crossProject: "one-hop",
      mentions: "system-notes-incoming",
      groupWorkItems: "listed-not-read",
    },
    limits,
    coverageComplete,
    coverage,
    nodes: values,
    components: components(nodes),
  };
}

export function renderGitLab(report: GitLabReport): string {
  return renderWorkMarkdown(report, {
    title: `GitLab graph · ${report.host}`,
    scope:
      "Issue links, closing merge requests, and mentions from system notes. References into other projects are read one hop. Group-level work items are listed but not read.",
    status: (node) => (node.draft ? " · draft" : ""),
    footer: report.coverage.groupWorkItems.length
      ? [`Group work items: ${report.coverage.groupWorkItems.length} linked, not read.`]
      : [],
  });
}
