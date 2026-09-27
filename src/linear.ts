import { components, crawlGraph } from "./crawl.js";
import {
  LINEAR_CONNECTIONS,
  type LinearConnection,
  LinearReadError,
  type LinearReader,
} from "./linear-queries.js";
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
const IDENTIFIER = /^[a-z][a-z0-9_]*-[1-9]\d*$/i;
const WORKSPACE = /^[a-z0-9][a-z0-9-]*$/i;

export interface LinearLocator {
  id: string;
  workspace?: string;
}

export function parseLinearLocator(input: string): LinearLocator {
  if (UUID.test(input)) return { id: input.toLowerCase() };
  if (IDENTIFIER.test(input)) return { id: input.toUpperCase() };
  try {
    const url = new URL(input);
    const match = url.pathname.match(/^\/([^/]+)\/issue\/([^/]+)(?:\/[^/]*)?\/?$/);
    if (
      url.protocol === "https:" &&
      url.hostname === "linear.app" &&
      !url.port &&
      !url.username &&
      !url.password &&
      match &&
      WORKSPACE.test(match[1]) &&
      IDENTIFIER.test(match[2])
    )
      return { id: match[2].toUpperCase(), workspace: match[1].toLowerCase() };
  } catch {}
  throw new Error("Expected a Linear issue URL, identifier (ENG-123), or UUID");
}

export interface LinearGraphOptions extends Omit<GraphCrawlOptions, "depthForEdge"> {
  maxPages: number;
  workspace?: string;
  generatedAt?: string;
}

export interface LinearReport {
  schemaVersion: 1;
  source: "linear";
  generatedAt: string;
  workspace: { id: string; slug: string; name: string };
  project?: WorkProject | null;
  team?: WorkNode["team"];
  openCount?: OpenItemCount;
  readSource?: string;
  inventory?: ReadCoverage;
  seeds: string[];
  scope: {
    issues?: "project" | "neighborhood";
    notes?: readonly string[];
    relationships: readonly string[];
    externalLinks: "reported-not-fetched";
    textReferences: "not-collected";
    archived: "issues-included-links-excluded" | "excluded";
  };
  limits: Omit<LinearGraphOptions, "workspace" | "generatedAt">;
  coverageComplete: boolean;
  coverage: {
    failed: string[];
    partial: string[];
    cappedOut: string[];
    hubs: string[];
    depthBoundaries: string[];
  };
  nodes: WorkNode[];
  components: string[][];
}

type RecordValue = Record<string, unknown>;

function object(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new LinearReadError("INVALID_PAYLOAD");
  return value as RecordValue;
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new LinearReadError("INVALID_PAYLOAD");
  return value;
}

function isArchived(value: unknown): boolean {
  if (value === null) return false;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new LinearReadError("INVALID_PAYLOAD");
  return true;
}

function nativeId(value: unknown): string {
  const id = text(value);
  if (!UUID.test(id)) throw new LinearReadError("INVALID_PAYLOAD");
  return id.toLowerCase();
}

function httpUrl(value: unknown): string {
  const url = new URL(text(value));
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
    throw new LinearReadError("INVALID_PAYLOAD");
  return url.href;
}

export function linearNodeKey(authority: string, id: string): string {
  return `linear:${nativeId(authority)}:issue:${nativeId(id)}`;
}

function ref(value: unknown, authority: string) {
  const item = object(value);
  if (nativeId(object(object(item.team).organization).id) !== authority)
    throw new LinearReadError("WORKSPACE_MISMATCH");
  return {
    id: nativeId(item.id),
    identifier: text(item.identifier),
    url: httpUrl(item.url),
  };
}

function relationType(type: string): WorkEdge["relation"] {
  if (type === "blocks") return "blocks";
  if (type === "duplicate") return "duplicate_of";
  if (type === "related") return "related";
  return "provider_specific";
}

function normalize(
  item: RecordValue,
  collections: Record<LinearConnection, unknown[]>,
  authority: string,
  depth: number,
  coverage: ReadCoverage[],
): WorkNode {
  const current = ref(item, authority);
  const edges: WorkEdge[] = [];
  for (const connection of ["relations", "inverseRelations"] as const) {
    for (const value of collections[connection]) {
      const relation = object(value);
      if (isArchived(relation.archivedAt)) continue;
      const from = ref(relation.issue, authority);
      const to = ref(relation.relatedIssue, authority);
      const outgoing = connection === "relations";
      if ((outgoing ? from.id : to.id) !== current.id)
        throw new LinearReadError("UNRELATED_RELATION");
      const type = text(relation.type);
      edges.push({
        to: linearNodeKey(authority, outgoing ? to.id : from.id),
        relation: relationType(type),
        direction:
          type === "related" || type === "similar"
            ? "undirected"
            : outgoing
              ? "outgoing"
              : "incoming",
        nativeRelation: type,
        evidence: { kind: "relation", id: text(relation.id) },
      });
    }
  }
  for (const [value, direction] of [
    ...(item.parent ? [[item.parent, "incoming"]] : []),
    ...collections.children.map((child) => [child, "outgoing"]),
  ] as Array<[unknown, "incoming" | "outgoing"]>) {
    const related = ref(value, authority);
    edges.push({
      to: linearNodeKey(authority, related.id),
      relation: "parent_of",
      direction,
      nativeRelation: "parent",
      evidence: {
        kind: "hierarchy",
        id: direction === "outgoing" ? related.id : current.id,
      },
    });
  }
  const links: WorkLink[] = collections.attachments.flatMap((value) => {
    const attachment = object(value);
    if (isArchived(attachment.archivedAt)) return [];
    if (typeof attachment.title !== "string") throw new LinearReadError("INVALID_PAYLOAD");
    return [
      {
        url: httpUrl(attachment.url),
        title: attachment.title,
        evidence: { kind: "attachment", id: text(attachment.id) },
      },
    ];
  });
  const state = object(item.state);
  const byIdentity = new Map(
    edges.map((edge) => [
      `${edge.to}\0${edge.relation}\0${edge.direction}\0${edge.evidence.id}`,
      edge,
    ]),
  );
  const orderedEdges = [...byIdentity.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, edge]) => edge);
  return {
    key: linearNodeKey(authority, current.id),
    provider: "linear",
    authority,
    nativeId: current.id,
    kind: "issue",
    identifier: current.identifier,
    title: text(item.title),
    description: typeof item.description === "string" ? item.description : null,
    url: current.url,
    state: { name: text(state.name), type: text(state.type) },
    updatedAt: text(item.updatedAt),
    archived: isArchived(item.archivedAt),
    project:
      item.project === undefined
        ? undefined
        : item.project === null
          ? null
          : {
              id: nativeId(object(item.project).id),
              name: text(object(item.project).name),
              url: httpUrl(object(item.project).url),
            },
    team:
      object(item.team).id === undefined
        ? undefined
        : {
            id: nativeId(object(item.team).id),
            name: text(object(item.team).name),
            key: text(object(item.team).key),
          },
    fetched: true,
    depth,
    edges: orderedEdges,
    externalLinks: [...new Map(links.map((link) => [link.evidence.id, link])).values()].sort(
      (a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0),
    ),
    coverage,
  };
}

export async function countLinearProjectOpen(
  reader: LinearReader,
  projectId: string,
  workspaceId: string,
  maxPages = 100,
): Promise<OpenItemCount | undefined> {
  if (!reader.projectOpenIssues) return undefined;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100)
    throw new RangeError("Count pages must be from 1 to 100");
  projectId = nativeId(projectId);
  workspaceId = nativeId(workspaceId);
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let after: string | undefined;
  let pages = 0;
  let complete = false;
  let overlap = false;
  try {
    for (; pages < maxPages; pages++) {
      const project = object(object(await reader.projectOpenIssues(projectId, after)).project);
      if (nativeId(project.id) !== projectId) throw new LinearReadError("IDENTITY_MISMATCH");
      const connection = object(project.issues);
      const info = object(connection.pageInfo);
      if (!Array.isArray(connection.nodes) || typeof info.hasNextPage !== "boolean")
        throw new LinearReadError("INVALID_PAYLOAD");
      const found = connection.nodes.map((value) => {
        const item = object(value);
        if (
          nativeId(object(item.project).id) !== projectId ||
          nativeId(object(object(item.team).organization).id) !== workspaceId
        )
          throw new LinearReadError("WORKSPACE_MISMATCH");
        if (
          isArchived(item.archivedAt) ||
          !["triage", "backlog", "unstarted", "started"].includes(text(object(item.state).type))
        )
          throw new LinearReadError("INVALID_PAYLOAD");
        return nativeId(item.id);
      });
      for (const id of found) {
        if (ids.has(id)) overlap = true;
        ids.add(id);
      }
      if (!info.hasNextPage) {
        complete = !overlap;
        break;
      }
      after = text(info.endCursor);
      if (cursors.has(after)) throw new LinearReadError("REPEATED_CURSOR");
      cursors.add(after);
    }
  } catch {
    if (!ids.size && !pages) return undefined;
  }
  return { value: ids.size, issues: ids.size, complete, observedAt: new Date().toISOString() };
}

async function readNode(
  reader: LinearReader,
  id: string,
  authority: string,
  depth: number,
  maxPages: number,
): Promise<WorkNode> {
  const collections: Record<LinearConnection, unknown[]> = {
    relations: [],
    inverseRelations: [],
    children: [],
    attachments: [],
  };
  const coverage: ReadCoverage[] = LINEAR_CONNECTIONS.map((source) => ({
    source,
    pages: 0,
    complete: false,
  }));
  const cursors: Partial<Record<LinearConnection, string>> = {};
  const seen = new Map(LINEAR_CONNECTIONS.map((name) => [name, new Set<string>()]));
  let include: LinearConnection[] = [...LINEAR_CONNECTIONS];
  let original: RecordValue | undefined;
  for (let page = 0; include.length && page < maxPages; page++) {
    let item: RecordValue;
    try {
      item = object(object(await reader.issue(id, { size: 50, cursors, include })).issue);
      const found = ref(item, authority);
      if ((UUID.test(id) && found.id !== id) || (original && found.id !== original.id))
        throw new LinearReadError("IDENTITY_MISMATCH");
    } catch (error) {
      if (!original) throw error;
      for (const state of coverage)
        if (include.includes(state.source as LinearConnection)) state.reason = "read-failed";
      break;
    }
    if (!original) original = item;
    else if (item.updatedAt !== original.updatedAt) {
      for (const state of coverage) {
        state.complete = false;
        state.reason = "changed-during-read";
      }
      break;
    }
    const next: LinearConnection[] = [];
    for (const name of include) {
      const state = coverage.find((state) => state.source === name);
      if (!state) throw new LinearReadError("INVALID_PAYLOAD");
      try {
        const connection = object(item[name]);
        const pageInfo = object(connection.pageInfo);
        if (!Array.isArray(connection.nodes) || typeof pageInfo.hasNextPage !== "boolean")
          throw new LinearReadError("INVALID_PAYLOAD");
        collections[name].push(...connection.nodes);
        state.pages++;
        state.complete = !pageInfo.hasNextPage;
        if (!state.complete) {
          const cursor = text(pageInfo.endCursor);
          if (seen.get(name)?.has(cursor)) throw new LinearReadError("REPEATED_CURSOR");
          seen.get(name)?.add(cursor);
          cursors[name] = cursor;
          if (page + 1 >= maxPages) state.reason = "page-limit";
          else next.push(name);
        }
      } catch {
        state.complete = false;
        state.reason = "invalid-page";
      }
    }
    include = next;
  }
  if (!original) throw new LinearReadError("NOT_FOUND");
  return normalize(original, collections, authority, depth, coverage);
}

export async function buildLinearGraph(
  reader: LinearReader,
  seed: string,
  options: LinearGraphOptions,
): Promise<LinearReport> {
  const locator = parseLinearLocator(seed);
  validateOptions(options);
  if (locator.workspace && options.workspace && locator.workspace !== options.workspace)
    throw new Error("Linear URL and --workspace disagree");
  const workspace = await readWorkspace(reader, locator.workspace ?? options.workspace);
  const first = await readNode(reader, locator.id, workspace.id, 0, options.maxPages);
  const limits = {
    maxDepth: options.maxDepth,
    maxNodes: options.maxNodes,
    hubThreshold: options.hubThreshold,
    concurrency: options.concurrency ?? 4,
    maxPages: options.maxPages,
  };
  const { nodes, cappedOut } = await crawlGraph(
    [{ key: first.key }],
    limits,
    async (key, depth) => {
      if (key === first.key) return first;
      const prefix = `linear:${workspace.id}:issue:`;
      if (!key.startsWith(prefix)) throw new LinearReadError("WORKSPACE_MISMATCH");
      const id = nativeId(key.slice(prefix.length));
      try {
        return await readNode(reader, id, workspace.id, depth, options.maxPages);
      } catch (error) {
        return unavailable(workspace.id, id, depth, error);
      }
    },
  );
  const values = [...nodes.values()];
  const coverage = {
    failed: values.filter((node) => !node.fetched).map((node) => node.key),
    partial: values
      .filter((node) => node.coverage.some((part) => !part.complete))
      .map((node) => node.key),
    cappedOut: [...cappedOut].sort(),
    hubs: values.filter((node) => node.hub).map((node) => node.key),
    depthBoundaries: values
      .filter((node) => node.depth === limits.maxDepth && node.edges.some((e) => !nodes.has(e.to)))
      .map((node) => node.key),
  };
  return {
    schemaVersion: 1,
    source: "linear",
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    workspace,
    project: first.project,
    team: first.team,
    openCount: first.project
      ? await countLinearProjectOpen(reader, first.project.id, workspace.id)
      : undefined,
    seeds: [first.key],
    scope: {
      issues: "neighborhood",
      relationships: ["relations", "inverseRelations", "parent", "children", "attachments"],
      externalLinks: "reported-not-fetched",
      textReferences: "not-collected",
      archived: "issues-included-links-excluded",
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

function validateOptions(options: LinearGraphOptions): void {
  for (const [name, value, minimum, maximum] of [
    ["maxDepth", options.maxDepth, 0, 8],
    ["maxNodes", options.maxNodes, 1, 1000],
    ["hubThreshold", options.hubThreshold, 1, 1000],
    ["concurrency", options.concurrency ?? 4, 1, 32],
    ["maxPages", options.maxPages, 1, 100],
  ] as const) {
    if (!Number.isInteger(value) || value < minimum || value > maximum)
      throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  if (options.workspace && !WORKSPACE.test(options.workspace))
    throw new Error("Invalid Linear workspace");
}

async function readWorkspace(reader: LinearReader, expected?: string) {
  const organization = object(object(await reader.workspace()).organization);
  const workspace = {
    id: nativeId(organization.id),
    slug: text(organization.urlKey),
    name: text(organization.name),
  };
  if (expected && workspace.slug !== expected) throw new LinearReadError("WORKSPACE_MISMATCH");
  return workspace;
}

function unavailable(authority: string, id: string, depth: number, error: unknown): WorkNode {
  return {
    key: linearNodeKey(authority, id),
    provider: "linear",
    authority,
    nativeId: id,
    kind: "issue",
    identifier: id,
    title: "Unavailable",
    url: "",
    state: { name: "Unknown", type: "unknown" },
    updatedAt: "",
    archived: false,
    fetched: false,
    error: error instanceof LinearReadError ? error.code : "READ_FAILED",
    depth,
    edges: [],
    externalLinks: [],
    coverage: [],
  };
}

export async function buildLinearProject(
  reader: LinearReader,
  projectId: string,
  options: LinearGraphOptions,
): Promise<LinearReport> {
  projectId = nativeId(projectId);
  validateOptions(options);
  if (!reader.projectIssues) throw new Error("Project issue listing is unavailable in this reader");
  const workspace = await readWorkspace(reader, options.workspace);
  const inventory: ReadCoverage = { source: "project issues", pages: 0, complete: false };
  const listed = new Map<string, string>();
  const cursors = new Set<string>();
  let after: string | undefined;
  let project: WorkProject | undefined;
  let changed = false;
  for (let index = 0; index < options.maxPages; index++) {
    try {
      const item = object(object(await reader.projectIssues(projectId, after)).project);
      if (nativeId(item.id) !== projectId) throw new LinearReadError("IDENTITY_MISMATCH");
      const metadata = { id: projectId, name: text(item.name), url: httpUrl(item.url) };
      const connection = object(item.issues);
      const info = object(connection.pageInfo);
      if (!Array.isArray(connection.nodes) || typeof info.hasNextPage !== "boolean")
        throw new LinearReadError("INVALID_PAYLOAD");
      const page = connection.nodes.map((value) => {
        const node = object(value);
        if (
          nativeId(object(node.project).id) !== projectId ||
          nativeId(object(object(node.team).organization).id) !== workspace.id
        )
          throw new LinearReadError("WORKSPACE_MISMATCH");
        return [nativeId(node.id), text(node.updatedAt)] as const;
      });
      project ??= metadata;
      inventory.pages++;
      for (const [id, updatedAt] of page) {
        if (listed.has(id)) changed = true;
        listed.set(id, updatedAt);
      }
      if (!info.hasNextPage) {
        inventory.complete = !changed;
        if (changed) inventory.reason = "changed-during-read";
        break;
      }
      if (listed.size >= options.maxNodes || index + 1 === options.maxPages) {
        inventory.reason = listed.size >= options.maxNodes ? "node-limit" : "page-limit";
        break;
      }
      after = text(info.endCursor);
      if (cursors.has(after)) throw new LinearReadError("REPEATED_CURSOR");
      cursors.add(after);
    } catch (error) {
      if (!project) throw error;
      inventory.reason =
        error instanceof LinearReadError &&
        ["INVALID_PAYLOAD", "IDENTITY_MISMATCH", "WORKSPACE_MISMATCH", "REPEATED_CURSOR"].includes(
          error.code,
        )
          ? "invalid-page"
          : "read-failed";
      break;
    }
  }
  if (!project) throw new LinearReadError("NOT_FOUND");
  const ids = [...listed.keys()].sort();
  const selected = ids.slice(0, options.maxNodes);
  const values: WorkNode[] = new Array(selected.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency ?? 4, selected.length) }, async () => {
      while (next < selected.length) {
        const index = next++;
        const id = selected[index];
        try {
          const node = await readNode(reader, id, workspace.id, 0, options.maxPages);
          if (node.project?.id !== projectId || node.archived)
            throw new LinearReadError("PROJECT_CHANGED");
          if (node.updatedAt !== listed.get(id))
            node.coverage.push({
              source: "project membership",
              pages: 1,
              complete: false,
              reason: "changed-during-read",
            });
          values[index] = node;
        } catch (error) {
          values[index] = { ...unavailable(workspace.id, id, 0, error), project };
        }
      }
    }),
  );
  const nodes = new Map(values.map((node) => [node.key, node]));
  const coverage = {
    failed: values.filter((node) => !node.fetched).map((node) => node.key),
    partial: values
      .filter((node) => node.coverage.some((part) => !part.complete))
      .map((node) => node.key),
    cappedOut: ids.slice(options.maxNodes).map((id) => linearNodeKey(workspace.id, id)),
    hubs: [],
    depthBoundaries: [],
  };
  return {
    schemaVersion: 1,
    source: "linear",
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    workspace,
    project,
    openCount: await countLinearProjectOpen(reader, projectId, workspace.id),
    inventory,
    seeds: [],
    scope: {
      issues: "project",
      relationships: ["relations", "inverseRelations", "parent", "children", "attachments"],
      externalLinks: "reported-not-fetched",
      textReferences: "not-collected",
      archived: "excluded",
      notes: ["Connections outside this project are retained without fetching those issues."],
    },
    limits: {
      maxDepth: 0,
      maxNodes: options.maxNodes,
      maxPages: options.maxPages,
      hubThreshold: options.hubThreshold,
      concurrency: options.concurrency ?? 4,
    },
    coverageComplete:
      inventory.complete &&
      !coverage.failed.length &&
      !coverage.partial.length &&
      !coverage.cappedOut.length,
    coverage,
    nodes: values,
    components: components(nodes),
  };
}

function markdown(value: string): string {
  return value.replace(/\p{Cc}/gu, " ").replace(/[\\`*_[\]<>|]/g, "\\$&");
}

export function renderLinear(report: LinearReport): string {
  const lines = [
    `# Linear graph · ${markdown(report.workspace.name)}`,
    "",
    `Coverage: ${report.coverageComplete ? "complete within requested scope" : "partial"} · ${report.nodes.length} nodes · ${report.scope.issues === "project" ? "project capture" : `depth ${report.limits.maxDepth}`}`,
    "",
    `Explicit relationships and hierarchy. ${report.scope.archived === "excluded" ? "Archived issues are excluded." : "Archived issues are included; archived relations and attachments are excluded."} Attachment URLs are reported without fetching their targets. Text mentions are not collected.`,
    "",
  ];
  const labels = new Map(report.nodes.map((node) => [node.key, node.identifier]));
  for (const node of report.nodes) {
    lines.push(
      `## ${markdown(node.identifier)} · ${markdown(node.title)}`,
      "",
      `Status: ${markdown(node.state.name)}${node.archived ? " · archived" : ""}${node.hub ? " · hub not expanded" : ""}`,
      "",
    );
    if (node.url) lines.push(node.url, "");
    if (!node.fetched) lines.push(`Read failed: ${node.error}`, "");
    for (const edge of node.edges) {
      const arrow =
        edge.direction === "incoming" ? "←" : edge.direction === "undirected" ? "↔" : "→";
      lines.push(
        `- ${arrow} ${markdown(edge.nativeRelation)}: ${markdown(labels.get(edge.to) ?? edge.to)}`,
      );
    }
    for (const link of node.externalLinks)
      lines.push(`- Attachment: ${markdown(link.title)} · ${markdown(link.url)}`);
    for (const part of node.coverage.filter((part) => !part.complete))
      lines.push(`- Incomplete ${part.source}: ${part.reason}`);
    lines.push("");
  }
  if (report.coverage.cappedOut.length)
    lines.push(`Node cap: ${report.coverage.cappedOut.length} known nodes not fetched.`, "");
  if (report.inventory && !report.inventory.complete)
    lines.push(`Project list incomplete: ${report.inventory.reason ?? "read incomplete"}.`, "");
  if (report.coverage.depthBoundaries.length)
    lines.push(`Depth boundary: ${report.coverage.depthBoundaries.length} nodes not expanded.`, "");
  return `${lines.join("\n")}\n`;
}
