export interface OpenItemCount {
  value: number;
  complete: boolean;
  observedAt: string;
  issues: number;
  pullRequests?: number;
}

export interface ReadCoverage {
  source: string;
  pages: number;
  complete: boolean;
  reason?: "page-limit" | "node-limit" | "invalid-page" | "read-failed" | "changed-during-read";
}

export interface WorkLink {
  url: string;
  title: string;
  evidence: { kind: "attachment"; id: string };
}

export interface RelationshipEvidence {
  kind: "relation" | "hierarchy";
  id: string;
}
