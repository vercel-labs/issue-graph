import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ReconcileAction, ReconcileHistory, ReconcileReport } from "./reconcile.js";
import type { GraphNode, NodeKey, Snapshot } from "./types.js";

export interface ReconcileSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  repo: string;
  items: Array<{ key: NodeKey; action: ReconcileAction }>;
  coverageComplete: boolean;
}

/** Per-seed-set directory under ~/.issue-graph where snapshots are persisted. */
export function snapshotDir(owner: string, repo: string, seedKeys: NodeKey[]): string {
  const id = `${owner}-${repo}-${seedKeys.map((k) => k.split("#")[1]).join("_")}`.slice(0, 80);
  return path.join(os.homedir(), ".issue-graph", id.replace(/[^\w.-]/g, "_"));
}

export function reconcileSnapshotDir(owner: string, repo: string): string {
  const id = `reconcile-${owner}-${repo}`.replace(/[^\w.-]/g, "_");
  return path.join(os.homedir(), ".issue-graph", id);
}

/** Prior snapshot filenames for a seed set, oldest first. */
export function listSnapshots(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
}

/** Read a persisted snapshot, or null if unreadable. */
export function readSnapshot(file: string): Snapshot | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Snapshot;
  } catch {
    return null;
  }
}

/** Reduce a live node map to the persistable snapshot shape. */
export function toSnapshot(nodes: Map<NodeKey, GraphNode>, ts: string): Snapshot {
  return {
    ts,
    nodes: [...nodes.values()].map((n) => ({
      key: n.key,
      kind: n.kind,
      state: n.state,
      title: n.title,
      edges: n.edges,
    })),
  };
}

/** Persist a snapshot; creates the directory if needed. */
export function writeSnapshot(dir: string, snap: Snapshot): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${snap.ts.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(snap, null, 2));
  return file;
}

export function toReconcileSnapshot(report: ReconcileReport): ReconcileSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: report.generatedAt,
    repo: report.repo,
    items: report.items.map((item) => ({ key: item.key, action: item.action })),
    coverageComplete:
      !report.limits.seedLimitReached &&
      !report.limits.fetchFailures.length &&
      !report.limits.cappedOut.length,
  };
}

export function readReconcileSnapshot(file: string): ReconcileSnapshot | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as ReconcileSnapshot;
    if (value.schemaVersion !== 1 || !Array.isArray(value.items)) return null;
    return value;
  } catch {
    return null;
  }
}

export function writeReconcileSnapshot(dir: string, snap: ReconcileSnapshot): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${snap.generatedAt.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(snap, null, 2));
  return file;
}

export function diffReconcileSnapshots(
  prev: ReconcileSnapshot,
  now: ReconcileSnapshot,
): ReconcileHistory {
  const prevItems = new Map(prev.items.map((item) => [item.key, item.action]));
  const nowItems = new Map(now.items.map((item) => [item.key, item.action]));
  const added = prev.coverageComplete
    ? now.items
        .filter((item) => !prevItems.has(item.key))
        .sort((a, b) => a.key.localeCompare(b.key))
    : [];
  const changed = now.items
    .flatMap((item) => {
      const from = prevItems.get(item.key);
      return from && from !== item.action ? [{ key: item.key, from, to: item.action }] : [];
    })
    .sort((a, b) => a.key.localeCompare(b.key));
  const resolved = now.coverageComplete
    ? prev.items
        .filter((item) => !nowItems.has(item.key))
        .map((item) => ({ key: item.key, previousAction: item.action }))
        .sort((a, b) => a.key.localeCompare(b.key))
    : [];
  const coverageChange =
    prev.coverageComplete === now.coverageComplete
      ? "unchanged"
      : now.coverageComplete
        ? "recovered"
        : "regressed";
  return {
    previousGeneratedAt: prev.generatedAt,
    added,
    changed,
    resolved,
    coverageChange,
  };
}

/** Markdown diff between two snapshots: new/removed nodes, state changes, new edges. */
export function diffSnapshots(prev: Snapshot, now: Snapshot): string {
  const prevMap = new Map(prev.nodes.map((n) => [n.key, n]));
  const nowMap = new Map(now.nodes.map((n) => [n.key, n]));
  const added = now.nodes.filter((n) => !prevMap.has(n.key));
  const removed = prev.nodes.filter((n) => !nowMap.has(n.key));
  const stateChanged: string[] = [];
  const newEdges: string[] = [];

  for (const n of now.nodes) {
    const p = prevMap.get(n.key);
    if (!p) continue;
    if (p.state !== n.state) stateChanged.push(`${n.key}: ${p.state} → ${n.state}`);
    const prevTo = new Set(p.edges.map((e) => e.to));
    for (const e of n.edges) {
      if (!prevTo.has(e.to))
        newEdges.push(`${n.key} —${e.via}→ ${e.to}${e.by ? ` (by @${e.by})` : ""}`);
    }
  }

  const out = [`\n## Since last snapshot (${prev.ts})\n`];
  if (!added.length && !removed.length && !stateChanged.length && !newEdges.length) {
    out.push("- no changes");
    return `${out.join("\n")}\n`;
  }
  if (added.length) {
    out.push("### New nodes");
    for (const n of added) out.push(`- ${n.key} ${n.state} — ${n.title}`);
  }
  if (stateChanged.length) {
    out.push("### State changes");
    for (const s of stateChanged) out.push(`- ${s}`);
  }
  if (newEdges.length) {
    out.push("### New references / links");
    for (const e of newEdges) out.push(`- ${e}`);
  }
  if (removed.length) {
    out.push("### No longer referenced");
    for (const n of removed) out.push(`- ${n.key} — ${n.title}`);
  }
  return `${out.join("\n")}\n`;
}
