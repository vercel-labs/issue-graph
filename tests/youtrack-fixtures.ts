import { YouTrackReadError, type YouTrackReader } from "../src/youtrack.js";

export const BASE = "https://acme.youtrack.cloud";

export interface LinkFixture {
  type: "Depend" | "Duplicate" | "Subtask" | "Relates" | string;
  direction: "OUTWARD" | "INWARD" | "BOTH";
  targets: string[];
}

export interface IssueFixture {
  summary?: string;
  resolved?: number | null;
  state?: string;
  links?: LinkFixture[];
  /** Pull request activity items in stream order; entries are [url, title, changeId?]. */
  pulls?: Array<{
    timestamp: number;
    state?: string;
    added?: Array<[string, string] | [string, string, string]>;
    removed?: Array<[string, string] | [string, string, string]>;
  }>;
  /** Commit activity items in stream order; entries are [url, version, changeId?]. */
  commits?: Array<{
    timestamp: number;
    added?: Array<[string, string] | [string, string, string]>;
    removed?: Array<[string, string] | [string, string, string]>;
  }>;
}

const TYPES: Record<
  string,
  { name: string; sourceToTarget: string; targetToSource: string; directed: boolean }
> = {
  Depend: {
    name: "Depend",
    sourceToTarget: "is required for",
    targetToSource: "depends on",
    directed: true,
  },
  Duplicate: {
    name: "Duplicate",
    sourceToTarget: "is duplicated by",
    targetToSource: "duplicates",
    directed: true,
  },
  Subtask: {
    name: "Subtask",
    sourceToTarget: "parent for",
    targetToSource: "subtask of",
    directed: true,
  },
  Relates: { name: "Relates", sourceToTarget: "relates to", targetToSource: "", directed: false },
};

const ORDER = ["Depend", "Duplicate", "Subtask", "Relates"];

export function linkType(name: string) {
  return (
    TYPES[name] ?? {
      name,
      sourceToTarget: `${name} out`,
      targetToSource: `${name} in`,
      directed: true,
    }
  );
}

export const databaseId = (id: string) => `2-${id.replace(/\D/g, "")}${id[0].toLowerCase()}`;

export interface Calls {
  paths: string[];
  queries: Array<Record<string, string>>;
}

/** A YouTrack REST API fixture: the documented resources and shapes, served from a map. */
export function fakeYouTrack(
  issues: Record<string, IssueFixture>,
  options: { fail?: (path: string) => Error | undefined; calls?: Calls; baseUrl?: string } = {},
): YouTrackReader {
  const byDatabase = new Map(Object.keys(issues).map((id) => [databaseId(id), id]));
  const linkId = (db: string, type: string, direction: string) =>
    `${db}:${type}:${direction === "OUTWARD" ? "s" : "t"}`;
  return {
    label: "fixture",
    baseUrl: options.baseUrl ?? BASE,
    async get(path, query = {}) {
      options.calls?.paths.push(path);
      options.calls?.queries.push(query);
      const failure = options.fail?.(path);
      if (failure) throw failure;
      const parts = path.split("/").map(decodeURIComponent);
      if (parts[0] !== "issues") throw new YouTrackReadError("NOT_FOUND");
      const key = parts[1];
      const id =
        byDatabase.get(key) ??
        Object.keys(issues).find((i) => i.toLowerCase() === key.toLowerCase());
      if (!id) throw new YouTrackReadError("NOT_FOUND");
      const issue = issues[id];
      const db = databaseId(id);
      const top = Number(query.$top ?? 42);
      const skip = Number(query.$skip ?? 0);
      if (parts.length === 2)
        return {
          id: db,
          idReadable: id,
          summary: issue.summary ?? `Summary ${id}`,
          resolved: issue.resolved ?? null,
          updated: 1_700_000_000_000,
          project: { shortName: id.slice(0, id.lastIndexOf("-")) },
          customFields: [
            { name: "Priority", value: { name: "Major" } },
            {
              name: "State",
              value: {
                name: issue.state ?? (issue.resolved ? "Done" : "Open"),
                isResolved: Boolean(issue.resolved),
              },
            },
          ],
        };
      const entries = (issue.links ?? [])
        .slice()
        .sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type));
      if (parts[2] === "links" && parts.length === 3)
        return entries
          .map((link) => ({
            id: linkId(db, link.type, link.direction),
            direction: link.direction,
            linkType: { id: `t-${link.type}`, ...linkType(link.type) },
            issues: link.targets.map((target) => ({ id: databaseId(target) })),
          }))
          .slice(skip, skip + top);
      if (parts[2] === "links" && parts[4] === "issues") {
        const link = entries.find((entry) => linkId(db, entry.type, entry.direction) === parts[3]);
        return (link?.targets ?? [])
          .map((target) => ({ id: databaseId(target), idReadable: target }))
          .slice(skip, skip + top);
      }
      if (parts[2] === "activitiesPage") {
        const commits = query.categories === "VcsChangeCategory";
        const items = (commits ? issue.commits : issue.pulls) ?? [];
        const change = (
          entry: [string, string] | [string, string, string],
          index: number,
          state?: string,
        ) =>
          commits
            ? { id: entry[2] ?? `c-${index}`, urls: [entry[0]], version: entry[1] }
            : {
                id: entry[2] ?? `p-${index}`,
                ...(state ? { state: { id: state } } : {}),
                pullRequest: { url: entry[0], title: entry[1] },
              };
        return {
          activities: items.map((item, index) => ({
            id: `a-${index}`,
            timestamp: item.timestamp,
            added: (item.added ?? []).map((entry) =>
              change(
                entry,
                index,
                "state" in item ? (item.state as string | undefined) : undefined,
              ),
            ),
            removed: (item.removed ?? []).map((entry) => change(entry, index)),
          })),
          hasAfter: false,
          afterCursor: "end",
        };
      }
      throw new YouTrackReadError("NOT_FOUND");
    },
  };
}

/** Serves `fakeYouTrack` over HTTP on a loopback port, with the token it must be sent. */
export async function serveYouTrack(
  issues: Record<string, IssueFixture>,
  token: string,
): Promise<{ url: string; requests: string[]; close(): Promise<void> }> {
  const { createServer } = await import("node:http");
  const reader = fakeYouTrack(issues);
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    requests.push(request.url ?? "");
    const url = new URL(request.url ?? "/", "http://localhost");
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.headers.authorization !== `Bearer ${token}`) return send(401, {});
    try {
      const path = url.pathname.replace(/^\/youtrack\/api\//, "");
      send(200, await reader.get(path, Object.fromEntries(url.searchParams)));
    } catch (error) {
      send(error instanceof YouTrackReadError && error.code === "NOT_FOUND" ? 404 : 500, {});
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/youtrack`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
