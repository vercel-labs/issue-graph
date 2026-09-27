import { components } from "./crawl.js";
import type { CrawlEdge, CrawlNode, GraphCrawlResult, NodeKey } from "./types.js";

const JIRA_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;
const JIRA_KEY_IN_TEXT = /\b[A-Z][A-Z0-9_]*-\d+\b/gi;
const GITHUB_URL = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)(?:[/?#]|$)/i;
const JIRA_BROWSE_URL = /\/browse\/([A-Z][A-Z0-9_]*-\d+)(?:[/?#]|$)/i;

export type JiraReferenceVia = "issue-link" | "text" | "remote-link";

export interface JiraEdge extends CrawlEdge {
  via: JiraReferenceVia;
  relation?: string;
  url?: string;
}

export interface JiraNode extends CrawlNode {
  source: "jira";
  issueKey: string;
  title: string;
  status: string;
  issueType: string;
  url: string;
  updatedAt?: string;
  assignee?: string;
  fetched: boolean;
  fetchError?: string;
  edges: JiraEdge[];
  externalLinks: string[];
}

export interface JiraReader {
  getIssue(issueKey: string, site?: string): Promise<unknown>;
}

export interface JiraReportLimits {
  maxDepth: number;
  maxNodes: number;
  hubThreshold: number;
  concurrency: number;
}

export interface JiraReport {
  schemaVersion: 1;
  source: "jira-twg";
  generatedAt: string;
  site?: string;
  seeds: string[];
  limits: JiraReportLimits;
  coverageComplete: boolean;
  coverage: {
    fetched: number;
    failed: string[];
    cappedOut: string[];
  };
  nodes: JiraNode[];
  components: NodeKey[][];
}

export class JiraPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JiraPayloadError";
  }
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nestedString(value: unknown, ...paths: string[][]): string | undefined {
  for (const path of paths) {
    let current: unknown = value;
    for (const part of path) current = record(current)?.[part];
    const found = string(current);
    if (found) return found;
  }
  return undefined;
}

export function normalizeJiraKey(value: unknown): string | null {
  const key = string(value)?.toUpperCase();
  return key && JIRA_KEY.test(key) ? key : null;
}

export function jiraNodeKey(issueKey: string): NodeKey {
  const normalized = normalizeJiraKey(issueKey);
  if (!normalized) throw new JiraPayloadError(`Invalid Jira issue key: ${issueKey}`);
  return `jira:${normalized}`;
}

export function jiraIssueKey(nodeKey: NodeKey): string | null {
  return nodeKey.startsWith("jira:") ? normalizeJiraKey(nodeKey.slice(5)) : null;
}

export function jiraProject(issueKey: string): string {
  const normalized = normalizeJiraKey(issueKey);
  if (!normalized) throw new JiraPayloadError(`Invalid Jira issue key: ${issueKey}`);
  return normalized.slice(0, normalized.lastIndexOf("-"));
}

function issueScore(candidate: UnknownRecord): number {
  const fields = record(candidate.fields);
  let score = 0;
  if (fields) score += 8;
  if (string(fields?.summary) || string(candidate.summary) || string(candidate.title)) score += 4;
  if (record(fields?.status) || string(candidate.status)) score += 2;
  if (string(candidate.self) || string(candidate.url) || string(candidate.webUrl)) score += 1;
  return score;
}

function findIssue(payload: unknown, requestedKey: string): UnknownRecord | null {
  const queue: Array<{ value: unknown; depth: number }> = [{ value: payload, depth: 0 }];
  const seen = new Set<object>();
  const candidates: UnknownRecord[] = [];
  let visited = 0;
  while (queue.length && visited < 10_000) {
    const { value, depth } = queue.shift() as { value: unknown; depth: number };
    if (value === null || typeof value !== "object" || seen.has(value) || depth > 12) continue;
    seen.add(value);
    visited++;
    if (Array.isArray(value)) {
      for (const child of value) queue.push({ value: child, depth: depth + 1 });
      continue;
    }
    const candidate = value as UnknownRecord;
    if (normalizeJiraKey(candidate.key ?? candidate.issueKey) === requestedKey)
      candidates.push(candidate);
    for (const child of Object.values(candidate))
      if (child !== null && typeof child === "object")
        queue.push({ value: child, depth: depth + 1 });
  }
  return candidates.sort((a, b) => issueScore(b) - issueScore(a))[0] ?? null;
}

function payloadError(payload: unknown): string | null {
  return (
    nestedString(payload, ["error", "message"], ["message"], ["data", "error", "message"]) ?? null
  );
}

function collectText(value: unknown, output: string[], depth = 0): void {
  if (depth > 20 || value === null || value === undefined) return;
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) collectText(child, output, depth + 1);
    return;
  }
  const object = record(value);
  if (!object) return;
  for (const child of Object.values(object)) collectText(child, output, depth + 1);
}

function namedArrays(payload: unknown, names: Set<string>): unknown[][] {
  const arrays: unknown[][] = [];
  const queue: Array<{ value: unknown; depth: number }> = [{ value: payload, depth: 0 }];
  const seen = new Set<object>();
  let visited = 0;
  while (queue.length && visited < 10_000) {
    const { value, depth } = queue.shift() as { value: unknown; depth: number };
    if (value === null || typeof value !== "object" || seen.has(value) || depth > 12) continue;
    seen.add(value);
    visited++;
    if (Array.isArray(value)) {
      for (const child of value) queue.push({ value: child, depth: depth + 1 });
      continue;
    }
    for (const [name, child] of Object.entries(value as UnknownRecord)) {
      if (names.has(name) && Array.isArray(child)) arrays.push(child);
      if (child !== null && typeof child === "object")
        queue.push({ value: child, depth: depth + 1 });
    }
  }
  return arrays;
}

function issueUrl(issue: UnknownRecord, fields: UnknownRecord, issueKey: string): string {
  const explicit =
    string(issue.webUrl) ?? string(issue.browseUrl) ?? string(issue.url) ?? string(fields.url);
  if (explicit) return explicit;
  const self = string(issue.self);
  const site = self?.match(/^(https?:\/\/[^/]+)\/rest\/api\//)?.[1];
  return site ? `${site}/browse/${issueKey}` : (self ?? "");
}

function addEdge(edges: Map<NodeKey, JiraEdge>, edge: JiraEdge): void {
  const existing = edges.get(edge.to);
  if (!existing || (existing.via === "text" && edge.via !== "text")) edges.set(edge.to, edge);
}

function linkedIssue(value: unknown): { key: string; url?: string } | null {
  const object = record(value);
  const key = normalizeJiraKey(object?.key ?? object?.issueKey);
  if (!key) return null;
  return { key, url: string(object?.self) ?? string(object?.url) };
}

function textKeys(value: unknown): string[] {
  const text: string[] = [];
  collectText(value, text);
  return [
    ...new Set(
      text.flatMap((part) => part.match(JIRA_KEY_IN_TEXT) ?? []).map((key) => key.toUpperCase()),
    ),
  ];
}

function commentBodies(payload: unknown, fields: UnknownRecord): unknown[] {
  const direct = record(fields.comment)?.comments;
  const values = Array.isArray(direct) ? [...direct] : [];
  for (const group of namedArrays(payload, new Set(["comments"]))) values.push(...group);
  return values.map((comment) => record(comment)?.body ?? record(comment)?.content ?? comment);
}

function remoteUrls(payload: unknown, issue: UnknownRecord): string[] {
  const groups = namedArrays(payload, new Set(["remoteLinks"]));
  if (Array.isArray(issue.remoteLinks)) groups.push(issue.remoteLinks);
  const urls = new Set<string>();
  for (const item of groups.flat()) {
    const url = nestedString(
      item,
      ["object", "url"],
      ["url"],
      ["href"],
      ["webUrl"],
      ["link", "url"],
    );
    if (url && /^https?:\/\//i.test(url)) urls.add(url);
  }
  return [...urls];
}

export function normalizeJiraPayload(
  payload: unknown,
  requestedKey: string,
  depth: number,
): JiraNode {
  const issueKey = normalizeJiraKey(requestedKey);
  if (!issueKey) throw new JiraPayloadError(`Invalid Jira issue key: ${requestedKey}`);
  const issue = findIssue(payload, issueKey);
  if (!issue)
    throw new JiraPayloadError(
      payloadError(payload) ?? `TWG returned no Jira work item matching ${issueKey}`,
    );
  const fields = record(issue.fields) ?? issue;
  const edges = new Map<NodeKey, JiraEdge>();

  const issueLinks = [
    ...(Array.isArray(fields.issuelinks) ? fields.issuelinks : []),
    ...(Array.isArray(issue.issueLinks) ? issue.issueLinks : []),
  ];
  for (const rawLink of issueLinks) {
    const link = record(rawLink);
    if (!link) continue;
    const type = record(link.type);
    const outward = linkedIssue(link.outwardIssue);
    const inward = linkedIssue(link.inwardIssue);
    const generic = linkedIssue(link.issue ?? link.workItem);
    for (const [target, relation] of [
      [outward, string(type?.outward) ?? string(type?.name)],
      [inward, string(type?.inward) ?? string(type?.name)],
      [generic, string(link.relation) ?? string(type?.name)],
    ] as const) {
      if (!target || target.key === issueKey) continue;
      addEdge(edges, {
        to: jiraNodeKey(target.key),
        via: "issue-link",
        relation,
        url: target.url,
      });
    }
  }

  const textSources = [fields.summary, fields.description, ...commentBodies(payload, fields)];
  for (const key of textKeys(textSources))
    if (key !== issueKey) addEdge(edges, { to: jiraNodeKey(key), via: "text" });

  const externalLinks = remoteUrls(payload, issue);
  for (const url of externalLinks) {
    const jira = url.match(JIRA_BROWSE_URL)?.[1];
    if (jira && normalizeJiraKey(jira) !== issueKey)
      addEdge(edges, { to: jiraNodeKey(jira), via: "remote-link", url });
    const github = url.match(GITHUB_URL);
    if (github)
      addEdge(edges, {
        to: `github:${github[1]}/${github[2]}#${github[3]}`,
        via: "remote-link",
        url,
      });
  }

  return {
    key: jiraNodeKey(issueKey),
    source: "jira",
    issueKey,
    title: string(fields.summary) ?? string(issue.summary) ?? string(issue.title) ?? "",
    status:
      nestedString(fields.status, ["name"], ["displayName"], ["value"]) ??
      string(fields.status) ??
      "UNKNOWN",
    issueType:
      nestedString(fields.issuetype ?? fields.issueType, ["name"], ["displayName"]) ??
      string(fields.issuetype ?? fields.issueType) ??
      "Issue",
    url: issueUrl(issue, fields, issueKey),
    updatedAt: string(fields.updated) ?? string(issue.updatedAt),
    assignee:
      nestedString(fields.assignee, ["displayName"], ["name"], ["accountId"]) ??
      string(fields.assignee),
    depth,
    fetched: true,
    edges: [...edges.values()],
    externalLinks,
  };
}

function cleanText(value: string): string {
  let cleaned = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    cleaned += code <= 31 || code === 127 ? " " : character;
  }
  return cleaned.replaceAll(/\s+/g, " ").trim();
}

function safeError(error: unknown): string {
  return cleanText(error instanceof Error ? error.message : String(error)).slice(0, 300);
}

export async function fetchJiraNode(
  reader: JiraReader,
  nodeKey: NodeKey,
  depth: number,
  site?: string,
): Promise<JiraNode> {
  const issueKey = jiraIssueKey(nodeKey);
  if (!issueKey) throw new JiraPayloadError(`Cannot fetch non-Jira node key: ${nodeKey}`);
  try {
    return normalizeJiraPayload(await reader.getIssue(issueKey, site), issueKey, depth);
  } catch (error) {
    return {
      key: nodeKey,
      source: "jira",
      issueKey,
      title: "",
      status: "UNKNOWN",
      issueType: "Issue",
      url: "",
      depth,
      fetched: false,
      fetchError: safeError(error),
      edges: [],
      externalLinks: [],
    };
  }
}

export function jiraDepthForEdge(seedKey: string) {
  const seedProject = jiraProject(seedKey);
  return ({
    edge,
    sourceDepth,
    maxDepth,
  }: {
    edge: CrawlEdge;
    sourceDepth: number;
    maxDepth: number;
  }) => {
    const target = jiraIssueKey(edge.to);
    if (!target) return null;
    if (jiraProject(target) === seedProject) return sourceDepth + 1;
    // Free-text matches can be ordinary hyphenated tokens (for example UTF-8),
    // so only structured cross-project references are trustworthy boundaries.
    if ("via" in edge && edge.via === "text") return null;
    return maxDepth;
  };
}

export function buildJiraReport(
  seedKey: string,
  site: string | undefined,
  limits: JiraReportLimits,
  result: GraphCrawlResult<JiraNode>,
  generatedAt = new Date().toISOString(),
): JiraReport {
  const nodes = [...result.nodes.values()].sort(
    (a, b) => a.depth - b.depth || a.issueKey.localeCompare(b.issueKey),
  );
  const failed = nodes.filter((node) => !node.fetched).map((node) => node.issueKey);
  const cappedOut = [...result.cappedOut].sort();
  return {
    schemaVersion: 1,
    source: "jira-twg",
    generatedAt,
    ...(site ? { site } : {}),
    seeds: [normalizeJiraKey(seedKey) as string],
    limits,
    coverageComplete: failed.length === 0 && cappedOut.length === 0,
    coverage: { fetched: nodes.length - failed.length, failed, cappedOut },
    nodes,
    components: components(result.nodes),
  };
}

const MARKDOWN_SPECIAL = new Set("\\`*_{}[]()<>#!|~".split(""));

function markdownText(value: string): string {
  let escaped = "";
  for (const character of cleanText(value))
    escaped += MARKDOWN_SPECIAL.has(character) ? `\\${character}` : character;
  return escaped;
}

function normalizedHttpUrl(value: string): string | null {
  try {
    const url = new URL(cleanText(value));
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href
      .replaceAll("\\", "%5C")
      .replaceAll("(", "%28")
      .replaceAll(")", "%29")
      .replaceAll("[", "%5B")
      .replaceAll("]", "%5D");
  } catch {
    return null;
  }
}

function markdownLink(label: string, value: string): string {
  const url = normalizedHttpUrl(value);
  return url ? `[${markdownText(label)}](<${url}>)` : markdownText(label);
}

export function renderJiraReport(report: JiraReport): string {
  const lines = [
    `# Jira issue graph: ${report.seeds[0]}`,
    "",
    `Source: TWG CLI${report.site ? ` · Site: ${markdownText(report.site)}` : ""}`,
    `Nodes: ${report.nodes.length} · Coverage: ${report.coverageComplete ? "complete" : "incomplete"}`,
    "",
    "## Issues",
    "",
  ];
  for (const node of report.nodes) {
    const title = markdownText(node.title) || "(no title)";
    const status = markdownText(node.status);
    const type = markdownText(node.issueType);
    const link = markdownLink(node.issueKey, node.url);
    const hub = node.hub ? " · hub, not expanded" : "";
    const failed = node.fetched
      ? ""
      : ` · FAILED: ${markdownText(node.fetchError ?? "unknown error")}`;
    lines.push(
      `- **${link}** · ${type} · ${status} · depth ${node.depth}${hub}${failed} — ${title}`,
    );
    for (const edge of node.edges) {
      const target = edge.to.startsWith("jira:") ? edge.to.slice(5) : edge.to;
      const relation = edge.relation ? `${markdownText(edge.relation)} ` : "";
      const boundary = report.nodes.some((candidate) => candidate.key === edge.to)
        ? ""
        : " _(not crawled)_";
      lines.push(`  - ${relation}${edge.via} → ${markdownText(target)}${boundary}`);
    }
    for (const value of node.externalLinks) {
      const url = normalizedHttpUrl(value);
      lines.push(
        url ? `  - external → [external link](<${url}>)` : `  - external → ${markdownText(value)}`,
      );
    }
  }
  if (report.coverage.cappedOut.length) {
    lines.push("", `## Not crawled (node cap): ${report.coverage.cappedOut.length}`, "");
    for (const key of report.coverage.cappedOut) lines.push(`- ${markdownText(key)}`);
  }
  return `${lines.join("\n")}\n`;
}
