import { components, crawlGraph, mapConcurrent } from "./crawl.js";
import { githubTargetLabel } from "./linear-github.js";
import {
  PLANE_OPEN_STATE_GROUPS,
  type PlanePage,
  PlaneReadError,
  type PlaneReader,
} from "./plane-queries.js";
import type { GraphCrawlOptions } from "./types.js";
import type {
  OpenItemCount,
  ReadCoverage,
  WorkEdge,
  WorkLink,
  WorkNode,
  WorkProject,
} from "./work-types.js";

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const IDENTIFIER = /^[a-z][a-z0-9]*-[1-9]\d*$/i;
const SLUG = /^[a-z0-9][a-z0-9_-]*$/i;
const MAX_PROJECT_PAGES = 20;

export interface PlaneLocator {
  /** `PROJ-123`, upper-cased. */
  identifier?: string;
  id?: string;
  projectId?: string;
  workspace?: string;
}

/** A work item key (`PROJ-123`), UUID, or web URL (`/slug/browse/PROJ-123/` or `/slug/projects/<id>/issues/<id>/`). */
export function parsePlaneLocator(input: string, webUrl = "https://app.plane.so"): PlaneLocator {
  if (UUID.test(input)) return { id: input.toLowerCase() };
  if (IDENTIFIER.test(input)) return { identifier: input.toUpperCase() };
  try {
    const url = new URL(input);
    const web = new URL(webUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    const [slug] = parts;
    if (
      url.protocol === web.protocol &&
      url.host === web.host &&
      !url.username &&
      !url.password &&
      slug &&
      SLUG.test(slug)
    ) {
      const workspace = slug.toLowerCase();
      if (parts.length === 3 && parts[1] === "browse" && IDENTIFIER.test(parts[2]))
        return { identifier: parts[2].toUpperCase(), workspace };
      if (
        parts.length === 5 &&
        parts[1] === "projects" &&
        UUID.test(parts[2]) &&
        ["issues", "work-items"].includes(parts[3]) &&
        UUID.test(parts[4])
      )
        return { id: parts[4].toLowerCase(), projectId: parts[2].toLowerCase(), workspace };
    }
  } catch {}
  throw new Error("Expected a Plane work item URL, key (PROJ-123), or UUID");
}

export interface PlaneGraphOptions extends Omit<GraphCrawlOptions, "depthForEdge"> {
  maxPages: number;
  generatedAt?: string;
}

export interface PlaneReport {
  schemaVersion: 1;
  source: "plane";
  generatedAt: string;
  workspace: { id: string; slug: string; name: string };
  webUrl: string;
  project?: WorkProject | null;
  openCount?: OpenItemCount;
  readSource?: string;
  /** The workspace work item list read up front to resolve projects, parents, and children. */
  index: ReadCoverage;
  inventory?: ReadCoverage;
  seeds: string[];
  scope: {
    issues: "project" | "neighborhood";
    notes?: readonly string[];
    relationships: readonly string[];
    externalLinks: "reported-not-fetched" | "github-resolved";
    textReferences: "not-collected";
    archived: "excluded";
  };
  limits: Omit<PlaneGraphOptions, "generatedAt">;
  coverageComplete: boolean;
  coverage: {
    failed: string[];
    partial: string[];
    cappedOut: string[];
    hubs: string[];
    depthBoundaries: string[];
  };
  nodes: WorkNode[];
  /** Identifier, title, and state of edge targets outside `nodes`, from the workspace index. */
  references: Record<string, { identifier: string; title: string; state: string; url: string }>;
  components: string[][];
}

type RecordValue = Record<string, unknown>;

function object(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new PlaneReadError("INVALID_PAYLOAD");
  return value as RecordValue;
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new PlaneReadError("INVALID_PAYLOAD");
  return value;
}

function uuid(value: unknown): string {
  const id = text(value);
  if (!UUID.test(id)) throw new PlaneReadError("INVALID_PAYLOAD");
  return id.toLowerCase();
}

/** A to-one reference that v2 returns as `<name>_id` and v1 as a bare id or an embedded object. */
function reference(item: RecordValue, name: string): string | null {
  const value = item[`${name}_id`] ?? item[name];
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return uuid(value);
  return uuid(object(value).id);
}

function httpUrl(value: unknown): string {
  const url = new URL(text(value));
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
    throw new PlaneReadError("INVALID_PAYLOAD");
  return url.href;
}

function plainText(html: unknown): string | null {
  if (typeof html !== "string") return null;
  const value = html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return value || null;
}

export function planeNodeKey(workspace: string, id: string): string {
  return `plane:${workspace.toLowerCase()}:issue:${uuid(id)}`;
}

interface PlaneProject {
  id: string;
  identifier: string;
  name: string;
}

interface Item {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  projectId: string;
  parentId: string | null;
  state: { name: string; type: string };
  archived: boolean;
  updatedAt: string;
}

function parseItem(value: unknown, projects: Map<string, PlaneProject>): Item {
  const item = object(value);
  const projectId = reference(item, "project");
  if (!projectId) throw new PlaneReadError("INVALID_PAYLOAD");
  let identifier: string;
  if (typeof item.identifier === "string" && IDENTIFIER.test(item.identifier))
    identifier = item.identifier.toUpperCase();
  else {
    const project = projects.get(projectId);
    if (!project || !Number.isInteger(item.sequence_id))
      throw new PlaneReadError("INVALID_PAYLOAD");
    identifier = `${project.identifier}-${item.sequence_id}`;
  }
  const state = item.state && typeof item.state === "object" ? object(item.state) : undefined;
  const group = typeof state?.group === "string" ? state.group : undefined;
  if (
    item.archived_at !== null &&
    item.archived_at !== undefined &&
    typeof item.archived_at !== "string"
  )
    throw new PlaneReadError("INVALID_PAYLOAD");
  return {
    id: uuid(item.id),
    identifier,
    title: text(item.name),
    description: plainText(item.description_html ?? item.description),
    projectId,
    parentId: reference(item, "parent"),
    state: group
      ? {
          name: typeof state?.name === "string" ? state.name : group,
          // Plane spells it "cancelled"; the shared model uses Linear's "canceled".
          type: group === "cancelled" ? "canceled" : group,
        }
      : { name: "Unknown", type: "unknown" },
    archived: Boolean(item.archived_at),
    updatedAt:
      typeof item.updated_at === "string"
        ? item.updated_at
        : typeof item.created_at === "string"
          ? item.created_at
          : "",
  };
}

/** Pages a list endpoint, stopping at `maxPages` or a repeated page token. */
async function readPages(
  source: string,
  maxPages: number,
  read: (next?: string) => Promise<PlanePage>,
  onItems: (items: unknown[]) => void,
): Promise<ReadCoverage> {
  const coverage: ReadCoverage = { source, pages: 0, complete: false };
  const tokens = new Set<string>();
  let next: string | undefined;
  for (;;) {
    let page: PlanePage;
    try {
      page = await read(next);
      onItems(page.items);
    } catch (error) {
      if (!coverage.pages) throw error;
      coverage.reason =
        error instanceof PlaneReadError && error.code === "INVALID_PAYLOAD"
          ? "invalid-page"
          : "read-failed";
      return coverage;
    }
    coverage.pages++;
    if (!page.next) {
      coverage.complete = true;
      return coverage;
    }
    if (tokens.has(page.next)) {
      coverage.reason = "invalid-page";
      return coverage;
    }
    tokens.add(page.next);
    next = page.next;
    if (coverage.pages >= maxPages) {
      coverage.reason = "page-limit";
      return coverage;
    }
  }
}

interface Context {
  reader: PlaneReader;
  workspace: string;
  webUrl: string;
  maxPages: number;
  projects: Map<string, PlaneProject>;
  items: Map<string, Item>;
  /** Children by parent id, trustworthy only when the index is complete. */
  children: Map<string, string[]>;
  index: ReadCoverage;
  /** A guess at the project of an item seen only as a relation target. */
  hints: Map<string, string>;
}

function remember(context: Context, item: Item): void {
  context.items.set(item.id, item);
}

async function readContext(reader: PlaneReader, options: PlaneGraphOptions): Promise<Context> {
  const projects = new Map<string, PlaneProject>();
  await readPages(
    "projects",
    MAX_PROJECT_PAGES,
    (next) => reader.projects(next),
    (values) => {
      for (const value of values) {
        const project = object(value);
        if (project.archived_at) continue;
        const id = uuid(project.id);
        projects.set(id, { id, identifier: text(project.identifier), name: text(project.name) });
      }
    },
  );
  const context: Context = {
    reader,
    workspace: reader.workspace.toLowerCase(),
    webUrl: reader.webUrl,
    maxPages: options.maxPages,
    projects,
    items: new Map(),
    children: new Map(),
    index: { source: "workspace work items", pages: 0, complete: false },
    hints: new Map(),
  };
  context.index = await readPages(
    "workspace work items",
    options.maxPages,
    (next) => reader.workItems(next),
    (values) => {
      for (const value of values) remember(context, parseItem(value, projects));
    },
  );
  for (const item of context.items.values()) {
    if (!item.parentId) continue;
    const list = context.children.get(item.parentId) ?? [];
    list.push(item.id);
    context.children.set(item.parentId, list);
  }
  return context;
}

function itemUrl(context: Context, item: Pick<Item, "identifier">): string {
  return `${context.webUrl}/${context.workspace}/browse/${item.identifier}/`;
}

function projectOf(context: Context, id: string): WorkProject | null {
  const project = context.projects.get(id);
  if (!project) return null;
  return {
    id: project.id,
    name: project.name,
    url: `${context.webUrl}/${context.workspace}/projects/${project.id}/issues/`,
  };
}

/** Finds an item the index did not cover: its hinted project first, then every other project. */
async function fetchItem(context: Context, id: string, projectId?: string): Promise<Item> {
  const order = [
    ...new Set([projectId, context.hints.get(id), ...context.projects.keys()].filter(Boolean)),
  ] as string[];
  for (const project of order) {
    try {
      const item = parseItem(await context.reader.workItem(project, id), context.projects);
      if (item.id !== id) throw new PlaneReadError("IDENTITY_MISMATCH");
      remember(context, item);
      return item;
    } catch (error) {
      if (!(error instanceof PlaneReadError) || error.code !== "NOT_FOUND") throw error;
    }
  }
  throw new PlaneReadError("NOT_FOUND");
}

async function resolveSeed(context: Context, locator: PlaneLocator): Promise<Item> {
  if (locator.id) {
    const known = context.items.get(locator.id);
    if (known) {
      if (locator.projectId && known.projectId !== locator.projectId)
        throw new PlaneReadError("IDENTITY_MISMATCH");
      return known;
    }
    return fetchItem(context, locator.id, locator.projectId);
  }
  const identifier = locator.identifier as string;
  for (const item of context.items.values()) if (item.identifier === identifier) return item;
  const item = parseItem(await context.reader.workItemByIdentifier(identifier), context.projects);
  if (item.identifier !== identifier) throw new PlaneReadError("IDENTITY_MISMATCH");
  remember(context, item);
  return item;
}

interface RelationRule {
  relation: WorkEdge["relation"];
  native: string;
  reverse?: boolean;
  undirected?: boolean;
}

/** Each Plane relation type, from the side of the work item whose relations were read. */
const RELATIONS: Record<string, RelationRule> = {
  blocking: { relation: "blocks", native: "blocks" },
  blocked_by: { relation: "blocks", native: "blocks", reverse: true },
  duplicate: { relation: "duplicate_of", native: "duplicate", undirected: true },
  relates_to: { relation: "related", native: "relates_to", undirected: true },
  start_before: { relation: "provider_specific", native: "start_before" },
  start_after: { relation: "provider_specific", native: "start_before", reverse: true },
  finish_before: { relation: "provider_specific", native: "finish_before" },
  finish_after: { relation: "provider_specific", native: "finish_before", reverse: true },
  implements: { relation: "provider_specific", native: "implements" },
  implemented_by: { relation: "provider_specific", native: "implements", reverse: true },
};

function relationEdges(context: Context, current: Item, raw: unknown): WorkEdge[] {
  const edges: WorkEdge[] = [];
  for (const [name, values] of Object.entries(object(raw))) {
    if (!Array.isArray(values)) throw new PlaneReadError("INVALID_PAYLOAD");
    const type = name.trim().toLowerCase().replace(/\s+/g, "_");
    const rule = RELATIONS[type] ?? { relation: "provider_specific", native: type };
    for (const value of values) {
      const other = typeof value === "string" ? uuid(value) : uuid(object(value).id);
      if (other === current.id) continue;
      if (!context.items.has(other)) context.hints.set(other, current.projectId);
      const [from, to] = rule.reverse ? [other, current.id] : [current.id, other];
      edges.push({
        to: planeNodeKey(context.workspace, other),
        relation: rule.relation,
        direction: rule.undirected ? "undirected" : rule.reverse ? "incoming" : "outgoing",
        nativeRelation: rule.native,
        evidence: {
          kind: "relation",
          id: rule.undirected
            ? `${rule.native}:${[from, to].sort().join(":")}`
            : `${rule.native}:${from}:${to}`,
        },
      });
    }
  }
  return edges;
}

async function readNode(context: Context, id: string, depth: number): Promise<WorkNode> {
  const item = context.items.get(id) ?? (await fetchItem(context, id));
  const coverage: ReadCoverage[] = [];
  const edges: WorkEdge[] = [];
  try {
    edges.push(...relationEdges(context, item, await context.reader.relations(item.projectId, id)));
    coverage.push({ source: "relations", pages: 1, complete: true });
  } catch (error) {
    coverage.push({
      source: "relations",
      pages: 0,
      complete: false,
      reason:
        error instanceof PlaneReadError && error.code === "INVALID_PAYLOAD"
          ? "invalid-page"
          : "read-failed",
    });
  }
  const links: WorkLink[] = [];
  try {
    coverage.push(
      await readPages(
        "links",
        context.maxPages,
        (next) => context.reader.links(item.projectId, id, next),
        (values) => {
          for (const value of values) {
            const link = object(value);
            const url = httpUrl(link.url);
            links.push({
              url,
              title: typeof link.title === "string" && link.title.trim() ? link.title : url,
              evidence: { kind: "attachment", id: uuid(link.id) },
            });
          }
        },
      ),
    );
  } catch {
    coverage.push({ source: "links", pages: 0, complete: false, reason: "read-failed" });
  }
  let children = context.children.get(id) ?? [];
  if (!context.index.complete) {
    const found: string[] = [];
    try {
      coverage.push(
        await readPages(
          "children",
          context.maxPages,
          (next) => context.reader.children(id, next),
          (values) => {
            for (const value of values) {
              const child = parseItem(value, context.projects);
              if (child.parentId !== id) throw new PlaneReadError("INVALID_PAYLOAD");
              remember(context, child);
              found.push(child.id);
            }
          },
        ),
      );
      children = found;
    } catch {
      coverage.push({ source: "children", pages: 0, complete: false, reason: "read-failed" });
    }
  }
  for (const [other, direction] of [
    ...(item.parentId ? [[item.parentId, "incoming"]] : []),
    ...children.map((child) => [child, "outgoing"]),
  ] as Array<[string, "incoming" | "outgoing"]>) {
    if (!context.items.has(other)) context.hints.set(other, item.projectId);
    edges.push({
      to: planeNodeKey(context.workspace, other),
      relation: "parent_of",
      direction,
      nativeRelation: "parent",
      evidence: { kind: "hierarchy", id: direction === "outgoing" ? other : id },
    });
  }
  const byIdentity = new Map(
    edges.map((edge) => [
      `${edge.to}\0${edge.relation}\0${edge.direction}\0${edge.evidence.id}`,
      edge,
    ]),
  );
  return {
    key: planeNodeKey(context.workspace, id),
    provider: "plane",
    authority: context.workspace,
    nativeId: id,
    kind: "issue",
    identifier: item.identifier,
    title: item.title,
    description: item.description,
    url: itemUrl(context, item),
    state: item.state,
    updatedAt: item.updatedAt,
    archived: item.archived,
    project: projectOf(context, item.projectId),
    fetched: true,
    depth,
    edges: [...byIdentity.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, edge]) => edge),
    externalLinks: [...new Map(links.map((link) => [link.evidence.id, link])).values()].sort(
      (a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0),
    ),
    coverage,
  };
}

function unavailable(context: Context, id: string, depth: number, error: unknown): WorkNode {
  const item = context.items.get(id);
  return {
    key: planeNodeKey(context.workspace, id),
    provider: "plane",
    authority: context.workspace,
    nativeId: id,
    kind: "issue",
    identifier: item?.identifier ?? id,
    title: item?.title ?? "Unavailable",
    url: item ? itemUrl(context, item) : "",
    state: item?.state ?? { name: "Unknown", type: "unknown" },
    updatedAt: item?.updatedAt ?? "",
    archived: item?.archived ?? false,
    ...(item && { project: projectOf(context, item.projectId) }),
    fetched: false,
    error: error instanceof PlaneReadError ? error.code : "READ_FAILED",
    depth,
    edges: [],
    externalLinks: [],
    coverage: [],
  };
}

function validateOptions(options: PlaneGraphOptions): void {
  for (const [name, value, minimum, maximum] of [
    ["maxDepth", options.maxDepth, 0, 8],
    ["maxNodes", options.maxNodes, 1, 1000],
    ["hubThreshold", options.hubThreshold, 1, 1000],
    ["concurrency", options.concurrency ?? 2, 1, 32],
    ["maxPages", options.maxPages, 1, 100],
  ] as const) {
    if (!Number.isInteger(value) || value < minimum || value > maximum)
      throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
}

const OPEN = new Set<string>(PLANE_OPEN_STATE_GROUPS);

async function openCount(context: Context, projectId: string): Promise<OpenItemCount | undefined> {
  const observedAt = new Date().toISOString();
  if (context.index.complete) {
    let value = 0;
    for (const item of context.items.values())
      if (item.projectId === projectId && !item.archived && OPEN.has(item.state.type)) value++;
    return { value, issues: value, complete: true, observedAt };
  }
  try {
    const value = await context.reader.countOpen?.(projectId);
    if (value === undefined) return undefined;
    return { value, issues: value, complete: true, observedAt };
  } catch {
    return undefined;
  }
}

function references(context: Context, nodes: WorkNode[]): PlaneReport["references"] {
  const present = new Set(nodes.map((node) => node.key));
  const prefix = `plane:${context.workspace}:issue:`;
  const out: PlaneReport["references"] = {};
  for (const node of nodes)
    for (const edge of node.edges) {
      if (present.has(edge.to) || out[edge.to]) continue;
      const item = context.items.get(edge.to.slice(prefix.length));
      if (item)
        out[edge.to] = {
          identifier: item.identifier,
          title: item.title,
          state: item.state.name,
          url: itemUrl(context, item),
        };
    }
  return out;
}

function summarize(nodes: WorkNode[]) {
  return {
    failed: nodes.filter((node) => !node.fetched).map((node) => node.key),
    partial: nodes
      .filter((node) => node.coverage.some((part) => !part.complete))
      .map((node) => node.key),
  };
}

const RELATIONSHIPS = ["relations", "parent", "children", "links"] as const;

/** An issue neighborhood: the seed and everything reachable through explicit relationships. */
export async function buildPlaneGraph(
  reader: PlaneReader,
  seed: string,
  options: PlaneGraphOptions,
): Promise<PlaneReport> {
  const locator = parsePlaneLocator(seed, reader.webUrl);
  validateOptions(options);
  if (locator.workspace && locator.workspace !== reader.workspace.toLowerCase())
    throw new PlaneReadError("WORKSPACE_MISMATCH");
  const context = await readContext(reader, options);
  const start = await resolveSeed(context, locator);
  const first = await readNode(context, start.id, 0);
  const limits = {
    maxDepth: options.maxDepth,
    maxNodes: options.maxNodes,
    hubThreshold: options.hubThreshold,
    concurrency: options.concurrency ?? 2,
    maxPages: options.maxPages,
  };
  const prefix = `plane:${context.workspace}:issue:`;
  const { nodes, cappedOut } = await crawlGraph(
    [{ key: first.key }],
    limits,
    async (key, depth) => {
      if (key === first.key) return first;
      if (!key.startsWith(prefix)) throw new PlaneReadError("WORKSPACE_MISMATCH");
      const id = uuid(key.slice(prefix.length));
      try {
        return await readNode(context, id, depth);
      } catch (error) {
        return unavailable(context, id, depth, error);
      }
    },
  );
  const values = [...nodes.values()];
  const coverage = {
    ...summarize(values),
    cappedOut: [...cappedOut].sort(),
    hubs: values.filter((node) => node.hub).map((node) => node.key),
    depthBoundaries: values
      .filter((node) => node.depth === limits.maxDepth && node.edges.some((e) => !nodes.has(e.to)))
      .map((node) => node.key),
  };
  return {
    schemaVersion: 1,
    source: "plane",
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    workspace: { id: context.workspace, slug: context.workspace, name: context.workspace },
    webUrl: context.webUrl,
    project: first.project ?? null,
    openCount: first.project ? await openCount(context, first.project.id) : undefined,
    index: context.index,
    seeds: [first.key],
    scope: {
      issues: "neighborhood",
      relationships: RELATIONSHIPS,
      externalLinks: "reported-not-fetched",
      textReferences: "not-collected",
      archived: "excluded",
    },
    limits,
    coverageComplete:
      !coverage.failed.length &&
      !coverage.partial.length &&
      !coverage.cappedOut.length &&
      !coverage.hubs.length,
    coverage,
    nodes: values,
    references: references(context, values),
    components: components(nodes),
  };
}

/** Every non-archived work item in one project, with its explicit relationships. */
export async function buildPlaneProject(
  reader: PlaneReader,
  projectRef: string,
  options: PlaneGraphOptions,
): Promise<PlaneReport> {
  validateOptions(options);
  const context = await readContext(reader, options);
  const wanted = projectRef.toLowerCase();
  const project = [...context.projects.values()].find(
    (item) => item.id === wanted || item.identifier.toLowerCase() === wanted,
  );
  if (!project) throw new PlaneReadError("PROJECT_NOT_FOUND");
  let inventory: ReadCoverage;
  let listed: string[];
  if (context.index.complete) {
    inventory = { ...context.index, source: "project work items" };
    listed = [...context.items.values()]
      .filter((item) => item.projectId === project.id && !item.archived)
      .map((item) => item.id);
  } else {
    const found = new Set<string>();
    inventory = await readPages(
      "project work items",
      options.maxPages,
      (next) => reader.projectWorkItems(project.id, next),
      (values) => {
        for (const value of values) {
          const item = parseItem(value, context.projects);
          if (item.projectId !== project.id) throw new PlaneReadError("INVALID_PAYLOAD");
          remember(context, item);
          if (!item.archived) found.add(item.id);
        }
      },
    );
    listed = [...found];
  }
  const ids = listed.sort();
  const selected = ids.slice(0, options.maxNodes);
  const values = await mapConcurrent(selected, options.concurrency ?? 2, async (id) => {
    try {
      return await readNode(context, id, 0);
    } catch (error) {
      return unavailable(context, id, 0, error);
    }
  });
  const nodes = new Map(values.map((node) => [node.key, node]));
  const coverage = {
    ...summarize(values),
    cappedOut: ids.slice(options.maxNodes).map((id) => planeNodeKey(context.workspace, id)),
    hubs: [],
    depthBoundaries: [],
  };
  return {
    schemaVersion: 1,
    source: "plane",
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    workspace: { id: context.workspace, slug: context.workspace, name: context.workspace },
    webUrl: context.webUrl,
    project: projectOf(context, project.id),
    openCount: await openCount(context, project.id),
    index: context.index,
    inventory,
    seeds: [],
    scope: {
      issues: "project",
      relationships: RELATIONSHIPS,
      externalLinks: "reported-not-fetched",
      textReferences: "not-collected",
      archived: "excluded",
      notes: ["Connections outside this project are retained without fetching those work items."],
    },
    limits: {
      maxDepth: 0,
      maxNodes: options.maxNodes,
      maxPages: options.maxPages,
      hubThreshold: options.hubThreshold,
      concurrency: options.concurrency ?? 2,
    },
    coverageComplete:
      inventory.complete &&
      !coverage.failed.length &&
      !coverage.partial.length &&
      !coverage.cappedOut.length,
    coverage,
    nodes: values,
    references: references(context, values),
    components: components(nodes),
  };
}

function markdown(value: string): string {
  return value.replace(/\p{Cc}/gu, " ").replace(/[\\`*_[\]<>|]/g, "\\$&");
}

const NATIVE_LABELS: Record<string, string> = {
  blocks: "blocks",
  duplicate: "duplicate",
  relates_to: "relates to",
  start_before: "starts before",
  finish_before: "finishes before",
  implements: "implements",
  parent: "parent",
};

export function renderPlane(report: PlaneReport): string {
  const lines = [
    `# Plane graph · ${markdown(report.workspace.name)}${report.project ? ` / ${markdown(report.project.name)}` : ""}`,
    "",
    `Coverage: ${report.coverageComplete ? "complete within requested scope" : "partial"} · ${report.nodes.length} nodes · ${report.scope.issues === "project" ? "project capture" : `depth ${report.limits.maxDepth}`}`,
    "",
    `Explicit relations and hierarchy. Archived work items are excluded. ${report.scope.externalLinks === "github-resolved" ? "GitHub issue and pull request links are read one hop; other link URLs are reported without fetching." : "Link URLs are reported without fetching their targets."} Text mentions are not collected.`,
    "",
  ];
  const labels = new Map([
    ...Object.entries(report.references).map(([key, ref]) => [key, ref.identifier] as const),
    ...report.nodes.map((node) => [node.key, node.identifier] as const),
  ]);
  for (const node of report.nodes) {
    lines.push(
      `## ${markdown(node.identifier)} · ${markdown(node.title)}`,
      "",
      `Status: ${markdown(node.state.name)}${node.hub ? " · hub not expanded" : ""}`,
      "",
    );
    if (node.url) lines.push(node.url, "");
    if (!node.fetched) lines.push(`Read failed: ${node.error}`, "");
    for (const edge of node.edges) {
      const arrow =
        edge.direction === "incoming" ? "←" : edge.direction === "undirected" ? "↔" : "→";
      lines.push(
        `- ${arrow} ${markdown(NATIVE_LABELS[edge.nativeRelation] ?? edge.nativeRelation)}: ${markdown(labels.get(edge.to) ?? edge.to)}`,
      );
    }
    for (const link of node.externalLinks)
      lines.push(
        `- Link: ${markdown(link.title)} · ${markdown(link.url)}${link.github ? ` · ${markdown(githubTargetLabel(link.github))}` : ""}`,
      );
    for (const part of node.coverage.filter((part) => !part.complete))
      lines.push(`- Incomplete ${part.source}: ${part.reason}`);
    lines.push("");
  }
  if (!report.index.complete)
    lines.push(
      `Workspace index incomplete (${report.index.reason ?? "read incomplete"}); items outside it were looked up one by one.`,
      "",
    );
  if (report.coverage.cappedOut.length)
    lines.push(`Node cap: ${report.coverage.cappedOut.length} known nodes not fetched.`, "");
  if (report.inventory && !report.inventory.complete)
    lines.push(`Project list incomplete: ${report.inventory.reason ?? "read incomplete"}.`, "");
  if (report.coverage.depthBoundaries.length)
    lines.push(`Depth boundary: ${report.coverage.depthBoundaries.length} nodes not expanded.`, "");
  return `${lines.join("\n")}\n`;
}
