import { components, crawlGraph } from "./crawl.js";
import type { GraphCrawlOptions } from "./types.js";
import type { ReadCoverage, WorkEdge, WorkNode } from "./work-types.js";

const KEY = /^([A-Z][A-Z0-9_]*)-([1-9]\d*)$/;
const SITE = /^[a-z0-9][a-z0-9.-]*$/;

export interface JiraLocator {
  key: string;
  site?: string;
}

export function parseJiraLocator(input: string): JiraLocator {
  const key = input.toUpperCase();
  if (KEY.test(key)) return { key };
  try {
    const url = new URL(input);
    const match = url.pathname.match(/^\/browse\/([^/]+)\/?$/);
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      match &&
      KEY.test(match[1].toUpperCase())
    )
      return { key: match[1].toUpperCase(), site: url.hostname.toLowerCase() };
  } catch {}
  throw new Error("Expected a Jira issue key (ABC-123) or a https://<site>/browse/ABC-123 URL");
}

/** A TWG site: prefix, domain, or cloud ID. A bare https origin is reduced to its host. */
export function parseJiraSite(input: string): string {
  let value = input.trim().toLowerCase();
  if (/^https?:\/\//.test(value)) {
    try {
      const url = new URL(value);
      if (url.pathname === "/" && !url.search && !url.username && !url.password)
        value = url.hostname;
    } catch {}
  }
  if (!SITE.test(value))
    throw new Error("Invalid Jira site: use a site prefix, domain, or cloud ID");
  return value;
}

/** A host and a site disagree only when the site is a domain; a prefix or cloud ID is not a host. */
export function jiraSiteConflicts(host: string, site: string): boolean {
  return site.includes(".") && host !== site;
}

export function jiraNodeKey(site: string, key: string): string {
  return `jira:${site}:${key}`;
}

export interface JiraReader {
  /** How the data was read, recorded as the report's source. */
  label?: string;
  /** One work item as TWG prints it: an envelope with `data`, or the item itself. */
  issue(key: string): Promise<unknown>;
}

export class JiraReadError extends Error {
  constructor(
    readonly code: string,
    detail?: string,
  ) {
    super(detail ? `Jira read failed (${code}): ${detail}` : `Jira read failed (${code})`);
    this.name = "JiraReadError";
  }
}

export interface JiraLink {
  url: string;
  title: string;
  evidence: { kind: "remote-link"; id: string };
}

export interface JiraNode extends Omit<WorkNode, "externalLinks"> {
  provider: "jira";
  projectKey: string;
  issueType?: string;
  externalLinks: JiraLink[];
}

export interface JiraGraphOptions extends Omit<GraphCrawlOptions, "depthForEdge"> {
  site?: string;
  generatedAt?: string;
}

export interface JiraReport {
  schemaVersion: 1;
  source: "jira";
  generatedAt: string;
  site: string;
  readSource?: string;
  seeds: string[];
  scope: {
    relationships: readonly string[];
    crossProject: "one-hop";
    externalLinks: "reported-not-fetched";
    textReferences: "not-collected";
  };
  limits: Required<Omit<JiraGraphOptions, "site" | "generatedAt">>;
  coverageComplete: boolean;
  coverage: {
    failed: string[];
    partial: string[];
    cappedOut: string[];
    hubs: string[];
    depthBoundaries: string[];
  };
  nodes: JiraNode[];
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
  if (!found) throw new JiraReadError("INVALID_PAYLOAD");
  return found;
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new JiraReadError("INVALID_PAYLOAD");
  return value;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function issueKey(value: unknown): string {
  const key = text(object(value).key).toUpperCase();
  if (!KEY.test(key)) throw new JiraReadError("INVALID_PAYLOAD");
  return key;
}

function projectOf(key: string): string {
  return key.slice(0, key.lastIndexOf("-"));
}

function httpUrl(value: unknown): string | undefined {
  try {
    const url = new URL(text(value));
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password)
      return url.href;
  } catch {}
  return undefined;
}

function hostOf(value: string | undefined): string | undefined {
  return value ? new URL(value).hostname.toLowerCase() : undefined;
}

interface Decoded {
  item: RecordValue;
  fields: RecordValue;
  warnings: string[];
}

function rejectError(value: RecordValue): void {
  if (value.ok !== false && !record(value.error)) return;
  const error = record(value.error);
  const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code);
  throw new JiraReadError(code ? (error?.code as string) : "TWG_FAILED", clean(error?.message));
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

/**
 * Accepts `twg jira workitem get` output (`{ data: [item] }` with fields flattened into the item),
 * a `{ data: { issue, remoteLinks, warnings } }` envelope with fields under `issue.fields`, or a bare item.
 * Errors arrive at the top level or under `data`.
 */
function decode(payload: unknown): Decoded {
  const outer = object(payload);
  rejectError(outer);
  let data: unknown = "data" in outer ? outer.data : outer;
  if (Array.isArray(data)) {
    if (data.length !== 1) throw new JiraReadError("INVALID_PAYLOAD");
    data = data[0];
  }
  const body = object(data);
  rejectError(body);
  const issue = record(body.issue);
  const item = issue
    ? { ...issue, ...(body.remoteLinks !== undefined ? { remoteLinks: body.remoteLinks } : {}) }
    : body;
  const warnings = [
    ...new Set([...strings(outer.warnings), ...(body === outer ? [] : strings(body.warnings))]),
  ];
  return { item, fields: record(item.fields) ?? item, warnings };
}

/** The browse URL: the item's web `url`, or one derived from a site-hosted REST `self` link. */
function webUrl(item: RecordValue, key: string): string | undefined {
  const explicit = httpUrl(item.url);
  if (explicit) return explicit;
  const self = httpUrl(item.self);
  if (!self) return undefined;
  // A gateway `self` (`api.atlassian.com/ex/jira/<cloud-id>/rest/api/...`) does not name the site.
  const url = new URL(self);
  return url.pathname.startsWith("/rest/api/") ? `${url.origin}/browse/${key}` : undefined;
}

function relation(name: string): Pick<WorkEdge, "relation"> & { undirected?: boolean } {
  const normalized = name.toLowerCase();
  if (normalized === "blocks") return { relation: "blocks" };
  if (normalized === "duplicate") return { relation: "duplicate_of" };
  if (normalized === "relates") return { relation: "related", undirected: true };
  return { relation: "provider_specific" };
}

/**
 * `subtasks` lists only sub-task children, so an issue above the sub-task level (Jira
 * `hierarchyLevel` above 0) has children that are not read. An unknown level, or a missing or
 * null `subtasks` field on an issue that is not itself a sub-task, counts as unlisted.
 */
function childrenUnlisted(issueType: RecordValue | undefined, subtasksListed: boolean): boolean {
  const level = issueType?.hierarchyLevel;
  if (typeof level === "number" && Number.isInteger(level))
    return level > 0 || (level === 0 && !subtasksListed);
  return issueType?.subtask !== true;
}

function normalize(
  payload: unknown,
  requested: string,
  site: string,
  depth: number,
): JiraNode & { webHost?: string; childrenUnlisted: boolean } {
  const { item, fields, warnings } = decode(payload);
  const key = issueKey(item);
  if (key !== requested) throw new JiraReadError("IDENTITY_MISMATCH");
  const edges: WorkEdge[] = [];
  const links = fields.issuelinks ?? [];
  if (!Array.isArray(links)) throw new JiraReadError("INVALID_PAYLOAD");
  for (const value of links) {
    const link = object(value);
    const type = object(link.type);
    const name = text(type.name);
    const outgoing = link.outwardIssue !== undefined;
    const target = issueKey(outgoing ? link.outwardIssue : link.inwardIssue);
    const mapped = relation(name);
    edges.push({
      to: jiraNodeKey(site, target),
      relation: mapped.relation,
      direction: mapped.undirected ? "undirected" : outgoing ? "outgoing" : "incoming",
      nativeRelation: name,
      evidence: { kind: "relation", id: String(link.id ?? `${name}:${target}`) },
    });
  }
  const subtasks: unknown[] | undefined = Array.isArray(fields.subtasks)
    ? fields.subtasks
    : undefined;
  if (fields.subtasks != null && !subtasks) throw new JiraReadError("INVALID_PAYLOAD");
  for (const [value, direction] of [
    ...(fields.parent ? [[fields.parent, "incoming"]] : []),
    ...(subtasks ?? []).map((child) => [child, "outgoing"]),
  ] as Array<[unknown, "incoming" | "outgoing"]>) {
    const related = issueKey(value);
    edges.push({
      to: jiraNodeKey(site, related),
      relation: "parent_of",
      direction,
      nativeRelation: "parent",
      evidence: { kind: "hierarchy", id: direction === "outgoing" ? related : key },
    });
  }
  const remote = item.remoteLinks ?? [];
  if (!Array.isArray(remote)) throw new JiraReadError("INVALID_PAYLOAD");
  const externalLinks: JiraLink[] = remote.flatMap((value) => {
    const link = object(value);
    const target = record(link.object);
    const url = httpUrl(target?.url);
    if (!url) return [];
    return [
      {
        url,
        title: optionalText(target?.title) ?? url,
        evidence: { kind: "remote-link" as const, id: String(link.id ?? url) },
      },
    ];
  });
  const status = object(fields.status);
  const reported = webUrl(item, key);
  const url = reported ?? (site.includes(".") ? `https://${site}/browse/${key}` : "");
  const coverage: ReadCoverage[] = warnings.length
    ? [{ source: "twg warnings", pages: 1, complete: false, reason: "read-failed" }]
    : [];
  const issueType = record(fields.issuetype);
  const byIdentity = new Map(
    edges.map((edge) => [
      `${edge.to}\0${edge.relation}\0${edge.direction}\0${edge.evidence.id}`,
      edge,
    ]),
  );
  return {
    key: jiraNodeKey(site, key),
    provider: "jira",
    authority: site,
    nativeId: optionalText(item.id) ?? key,
    kind: "issue",
    identifier: key,
    projectKey: optionalText(record(fields.project)?.key)?.toUpperCase() ?? projectOf(key),
    issueType: optionalText(issueType?.name) ?? optionalText(fields.issuetype),
    title: text(fields.summary),
    url,
    state: {
      name: text(status.name),
      type: optionalText(record(status.statusCategory)?.key) ?? "unknown",
    },
    updatedAt: optionalText(fields.updated) ?? "",
    archived: false,
    fetched: true,
    depth,
    edges: [...byIdentity.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, edge]) => edge),
    externalLinks: [...new Map(externalLinks.map((link) => [link.evidence.id, link])).values()],
    coverage,
    webHost: hostOf(reported),
    childrenUnlisted: childrenUnlisted(issueType, subtasks !== undefined),
  };
}

type Normalized = ReturnType<typeof normalize>;

function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/\p{Cc}/gu, " ").trim();
  return cleaned ? cleaned.slice(0, 300) : undefined;
}

function unavailable(site: string, key: string, depth: number, error: unknown): JiraNode {
  return {
    key: jiraNodeKey(site, key),
    provider: "jira",
    authority: site,
    nativeId: key,
    kind: "issue",
    identifier: key,
    projectKey: projectOf(key),
    title: "Unavailable",
    url: site.includes(".") ? `https://${site}/browse/${key}` : "",
    state: { name: "Unknown", type: "unknown" },
    updatedAt: "",
    archived: false,
    fetched: false,
    error:
      error instanceof JiraReadError && /^[A-Z0-9_]{1,64}$/.test(error.code)
        ? error.code
        : "READ_FAILED",
    depth,
    edges: [],
    externalLinks: [],
    coverage: [],
  };
}

function validateOptions(options: JiraGraphOptions): void {
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
 * Reads a bounded Jira neighborhood. Same-project links recurse to `maxDepth`;
 * links into other projects are read one hop and not expanded.
 */
export async function buildJiraGraph(
  reader: JiraReader,
  seed: string,
  options: JiraGraphOptions,
): Promise<JiraReport> {
  validateOptions(options);
  const locator = parseJiraLocator(seed);
  const requested = options.site ? parseJiraSite(options.site) : undefined;
  if (locator.site && requested && jiraSiteConflicts(locator.site, requested))
    throw new Error("Jira URL and --site disagree");
  const given = locator.site ?? requested;
  // The seed's web URL names the site authoritatively; a prefix or cloud ID cannot be compared.
  const payload = await reader.issue(locator.key);
  const probe = normalize(payload, locator.key, given ?? "pending", 0);
  if (given && probe.webHost && jiraSiteConflicts(probe.webHost, given))
    throw new JiraReadError("SITE_MISMATCH", `${locator.key} belongs to ${probe.webHost}`);
  if (locator.site && requested && requested !== locator.site && !probe.webHost)
    throw new JiraReadError(
      "SITE_UNKNOWN",
      `twg did not confirm that ${requested} is ${locator.site}`,
    );
  const site = probe.webHost ?? given;
  if (!site) throw new JiraReadError("SITE_UNKNOWN", "pass --site or a browse URL");
  const first = normalize(payload, locator.key, site, 0);
  const firstPayloadKey = first.key;
  const limits = {
    maxDepth: options.maxDepth,
    maxNodes: options.maxNodes,
    hubThreshold: options.hubThreshold,
    concurrency: options.concurrency ?? 4,
  };
  const prefix = `jira:${site}:`;
  const seedProject = first.projectKey;
  const unlistedChildren = new Set<string>();
  // Unlisted children make an expanded issue partial; at the depth limit they are a boundary.
  const finish = (node: Normalized, depth: number): JiraNode => {
    if (node.childrenUnlisted) {
      if (depth < limits.maxDepth)
        node.coverage.push({ source: "child issues", pages: 0, complete: false });
      else unlistedChildren.add(node.key);
    }
    return strip(node);
  };
  const { nodes, cappedOut } = await crawlGraph<JiraNode>(
    [{ key: firstPayloadKey }],
    {
      ...limits,
      depthForEdge: ({ edge, sourceDepth, maxDepth }) => {
        if (!edge.to.startsWith(prefix)) return null;
        return projectOf(edge.to.slice(prefix.length)) === seedProject ? sourceDepth + 1 : maxDepth;
      },
    },
    async (key, depth) => {
      if (key === firstPayloadKey) return finish(first, depth);
      const target = key.slice(prefix.length);
      try {
        const node = normalize(await reader.issue(target), target, site, depth);
        if (node.webHost && jiraSiteConflicts(node.webHost, site))
          throw new JiraReadError("SITE_MISMATCH");
        return finish(node, depth);
      } catch (error) {
        return unavailable(site, target, depth, error);
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
      .filter(
        (node) =>
          unlistedChildren.has(node.key) ||
          (node.depth === limits.maxDepth && node.edges.some((e) => !nodes.has(e.to))),
      )
      .map((node) => node.key),
  };
  return {
    schemaVersion: 1,
    source: "jira",
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    site,
    ...(reader.label ? { readSource: reader.label } : {}),
    seeds: [first.key],
    scope: {
      relationships: ["issuelinks", "parent", "subtasks", "remoteLinks"],
      crossProject: "one-hop",
      externalLinks: "reported-not-fetched",
      textReferences: "not-collected",
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

function strip(node: Normalized): JiraNode {
  const { webHost: _, childrenUnlisted: __, ...rest } = node;
  return rest;
}

function markdown(value: string): string {
  return value.replace(/\p{Cc}/gu, " ").replace(/[\\`*_[\]<>|]/g, "\\$&");
}

export function renderJira(report: JiraReport): string {
  const lines = [
    `# Jira graph · ${markdown(report.site)}`,
    "",
    `Coverage: ${report.coverageComplete ? "complete within requested scope" : "partial"} · ${report.nodes.length} nodes · depth ${report.limits.maxDepth}`,
    "",
    "Issue links, parents, and subtasks. Links into other projects are read one hop. Remote link URLs are reported without fetching their targets. Text mentions are not collected.",
    "",
  ];
  const labels = new Map(report.nodes.map((node) => [node.key, node.identifier]));
  for (const node of report.nodes) {
    lines.push(
      `## ${markdown(node.identifier)} · ${markdown(node.title)}`,
      "",
      `Status: ${markdown(node.state.name)}${node.issueType ? ` · ${markdown(node.issueType)}` : ""}${node.hub ? " · hub not expanded" : ""}`,
      "",
    );
    if (node.url) lines.push(markdown(node.url), "");
    if (!node.fetched) lines.push(`Read failed: ${node.error ?? "READ_FAILED"}`, "");
    for (const edge of node.edges) {
      const arrow =
        edge.direction === "incoming" ? "←" : edge.direction === "undirected" ? "↔" : "→";
      lines.push(
        `- ${arrow} ${markdown(edge.nativeRelation)}: ${markdown(labels.get(edge.to) ?? edge.to.slice(edge.to.lastIndexOf(":") + 1))}`,
      );
    }
    for (const link of node.externalLinks)
      lines.push(`- Remote link: ${markdown(link.title)} · ${markdown(link.url)}`);
    for (const part of node.coverage.filter((part) => !part.complete))
      lines.push(`- Incomplete ${part.source}: ${part.reason ?? "not read"}`);
    lines.push("");
  }
  if (report.coverage.cappedOut.length)
    lines.push(`Node cap: ${report.coverage.cappedOut.length} known nodes not fetched.`, "");
  if (report.coverage.depthBoundaries.length)
    lines.push(`Depth boundary: ${report.coverage.depthBoundaries.length} nodes not expanded.`, "");
  return `${lines.join("\n")}\n`;
}
