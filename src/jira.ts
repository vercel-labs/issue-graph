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
import type { ReadCoverage, WorkEdge, WorkNode } from "./work-types.js";

const KEY = /^([A-Z][A-Z0-9_]*)-([1-9]\d*)$/;
const SITE = /^[a-z0-9][a-z0-9.-]*$/;
const CLOUD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SUBTASK_TYPE = /^sub-?task$/i;

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
      KEY.test(match[1].toUpperCase()) &&
      SITE.test(url.hostname.toLowerCase())
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

/**
 * A domain must equal the host and a prefix must be its first label. A cloud ID names no host,
 * so twg resolving it is the only check.
 */
export function jiraSiteConflicts(host: string, site: string): boolean {
  if (site.includes(".")) return host !== site;
  if (CLOUD_ID.test(site)) return false;
  return host.split(".")[0] !== site;
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

export interface JiraGraphOptions extends Omit<GraphCrawlOptions, "depthForEdge" | "expand"> {
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
  coverage: WorkCoverage;
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
  incomplete: boolean;
}

/** twg `meta`: `partial`, `evidence.coverage.status`, or `evidence.truncation.truncated`. */
function metaIncomplete(value: unknown): boolean {
  const meta = record(value);
  const evidence = record(meta?.evidence);
  return (
    meta?.partial === true ||
    record(evidence?.coverage)?.status === "partial" ||
    record(evidence?.truncation)?.truncated === true
  );
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
  const incomplete = metaIncomplete(outer.meta) || (body !== outer && metaIncomplete(body.meta));
  return { item, fields: record(item.fields) ?? item, warnings, incomplete };
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
function childrenUnlisted(
  issueType: RecordValue | undefined,
  typeName: string | undefined,
  subtasksListed: boolean,
): boolean {
  const level = issueType?.hierarchyLevel;
  if (typeof level === "number" && Number.isInteger(level))
    return level > 0 || (level === 0 && !subtasksListed);
  return issueType?.subtask !== true && !SUBTASK_TYPE.test(typeName ?? "");
}

function normalize(
  payload: unknown,
  requested: string,
  site: string,
  depth: number,
): JiraNode & { webHost?: string; childrenUnlisted: boolean } {
  const { item, fields, warnings, incomplete } = decode(payload);
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
  const coverage: ReadCoverage[] = [
    ...(warnings.length
      ? [{ source: "twg warnings", pages: 1, complete: false, reason: "read-failed" as const }]
      : []),
    ...(incomplete
      ? [{ source: "twg coverage", pages: 1, complete: false, reason: "read-failed" as const }]
      : []),
  ];
  const issueType = record(fields.issuetype);
  const typeName = optionalText(issueType?.name) ?? optionalText(fields.issuetype);
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
    issueType: typeName,
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
    childrenUnlisted: childrenUnlisted(issueType, typeName, subtasks !== undefined),
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

/**
 * Reads a bounded Jira neighborhood. Same-project links recurse to `maxDepth`;
 * links into other projects are read one hop and not expanded.
 */
export async function buildJiraGraph(
  reader: JiraReader,
  seed: string,
  options: JiraGraphOptions,
): Promise<JiraReport> {
  validateWorkLimits(options, 16);
  const locator = parseJiraLocator(seed);
  const requested = options.site ? parseJiraSite(options.site) : undefined;
  if (locator.site && requested && jiraSiteConflicts(locator.site, requested))
    throw new Error("Jira URL and --site disagree");
  const given = locator.site ?? requested;
  // The seed's web URL names the site authoritatively; a cloud ID can only be confirmed by it.
  const payload = await reader.issue(locator.key);
  const probe = normalize(payload, locator.key, given ?? "pending", 0);
  if (given && probe.webHost && jiraSiteConflicts(probe.webHost, given))
    throw new JiraReadError("SITE_MISMATCH", `${locator.key} belongs to ${probe.webHost}`);
  if (locator.site && requested && CLOUD_ID.test(requested) && !probe.webHost)
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
  const expandable = (key: string) => projectOf(key.slice(prefix.length)) === seedProject;
  const unlistedChildren = new Set<string>();
  // Unlisted children make an expanded issue partial; on an unexpanded issue they are a boundary.
  const finish = (node: Normalized, depth: number): JiraNode => {
    if (node.childrenUnlisted) {
      if (depth < limits.maxDepth && expandable(node.key))
        node.coverage.push({ source: "child issues", pages: 0, complete: false });
      else unlistedChildren.add(node.key);
    }
    return strip(node);
  };
  const { nodes, cappedOut } = await crawlGraph<JiraNode>(
    [{ key: firstPayloadKey }],
    {
      ...limits,
      // Links into other projects sit one hop out, read but not expanded.
      expand: expandable,
      depthForEdge: ({ edge, sourceDepth }) =>
        edge.to.startsWith(prefix) ? sourceDepth + 1 : null,
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
  const { coverage, coverageComplete } = workCoverage(
    nodes,
    cappedOut,
    (node) =>
      unlistedChildren.has(node.key) ||
      ((node.depth === limits.maxDepth || !expandable(node.key)) && hasUnreadEdges(node, nodes)),
  );
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
    coverageComplete,
    coverage,
    nodes: [...nodes.values()],
    components: components(nodes),
  };
}

function strip(node: Normalized): JiraNode {
  const { webHost: _, childrenUnlisted: __, ...rest } = node;
  return rest;
}

export function renderJira(report: JiraReport): string {
  return renderWorkMarkdown(report, {
    title: `Jira graph · ${report.site}`,
    scope:
      "Issue links, parents, and subtasks. Links into other projects are read one hop. Remote link URLs are reported without fetching their targets. Text mentions are not collected.",
    status: (node) => (node.issueType ? ` · ${markdownText(node.issueType)}` : ""),
    links: (node) =>
      node.externalLinks.map(
        (link) => `- Remote link: ${markdownText(link.title)} · ${markdownText(link.url)}`,
      ),
  });
}
