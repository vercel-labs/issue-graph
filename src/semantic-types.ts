import type { JevTiming, SemanticGatewayDiagnostic } from "./semantic-jev.js";
import type { NodeKey } from "./types.js";

export interface SemanticPerformance {
  githubCalls: number;
  githubRequestMs: number;
  captureMs: number;
  evaluationMs: number;
  totalMs: number;
}

export interface SemanticEvidenceSource {
  mode: "cached" | "live";
  capturedAt: string;
  ageMs: number;
  liveRevalidated: boolean;
  reusedIssues: number;
}

export interface SemanticProviderError {
  code: string;
  status: number | null;
  retryAfterSeconds: number | null;
  diagnostic?: SemanticGatewayDiagnostic;
  retryRefusalReason?: string;
}

export interface SemanticRunAttempt {
  receipt: { pending: SemanticPendingReceipt; final: SemanticFinalReceipt | null };
  attempted: boolean;
  gatewayTiming: JevTiming | null;
  providerError: SemanticProviderError | null;
}

export interface SemanticTaxonomy {
  schemaVersion: 1;
  repo: string;
  version: string;
  components: Array<{ id: string; description: string; examples?: string[] }>;
}

export interface SemanticWindow {
  startedAt: string;
  completedAt: string;
}

export interface SemanticCoverage {
  captured: number;
  total: number | null;
  hasNextPage: boolean | null;
  pages: number;
  complete: boolean;
  reasonCodes: string[];
}

export interface SemanticComment {
  id: string;
  url: string;
  author: string | null;
  updatedAt: string;
  body: string;
}

export interface SemanticEvidence {
  key: NodeKey;
  id: string;
  url: string;
  number: number;
  state: "OPEN" | "CLOSED";
  title: string;
  body: string;
  updatedAt: string;
  comments: SemanticComment[];
  commentsCoverage: SemanticCoverage;
  captureWindow: SemanticWindow;
  status: "ready" | "excluded" | "failed";
  reasonCodes: string[];
}

export interface SemanticCapture {
  repo: string;
  visibility: "PUBLIC";
  captureWindow: SemanticWindow;
  coverage: SemanticCoverage;
  items: SemanticEvidence[];
}

export type SemanticQuestion =
  | { type: "choice"; instruction: string; options: Record<string, string> }
  | { type: "boolean"; instruction: string }
  | { type: "score"; instruction: string; levels: string[] };

export interface SemanticEvaluationInput {
  model: string;
  state: {
    issue: {
      key: NodeKey;
      id: string;
      url: string;
      state: "OPEN" | "CLOSED";
      title: string;
      body: string;
      updatedAt: string;
      comments: SemanticComment[];
      commentsCoverage: Pick<SemanticCoverage, "captured" | "total" | "hasNextPage" | "complete">;
    };
  };
  questions: Record<string, SemanticQuestion>;
}

export interface SemanticPreviewItem {
  key: NodeKey;
  url: string;
  inputHash: string | null;
  outcome: "needs-review" | "skipped" | "failed";
  reviewRequired: true;
  reasonCodes: string[];
  plannedCall: boolean;
  inputBytes: number | null;
  questionIds: string[];
  componentStatus: "available" | "unavailable";
  cacheStatus:
    | "not-checked"
    | "disabled"
    | "hit"
    | "miss"
    | "expired"
    | "refresh"
    | "blocked"
    | "invalid";
  cacheEvaluatedAt: string | null;
  cacheSourceRequestId: string | null;
  evidence: {
    id: string;
    updatedAt: string;
    state: "OPEN" | "CLOSED";
    captureWindow: SemanticWindow;
    comments: Array<Omit<SemanticComment, "body">>;
    commentsCoverage: SemanticCoverage;
    excludedSources: ["attachments", "external-urls", "pull-requests", "relations"];
  };
}

export interface SemanticPreview {
  evidenceSource?: SemanticEvidenceSource;
  performance?: SemanticPerformance;
  schemaVersion: 1;
  kind: "classification-preview";
  scope: { repo: string; state: "OPEN"; limit: number; maxCalls: number };
  captureWindow: SemanticWindow;
  coverage: SemanticCoverage;
  coverageComplete: boolean;
  taxonomy: { version: string; components: string[] } | null;
  rubricVersion: string;
  policyVersion: string;
  projectionVersion: string;
  modelRequested: string;
  modelResolved: null;
  cacheEpoch: string;
  execution: {
    dryRun: true;
    gatewayCalls: 0;
    localWrites: 0;
    cache: "not-checked" | "read-only" | "disabled";
  };
  items: SemanticPreviewItem[];
  totals: {
    captured: number;
    eligible: number;
    plannedCalls: number;
    cacheHits: number;
    deferred: number;
    excluded: number;
    failed: number;
    oversized: number;
    reportedCostUsd: 0;
    hasUnknownCost: false;
  };
  nextSteps: Array<{
    action: "review-evidence" | "rerun-preview";
    description: string;
    command?: string;
  }>;
}

export type GatewayQuestion =
  | { type: "boolean"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export interface GatewayEvaluationRequest {
  model: "typesafe-ai/jev";
  state: SemanticEvaluationInput["state"];
  questions: Record<string, GatewayQuestion>;
  providerOptions: { gateway: { only: ["typesafe-ai"] } };
}

export interface SemanticTokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface SemanticDistribution {
  probabilities: Record<string, number>;
  topProbability: number;
  margin: number;
  providerConfidence: number | null;
}

export type SemanticAnswer =
  | { type: "boolean"; probability: number; providerConfidence: number | null }
  | (SemanticDistribution & { type: "choice"; choice: string })
  | (SemanticDistribution & { type: "score"; score: number; levels: string[] });

export interface SemanticEvaluation {
  answers: Record<string, SemanticAnswer>;
  modelResolved: string | null;
  tokenUsage: SemanticTokenUsage;
  reportedCostUsd: number | null;
}

export interface SemanticPendingReceipt {
  schemaVersion: 1;
  requestId: string;
  inputHash: string;
  modelRequested: string;
  adapterVersion: string;
  createdAt: string;
  phase: "pending";
  durable: boolean;
}

export interface SemanticReceiptResult {
  status: "succeeded" | "failed" | "not-sent";
  evaluatedAt: string | null;
  tokenUsage: SemanticTokenUsage;
  reportedCostUsd: number | null;
  errorCode: string | null;
  outcomeUnknown: boolean;
}

export interface SemanticFinalReceipt extends Omit<SemanticPendingReceipt, "phase"> {
  phase: "final";
  completedAt: string;
  result: SemanticReceiptResult;
}

export interface SemanticReceiptStore {
  begin(input: {
    inputHash: string;
    modelRequested: string;
    adapterVersion: string;
  }): Promise<SemanticPendingReceipt>;
  finish(
    pending: SemanticPendingReceipt,
    result: SemanticReceiptResult,
  ): Promise<SemanticFinalReceipt>;
}

export interface SemanticCacheContext {
  inputHash: string;
  request: GatewayEvaluationRequest;
  taxonomy: SemanticTaxonomy | null;
  adapterVersion: string;
  cacheEpoch: string;
}

export interface SemanticCacheEntry {
  schemaVersion: 1;
  inputHash: string;
  requestId: string;
  adapterVersion: string;
  cacheEpoch: string;
  evaluatedAt: string;
  expiresAt: string;
  evaluation: SemanticEvaluation;
}

export type SemanticCacheLookup =
  | { status: "hit"; entry: SemanticCacheEntry }
  | { status: "miss" | "expired" | "refresh" };

export interface SemanticCacheStore {
  read(
    context: SemanticCacheContext,
    options?: { refresh?: boolean; ownedRequestId?: string },
  ): Promise<SemanticCacheLookup>;
  write(
    context: SemanticCacheContext,
    value: { evaluation: SemanticEvaluation; evaluatedAt: string },
    pending: SemanticPendingReceipt,
  ): Promise<void>;
}

export interface SemanticPolicy {
  version: string;
  decide: (
    evaluation: SemanticEvaluation,
    coverageComplete: boolean,
  ) => {
    outcome: "suggested" | "needs-review";
    reasonCodes: string[];
    answers: Record<string, SemanticAnswer>;
    impactReportedStatus: "applicable" | "not-applicable";
  };
}

export interface SemanticReportItem extends Omit<SemanticPreviewItem, "outcome" | "plannedCall"> {
  outcome: "suggested" | "needs-review" | "skipped" | "failed";
  answers: Record<string, SemanticAnswer> | null;
  impactReportedStatus: "applicable" | "not-applicable" | "unavailable";
  provenance: {
    modelRequested: string;
    modelResolved: string | null;
    adapterVersion: string;
    evaluatedAt: string;
    cacheHit: boolean;
    tokenUsage: SemanticTokenUsage;
    reportedCostUsd: number | null;
  } | null;
  receipt: { pending: SemanticPendingReceipt; final: SemanticFinalReceipt | null } | null;
  providerError: SemanticProviderError | null;
  attempts?: SemanticRunAttempt[];
}

export interface SemanticReport
  extends Omit<SemanticPreview, "kind" | "execution" | "items" | "totals"> {
  kind: "classification-report";
  execution: {
    dryRun: false;
    gatewayCalls: number;
    receiptRecordsWritten: number;
    receipts: "durable" | "memory-only";
    cache: "enabled" | "disabled";
    cacheEntriesWritten: number;
  };
  items: SemanticReportItem[];
  totals: {
    captured: number;
    evaluated: number;
    cacheHits: number;
    suggested: number;
    needsReview: number;
    skipped: number;
    failed: number;
    deferred: number;
    reportedCostUsd: number;
    hasUnknownCost: boolean;
    cachedHistoricalCostUsd: number;
    hasUnknownHistoricalCost: boolean;
    oversized: number;
  };
}

export class SemanticError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint: string,
    readonly exitCode: 1 | 2 = 1,
  ) {
    super(message);
    this.name = "SemanticError";
  }
}
