export const LINEAR_CONNECTIONS = [
  "relations",
  "inverseRelations",
  "children",
  "attachments",
] as const;

export type LinearConnection = (typeof LINEAR_CONNECTIONS)[number];

export interface LinearPage {
  size: number;
  cursors: Partial<Record<LinearConnection, string>>;
  include: LinearConnection[];
}

export const LINEAR_WORKSPACE_QUERY = `query IssueGraphWorkspace {
  organization { id urlKey name }
}`;

const REF = "id identifier url team { organization { id } }";
const PAGE = "pageInfo { hasNextPage endCursor }";

export const LINEAR_ISSUE_QUERY = `query IssueGraphIssue(
  $id: String!, $size: Int!,
  $relations: Boolean!, $inverseRelations: Boolean!, $children: Boolean!, $attachments: Boolean!,
  $relationsAfter: String, $inverseRelationsAfter: String, $childrenAfter: String, $attachmentsAfter: String
) {
  issue(id: $id) {
    ${REF}
    title description updatedAt archivedAt state { name type }
    project { id name url }
    team { id name key organization { id } }
    parent { ${REF} }
    relations(first: $size, after: $relationsAfter, includeArchived: false) @include(if: $relations) {
      nodes { id type archivedAt issue { ${REF} } relatedIssue { ${REF} } }
      ${PAGE}
    }
    inverseRelations(first: $size, after: $inverseRelationsAfter, includeArchived: false) @include(if: $inverseRelations) {
      nodes { id type archivedAt issue { ${REF} } relatedIssue { ${REF} } }
      ${PAGE}
    }
    children(first: $size, after: $childrenAfter, includeArchived: true) @include(if: $children) {
      nodes { ${REF} }
      ${PAGE}
    }
    attachments(first: $size, after: $attachmentsAfter, includeArchived: false) @include(if: $attachments) {
      nodes { id title url archivedAt }
      ${PAGE}
    }
  }
}`;

export const LINEAR_PROJECT_OPEN_QUERY = `query IssueGraphProjectOpen($id: String!, $after: String) {
  project(id: $id) {
    id
    issues(first: 250, after: $after, includeArchived: false,
      filter: { state: { type: { in: ["triage", "backlog", "unstarted", "started"] } } }) {
      nodes { id archivedAt state { type } project { id } team { organization { id } } }
      ${PAGE}
    }
  }
}`;

export const LINEAR_PROJECT_QUERY = `query IssueGraphProject($id: String!, $after: String) {
  project(id: $id) {
    id name url
    issues(first: 250, after: $after, includeArchived: false) {
      nodes { id updatedAt project { id } team { organization { id } } }
      ${PAGE}
    }
  }
}`;

export interface LinearReader {
  workspace(): Promise<unknown>;
  issue(id: string, page: LinearPage): Promise<unknown>;
  projectOpenIssues?(id: string, after?: string): Promise<unknown>;
  projectIssues?(id: string, after?: string): Promise<unknown>;
}

export class LinearReadError extends Error {
  constructor(readonly code: string) {
    super(`Linear read failed (${code})`);
    this.name = "LinearReadError";
  }
}
