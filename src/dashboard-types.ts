export interface OpenItemCount {
  value: number;
  complete: boolean;
  observedAt: string;
  issues: number;
  pullRequests?: number;
  /** Why a count is partial, when known. */
  reason?: string;
}

export interface ReadCoverage {
  source: string;
  pages: number;
  complete: boolean;
  reason?: "page-limit" | "node-limit" | "invalid-page" | "read-failed" | "changed-during-read";
}

export interface GithubTarget {
  repo: string;
  number: number;
  kind?: "issue" | "pull-request";
  state?: "OPEN" | "CLOSED" | "MERGED";
  draft?: boolean;
  title?: string;
  error?: "NOT_FOUND" | "READ_FAILED";
  observedAt: string;
}

export interface WorkLink {
  url: string;
  title: string;
  evidence: { kind: "attachment"; id: string };
  /** Observed state of a GitHub issue or pull request target, when it was read. */
  github?: GithubTarget;
}

export interface RelationshipEvidence {
  kind: "relation" | "hierarchy";
  id: string;
}
