/**
 * The runtime-agnostic core: graph types, crawling, classification, ranking,
 * and rendering. Nothing here imports a Node builtin, so it bundles for any
 * runtime.
 *
 * The two transports are separate entry points, so importing the core never
 * drags in `node:child_process`:
 *   ./transports/shell.js  — `gh` shell-out
 *   ./transports/http.js   — fetch + token
 *
 * `snapshot.ts` (node:fs) and `cluster.ts` (node:child_process) are CLI
 * internals with no external consumer, so they are deliberately not exported.
 */
export * from "./classify.js";
export * from "./crawl.js";
export * from "./github.js";
export * from "./html.js";
export * from "./overlaps.js";
export * from "./plan.js";
export * from "./priority.js";
export * from "./reconcile.js";
export * from "./refs.js";
export * from "./render.js";
export * from "./schema.js";
export * from "./status.js";
export * from "./status-history.js";
export * from "./status-history-render.js";
export * from "./status-history-types.js";
export * from "./status-render.js";
export * from "./status-snapshot.js";
export * from "./transport.js";
export * from "./types.js";
