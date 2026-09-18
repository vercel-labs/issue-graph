import type { StatusCoverage, StatusMetric, StatusPullRequest, StatusReport } from "./status.js";

export interface StatusSnapshot {
  kind: "issue-graph-status-snapshot";
  schemaVersion: 1;
  startedAt: string;
  generatedAt: string;
  scope: StatusReport["scope"];
  coverage: StatusCoverage[];
  pullRequests: StatusPullRequest[];
  provenance: {
    kind: "live" | "reconstructed" | "imported-report";
    note: string;
    sources: string[];
  };
}

export type StatusChangeField =
  | "reviewState"
  | "mergeability"
  | "isDraft"
  | "headSha"
  | "assignees"
  | "requestedReviewers";
export type StatusChangeValue = string | boolean | string[];
export interface StatusChange {
  id: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  field: StatusChangeField;
  before: StatusChangeValue;
  after: StatusChangeValue;
}

export interface StatusDeparture {
  id: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  state: "MERGED" | "CLOSED" | "UNVERIFIED";
  checkedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  reason: string | null;
}

export interface StatusMetricDelta {
  before: number | null;
  after: number | null;
  delta: number | null;
}
export type StatusMetricDeltas = Record<StatusMetric, StatusMetricDelta>;

export interface StatusHistory {
  schemaVersion: 1;
  previousGeneratedAt: string;
  currentGeneratedAt: string;
  comparedAt: string;
  previousProvenance: StatusSnapshot["provenance"];
  coverageComplete: boolean;
  totals: StatusMetricDeltas;
  rows: Array<{ repo: string; author: string; counts: StatusMetricDeltas }>;
  changes: StatusChange[];
  added: StatusPullRequest[];
  departures: StatusDeparture[];
  uncertain: Array<{ id: string; reason: string }>;
}

export interface StatusHistoryOutput {
  history?: StatusHistory;
  snapshot?: { path: string; generatedAt: string };
}
