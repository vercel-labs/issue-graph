import { LinearReadError, type LinearReader } from "../linear-queries.js";
import { type McpClient, McpError, mcpClient } from "./mcp.js";

/** Linear's hosted MCP server, read-only endpoint. */
export const LINEAR_MCP_URL = "https://mcp.linear.app/mcp/readonly";

export interface LinearMcpReaderOptions {
  token: string;
  url?: string;
  timeoutMs?: number;
  /** Injected for tests. */
  client?: McpClient;
}

type Value = Record<string, unknown>;

const ISSUE_FIELDS = [
  "id",
  "uuid",
  "title",
  "description",
  "url",
  "updatedAt",
  "archivedAt",
  "status",
  "statusType",
  "project",
  "projectId",
  "parentId",
  "team",
  "teamId",
  "attachments",
  "relations",
];
const LIST_FIELDS = [
  "id",
  "uuid",
  "url",
  "updatedAt",
  "archivedAt",
  "statusType",
  "projectId",
  "teamId",
];
const OPEN = new Set(["triage", "backlog", "unstarted", "started"]);

const record = (value: unknown): Value =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Value) : {};
const str = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Cursor of the next page, under whichever name the tool uses. */
function nextCursor(result: Value): string | null {
  if (result.hasNextPage !== true) return null;
  return str(result.cursor) ?? str(result.endCursor) ?? str(result.nextCursor) ?? null;
}

function page(nodes: unknown[], cursor: string | null = null) {
  return { nodes, pageInfo: { hasNextPage: cursor !== null, endCursor: cursor } };
}

/**
 * The same read-only queries as the GraphQL transport, answered through Linear's MCP tools and
 * returned in the GraphQL shapes, so graph building and identity checks are shared.
 */
export function linearMcpReader(options: LinearMcpReaderOptions): LinearReader & { label: string } {
  const client =
    options.client ??
    mcpClient({
      url: options.url ?? LINEAR_MCP_URL,
      token: options.token,
      timeoutMs: options.timeoutMs,
    });
  let workspace: Promise<{ id: string; urlKey: string; name: string }> | undefined;
  const refs = new Map<string, Promise<Value>>();
  const projects = new Map<string, Promise<Value>>();

  async function call(tool: string, args: Value): Promise<Value> {
    try {
      return record(await client.call(tool, args));
    } catch (error) {
      throw new LinearReadError(error instanceof McpError ? error.code : "MCP_ERROR");
    }
  }

  function org() {
    workspace ??= call("get_workspace", {}).then((value) => {
      const id = str(value.id);
      const url = str(value.url);
      if (!id || !url) throw new LinearReadError("INVALID_PAYLOAD");
      return {
        id,
        urlKey: new URL(url).pathname.split("/").filter(Boolean)[0] ?? "",
        name: str(value.name) ?? "",
      };
    });
    return workspace;
  }

  async function asRef(issue: Value): Promise<Value> {
    const { id } = await org();
    return {
      id: str(issue.uuid),
      identifier: str(issue.id),
      url: str(issue.url),
      team: { organization: { id } },
    };
  }

  /** Reference for a related issue given by identifier, UUID, or an object carrying either. */
  function ref(target: unknown): Promise<Value> {
    const item = record(target);
    const locator =
      typeof target === "string"
        ? target
        : (str(item.uuid) ?? str(item.identifier) ?? str(item.id));
    if (!locator) return Promise.reject(new LinearReadError("INVALID_PAYLOAD"));
    let found = refs.get(locator);
    if (!found) {
      found = call("get_issue", { id: locator, fields: ["id", "uuid", "url"] }).then(asRef);
      refs.set(locator, found);
    }
    return found;
  }

  function project(id: string): Promise<Value> {
    let found = projects.get(id);
    if (!found) {
      found = Promise.all([call("get_project", { query: id }), org()]).then(([value, ws]) => ({
        id,
        name: str(value.name) ?? "",
        url: str(value.url) ?? `https://linear.app/${ws.urlKey}`,
      }));
      projects.set(id, found);
    }
    return found;
  }

  /** Native relations from the MCP issue, split into outgoing and incoming GraphQL relation nodes. */
  async function relations(self: Value, value: Value) {
    const outgoing: unknown[] = [];
    const incoming: unknown[] = [];
    const add = async (target: unknown, type: string, direction: "out" | "in") => {
      const other = await ref(target);
      const node = {
        id: `${self.id}:${direction}:${type}:${other.id}`,
        type,
        archivedAt: null,
        issue: direction === "out" ? self : other,
        relatedIssue: direction === "out" ? other : self,
      };
      (direction === "out" ? outgoing : incoming).push(node);
    };
    for (const target of list(value.blocks)) await add(target, "blocks", "out");
    for (const target of list(value.blockedBy)) await add(target, "blocks", "in");
    for (const target of list(value.relatedTo)) await add(target, "related", "out");
    for (const target of value.duplicateOf ? [value.duplicateOf] : [])
      await add(target, "duplicate", "out");
    return { outgoing, incoming };
  }

  return {
    label: "Linear MCP (signed in)",

    async workspace() {
      return { organization: await org() };
    },

    async issue(id, request) {
      const value = await call("get_issue", { id, fields: ISSUE_FIELDS, includeRelations: true });
      const { id: workspaceId } = await org();
      const self = await asRef(value);
      const include = new Set(request.include);
      const result: Value = {
        ...self,
        title: str(value.title) ?? "",
        description: str(value.description) ?? null,
        updatedAt: str(value.updatedAt) ?? "",
        archivedAt: str(value.archivedAt) ?? null,
        state: { name: str(value.status) ?? "", type: str(value.statusType) ?? "" },
        project: str(value.projectId) ? await project(str(value.projectId) as string) : null,
        team: {
          id: str(value.teamId) ?? "",
          name: str(value.team) ?? "",
          key: (str(value.id) ?? "").split("-")[0] ?? "",
          organization: { id: workspaceId },
        },
        parent: str(value.parentId) ? await ref(value.parentId) : null,
      };
      // Relations arrive complete in one response; a later page request is answered empty.
      if (include.has("relations") || include.has("inverseRelations")) {
        const { outgoing, incoming } = await relations(self, record(value.relations));
        if (include.has("relations"))
          result.relations = page(request.cursors.relations ? [] : outgoing);
        if (include.has("inverseRelations"))
          result.inverseRelations = page(request.cursors.inverseRelations ? [] : incoming);
      }
      if (include.has("attachments"))
        result.attachments = page(
          request.cursors.attachments
            ? []
            : list(value.attachments).map((item) => ({
                id: str(record(item).id),
                title: str(record(item).title) ?? "",
                url: str(record(item).url) ?? "",
                archivedAt: null,
              })),
        );
      if (include.has("children")) {
        const children = await call("list_issues", {
          parentId: str(value.id),
          limit: Math.min(250, request.size),
          includeArchived: true,
          fields: LIST_FIELDS,
          ...(request.cursors.children ? { cursor: request.cursors.children } : {}),
        });
        result.children = page(
          await Promise.all(list(children.issues).map((item) => asRef(record(item)))),
          nextCursor(children),
        );
      }
      return { issue: result };
    },

    async projectIssues(id, after) {
      const [listing, details] = await Promise.all([
        call("list_issues", {
          project: id,
          limit: 250,
          includeArchived: false,
          fields: LIST_FIELDS,
          ...(after ? { cursor: after } : {}),
        }),
        project(id),
      ]);
      const { id: workspaceId } = await org();
      return {
        project: {
          ...details,
          issues: page(
            list(listing.issues).map((item) => ({
              id: str(record(item).uuid),
              updatedAt: str(record(item).updatedAt) ?? "",
              project: { id: str(record(item).projectId) },
              team: { organization: { id: workspaceId } },
            })),
            nextCursor(listing),
          ),
        },
      };
    },

    async projectOpenIssues(id, after) {
      const listing = await call("list_issues", {
        project: id,
        limit: 250,
        includeArchived: false,
        fields: LIST_FIELDS,
        ...(after ? { cursor: after } : {}),
      });
      const { id: workspaceId } = await org();
      return {
        project: {
          id,
          issues: page(
            list(listing.issues)
              .map(record)
              .filter((item) => OPEN.has(str(item.statusType) ?? ""))
              .map((item) => ({
                id: str(item.uuid),
                archivedAt: str(item.archivedAt) ?? null,
                state: { type: str(item.statusType) },
                project: { id: str(item.projectId) },
                team: { organization: { id: workspaceId } },
              })),
            nextCursor(listing),
          ),
        },
      };
    },
  };
}
