import type { ReadCoverage, RelationshipEvidence, WorkLink } from "./dashboard-types.js";

export type { OpenItemCount, ReadCoverage, WorkLink } from "./dashboard-types.js";

import type { CrawlEdge, CrawlNode } from "./types.js";

export interface WorkProject {
  id: string;
  name: string;
  url: string;
}

export interface WorkEdge extends CrawlEdge {
  relation: "blocks" | "duplicate_of" | "related" | "parent_of" | "provider_specific";
  direction: "outgoing" | "incoming" | "undirected";
  nativeRelation: string;
  evidence: RelationshipEvidence;
}

export interface WorkNode extends CrawlNode {
  provider: string;
  authority: string;
  nativeId: string;
  kind: "issue" | "pull-request";
  identifier: string;
  title: string;
  description?: string | null;
  url: string;
  state: { name: string; type: string };
  updatedAt: string;
  archived: boolean;
  project?: WorkProject | null;
  team?: { id: string; name: string; key: string };
  fetched: boolean;
  error?: string;
  edges: WorkEdge[];
  externalLinks: WorkLink[];
  coverage: ReadCoverage[];
}
