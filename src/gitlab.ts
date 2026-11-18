import { components, crawlGraph } from "./crawl.js";
import type { GraphCrawlOptions } from "./types.js";
import type { ReadCoverage, WorkEdge, WorkNode } from "./work-types.js";

const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/;
const SEGMENT = /^[A-Za-z0-9_][\w.-]*$/;
const REFERENCE = /^(.*?)([#!])([1-9]\d*)$/;
const ITEM_PATH =
  /^\/(groups\/)?(.+?)\/-\/(issues(?:\/incident)?|work_items|merge_requests)\/([1-9]\d*)(?:\/.*)?$/;
const MENTION = /^mentioned in [a-z ]+? ((?:[\w.-]+(?:\/[\w.-]+)*)?[#!][1-9]\d*)$/;
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

/** A GitLab host name with an optional port. A bare https origin is reduced to its host. */
export function parseGitLabHost(input: string): string {
  let value = input.trim().toLowerCase();
  if (value.startsWith("https://")) {
    try {
      const url = new URL(value);
      if (url.pathname === "/" && !url.search && !url.username && !url.password) value = url.host;
    } catch {}
  }
  if (!HOST.test(value)) throw new Error("Invalid GitLab host: use a host name such as gitlab.com");
  return value;
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
  coverage: {
    failed: string[];
    partial: string[];
    cappedOut: string[];
    hubs: string[];
    depthBoundaries: string[];
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

/** The item a payload's `web_url` names, when it is on `host`. */
function linked(value: unknown, host: string): GitLabItem | undefined {
  const parsed = parseGitLabUrl(text(object(value).web_url));
  if (!parsed || parsed.host !== host) return undefined;
  const { host: _, ...item } = parsed;
  return item;
}

interface Listing {
  items: unknown[];
  coverage?: ReadCoverage;
}

/** Reads up to MAX_PAGES pages; a failed or capped listing becomes incomplete coverage. */
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
    const target = match ? resolveGitLabReference(match[1], self.path) : undefined;
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

function validateOptions(options: GitLabGraphOptions): void {
  for (const [name, value, minimum, maximum] of [
    ["maxDepth", options.maxDepth, 0, 8],
    ["maxNodes", options.maxNodes, 1, 1000],
    ["hubThreshold", options.hubThreshold, 1, 1000],
    ["concurrency", options.concurrency ?? 4, 1, 16],
  ] as const) {
    if (!Number.isInteger(value) || value < minimum || value > maximum)
      throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
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
  validateOptions(options);
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
  const coverage = {
    failed: values.filter((node) => !node.fetched).map((node) => node.key),
    partial: values
      .filter((node) => node.coverage.some((part) => !part.complete))
      .map((node) => node.key),
    cappedOut: [...cappedOut].sort(),
    hubs: values.filter((node) => node.hub).map((node) => node.key),
    depthBoundaries: values
      .filter(
        (node) =>
          (node.depth === limits.maxDepth || !sameProject(node.key)) &&
          node.edges.some((edge) => !nodes.has(edge.to) && !isGroupItem(edge.to)),
      )
      .map((node) => node.key),
    groupWorkItems,
  };
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
    coverageComplete:
      !coverage.failed.length &&
      !coverage.partial.length &&
      !coverage.cappedOut.length &&
      !coverage.hubs.length,
    coverage,
    nodes: values,
    components: components(nodes),
  };
}

const ARROWS: Record<WorkEdge["direction"], string> = {
  incoming: "←",
  outgoing: "→",
  undirected: "↔",
};

function markdown(value: string): string {
  return value.replace(/\p{Cc}/gu, " ").replace(/[\\`*_[\]<>|#]/g, "\\$&");
}

export function renderGitLab(report: GitLabReport): string {
  const lines = [
    `# GitLab graph · ${markdown(report.host)}`,
    "",
    `Coverage: ${report.coverageComplete ? "complete within requested scope" : "partial"} · ${report.nodes.length} nodes · depth ${report.limits.maxDepth}`,
    "",
    "Issue links, closing merge requests, and mentions from system notes. References into other projects are read one hop. Group-level work items are listed but not read.",
    "",
  ];
  const labels = new Map(report.nodes.map((node) => [node.key, node.identifier]));
  const prefix = `gitlab:${report.host}:`;
  for (const node of report.nodes) {
    const draft = node.draft ? " · draft" : "";
    lines.push(
      `## ${markdown(node.identifier)} · ${markdown(node.title)}`,
      "",
      `State: ${markdown(node.state.name)}${draft}${node.hub ? " · hub not expanded" : ""}`,
      "",
      markdown(node.url),
      "",
    );
    if (!node.fetched) lines.push(`Read failed: ${node.error ?? "READ_FAILED"}`, "");
    for (const edge of node.edges) {
      const arrow = ARROWS[edge.direction];
      const target =
        labels.get(edge.to) ??
        (edge.to.startsWith(prefix) ? edge.to.slice(prefix.length) : edge.to);
      lines.push(`- ${arrow} ${markdown(edge.nativeRelation)}: ${markdown(target)}`);
    }
    for (const part of node.coverage.filter((part) => !part.complete))
      lines.push(`- Incomplete ${part.source}: ${part.reason ?? "not read"}`);
    lines.push("");
  }
  if (report.coverage.cappedOut.length)
    lines.push(`Node cap: ${report.coverage.cappedOut.length} known nodes not fetched.`, "");
  if (report.coverage.depthBoundaries.length)
    lines.push(`Depth boundary: ${report.coverage.depthBoundaries.length} nodes not expanded.`, "");
  if (report.coverage.groupWorkItems.length)
    lines.push(`Group work items: ${report.coverage.groupWorkItems.length} linked, not read.`, "");
  return `${lines.join("\n")}\n`;
}
