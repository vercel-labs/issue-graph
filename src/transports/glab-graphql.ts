import {
  GITLAB_ISSUE_BATCH_SIZE,
  type GitLabIssueBatch,
  type GitLabIssueRead,
  type GitLabItem,
  gitlabReference,
} from "../gitlab.js";

const REFS_PER_FIELD = 10;
const WORK_ITEM_FIELDS = `
  id
  reference(full: true)
  title
  state
  webUrl
  updatedAt
  features {
    development {
      closingMergeRequests(first: 100) {
        nodes { mergeRequest { webUrl } }
        pageInfo { hasNextPage }
      }
    }
    linkedItems {
      linkedItems(first: 100) {
        nodes { linkId linkType workItem { webUrl } }
        pageInfo { hasNextPage }
      }
    }
  }
`;

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

export function issueBatchQuery(items: GitLabItem[]) {
  if (
    !items.length ||
    items.length > GITLAB_ISSUE_BATCH_SIZE ||
    items.some((item) => item.kind !== "issue" || item.group)
  )
    throw new RangeError("Expected 1 to 30 project issues in a GitLab batch");

  const variables: Record<string, string | string[]> = {};
  const declarations: string[] = [];
  const fields: string[] = [];
  for (let offset = 0; offset < items.length; offset += REFS_PER_FIELD) {
    const index = fields.length;
    const scope = `scope${index}`;
    const refs = `refs${index}`;
    variables[scope] = items[offset].path;
    variables[refs] = items.slice(offset, offset + REFS_PER_FIELD).map(gitlabReference);
    declarations.push(`$${scope}: ID!, $${refs}: [String!]!`);
    fields.push(
      `batch${index}: workItemsByReference(contextNamespacePath: $${scope}, refs: $${refs}, first: 10) {
        nodes { ...IssueGraphWorkItem }
      }`,
    );
  }
  return {
    query: `query IssueGraphWorkItems(${declarations.join(", ")}) {
      ${fields.join("\n")}
    }
    fragment IssueGraphWorkItem on WorkItem { ${WORK_ITEM_FIELDS} }`,
    variables,
  };
}

function connection(
  value: unknown,
  convert: (node: RecordValue) => RecordValue | null | undefined,
) {
  const body = record(value);
  const hasNextPage = record(body?.pageInfo)?.hasNextPage;
  if (typeof hasNextPage !== "boolean" || !Array.isArray(body?.nodes)) return undefined;

  const results: RecordValue[] = [];
  let malformed = false;
  for (const raw of body.nodes) {
    const node = record(raw);
    const item = node && convert(node);
    if (item === undefined) malformed = true;
    else if (item !== null) results.push(item);
  }
  const incomplete = malformed
    ? ("read-failed" as const)
    : hasNextPage
      ? ("page-limit" as const)
      : undefined;
  return { items: results, incomplete };
}

function urlItem(value: unknown) {
  if (value === null) return null;
  const url = record(value)?.webUrl;
  return typeof url === "string" && url ? { web_url: url } : undefined;
}

function issueRead(node: RecordValue): GitLabIssueRead | undefined {
  const { title, state, webUrl, id, updatedAt } = node;
  if (typeof title !== "string" || !title.trim() || typeof webUrl !== "string") return undefined;
  if (state !== "OPEN" && state !== "CLOSED") return undefined;
  const features = record(node.features);
  const development = record(features?.development);
  const linked = record(features?.linkedItems);
  const links = connection(linked?.linkedItems, ({ workItem, linkId, linkType }) => {
    const target = urlItem(workItem);
    if (!target) return target;
    if (typeof linkId !== "string" || typeof linkType !== "string") return undefined;
    return { ...target, issue_link_id: linkId.split("/").at(-1), link_type: linkType };
  });
  const closing = connection(development?.closingMergeRequests, ({ mergeRequest }) =>
    urlItem(mergeRequest),
  );
  return {
    body: {
      id: typeof id === "string" ? id.match(/\/(\d+)$/)?.[1] : undefined,
      title,
      state: state === "OPEN" ? "opened" : "closed",
      web_url: webUrl,
      updated_at: updatedAt,
    },
    links: links?.incomplete ? undefined : links?.items,
    closing: closing?.items,
    closingIncomplete: closing?.incomplete,
  };
}

export function parseIssueBatch(payload: unknown, items: GitLabItem[]): GitLabIssueBatch {
  const response = record(payload);
  const data = record(response?.data);
  const errors = Array.isArray(response?.errors) ? response.errors.map(record) : [];
  const issues = new Map<string, GitLabIssueRead>();
  if (!data) return { supported: false, issues };

  for (let offset = 0; offset < items.length; offset += REFS_PER_FIELD) {
    const alias = `batch${offset / REFS_PER_FIELD}`;
    const nodes = record(data?.[alias])?.nodes;
    if (
      !Array.isArray(nodes) ||
      errors.some(
        (error) => Array.isArray(error?.path) && error.path.length === 1 && error.path[0] === alias,
      )
    )
      continue;
    const expected = new Set(
      items
        .slice(offset, offset + REFS_PER_FIELD)
        .map((item) => gitlabReference(item).toLowerCase()),
    );
    for (const [index, raw] of nodes.entries()) {
      const node = record(raw);
      if (!node || typeof node.reference !== "string") continue;
      const key = node.reference.toLowerCase();
      if (!expected.has(key)) continue;
      const issue = issueRead(node);
      if (!issue) continue;
      for (const error of errors) {
        const path = error?.path;
        if (!Array.isArray(path) || path[0] !== alias || path[1] !== "nodes" || path[2] !== index)
          continue;
        if (path[3] !== "features") continue;
        if (path[4] === "linkedItems") issue.links = undefined;
        if (path[4] === "development" && issue.closing) issue.closingIncomplete = "read-failed";
      }
      issues.set(key, issue);
    }
  }
  return { supported: true, issues };
}
