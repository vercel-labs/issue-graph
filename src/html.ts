import { isSupersededVerdict } from "./classify.js";
import { components } from "./crawl.js";
import { fileOverlaps } from "./overlaps.js";
import { prioritize } from "./priority.js";
import type { GraphNode, NodeKey } from "./types.js";

/** Optional semantic clustering supplied by the calling agent (`--clusters`). */
export interface ClusterInput {
  label: string;
  root_cause?: string;
  members: Array<{ key: NodeKey; verdict?: string }>;
}

/** One actionable cleanup line: close/supersede/retest, with credit. */
export interface CleanupItem {
  /** Node this action targets, so the UI can link to it. */
  key?: NodeKey;
  text: string;
}

/**
 * The `--clusters` file is either a bare `ClusterInput[]` or an object that
 * also carries a global `cleanup` checklist (the actionable close/credit list).
 */
export type ClustersConfig = ClusterInput[] | { clusters: ClusterInput[]; cleanup?: CleanupItem[] };

function normalizeClusters(c?: ClustersConfig): {
  clusters: ClusterInput[];
  cleanup: CleanupItem[];
} {
  if (!c) return { clusters: [], cleanup: [] };
  if (Array.isArray(c)) return { clusters: c, cleanup: [] };
  return { clusters: c.clusters ?? [], cleanup: c.cleanup ?? [] };
}

/** A group in the left tree: a connected component, or an agent-named cluster. */
interface Group {
  label: string;
  subtitle: string;
  members: NodeKey[];
}

/** The compact, self-contained model embedded in the page for the client app. */
interface Model {
  repo: string;
  seeds: NodeKey[];
  groups: Group[];
  cleanup: CleanupItem[];
  stats: Record<string, number>;
  nodes: Record<NodeKey, ClientNode>;
}

interface ClientNode {
  key: NodeKey;
  num: number;
  kind: "PullRequest" | "Issue" | "Unknown";
  state: string;
  title: string;
  url: string;
  author?: string;
  depth: number;
  seed: boolean;
  flags: string[];
  verdict?: string;
  mentionedBy: string[];
  external: string[];
  pr?: {
    draft: boolean;
    review: string;
    mergeable: string;
    updated: string;
    adds: number;
    dels: number;
    files: number;
  };
  /** Raw triage signals from prioritize(); open, fetched nodes only. */
  heat?: {
    comments: number;
    participants: number;
    reactions: number;
    daysOpen: number;
    inboundRefs: number;
  };
  out: Array<{ to: NodeKey; via: string; by?: string; at?: string }>;
  in: Array<{ from: NodeKey; via: string; by?: string }>;
  overlaps: Array<{ with: NodeKey; shared: string[]; significant: number; sharedIssue?: NodeKey }>;
}

function shortKey(k: NodeKey): string {
  const n = k.split("#")[1];
  return n ? `#${n}` : k;
}

function buildModel(
  nodes: Map<NodeKey, GraphNode>,
  seedKeys: NodeKey[],
  repo: string,
  clusters: ClusterInput[],
  cleanup: CleanupItem[],
): Model {
  const seeds = new Set(seedKeys);

  // invert edges once
  const inbound = new Map<NodeKey, Array<{ from: NodeKey; via: string; by?: string }>>();
  for (const n of nodes.values())
    for (const e of n.edges) {
      const list = inbound.get(e.to) ?? [];
      list.push({ from: n.key, via: e.via, by: e.by });
      inbound.set(e.to, list);
    }

  // attach overlaps to both endpoints
  const overlapsBy = new Map<NodeKey, ClientNode["overlaps"]>();
  for (const o of fileOverlaps(nodes)) {
    (overlapsBy.get(o.a) ?? overlapsBy.set(o.a, []).get(o.a))?.push({
      with: o.b,
      shared: o.shared,
      significant: o.significant,
      sharedIssue: o.sharedIssue,
    });
    (overlapsBy.get(o.b) ?? overlapsBy.set(o.b, []).get(o.b))?.push({
      with: o.a,
      shared: o.shared,
      significant: o.significant,
      sharedIssue: o.sharedIssue,
    });
  }

  const heat = new Map(prioritize(nodes, new Date()).map((r) => [r.key, r]));
  const clientNodes: Record<NodeKey, ClientNode> = {};
  for (const n of nodes.values()) {
    clientNodes[n.key] = {
      key: n.key,
      num: n.number,
      kind: n.kind,
      state: n.state,
      title: n.title,
      url: n.url,
      author: n.author,
      depth: n.depth,
      seed: seeds.has(n.key),
      flags: n.flags ?? [],
      verdict: n.verdict,
      mentionedBy: n.mentionedBy ?? [],
      external: n.externalLinks,
      pr: n.pr
        ? {
            draft: n.pr.isDraft,
            review: n.pr.reviewDecision || "none",
            mergeable: n.pr.mergeable,
            updated: n.pr.updatedAt.slice(0, 10),
            adds: n.pr.additions,
            dels: n.pr.deletions,
            files: n.pr.changedFiles,
          }
        : undefined,
      heat: (() => {
        const h = heat.get(n.key);
        return h
          ? {
              comments: h.comments,
              participants: h.participants,
              reactions: h.reactions,
              daysOpen: h.daysOpen,
              inboundRefs: h.inboundRefs,
            }
          : undefined;
      })(),
      out: n.edges.map((e) => ({ to: e.to, via: e.via, by: e.by, at: e.at })),
      in: inbound.get(n.key) ?? [],
      overlaps: overlapsBy.get(n.key) ?? [],
    };
  }

  // groups: agent clusters if supplied, else deterministic connected components
  let groups: Group[];
  if (clusters.length) {
    const seen = new Set<NodeKey>();
    groups = clusters.map((c) => {
      const members = c.members.map((m) => m.key).filter((k) => clientNodes[k]);
      for (const m of c.members) {
        seen.add(m.key);
        const cn = clientNodes[m.key];
        if (cn && m.verdict) cn.verdict = m.verdict; // cluster verdict wins
      }
      return { label: c.label, subtitle: c.root_cause ?? "", members };
    });
    const rest = [...nodes.keys()].filter((k) => !seen.has(k));
    if (rest.length) groups.push({ label: "Ungrouped", subtitle: "no cluster", members: rest });
  } else {
    groups = components(nodes).map((c, i) => {
      const members = c
        .map((k) => nodes.get(k))
        .filter((n): n is GraphNode => !!n)
        .sort((a, b) => a.depth - b.depth || a.key.localeCompare(b.key));
      const hub = members.slice().sort((a, b) => b.edges.length - a.edges.length)[0];
      return {
        label: `Component ${i + 1}`,
        subtitle: hub ? `hub ${shortKey(hub.key)} — ${hub.title}` : "",
        members: members.map((m) => m.key),
      };
    });
  }

  const all = [...nodes.values()];
  const openPRs = all.filter((n) => n.state === "OPEN" && n.kind === "PullRequest");
  const stats = {
    nodes: nodes.size,
    openPRs: openPRs.length,
    openIssues: all.filter((n) => n.state === "OPEN" && n.kind === "Issue").length,
    superseded: openPRs.filter((n) => isSupersededVerdict(n.verdict)).length,
    competing: openPRs.filter((n) => n.flags?.some((f) => f.startsWith("competes"))).length,
    noClose: openPRs.filter((n) => n.flags?.some((f) => f.includes("no closing link"))).length,
    overlaps: fileOverlaps(nodes).length,
  };

  return { repo, seeds: seedKeys, groups, cleanup, stats, nodes: clientNodes };
}

/** Render the graph as a self-contained, Geist-styled master–detail explorer. */
export function renderHtml(
  nodes: Map<NodeKey, GraphNode>,
  seedKeys: NodeKey[],
  repo: string,
  clustersConfig?: ClustersConfig,
): string {
  const { clusters, cleanup } = normalizeClusters(clustersConfig);
  const model = buildModel(nodes, seedKeys, repo, clusters, cleanup);
  // JSON is safe inside <script> once "<" is escaped (prevents </script> break-out).
  const data = JSON.stringify(model).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>issue-graph · ${repo.replace(/</g, "&lt;")}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500&family=Geist:wght@400;500;600&display=swap" rel="stylesheet"/>
<style>${CSS}</style>
</head>
<body>
<div id="app"></div>
<script id="data" type="application/json">${data}</script>
<script>${APP}</script>
</body>
</html>`;
}

const CSS = `
:root{
  --bg:#ffffff;--bg2:#fafafa;--fg:#171717;--fg2:#4d4d4d;--muted:#8f8f8f;
  --border:#00000014;--border2:#00000024;--accent:#006bff;
  --open-fg:#107d32;--open-bg:#ecfdec;--merged-fg:#7d00cc;--merged-bg:#faf0ff;
  --closed-fg:#7d7d7d;--closed-bg:#f2f2f2;--warn-fg:#ff9300;--warn-bg:#fff6de;
  --danger-fg:#ea001d;--danger-bg:#ffeeef;
  --radius:6px;--radius-md:12px;--shadow:0 2px 2px rgba(0,0,0,.04);
  --sans:'Geist',ui-sans-serif,system-ui,sans-serif;--mono:'Geist Mono',ui-monospace,monospace;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#0a0a0a;--bg2:#111111;--fg:#ededed;--fg2:#a1a1a1;--muted:#7d7d7d;
  --border:#ffffff17;--border2:#ffffff29;
  --open-bg:#0e2a14;--open-fg:#62c073;--merged-bg:#1e1033;--merged-fg:#c987ff;
  --closed-bg:#1a1a1a;--closed-fg:#a1a1a1;--warn-bg:#2a1e00;--warn-fg:#ffb224;
  --danger-bg:#2d0a0e;--danger-fg:#ff6166;
}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--sans);font-size:14px;line-height:20px;letter-spacing:-.006em}
.mono{font-family:var(--mono)}
.muted{color:var(--muted)}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
code{font-family:var(--mono);font-size:12px;background:var(--closed-bg);padding:1px 5px;border-radius:4px}
.shell{display:grid;grid-template-columns:340px 1fr;height:100vh}
@media(max-width:820px){.shell{grid-template-columns:1fr;height:auto}}
/* sidebar */
.side{border-right:1px solid var(--border);display:flex;flex-direction:column;min-height:0;background:var(--bg)}
.side-top{padding:20px 16px 16px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:16px}
.brand{display:flex;flex-direction:column;gap:4px}
.brand-row{display:flex;align-items:center;gap:8px}
.labs{display:inline-flex;color:var(--fg);border-radius:4px}.labs:hover{text-decoration:none;opacity:.8}
.labs:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.labs-mark{height:16px;width:auto;display:block}
.brand-sep{color:var(--border2);font-size:18px;font-weight:300;line-height:1}
.brand-name{font-weight:600;font-size:15px;letter-spacing:-.01em}
.brand-repo{font-family:var(--mono);font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mix{display:flex;flex-direction:column;gap:8px}
.mix-bar{display:flex;height:6px;border-radius:9999px;overflow:hidden;gap:2px}
.mix-bar span{display:block;height:100%;border-radius:9999px;transition:flex-grow 600ms cubic-bezier(.2,.8,.2,1)}
.mix-legend{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px;color:var(--fg2)}
.mix-legend span{display:inline-flex;align-items:center;gap:5px}
.mix-legend b{font-weight:500;color:var(--muted);font-variant-numeric:tabular-nums}
.stats{display:grid;grid-template-columns:repeat(3,1fr);border-top:1px solid var(--border);border-bottom:1px solid var(--border)}
.stat{padding:10px 0 10px 12px;border-left:1px solid var(--border)}
.stat:nth-child(3n+1){border-left:0;padding-left:0}
.stat:nth-child(n+4){border-top:1px solid var(--border)}
.stat-n{font-weight:600;font-size:18px;line-height:24px;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.stat-l{font-size:12px;color:var(--muted)}
.stat.warn .stat-n{color:var(--warn-fg)}.stat.danger .stat-n{color:var(--danger-fg)}.stat.zero .stat-n{color:var(--muted)}
.view-toggle{display:grid;grid-template-columns:repeat(4,1fr);gap:2px;padding:2px;background:var(--bg2);border:1px solid var(--border);border-radius:9999px}
.view-btn{height:28px;border:0;border-radius:9999px;background:transparent;color:var(--muted);font-family:var(--sans);font-size:13px;cursor:pointer;transition:color 150ms,background 150ms}
.view-btn:hover{color:var(--fg)}.view-btn.active{background:var(--bg);color:var(--fg);box-shadow:0 0 0 1px var(--border2)}
.view-btn:focus-visible,.item:focus-visible,.cleanup-pill:focus-visible,.grp>summary:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.filter{width:100%;height:32px;padding:0 12px;border:1px solid var(--border2);border-radius:9999px;background:var(--bg);color:var(--fg);font-family:var(--sans);font-size:13px}
.filter:focus{outline:2px solid var(--accent);outline-offset:0;border-color:transparent}
.cleanup-pill{display:flex;align-items:center;justify-content:space-between;width:100%;height:32px;border:1px solid var(--border2);border-radius:9999px;background:var(--bg);color:var(--fg);font-family:var(--sans);font-size:13px;cursor:pointer;padding:0 6px 0 12px;transition:background 150ms}
.cleanup-pill:hover{background:var(--bg2)}
.cleanup-pill.active{background:var(--fg);color:var(--bg);border-color:var(--fg)}
.cleanup-pill .cnt{min-width:22px;height:20px;padding:0 6px;border-radius:9999px;background:var(--warn-bg);color:var(--warn-fg);font-size:12px;font-weight:500;display:inline-flex;align-items:center;justify-content:center;font-variant-numeric:tabular-nums}
.tree{overflow-y:auto;padding:8px;flex:1;min-height:0}
.grp{margin-bottom:2px}
.grp>summary{cursor:pointer;list-style:none;padding:10px 8px;border-radius:8px;display:grid;grid-template-columns:12px 1fr auto;gap:2px 8px;align-items:center}
.grp>summary::-webkit-details-marker{display:none}
.grp>summary:hover{background:var(--bg2)}
.chev{width:12px;height:12px;color:var(--muted);transition:transform 200ms cubic-bezier(.2,.8,.2,1)}
.grp[open] .chev{transform:rotate(90deg)}
.grp-label{font-weight:500;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.grp-n{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.grp-sub{grid-column:2/4;color:var(--muted);font-size:12px;line-height:16px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.grp-dots{grid-column:2/4;display:flex;flex-wrap:wrap;gap:3px;margin-top:4px}
.grp-dots i{width:6px;height:6px;border-radius:9999px;display:block}
.grp-items{padding:2px 0 6px}
.grp.anim .grp-items .item{animation:item-in 280ms cubic-bezier(.2,.8,.2,1) both}
@keyframes item-in{from{opacity:0;transform:translateY(-3px)}}
.item{display:flex;align-items:center;gap:8px;width:100%;text-align:left;border:0;background:none;color:var(--fg2);font-family:var(--sans);font-size:13px;padding:5px 8px 5px 28px;border-radius:8px;cursor:pointer;transition:background 120ms,color 120ms}
.item:hover{background:var(--bg2);color:var(--fg)}
.item.sel{background:var(--bg2);color:var(--fg);box-shadow:inset 0 0 0 1px var(--border2)}
.item .num{font-family:var(--mono);font-size:12px;color:var(--muted);flex-shrink:0;font-variant-numeric:tabular-nums}
.item .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.dot{width:8px;height:8px;border-radius:9999px;flex-shrink:0}
.k-iss{background:var(--open-fg)}.k-pr{background:var(--accent)}.k-merged{background:var(--merged-fg)}.k-closed{background:var(--closed-fg)}
.k-sup{background:transparent;box-shadow:inset 0 0 0 1.5px var(--accent)}
.dot-OPEN{background:var(--open-fg)}.dot-MERGED{background:var(--merged-fg)}.dot-CLOSED{background:var(--closed-fg)}.dot-UNKNOWN{background:var(--muted)}
.fl{color:var(--warn-fg);flex-shrink:0;font-size:12px}
.swarm .d.hl circle{stroke:var(--fg);stroke-width:2.5}
.swarm .d.hl{filter:drop-shadow(0 0 0 var(--fg))}
@media (prefers-reduced-motion:reduce){.chev,.mix-bar span,.grp.anim .grp-items .item{transition:none;animation:none}}
/* main */
.main{overflow-y:auto;padding:32px 40px 80px;min-height:0}
.empty{color:var(--muted);display:flex;height:100%;align-items:center;justify-content:center}
.insp h1{font-size:22px;font-weight:600;letter-spacing:-.02em;margin:0 0 4px;display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.insp h1 .num{font-family:var(--mono);color:var(--muted);font-size:18px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0}
.sec{margin-top:24px}
.sec h3{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:0 0 8px;font-weight:600}
.rel{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)}
.rel .via{font-family:var(--mono);font-size:11px;padding:1px 6px;border-radius:4px;background:var(--closed-bg);color:var(--fg2);min-width:78px;text-align:center}
.rel .via-closes,.rel .via-closed-by{background:var(--merged-bg);color:var(--merged-fg)}
.rel .via-competes,.rel .via-overlaps{background:var(--warn-bg);color:var(--warn-fg)}
.rellink{cursor:pointer;font-family:var(--mono)}
.verdict{padding:12px 14px;border-radius:var(--radius-md);background:var(--warn-bg);color:var(--warn-fg);font-weight:500;border:1px solid var(--border)}
.badge{font-size:12px;font-weight:500;padding:2px 8px;border-radius:9999px;white-space:nowrap}
.b-open{background:var(--open-bg);color:var(--open-fg)}.b-merged{background:var(--merged-bg);color:var(--merged-fg)}
.b-closed{background:var(--closed-bg);color:var(--closed-fg)}.b-warn{background:var(--warn-bg);color:var(--warn-fg)}
.b-danger{background:var(--danger-bg);color:var(--danger-fg)}.b-muted{background:var(--closed-bg);color:var(--muted)}
.kind{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
/* swarm */
.swarm-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:16px}
.swarm-head h1{font-size:22px;font-weight:600;letter-spacing:-.02em;margin:0 0 4px}
.seg{display:inline-flex;gap:2px;padding:2px;border:1px solid var(--border);border-radius:9999px;background:var(--bg2)}
.seg button{border:0;background:none;color:var(--muted);font-family:var(--sans);font-size:13px;height:28px;padding:0 12px;border-radius:9999px;cursor:pointer}
.seg button:hover{color:var(--fg)}
.seg button.on{background:var(--bg);color:var(--fg);box-shadow:0 0 0 1px var(--border2)}
.seg button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.segs{display:flex;gap:8px;flex-wrap:wrap}
.swarm-legend{display:flex;gap:16px;flex-wrap:wrap;align-items:center;font-size:13px;color:var(--fg2);margin:4px 0 12px}
.swarm-legend .lg{display:inline-flex;align-items:center;gap:6px}
.swarm-legend .lg b{font-weight:500;color:var(--muted);font-variant-numeric:tabular-nums}
.swarm-legend .tot{margin-left:auto;color:var(--muted);font-variant-numeric:tabular-nums}
.swarm-card{border:1px solid var(--border);border-radius:var(--radius-md);background:var(--bg);padding:16px 20px}
.swarm svg{display:block;overflow:visible}
.swarm .row-lbl{font-family:var(--sans);font-size:12px;fill:var(--fg2)}
.swarm .row-n{font-family:var(--sans);font-size:12px;fill:var(--muted)}
.swarm .grid{stroke:var(--border)}
.swarm .tick{font-family:var(--mono);font-size:11px;fill:var(--muted)}
.swarm .axis-t{font-family:var(--sans);font-size:12px;fill:var(--fg2)}.swarm .muted-t{fill:var(--muted)}
.swarm .d{cursor:pointer;transition:transform 700ms cubic-bezier(.2,.8,.2,1),opacity 300ms}
.swarm .d circle{stroke-width:1.5}
.swarm .d:hover circle{stroke:var(--fg);stroke-width:2}
.swarm .d.gone{opacity:0;pointer-events:none}
.c-iss{fill:var(--open-fg);stroke:var(--open-fg)}.c-pr{fill:var(--accent);stroke:var(--accent)}
.c-merged{fill:var(--merged-fg);stroke:var(--merged-fg)}.c-closed{fill:var(--closed-fg);stroke:var(--closed-fg)}
.c-sup{fill:var(--bg)!important}
.swarm-tip{position:fixed;pointer-events:none;z-index:10;max-width:320px;background:var(--bg);border:1px solid var(--border2);border-radius:var(--radius);padding:8px 10px;font-size:12px;line-height:17px;box-shadow:0 4px 12px rgba(0,0,0,.08)}
.swarm-tip .mono{color:var(--muted)}
.swarm .d .ring{fill:none;stroke:var(--warn-fg);stroke-width:1.5;opacity:0;transition:opacity 250ms}
.swarm .d.cl .ring{opacity:1}
.tip-cl{color:var(--warn-fg)}
.cl{max-width:880px}
.cl-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}
.cl-head h1{margin-bottom:4px}.cl-head p{margin:0;max-width:60ch}
.cl-swarm{flex-shrink:0;height:32px;padding:0 14px;border:1px solid var(--border2);border-radius:9999px;background:var(--bg);color:var(--fg);font-family:var(--sans);font-size:13px;cursor:pointer}
.cl-swarm:hover{background:var(--bg2)}
.cl-progress{display:flex;align-items:center;gap:12px;margin:24px 0 8px}
.cl-bar{flex:1;height:6px;border-radius:9999px;background:var(--bg2);box-shadow:inset 0 0 0 1px var(--border);overflow:hidden}
.cl-bar span{display:block;height:100%;background:var(--open-fg);border-radius:9999px;transition:width 500ms cubic-bezier(.2,.8,.2,1)}
.cl-count{font-size:13px;color:var(--fg2);font-variant-numeric:tabular-nums;white-space:nowrap}
.cl-sec{margin-top:24px}
.cl-h{font-size:14px;font-weight:600;margin:0 0 8px;display:flex;gap:8px;align-items:baseline}
.cl-h span{font-weight:400;color:var(--muted);font-variant-numeric:tabular-nums}
.cl-row{display:grid;grid-template-columns:16px 1fr auto;gap:12px;align-items:start;padding:12px 14px;border:1px solid var(--border);border-radius:10px;margin-bottom:6px;cursor:pointer;transition:background 150ms,opacity 200ms}
.cl-row:hover{background:var(--bg2)}
.cl-row input{margin:3px 0 0;accent-color:var(--open-fg)}
.cl-body{display:flex;flex-direction:column;gap:4px;min-width:0}
.cl-top{display:flex;align-items:center;gap:8px;min-width:0}
.cl-key{font-family:var(--mono);font-size:13px;flex-shrink:0}
.cl-title{color:var(--muted);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cl-text{font-size:14px;line-height:20px;color:var(--fg)}
.cl-grp{font-size:12px;color:var(--fg2);background:var(--bg2);border:1px solid var(--border);border-radius:9999px;padding:1px 8px;white-space:nowrap;max-width:180px;overflow:hidden;text-overflow:ellipsis}
.cl-row.done{opacity:.55}.cl-row.done .cl-text{text-decoration:line-through;color:var(--muted)}
@media(max-width:820px){.cl-row{grid-template-columns:16px 1fr}.cl-grp{grid-column:2}}
.rk-weights{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;margin:4px 0 8px}
@media(max-width:1100px){.rk-weights{grid-template-columns:repeat(2,minmax(0,1fr))}}
.rk-w{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--bg)}
.rk-w-top{display:flex;justify-content:space-between;align-items:center;font-size:13px;font-weight:500}
.rk-w-top span{display:inline-flex;align-items:center;gap:6px}
.rk-w output{font-family:var(--mono);font-size:12px;color:var(--fg2);font-variant-numeric:tabular-nums}
.rk-w input{width:100%;accent-color:var(--fg)}
.rk-w-sub{font-size:12px;color:var(--muted)}
.rk-sw{width:8px;height:8px;border-radius:2px;display:inline-block}
.rk-formula{font-family:var(--mono);font-size:12px;margin:8px 0 12px}
.rk-card{border:1px solid var(--border);border-radius:var(--radius-md);overflow:hidden}
.rk-table{width:100%;border-collapse:collapse;font-size:13px}
.rk-table th{text-align:right;font-weight:500;color:var(--muted);font-size:12px;padding:10px 12px;border-bottom:1px solid var(--border);background:var(--bg2);white-space:nowrap}
.rk-table th:nth-child(2),.rk-table th:nth-child(3){text-align:left}
.rk-table td{padding:10px 12px;border-bottom:1px solid var(--border);text-align:right;font-variant-numeric:tabular-nums;color:var(--fg2);vertical-align:top}
.rk-table tr:last-child td{border-bottom:0}
.rk-table tbody tr{cursor:pointer;background:var(--bg);position:relative}
.rk-table tbody tr:hover{background:var(--bg2)}
.rk-table tbody tr:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.rk-n{width:32px;color:var(--muted)!important;text-align:right}
.rk-item{text-align:left!important;width:48%;max-width:0}
.rk-top{display:flex;align-items:center;gap:8px;min-width:0;color:var(--fg)}
.rk-key{font-family:var(--mono);font-size:12px;color:var(--muted);flex-shrink:0}
.rk-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rk-bar{display:flex;gap:1px;height:4px;margin-top:8px;border-radius:9999px;overflow:hidden}
.rk-bar span{display:block;height:100%;transition:width 400ms cubic-bezier(.2,.8,.2,1)}
.rk-grp{text-align:left!important;max-width:160px}
.rk-grp span{display:inline-block;font-size:12px;color:var(--fg2);background:var(--bg2);border:1px solid var(--border);border-radius:9999px;padding:1px 8px;white-space:nowrap;max-width:160px;overflow:hidden;text-overflow:ellipsis;vertical-align:middle}
.rk-score{font-weight:600;color:var(--fg)!important;width:56px}
.rk-s0{background:var(--accent)}.rk-s1{background:var(--open-fg)}.rk-s2{background:var(--warn-fg)}.rk-s3{background:var(--merged-fg)}.rk-s4{background:var(--closed-fg)}
.rk-s0-t{color:var(--accent)}.rk-s1-t{color:var(--open-fg)}.rk-s2-t{color:var(--warn-fg)}.rk-s3-t{color:var(--merged-fg)}.rk-s4-t{color:var(--closed-fg)}
@media (prefers-reduced-motion:reduce){.rk-bar span{transition:none}}
@media (prefers-reduced-motion:reduce){.swarm .d,.swarm .d .ring,.cl-bar span{transition:none}}
svg .lbl{font-family:var(--mono);font-size:10px;fill:var(--fg)}
svg .center{font-weight:600}
.view-in{animation:view-in 320ms cubic-bezier(.2,.8,.2,1) both}
@keyframes view-in{from{opacity:0;transform:translateY(4px)}}
.stagger>*{animation:view-in 360ms cubic-bezier(.2,.8,.2,1) both}
/* explore: cluster map */
.ex-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.ex-card{display:flex;flex-direction:column;gap:10px;text-align:left;padding:16px;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--bg);color:var(--fg);font-family:var(--sans);cursor:pointer;transition:border-color 150ms,box-shadow 200ms,transform 200ms cubic-bezier(.2,.8,.2,1)}
.ex-card:hover{border-color:var(--border2);box-shadow:0 4px 16px rgba(0,0,0,.06);transform:translateY(-1px)}
.ex-card:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.ex-top{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.ex-label{font-weight:600;font-size:15px;letter-spacing:-.01em}
.ex-n{font-size:13px;color:var(--muted);font-variant-numeric:tabular-nums}
.ex-cause{font-size:13px;line-height:19px;color:var(--fg2);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:38px}
.ex-dots{display:flex;flex-wrap:wrap;gap:4px}.ex-dots i{width:8px;height:8px;border-radius:9999px;display:block}
.ex-meta{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--muted);border-top:1px solid var(--border);padding-top:10px}
.ex-meta b{font-weight:500;color:var(--fg2);font-variant-numeric:tabular-nums}
.ex-meta .warn b{color:var(--warn-fg)}
.ex-hot{font-size:12px;color:var(--fg2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ex-hot span{font-family:var(--mono);color:var(--muted)}
.ex-back{border:0;background:none;color:var(--muted);font-family:var(--sans);font-size:13px;padding:0;cursor:pointer;margin-bottom:8px}
.ex-back:hover{color:var(--fg)}
.ex-graph{border:1px solid var(--border);border-radius:var(--radius-md);background:var(--bg);margin:16px 0}
.ex-graph svg{display:block;width:100%}
.ex-graph .e{stroke:var(--border2);stroke-width:1.25;fill:none;transition:stroke 150ms,opacity 150ms}
.ex-graph .e.closes{stroke:var(--merged-fg)}
.ex-graph .e.draw{stroke-dasharray:var(--len);stroke-dashoffset:var(--len);animation:draw 600ms cubic-bezier(.2,.8,.2,1) forwards}
@keyframes draw{to{stroke-dashoffset:0}}
.ex-graph .n{cursor:pointer}
.ex-graph .n circle{transform-box:fill-box;transform-origin:center;animation:pop 420ms cubic-bezier(.3,1.4,.5,1) both;stroke:var(--bg);stroke-width:2}
@keyframes pop{from{transform:scale(0)}}
.ex-graph .n text{font-family:var(--mono);font-size:10px;fill:var(--muted);pointer-events:none;transition:fill 150ms}
.ex-graph.focus .e{opacity:.15}.ex-graph.focus .e.on{opacity:1;stroke:var(--fg)}
.ex-graph.focus .n{opacity:.3;transition:opacity 150ms}.ex-graph.focus .n.on{opacity:1}.ex-graph.focus .n.on text{fill:var(--fg)}
.ex-graph .n .ring{fill:none;stroke:var(--warn-fg);stroke-width:1.5}
.tbl{width:100%;border-collapse:collapse;font-size:13px;table-layout:fixed}
.tbl th:nth-child(1){width:auto}.tbl th:nth-child(2){width:90px}.tbl th:nth-child(3),.tbl th:nth-child(4){width:64px}
.tbl td:first-child{overflow:hidden}
.tbl th{text-align:left;font-weight:500;color:var(--muted);font-size:12px;padding:8px 12px;border-bottom:1px solid var(--border);background:var(--bg2)}
.tbl td{padding:9px 12px;border-bottom:1px solid var(--border);color:var(--fg2);vertical-align:top}
.tbl tr:last-child td{border-bottom:0}
.tbl tbody tr{cursor:pointer}.tbl tbody tr:hover{background:var(--bg2)}
.tbl .num{text-align:right;font-variant-numeric:tabular-nums}
.tbl .who{display:flex;align-items:center;gap:8px;color:var(--fg);min-width:0}
.tbl .who .k{font-family:var(--mono);font-size:12px;color:var(--muted);flex-shrink:0}
.tbl .who .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tbl .act{color:var(--warn-fg);font-size:12px}
.card-wrap{border:1px solid var(--border);border-radius:var(--radius-md);overflow:hidden}
/* impact: ranking + ripple */
.im{display:grid;grid-template-columns:minmax(0,1fr) 420px;gap:24px;align-items:start}
@media(max-width:1180px){.im{grid-template-columns:1fr}}
.im-list{display:flex;flex-direction:column;border:1px solid var(--border);border-radius:var(--radius-md);overflow:hidden}
.im-row{display:grid;grid-template-columns:28px minmax(0,1fr) 160px 32px;gap:12px;align-items:center;padding:9px 12px;border:0;border-bottom:1px solid var(--border);background:var(--bg);color:var(--fg);font-family:var(--sans);font-size:13px;text-align:left;cursor:pointer;transition:background 120ms}
.im-row:last-child{border-bottom:0}
.im-row:hover{background:var(--bg2)}
.im-row.on{background:var(--bg2);box-shadow:inset 0 0 0 1px var(--border2)}
.im-row:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.im-rank{color:var(--muted);font-variant-numeric:tabular-nums;text-align:right}
.im-who{display:flex;align-items:center;gap:8px;min-width:0}
.im-who .k{font-family:var(--mono);font-size:12px;color:var(--muted);flex-shrink:0}
.im-who .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.im-lane{height:8px;border-radius:9999px;background:var(--bg2);overflow:hidden;display:flex;gap:1px}
.im-lane span{display:block;height:100%;transform-origin:left;animation:grow 500ms cubic-bezier(.2,.8,.2,1) both}
@keyframes grow{from{transform:scaleX(0)}}
.im-total{font-weight:600;font-variant-numeric:tabular-nums;text-align:right}
.b-resolves{background:var(--open-fg)}.b-prs{background:var(--accent)}.b-overlaps{background:var(--warn-fg)}.b-followups{background:var(--merged-fg)}.b-related{background:var(--closed-fg)}
.s-resolves{fill:var(--open-fg)}.s-prs{fill:var(--accent)}.s-overlaps{fill:var(--warn-fg)}.s-followups{fill:var(--merged-fg)}.s-related{fill:var(--closed-fg)}
.im-panel{position:sticky;top:0;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--bg);padding:16px}
.im-panel h2{font-size:15px;font-weight:600;margin:0 0 2px;display:flex;gap:8px;align-items:baseline}
.im-panel h2 .k{font-family:var(--mono);font-size:13px;color:var(--muted);font-weight:400}
.im-panel .sub{font-size:13px;color:var(--fg2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.im-rip{display:block;width:100%;margin:8px 0}
.im-rip .orbit{fill:none;stroke:var(--border);stroke-dasharray:2 4}
.im-rip .ray{stroke:var(--border2);stroke-width:1.25;stroke-dasharray:var(--len);stroke-dashoffset:var(--len);animation:draw 520ms cubic-bezier(.2,.8,.2,1) forwards}
.im-rip .sat{cursor:pointer}
.im-rip .sat circle{transform-box:fill-box;transform-origin:center;animation:pop 420ms cubic-bezier(.3,1.4,.5,1) both;stroke:var(--bg);stroke-width:2}
.im-rip .sat text{font-family:var(--mono);font-size:10px;fill:var(--fg2);pointer-events:none}
.im-rip .sat:hover circle{stroke:var(--fg)}
.im-rip .core{fill:var(--fg)}
.im-rip .core-t{font-family:var(--mono);font-size:11px;fill:var(--bg);font-weight:600}
.im-rip .wave{fill:none;stroke:var(--fg);opacity:0;transform-box:fill-box;transform-origin:center;animation:wave 900ms ease-out 1}
@keyframes wave{0%{opacity:.35;transform:scale(.3)}100%{opacity:0;transform:scale(1)}}
.im-legend{display:grid;grid-template-columns:1fr 1fr;gap:6px 16px;font-size:12px;color:var(--fg2)}
.im-legend span{display:flex;align-items:center;gap:6px}.im-legend b{margin-left:auto;font-weight:500;font-variant-numeric:tabular-nums;color:var(--fg)}
.im-legend i{width:8px;height:8px;border-radius:9999px;display:block}
.im-actions{display:flex;gap:8px;margin-top:14px}
.im-hint{font-size:12px;color:var(--muted);margin-top:8px}
@media (prefers-reduced-motion:reduce){.view-in,.stagger>*,.ex-graph .e.draw,.ex-graph .n circle,.im-lane span,.im-rip .ray,.im-rip .sat circle,.im-rip .wave{animation:none;stroke-dashoffset:0}}
@media(max-width:820px){.impact-head{flex-direction:column}.impact-breakdown{grid-template-columns:1fr 1fr}.main{padding:24px 16px 60px}}
`;

const LABS_SVG =
  '<svg class="labs-mark" aria-hidden="true" fill="none" focusable="false" viewBox="0 0 183 42" xmlns="http://www.w3.org/2000/svg"><path clip-rule="evenodd" d="M23.5092 0L47.0185 41.44H0L23.5092 0Z" fill="currentColor" fill-rule="evenodd"></path><path d="M169.729 41.2752C166.731 41.2752 164.206 40.8386 162.156 39.9656C160.145 39.0925 158.588 37.8778 157.487 36.3214C156.387 34.7651 155.76 32.9999 155.608 31.026L163.068 30.6844C163.333 32.2787 163.998 33.5124 165.06 34.3855C166.123 35.2585 167.699 35.6951 169.786 35.6951C171.495 35.6951 172.823 35.4294 173.772 34.8979C174.759 34.3285 175.253 33.4554 175.253 32.2787C175.253 31.5954 175.082 31.026 174.74 30.5705C174.399 30.115 173.753 29.7164 172.804 29.3748C171.855 29.0331 170.451 28.6915 168.591 28.3498C165.478 27.8184 163.03 27.1731 161.245 26.4139C159.461 25.6167 158.19 24.6298 157.43 23.453C156.709 22.2763 156.349 20.8148 156.349 19.0687C156.349 16.2217 157.43 13.9251 159.594 12.1789C161.796 10.3948 165.003 9.50278 169.217 9.50278C171.95 9.50278 174.247 9.95829 176.107 10.8693C177.967 11.7424 179.409 12.9571 180.434 14.5135C181.497 16.0319 182.161 17.778 182.427 19.7519L175.082 20.0936C174.892 19.0687 174.55 18.1766 174.057 17.4174C173.563 16.6582 172.899 16.0888 172.064 15.7092C171.229 15.2917 170.242 15.0829 169.103 15.0829C167.395 15.0829 166.104 15.4245 165.231 16.1078C164.358 16.7911 163.922 17.7021 163.922 18.8409C163.922 19.6381 164.111 20.3024 164.491 20.8338C164.909 21.3652 165.573 21.8018 166.484 22.1434C167.395 22.4471 168.61 22.7318 170.128 22.9975C173.317 23.491 175.822 24.1363 177.644 24.9335C179.504 25.6927 180.814 26.6796 181.573 27.8943C182.37 29.0711 182.769 30.4946 182.769 32.1648C182.769 34.1008 182.218 35.752 181.117 37.1186C180.055 38.4851 178.536 39.529 176.562 40.2503C174.626 40.9335 172.349 41.2752 169.729 41.2752Z" fill="currentColor"></path><path d="M141.184 41.2752C139.058 41.2752 137.198 40.8197 135.603 39.9086C134.047 38.9976 132.832 37.7259 131.959 36.0937L131.788 40.5919H124.842V0.164658L132.13 0.164658V14.5135C132.965 13.109 134.161 11.9322 135.717 10.9832C137.274 9.99626 139.096 9.50278 141.184 9.50278C143.803 9.50278 146.061 10.1671 147.959 11.4957C149.895 12.7863 151.376 14.6274 152.401 17.0188C153.464 19.3723 153.995 22.1624 153.995 25.389C153.995 28.6156 153.464 31.4246 152.401 33.8161C151.376 36.1696 149.895 38.0106 147.959 39.3392C146.061 40.6299 143.803 41.2752 141.184 41.2752ZM139.532 35.3534C141.62 35.3534 143.29 34.4804 144.543 32.7342C145.796 30.9501 146.422 28.5017 146.422 25.389C146.422 22.2383 145.796 19.7899 144.543 18.0438C143.328 16.2976 141.677 15.4245 139.589 15.4245C138.033 15.4245 136.685 15.8231 135.546 16.6203C134.446 17.3795 133.592 18.4993 132.984 19.9797C132.415 21.4601 132.13 23.2632 132.13 25.389C132.13 27.4388 132.415 29.2229 132.984 30.7413C133.592 32.2218 134.446 33.3606 135.546 34.1577C136.647 34.9549 137.976 35.3534 139.532 35.3534Z" fill="currentColor"></path><path d="M103.361 41.2752C100.172 41.2752 97.6099 40.5539 95.6739 39.1115C93.738 37.631 92.77 35.5812 92.77 32.962C92.77 30.3427 93.5862 28.2929 95.2184 26.8125C96.8507 25.332 99.3371 24.2692 102.678 23.6238L112.756 21.631C112.756 19.4672 112.262 17.8539 111.275 16.7911C110.288 15.6902 108.827 15.1398 106.891 15.1398C105.145 15.1398 103.759 15.5574 102.734 16.3925C101.748 17.1896 101.064 18.3474 100.685 19.8658L93.2825 19.5242C93.8898 16.2976 95.3703 13.8302 97.7238 12.122C100.077 10.3759 103.133 9.50278 106.891 9.50278C111.219 9.50278 114.483 10.6036 116.685 12.8053C118.924 14.969 120.044 18.0817 120.044 22.1434V33.1897C120.044 33.9869 120.177 34.5373 120.443 34.841C120.746 35.1447 121.183 35.2965 121.752 35.2965H122.72V40.5919C122.493 40.6678 122.113 40.7248 121.582 40.7627C121.088 40.8007 120.576 40.8197 120.044 40.8197C118.792 40.8197 117.672 40.6299 116.685 40.2503C115.698 39.8327 114.939 39.1304 114.407 38.1435C113.876 37.1186 113.61 35.733 113.61 33.9869L114.236 34.4424C113.933 35.771 113.268 36.9667 112.243 38.0296C111.256 39.0545 110.004 39.8517 108.485 40.4211C106.967 40.9905 105.259 41.2752 103.361 41.2752ZM104.841 35.9798C106.474 35.9798 107.878 35.6571 109.055 35.0118C110.232 34.3665 111.143 33.4744 111.788 32.3356C112.433 31.1968 112.756 29.8493 112.756 28.2929V26.5847L104.898 28.179C103.266 28.5207 102.089 29.0331 101.368 29.7164C100.685 30.3617 100.343 31.2158 100.343 32.2787C100.343 33.4554 100.723 34.3665 101.482 35.0118C102.279 35.6571 103.399 35.9798 104.841 35.9798Z" fill="currentColor"></path><path d="M64.0186 40.5919V0.164627L71.4207 0.164627V38.3143L67.378 34.1577H90.6094V40.5919H64.0186Z" fill="currentColor"></path></svg>';

const APP = `
const LABS_SVG=${JSON.stringify(LABS_SVG)};
const DATA=JSON.parse(document.getElementById('data').textContent);
const N=DATA.nodes;
const app=document.getElementById('app');
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const short=k=>{const n=String(k).split('#')[1];return n?'#'+n:k};
const tone=s=>s==='OPEN'?'open':s==='MERGED'?'merged':s==='CLOSED'?'closed':'muted';
let sel=null;
let lastHash=null;
// views write the hash themselves; remember it so hashchange does not re-render
function setHash(h){lastHash=decodeURIComponent(h);if(location.hash.slice(1)!==h)location.hash=h;}
let view='explore';
let impactSel=null;

function kcls(n){
  if(n.state==='MERGED')return 'k-merged';
  if(n.state!=='OPEN')return 'k-closed';
  if(/SUPERSEDED/.test(n.verdict||''))return 'k-sup';
  return n.kind==='PullRequest'?'k-pr':'k-iss';
}
function sidebar(){
  const s=DATA.stats,all=Object.values(N);
  const mix=[['k-iss','Open issues',all.filter(n=>n.state==='OPEN'&&n.kind!=='PullRequest').length],
    ['k-pr','Open PRs',all.filter(n=>n.state==='OPEN'&&n.kind==='PullRequest').length],
    ['k-merged','Merged',all.filter(n=>n.state==='MERGED').length],
    ['k-closed','Closed',all.filter(n=>n.state!=='OPEN'&&n.state!=='MERGED').length]].filter(m=>m[2]);
  const stats=[['Nodes',s.nodes,''],['Open PRs',s.openPRs,''],['Open issues',s.openIssues,''],
    ['Superseded',s.superseded,'warn'],['Competing',s.competing,'warn'],['No close link',s.noClose,'danger']];
  const chev='<svg class="chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const groups=DATA.groups.map((g,gi)=>{
    const ms=g.members.filter(k=>N[k]);
    const items=ms.map((k,i)=>{const n=N[k];
      const fl=n.flags.length?'<span class="fl" title="'+esc(n.flags.join(' · '))+'">⚠</span>':'';
      const t=(n.key+' '+n.title+' '+(n.author||'')).toLowerCase();
      return '<button class="item" data-key="'+esc(k)+'" data-t="'+esc(t)+'" style="animation-delay:'+Math.min(i*18,220)+'ms">'+
        '<span class="dot '+kcls(n)+'"></span><span class="num">'+short(k)+'</span>'+
        '<span class="t">'+esc(n.title||'(no title)')+'</span>'+fl+'</button>';
    }).join('');
    const dots=ms.slice().sort((a,b)=>kcls(N[a]).localeCompare(kcls(N[b]))).map(k=>'<i class="'+kcls(N[k])+'"></i>').join('');
    return '<details class="grp" '+(DATA.groups.length<=6?'open':'')+' data-gi="'+gi+'">'+
      '<summary>'+chev+'<span class="grp-label">'+esc(g.label)+'</span><span class="grp-n">'+ms.length+'</span>'+
      (g.subtitle?'<span class="grp-sub">'+esc(g.subtitle)+'</span>':'')+
      '<span class="grp-dots" aria-hidden="true">'+dots+'</span></summary><div class="grp-items">'+items+'</div></details>';
  }).join('');
  const cleanupBtn=DATA.cleanup.length
    ? '<button id="cleanup-btn" class="cleanup-pill"><span>Cleanup checklist</span><span class="cnt">'+DATA.cleanup.filter((c,i)=>!DONE.has(clId(c,i))).length+'</span></button>'
    : '';
  const total=mix.reduce((a,m)=>a+m[2],0)||1;
  return '<div class="side"><div class="side-top">'+
    '<div class="brand"><div class="brand-row"><a class="labs" href="https://vercel.com/labs" target="_blank" rel="noopener" aria-label="Vercel Labs">'+LABS_SVG+'</a><span class="brand-sep" aria-hidden="true">/</span><span class="brand-name">issue-graph</span></div><span class="brand-repo">'+esc(DATA.repo)+'</span></div>'+
    '<div class="mix"><div class="mix-bar" role="img" aria-label="'+esc(mix.map(m=>m[2]+' '+m[1].toLowerCase()).join(', '))+'">'+
      mix.map(m=>'<span class="'+m[0]+'" style="flex-grow:'+(m[2]/total)+'"></span>').join('')+'</div>'+
      '<div class="mix-legend">'+mix.map(m=>'<span><i class="dot '+m[0]+'"></i>'+m[1]+' <b>'+m[2]+'</b></span>').join('')+'</div></div>'+
    '<div class="stats">'+stats.map(t=>'<div class="stat '+(t[1]===0?'zero':t[2])+'"><div class="stat-n">'+t[1]+'</div><div class="stat-l">'+t[0]+'</div></div>').join('')+'</div>'+
    '<div class="view-toggle" role="group" aria-label="View"><button class="view-btn active" id="explore-view">Explore</button><button class="view-btn" id="impact-view">Impact</button><button class="view-btn" id="swarm-view">Swarm</button><button class="view-btn" id="rank-view">Rank</button></div>'+
    '<input class="filter" id="filter" placeholder="Filter by #, title, author" aria-label="Filter nodes"/>'+cleanupBtn+'</div>'+
    '<div class="tree">'+groups+'</div></div>';
}

function egoSvg(n){
  const nb=[];const push=(k,via)=>{if(N[k]&&!nb.find(x=>x.k===k))nb.push({k,via})};
  n.out.forEach(e=>push(e.to,e.via));
  n.in.forEach(e=>push(e.from,e.via==='closes'?'closed-by':e.via));
  n.overlaps.forEach(o=>push(o.with,'overlaps'));
  const cap=nb.slice(0,12),W=560,H=260,cx=W/2,cy=H/2,r=95;
  const col=v=>v==='closes'||v==='closed-by'?'var(--merged-fg)':v==='overlaps'||v==='competes'?'var(--warn-fg)':'var(--border2)';
  const parts=cap.map((x,i)=>{const a=(i/cap.length)*2*Math.PI-Math.PI/2,px=cx+r*Math.cos(a)*1.9,py=cy+r*Math.sin(a);
    const t=N[x.k];
    return '<line x1="'+cx+'" y1="'+cy+'" x2="'+px+'" y2="'+py+'" stroke="'+col(x.via)+'" stroke-width="1.5"/>'+
      '<circle cx="'+px+'" cy="'+py+'" r="4" fill="var(--'+tone(t.state)+'-fg)"/>'+
      '<text class="lbl rellink" data-key="'+esc(x.k)+'" x="'+px+'" y="'+(py-8)+'" text-anchor="middle">'+short(x.k)+' '+esc(x.via)+'</text>';
  }).join('');
  const more=nb.length>cap.length?'<text class="lbl" x="'+(W-8)+'" y="'+(H-8)+'" text-anchor="end">+'+(nb.length-cap.length)+' more</text>':'';
  return '<svg viewBox="0 0 '+W+' '+H+'" width="100%" height="'+H+'">'+parts+
    '<circle cx="'+cx+'" cy="'+cy+'" r="6" fill="var(--accent)"/>'+
    '<text class="lbl center" x="'+cx+'" y="'+(cy-12)+'" text-anchor="middle">'+short(n.key)+'</text>'+more+'</svg>';
}

function relList(title,arr,fmt){if(!arr.length)return '';
  return '<div class="sec"><h3>'+title+'</h3>'+arr.map(fmt).join('')+'</div>';}

function inspector(k){
  const n=N[k];if(!n){app.querySelector('.main').innerHTML='<div class="empty">not found</div>';return}
  const badges=[];
  badges.push('<span class="badge b-'+tone(n.state)+'">'+n.state+'</span>');
  badges.push('<span class="kind">'+(n.kind==='PullRequest'?'PR':'issue')+'</span>');
  if(n.author)badges.push('<span class="muted">@'+esc(n.author)+'</span>');
  if(n.seed)badges.push('<span class="badge b-muted">seed</span>');
  let pr='';
  if(n.pr){const p=n.pr,m=[];
    if(p.draft)m.push('<span class="badge b-muted">draft</span>');
    m.push('<span class="badge b-'+(p.review==='APPROVED'?'open':p.review==='CHANGES_REQUESTED'?'danger':'warn')+'">review: '+esc(p.review)+'</span>');
    if(p.mergeable==='CONFLICTING')m.push('<span class="badge b-danger">conflicting</span>');
    m.push('<span class="muted mono">+'+p.adds+'/-'+p.dels+' · '+p.files+'f</span>');
    if(p.updated)m.push('<span class="muted">updated '+p.updated+'</span>');
    pr='<div class="row">'+m.join(' ')+'</div>';}
  const flags=n.flags.length?'<div class="row">'+n.flags.map(f=>'<span class="badge b-'+(/no closing link|conflicting/i.test(f)?'danger':'warn')+'">'+esc(f)+'</span>').join(' ')+'</div>':'';
  const verdict=n.verdict&&!n.seed?'<div class="sec"><div class="verdict">'+esc(n.verdict)+'</div></div>':'';
  const closesOut=n.out.filter(e=>e.via==='closes').map(e=>({k:e.to,via:'closes'}));
  const otherOut=n.out.filter(e=>e.via!=='closes');
  const closedByIn=n.in.filter(e=>e.via==='closes').map(e=>({k:e.from,via:'closed by'}));
  const otherIn=n.in.filter(e=>e.via!=='closes');
  const rel=(x)=>{const t=N[x.k];const lbl=t?esc(t.title):'(beyond depth)';
    return '<div class="rel"><span class="via via-'+(x.via.replace(' ','-'))+'">'+esc(x.via)+'</span>'+
      '<span class="dot dot-'+(t?t.state:'UNKNOWN')+'"></span>'+
      (t?'<a class="rellink" data-key="'+esc(x.k)+'">'+short(x.k)+'</a>':short(x.k))+
      ' <span class="muted" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+lbl+'</span></div>';};
  const ovl=n.overlaps.slice().sort((a,b)=>b.significant-a.significant).map(o=>{
    const dup=o.sharedIssue?' <span class="badge b-warn">both close '+short(o.sharedIssue)+'</span>':'';
    return '<div class="rel"><span class="via via-overlaps">overlaps</span>'+
      '<a class="rellink" data-key="'+esc(o.with)+'">'+short(o.with)+'</a>'+dup+
      '<span class="muted" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"> '+o.shared.map(f=>'<code>'+esc(f)+'</code>').join(' ')+'</span></div>';});
  const ext=n.external.map(u=>'<div class="rel"><span class="via">external</span><a href="'+esc(u)+'" target="_blank" rel="noopener">'+esc(u)+'</a></div>');
  const ment=n.mentionedBy.length?'<div class="sec"><h3>mentioned by</h3><div class="row">'+n.mentionedBy.map(u=>'<span class="badge b-muted">@'+esc(u)+'</span>').join(' ')+'</div></div>':'';

  app.querySelector('.main').innerHTML='<div class="insp">'+
    '<h1><span class="num">'+short(n.key)+'</span> '+esc(n.title||'(no title)')+'</h1>'+
    '<div class="row">'+badges.join(' ')+' <a href="'+esc(n.url)+'" target="_blank" rel="noopener">open on GitHub ↗</a></div>'+
    pr+flags+verdict+
    '<div class="sec"><h3>neighborhood</h3>'+egoSvg(n)+'</div>'+
    relList('closes',closesOut,rel)+relList('closed by',closedByIn,rel)+
    relList('overlaps (shared files)',ovl,x=>x)+
    relList('references out',otherOut.map(e=>({k:e.to,via:e.via})),rel)+
    relList('referenced by',otherIn.map(e=>({k:e.from,via:e.via})),rel)+
    ment+relList('external links',ext,x=>x)+'</div>';
  for(const b of app.querySelectorAll('.item'))b.classList.toggle('sel',b.dataset.key===k);
}

// Cleanup progress is per-viewer scratch; nothing is posted to GitHub.
const CL_KEY='issue-graph:cleanup:'+DATA.repo;
const DONE=new Set((()=>{try{return JSON.parse(localStorage.getItem(CL_KEY)||'[]')}catch{return []}})());
const saveDone=()=>{try{localStorage.setItem(CL_KEY,JSON.stringify([...DONE]))}catch{}};
const clId=(c,i)=>(c.key||'')+'|'+i;
const CL_ACTIONS=[['retest','Retest',/retest/i],['pick','Pick one',/pick one/i],['duplicate','Duplicate',/duplicate/i],
  ['supersede','Supersede',/supersed/i],['close','Close',/close/i],['other','Other',/./]];
function clAction(t){return CL_ACTIONS.find(a=>a[2].test(t))}
function clPending(){const m=new Set();DATA.cleanup.forEach((c,i)=>{if(c.key&&!DONE.has(clId(c,i)))m.add(c.key)});return m}
function refLinks(text){
  const repo=DATA.repo;
  return esc(text).replace(/#([0-9]+)/g,(m,num)=>N[repo+'#'+num]?'<a class="rellink" data-key="'+esc(repo+'#'+num)+'">'+m+'</a>':m);
}
function cleanupView(){
  setView('cleanup');
  const labels=groupLabels();
  const rows=DATA.cleanup.map((c,i)=>({c,i,id:clId(c,i),a:clAction(c.text)}));
  const done=rows.filter(r=>DONE.has(r.id)).length;
  const sections=CL_ACTIONS.map(a=>{
    const rs=rows.filter(r=>r.a[0]===a[0]);if(!rs.length)return '';
    return '<section class="cl-sec"><h2 class="cl-h">'+a[1]+' <span>'+rs.length+'</span></h2>'+rs.map(r=>{
      const n=r.c.key&&N[r.c.key];
      const target=n?'<a class="rellink cl-key" data-key="'+esc(r.c.key)+'">'+short(r.c.key)+'</a>':'<span class="cl-key">'+esc(r.c.key?r.c.key.split('/').slice(1).join('/'):'')+'</span>';
      return '<label class="cl-row'+(DONE.has(r.id)?' done':'')+'" data-id="'+esc(r.id)+'">'+
        '<input type="checkbox"'+(DONE.has(r.id)?' checked':'')+'/>'+
        '<span class="cl-body"><span class="cl-top">'+(n?'<i class="dot '+kcls(n)+'"></i>':'')+target+
          (n?'<span class="cl-title">'+esc(n.title)+'</span>':'<span class="cl-title">outside this graph</span>')+'</span>'+
        '<span class="cl-text">'+refLinks(r.c.text)+'</span></span>'+
        '<span class="cl-grp">'+esc(n?labels[r.c.key]||'Ungrouped':'External')+'</span></label>';
    }).join('')+'</section>';
  }).join('');
  const pct=rows.length?Math.round(done/rows.length*100):0;
  app.querySelector('.main').innerHTML='<div class="insp cl">'+
    '<div class="cl-head"><div><h1>Cleanup</h1><p class="muted">What to close, supersede, or retest, and who to credit. Check items off as you go; progress stays in this browser and nothing is posted to GitHub.</p></div>'+
    '<button class="cl-swarm" id="cl-swarm">Show in Swarm</button></div>'+
    '<div class="cl-progress"><div class="cl-bar"><span style="width:'+pct+'%"></span></div><span class="cl-count">'+done+' of '+rows.length+' done</span></div>'+
    sections+'</div>';
  for(const r of app.querySelectorAll('.cl-row input'))r.onchange=e=>{const id=e.target.closest('.cl-row').dataset.id;
    if(e.target.checked)DONE.add(id);else DONE.delete(id);saveDone();cleanupView();};
  document.getElementById('cl-swarm').onclick=()=>swarmView();
  for(const b of app.querySelectorAll('.item'))b.classList.remove('sel');
  const cb=document.getElementById('cleanup-btn');if(cb){cb.classList.add('active');const n=cb.querySelector('.cnt');if(n)n.textContent=rows.length-done;}
  setHash('cleanup');sel='cleanup';
}
function select(k){setView('explore');sel=k;setHash(encodeURIComponent(k));const cb=document.getElementById('cleanup-btn');if(cb)cb.classList.remove('active');inspector(k);}

function neighbors(k){
  const n=N[k],out=new Set();
  if(!n)return out;
  n.out.forEach(e=>{if(N[e.to])out.add(e.to)});
  n.in.forEach(e=>{if(N[e.from])out.add(e.from)});
  n.overlaps.forEach(o=>{if(N[o.with])out.add(o.with)});
  return out;
}

function blastRadius(k){
  const n=N[k];
  const raw={resolves:new Set(),prs:new Set(),overlaps:new Set(),followups:new Set(),related:new Set()};
  if(!n)return {...raw,keys:[],total:0,issues:0,prCount:0};

  if(n.kind==='PullRequest'){
    for(const e of n.out){
      if(e.via!=='closes'||!N[e.to])continue;
      raw.resolves.add(e.to);
      for(const incoming of N[e.to].in){
        if(incoming.via==='closes'&&incoming.from!==k&&N[incoming.from]?.state==='OPEN')raw.prs.add(incoming.from);
      }
    }
    n.overlaps.forEach(o=>{if(N[o.with]?.state==='OPEN')raw.overlaps.add(o.with)});
  }else if(n.kind==='Issue'){
    for(const incoming of n.in){
      if(incoming.via==='closes'&&N[incoming.from]?.state==='OPEN')raw.prs.add(incoming.from);
    }
    for(const pr of raw.prs){
      N[pr].overlaps.forEach(o=>{if(N[o.with]?.state==='OPEN')raw.overlaps.add(o.with)});
    }
  }

  for(const linked of neighbors(k)){
    const target=N[linked];
    if(!target||target.state!=='OPEN')continue;
    if(target.kind==='Issue')raw.followups.add(linked);
    else if(target.kind==='PullRequest'&&/^POSSIBLY SUPERSEDED|^SUPERSEDED/.test(target.verdict||''))raw.prs.add(linked);
    else raw.related.add(linked);
  }

  const seen=new Set([k]);
  const ordered=['resolves','prs','overlaps','followups','related'];
  for(const bucket of ordered){
    for(const key of [...raw[bucket]]){
      if(seen.has(key))raw[bucket].delete(key);else seen.add(key);
    }
  }
  const keys=[...seen].filter(x=>x!==k);
  const issues=keys.filter(x=>N[x]?.kind==='Issue').length;
  const prCount=keys.filter(x=>N[x]?.kind==='PullRequest').length;
  return {...raw,keys,total:keys.length,issues,prCount};
}

function groupLabels(){
  const labels={};
  DATA.groups.forEach(g=>g.members.forEach(k=>{labels[k]=g.label}));
  return labels;
}

const BUCKETS=[['resolves','Issues it resolves'],['prs','PRs to reconcile'],['overlaps','Overlapping PRs'],['followups','Follow-up issues'],['related','Other open links']];
function impactRows(){
  return Object.keys(N).filter(k=>N[k].state==='OPEN').map(k=>({k,b:blastRadius(k)})).filter(r=>r.b.total>0)
    .sort((x,y)=>y.b.total-x.b.total||y.b.resolves.size-x.b.resolves.size||x.k.localeCompare(y.k));
}
function ripple(k){
  const b=blastRadius(k),W=460,H=360,cx=W/2,cy=H/2,R1=78,R2=140;
  const inner=[...b.resolves].map(x=>[x,'resolves']).concat([...b.prs].map(x=>[x,'prs']));
  const outer=[...b.overlaps].map(x=>[x,'overlaps']).concat([...b.followups].map(x=>[x,'followups']),[...b.related].map(x=>[x,'related']));
  let i=0;
  const ring=(list,r,phase)=>list.map((it,j)=>{const a=-Math.PI/2+phase+(j/list.length)*2*Math.PI;
    const x=cx+r*Math.cos(a),y=cy+r*Math.sin(a),len=Math.round(r),d=(i++)*45;
    const lx=cx+(r+18)*Math.cos(a),ly=cy+(r+18)*Math.sin(a)+3;
    return '<line class="ray" x1="'+cx+'" y1="'+cy+'" x2="'+x+'" y2="'+y+'" style="--len:'+len+';animation-delay:'+d+'ms"/>'+
      '<g class="sat" data-key="'+esc(it[0])+'"><title>'+esc(short(it[0])+' '+(N[it[0]]?.title||''))+'</title>'+
      '<circle class="s-'+it[1]+'" cx="'+x+'" cy="'+y+'" r="7" style="animation-delay:'+(d+220)+'ms"/>'+
      '<text x="'+lx+'" y="'+ly+'" text-anchor="'+(Math.abs(lx-cx)<8?'middle':lx<cx?'end':'start')+'">'+short(it[0])+'</text></g>';}).join('');
  const body=ring(inner,R1,0)+ring(outer,R2,Math.PI/Math.max(outer.length,1));
  return '<svg class="im-rip" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+b.total+' items affected by '+esc(short(k))+'">'+
    (inner.length?'<circle class="orbit" cx="'+cx+'" cy="'+cy+'" r="'+R1+'"/>':'')+(outer.length?'<circle class="orbit" cx="'+cx+'" cy="'+cy+'" r="'+R2+'"/>':'')+
    '<circle class="wave" cx="'+cx+'" cy="'+cy+'" r="'+R2+'"/>'+body+
    '<circle class="core" cx="'+cx+'" cy="'+cy+'" r="22"/><text class="core-t" x="'+cx+'" y="'+(cy+4)+'" text-anchor="middle">'+short(k)+'</text></svg>';
}
function impactPanel(k){
  const n=N[k],b=blastRadius(k);
  return '<div class="im-panel view-in" id="im-panel"><h2><span class="k">'+short(k)+'</span>'+(n.kind==='PullRequest'?'If this PR ships':'If this issue is resolved')+'</h2>'+
    '<div class="sub">'+esc(n.title||'')+'</div>'+ripple(k)+
    '<div class="im-legend">'+BUCKETS.map(x=>'<span><i class="b-'+x[0]+'"></i>'+x[1]+'<b>'+b[x[0]].size+'</b></span>').join('')+
    '<span><i style="background:var(--fg)"></i>Total affected<b>'+b.total+'</b></span></div>'+
    '<div class="im-actions"><button class="cl-swarm" id="im-inspect">Inspect evidence</button><button class="cl-swarm" id="im-swarm">See in Swarm</button></div>'+
    '<div class="im-hint">Inner ring: direct effects. Outer ring: work that touches it. A projection from visible links, not proof.</div></div>';
}
function impactView(k){
  setView('impact');
  const rows=impactRows();
  if(k!==undefined&&k!==null&&N[k])impactSel=k;
  if(!impactSel||!rows.some(r=>r.k===impactSel))impactSel=rows[0]?.k||null;
  const max=Math.max(1,...rows.map(r=>r.b.total));
  const list=rows.map((r,i)=>{const n=N[r.k];
    const lane=BUCKETS.map((x,j)=>r.b[x[0]].size?'<span class="b-'+x[0]+'" style="width:'+(r.b[x[0]].size/max*100)+'%;animation-delay:'+(Math.min(i,14)*25+j*40)+'ms"></span>':'').join('');
    return '<button class="im-row'+(r.k===impactSel?' on':'')+'" data-k="'+esc(r.k)+'"><span class="im-rank">'+(i+1)+'</span>'+
      '<span class="im-who"><i class="dot '+kcls(n)+'"></i><span class="k">'+short(r.k)+'</span><span class="t">'+esc(n.title||'')+'</span></span>'+
      '<span class="im-lane" aria-hidden="true">'+lane+'</span><span class="im-total">'+r.b.total+'</span></button>';}).join('');
  app.querySelector('.main').innerHTML='<div class="view-in">'+
    '<div class="swarm-head"><div><h1>Impact</h1><div class="muted">Open items ranked by how much other work their resolution touches. Pick one to see its ripple; use ↑ and ↓ to move.</div></div></div>'+
    (rows.length?'<div class="im"><div class="im-list" role="listbox" aria-label="Items by impact">'+list+'</div><div id="im-side">'+impactPanel(impactSel)+'</div></div>'
      :'<div class="empty">No open item has a visible downstream effect in this graph.</div>')+'</div>';
  for(const b of app.querySelectorAll('.item'))b.classList.remove('sel');
  const pick=key=>{impactSel=key;
    for(const r of app.querySelectorAll('.im-row'))r.classList.toggle('on',r.dataset.k===key);
    document.getElementById('im-side').innerHTML=impactPanel(key);wireImpactPanel();
    setHash('impact:'+encodeURIComponent(key));};
  for(const r of app.querySelectorAll('.im-row')){r.onclick=()=>pick(r.dataset.k);
    r.onkeydown=e=>{if(e.key!=='ArrowDown'&&e.key!=='ArrowUp')return;e.preventDefault();
      const next=e.key==='ArrowDown'?r.nextElementSibling:r.previousElementSibling;if(next){next.focus();pick(next.dataset.k)}};}
  wireImpactPanel();
  if(impactSel)setHash('impact:'+encodeURIComponent(impactSel));sel='impact';
}
function wireImpactPanel(){
  for(const g of app.querySelectorAll('.im-rip .sat'))g.onclick=()=>impactView(g.dataset.key);
  const i=document.getElementById('im-inspect');if(i)i.onclick=()=>select(impactSel);
  const w=document.getElementById('im-swarm');if(w)w.onclick=()=>swarmView(undefined,'blast');
}

// Explore: the cluster map first, then one cluster's subgraph, then a node.
function clusterStats(g){
  const ms=g.members.filter(k=>N[k]),open=ms.filter(k=>N[k].state==='OPEN');
  const pend=clPending();
  const hot=open.filter(k=>N[k].heat).sort((a,b)=>heatScore(N[b])-heatScore(N[a]))[0];
  return {ms,open:open.length,prs:open.filter(k=>N[k].kind==='PullRequest').length,cleanup:ms.filter(k=>pend.has(k)).length,
    heat:Math.round(open.reduce((a,k)=>a+(N[k].heat?heatScore(N[k]):0),0)),hot};
}
function exploreView(gi){
  setView('explore');
  for(const b of app.querySelectorAll('.item'))b.classList.remove('sel');
  const cb=document.getElementById('cleanup-btn');if(cb)cb.classList.remove('active');
  if(gi!=null&&DATA.groups[gi])return clusterView(+gi);
  const order=DATA.groups.map((g,i)=>({g,i,st:clusterStats(g)})).sort((a,b)=>b.st.heat-a.st.heat||b.st.open-a.st.open);
  const cards=order.map((c,j)=>{const st=c.st;
    const dots=st.ms.slice().sort((a,b)=>kcls(N[a]).localeCompare(kcls(N[b]))).map(k=>'<i class="'+kcls(N[k])+'"></i>').join('');
    return '<button class="ex-card" data-gi="'+c.i+'" style="animation-delay:'+Math.min(j*45,360)+'ms">'+
      '<span class="ex-top"><span class="ex-label">'+esc(c.g.label)+'</span><span class="ex-n">'+st.ms.length+'</span></span>'+
      '<span class="ex-cause">'+esc(c.g.subtitle||'No root cause recorded.')+'</span>'+
      '<span class="ex-dots" aria-hidden="true">'+dots+'</span>'+
      (st.hot?'<span class="ex-hot">Hottest: <span>'+short(st.hot)+'</span> '+esc(N[st.hot].title)+'</span>':'<span class="ex-hot">Nothing open.</span>')+
      '<span class="ex-meta"><span><b>'+st.open+'</b> open</span><span><b>'+st.prs+'</b> PRs</span><span><b>'+st.heat+'</b> heat</span>'+
      (st.cleanup?'<span class="warn"><b>'+st.cleanup+'</b> to clean up</span>':'')+'</span></button>';}).join('');
  app.querySelector('.main').innerHTML='<div class="view-in"><div class="swarm-head"><div><h1>Explore</h1><div class="muted">'+
    DATA.groups.length+' groups, hottest first. Open one to see how its items reference each other.</div></div></div>'+
    '<div class="ex-grid stagger">'+cards+'</div></div>';
  for(const c of app.querySelectorAll('.ex-card'))c.onclick=()=>exploreView(+c.dataset.gi);
  setHash('explore');sel='explore';
}
function layoutCluster(keys,W,H){
  const P={},n=keys.length,idx=new Map(keys.map((k,i)=>[k,i]));
  keys.forEach((k,i)=>{const a=(i/n)*2*Math.PI;P[k]={x:W/2+Math.cos(a)*W*.3,y:H/2+Math.sin(a)*H*.3,vx:0,vy:0}});
  const links=[];keys.forEach(k=>N[k].out.forEach(e=>{if(idx.has(e.to)&&e.to!==k)links.push([k,e.to,e.via])}));
  keys.forEach(k=>N[k].overlaps.forEach(o=>{if(idx.has(o.with)&&k<o.with)links.push([k,o.with,'overlaps'])}));
  for(let it=0;it<260;it++){
    for(let i=0;i<n;i++)for(let j=i+1;j<n;j++){const a=P[keys[i]],b=P[keys[j]];let dx=a.x-b.x,dy=a.y-b.y,d2=dx*dx+dy*dy||1;
      const f=2600/d2;const d=Math.sqrt(d2);dx/=d;dy/=d;a.vx+=dx*f;a.vy+=dy*f;b.vx-=dx*f;b.vy-=dy*f;}
    for(const [s,t] of links){const a=P[s],b=P[t];const dx=b.x-a.x,dy=b.y-a.y,d=Math.sqrt(dx*dx+dy*dy)||1,f=(d-90)*.02;
      a.vx+=dx/d*f;a.vy+=dy/d*f;b.vx-=dx/d*f;b.vy-=dy/d*f;}
    for(const k of keys){const p=P[k];p.vx+=(W/2-p.x)*.004;p.vy+=(H/2-p.y)*.004;p.x+=p.vx*.5;p.y+=p.vy*.5;p.vx*=.6;p.vy*=.6;
      p.x=Math.max(30,Math.min(W-30,p.x));p.y=Math.max(24,Math.min(H-24,p.y));}
  }
  return {P,links};
}
function clusterView(gi){
  const g=DATA.groups[gi],st=clusterStats(g),keys=st.ms,W=860,H=Math.min(460,220+keys.length*14);
  const {P,links}=layoutCluster(keys,W,H),pend=clPending();
  const edges=links.map(([s,t,via],i)=>{const a=P[s],b=P[t],len=Math.round(Math.hypot(b.x-a.x,b.y-a.y));
    return '<line class="e draw'+(via==='closes'?' closes':'')+'" data-s="'+esc(s)+'" data-t="'+esc(t)+'" x1="'+a.x+'" y1="'+a.y+'" x2="'+b.x+'" y2="'+b.y+'" style="--len:'+len+';animation-delay:'+(200+i*30)+'ms"><title>'+esc(via)+'</title></line>';}).join('');
  const nodes=keys.map((k,i)=>{const p=P[k],n=N[k],r=n.heat?5+Math.min(9,Math.sqrt(heatScore(n))):5;
    return '<g class="n" data-key="'+esc(k)+'" tabindex="0"><title>'+esc(short(k)+' '+n.title)+'</title>'+
      (pend.has(k)?'<circle class="ring" cx="'+p.x+'" cy="'+p.y+'" r="'+(r+4)+'"/>':'')+
      '<circle class="'+swClass(n)+(/SUPERSEDED/.test(n.verdict||'')?' c-sup':'')+'" cx="'+p.x+'" cy="'+p.y+'" r="'+r+'" style="animation-delay:'+(i*35)+'ms"/>'+
      '<text x="'+p.x+'" y="'+(p.y-r-6)+'" text-anchor="middle">'+short(k)+'</text></g>';}).join('');
  const labels=DATA.cleanup.reduce((m,c,i)=>{if(c.key&&!DONE.has(clId(c,i)))m[c.key]=c.text;return m},{});
  const rows=keys.slice().sort((a,b)=>(N[b].heat?heatScore(N[b]):-1)-(N[a].heat?heatScore(N[a]):-1)).map(k=>{const n=N[k];
    return '<tr data-key="'+esc(k)+'"><td><span class="who"><i class="dot '+kcls(n)+'"></i><span class="k">'+short(k)+'</span><span class="t">'+esc(n.title)+'</span></span>'+
      (labels[k]?'<div class="act">'+esc(labels[k])+'</div>':'')+(n.verdict&&!labels[k]?'<div class="act">'+esc(n.verdict)+'</div>':'')+'</td>'+
      '<td>'+n.state.toLowerCase()+'</td><td class="num">'+(n.heat?heatScore(n):'')+'</td><td class="num">'+neighbors(k).size+'</td></tr>';}).join('');
  app.querySelector('.main').innerHTML='<div class="view-in"><button class="ex-back" id="ex-back">← All groups</button>'+
    '<div class="swarm-head"><div><h1>'+esc(g.label)+'</h1><div class="muted">'+esc(g.subtitle||'')+'</div></div>'+
    '<div class="segs"><span class="muted" style="font-size:13px">'+st.open+' open · '+st.prs+' PRs · '+st.heat+' heat'+(st.cleanup?' · '+st.cleanup+' to clean up':'')+'</span></div></div>'+
    '<div class="ex-graph" id="ex-graph"><svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="References between the items in '+esc(g.label)+'">'+edges+nodes+'</svg></div>'+
    '<div class="muted" style="font-size:12px;margin:-8px 0 16px">Dot size is heat; purple lines close, grey lines reference or share files; an amber ring needs cleanup. Hover to trace, click to inspect.</div>'+
    '<div class="card-wrap"><table class="tbl"><thead><tr><th>Item</th><th>State</th><th class="num">Heat</th><th class="num">Links</th></tr></thead><tbody>'+rows+'</tbody></table></div></div>';
  const graph=document.getElementById('ex-graph');
  const focus=k=>{graph.classList.toggle('focus',!!k);if(!k)return;
    const on=new Set([k]);for(const e of graph.querySelectorAll('.e')){const hit=e.dataset.s===k||e.dataset.t===k;e.classList.toggle('on',hit);if(hit){on.add(e.dataset.s);on.add(e.dataset.t)}}
    for(const n of graph.querySelectorAll('.n'))n.classList.toggle('on',on.has(n.dataset.key));};
  for(const n of graph.querySelectorAll('.n')){n.onmouseenter=()=>focus(n.dataset.key);n.onmouseleave=()=>focus(null);
    n.onfocus=()=>focus(n.dataset.key);n.onblur=()=>focus(null);n.onclick=()=>select(n.dataset.key);
    n.onkeydown=e=>{if(e.key==='Enter')select(n.dataset.key)};}
  for(const tr of app.querySelectorAll('.tbl tbody tr')){tr.onclick=()=>select(tr.dataset.key);
    tr.onmouseenter=()=>focus(tr.dataset.key);tr.onmouseleave=()=>focus(null);}
  document.getElementById('ex-back').onclick=()=>exploreView();
  setHash('explore:'+gi);sel='explore:'+gi;
}

// Swarm: every node is a dot. Toggling grouping or x-metric moves the same
// dots (keyed by node) so the transition shows where each item went.
const SW={by:'cluster',x:'links'};
const SW_BY=[['cluster','Cluster'],['state','State'],['kind','Kind'],['all','All']];
const SW_X=[['heat','Heat'],['links','Links'],['blast','Blast radius'],['depth','Depth']];
const SW_META={
  heat:{axis:'Triage score: discussion, people, reactions, references, age',dir:'hotter',
    say:'the items with the most discussion and frustration, scored with the Rank weights'},
  links:{axis:'How many other issues and PRs is it connected to?',dir:'more connected',
    say:'the most connected items, the hubs where several threads meet'},
  blast:{axis:'How many items does resolving it affect?',dir:'more leverage',
    say:'the items whose fix unblocks the most other work'},
  depth:{axis:'How many reference hops from the seed bugs?',dir:'further away',
    say:'items pulled in indirectly, several references away from the seeds'}};
const SW_BY_SAY={cluster:'Each row is a root cause the agent found.',state:'Each row is a state: open, merged, closed.',
  kind:'Each row is issues or pull requests.',all:'One row with every node.'};
function swClass(n){
  if(n.state==='MERGED')return 'c-merged';
  if(n.state!=='OPEN')return 'c-closed';
  return n.kind==='PullRequest'?'c-pr':'c-iss';
}
function swGroups(){
  const keys=Object.keys(N);
  if(SW.by==='all')return [{label:'All nodes',members:keys}];
  if(SW.by==='state'||SW.by==='kind'){
    const f=SW.by==='state'?(n=>n.state):(n=>n.kind==='PullRequest'?'Pull requests':'Issues');
    const m=new Map();keys.forEach(k=>{const g=f(N[k]);(m.get(g)??m.set(g,[]).get(g)).push(k)});
    return [...m].map(([label,members])=>({label:label.charAt(0)+label.slice(1).toLowerCase(),members})).sort((a,b)=>b.members.length-a.members.length);
  }
  return DATA.groups.map(g=>({label:g.label,members:g.members.filter(k=>N[k])})).filter(g=>g.members.length);
}
function swMetric(k){
  const n=N[k];
  if(SW.x==='depth')return n.depth;
  if(SW.x==='heat')return n.heat?heatScore(n):null;
  if(SW.x==='blast')return blastRadius(k).total;
  return neighbors(k).size;
}
function swLayout(W){
  const R=4,GAP=5,D=2*R+GAP,LBL=190,PAD=12;
  // a metric can be undefined for a node (closed items have no heat): leave it out
  const vals={};Object.keys(N).forEach(k=>{const v=swMetric(k);if(v!=null)vals[k]=v});
  const groups=swGroups().map(g=>({...g,members:g.members.filter(k=>k in vals)})).filter(g=>g.members.length);
  const max=Math.max(1,...Object.values(vals));
  // linear and exact: a dot's x is its value, equal values stack vertically
  const x0=LBL+PAD,x1=W-PAD-8,px=v=>x0+(v/max)*(x1-x0);
  const pos={};let y=0;const rows=[];
  for(const g of groups){
    const placed=[];
    const sorted=g.members.slice().sort((a,b)=>vals[a]-vals[b]||a.localeCompare(b));
    for(const k of sorted){
      const x=px(vals[k]);let off=0;
      for(let i=0;;i++){
        off=i===0?0:(i%2?1:-1)*Math.ceil(i/2)*D;
        if(!placed.some(p=>Math.abs(p.x-x)<D&&Math.abs(p.o-off)<D))break;
      }
      placed.push({k,x,o:off});
    }
    const spread=placed.reduce((m,p)=>Math.max(m,Math.abs(p.o)),0);
    const h=Math.max(44,2*spread+D+20);
    const cy=y+h/2+6;
    placed.forEach(p=>{pos[p.k]={x:p.x,y:cy+p.o}});
    rows.push({label:g.label,n:g.members.length,top:y,h,cy});
    y+=h;
  }
  const step=Math.max(1,Math.ceil(max/12));const ticks=[];
  for(let t=0;t<=max;t+=step)ticks.push(t);
  return {pos,rows,H:y+52,ticks:ticks.map(t=>({t,x:px(t)})),x0,x1,R};
}
function swarmSvg(W){
  const L=swLayout(W);
  const rows=L.rows.map((r,i)=>
    (i?'<line class="grid" x1="0" x2="'+W+'" y1="'+r.top+'" y2="'+r.top+'"/>':'')+
    '<text class="row-lbl" x="0" y="'+(r.cy+4)+'">'+esc(r.label.length>26?r.label.slice(0,25)+'…':r.label)+'</text>'+
    '<text class="row-n" x="'+(L.x0-16)+'" y="'+(r.cy+4)+'" text-anchor="end">'+r.n+'</text>').join('');
  const ay=L.H-48,meta=SW_META[SW.x];
  const axis='<line class="grid" x1="'+L.x0+'" x2="'+L.x1+'" y1="'+ay+'" y2="'+ay+'"/>'+
    L.ticks.map(t=>'<line class="grid" x1="'+t.x+'" x2="'+t.x+'" y1="'+ay+'" y2="'+(ay+4)+'"/>'+
      '<text class="tick" x="'+t.x+'" y="'+(ay+16)+'" text-anchor="middle">'+t.t+'</text>').join('')+
    '<text class="axis-t" x="'+L.x0+'" y="'+(ay+38)+'">'+esc(meta.axis)+'</text>'+
    '<text class="axis-t muted-t" x="'+L.x1+'" y="'+(ay+38)+'" text-anchor="end">'+esc(meta.dir)+' →</text>';
  return {L,frame:'<g class="sw-rows">'+rows+axis+'</g>'};
}
function swarmRender(){
  const card=document.getElementById('swarm-card');if(!card)return;
  const W=Math.max(480,card.clientWidth-40);
  const {L,frame}=swarmSvg(W);
  let svg=card.querySelector('svg');
  if(!svg){
    const dots=Object.keys(N).map(k=>{const n=N[k];const sup=/SUPERSEDED/.test(n.verdict||'')?' c-sup':'';
      return '<g class="d" data-key="'+esc(k)+'"><circle class="ring" r="'+(L.R+2.5)+'"/><circle r="'+L.R+'" class="'+swClass(n)+sup+'"/></g>'}).join('');
    card.innerHTML='<svg width="'+W+'"><g class="sw-frame"></g><g class="sw-dots">'+dots+'</g></svg>';
    svg=card.querySelector('svg');
    // first paint: start every dot on the baseline, then let it travel in
    for(const g of svg.querySelectorAll('.d'))g.style.transform='translate('+L.x0+'px,'+(L.H-48)+'px)';
    svg.getBoundingClientRect();
  }
  svg.setAttribute('width',W);svg.setAttribute('height',L.H);svg.setAttribute('viewBox','0 0 '+W+' '+L.H);
  svg.querySelector('.sw-frame').innerHTML=frame;
  const say=document.getElementById('sw-say');
  if(say)say.textContent='Each dot is an issue or PR. '+SW_BY_SAY[SW.by]+' Further right: '+SW_META[SW.x].say+'.';
  const pend=clPending();
  for(const g of svg.querySelectorAll('.d'))g.classList.toggle('cl',pend.has(g.dataset.key));
  const ordered=[...svg.querySelectorAll('.d')].sort((a,b)=>(L.pos[a.dataset.key]?.x??0)-(L.pos[b.dataset.key]?.x??0));
  ordered.forEach((g,i)=>{const p=L.pos[g.dataset.key];
    g.style.transitionDelay=Math.min(i*2,240)+'ms';
    if(p){g.classList.remove('gone');g.style.transform='translate('+p.x+'px,'+p.y+'px)'}else g.classList.add('gone');});
}
function swarmView(by,x){
  if(by&&SW_BY.some(b=>b[0]===by))SW.by=by;
  if(x&&SW_X.some(b=>b[0]===x))SW.x=x;
  setView('swarm');
  const seg=(id,opts,cur)=>'<div class="seg" role="group" id="'+id+'">'+opts.map(o=>'<button data-v="'+o[0]+'" class="'+(o[0]===cur?'on':'')+'" aria-pressed="'+(o[0]===cur)+'">'+o[1]+'</button>').join('')+'</div>';
  const all=Object.values(N);
  const cnt=f=>all.filter(f).length;
  const lg=(c,l,n,hollow)=>'<span class="lg"><svg width="10" height="10"><circle cx="5" cy="5" r="4" class="'+c+(hollow?' c-sup':'')+'" stroke-width="1.5"/></svg>'+l+' <b>'+n+'</b></span>';
  app.querySelector('.main').innerHTML='<div class="swarm">'+
    '<div class="swarm-head"><div><h1>Swarm</h1><div class="muted" id="sw-say"></div></div>'+
    '<div class="segs">'+seg('sw-x',SW_X,SW.x)+seg('sw-by',SW_BY,SW.by)+'</div></div>'+
    '<div class="swarm-legend">'+lg('c-iss','Open issue',cnt(n=>n.state==='OPEN'&&n.kind!=='PullRequest'))+
    lg('c-pr','Open PR',cnt(n=>n.state==='OPEN'&&n.kind==='PullRequest'))+
    lg('c-merged','Merged',cnt(n=>n.state==='MERGED'))+lg('c-closed','Closed',cnt(n=>n.state!=='OPEN'&&n.state!=='MERGED'))+
    lg('c-pr','Superseded',DATA.stats.superseded,true)+
    (DATA.cleanup.length?'<span class="lg"><svg width="16" height="16"><circle cx="8" cy="8" r="6.5" fill="none" stroke="var(--warn-fg)" stroke-width="1.5"/></svg>Needs cleanup (ring) <b>'+clPending().size+'</b></span>':'')+
    '<span class="tot">'+all.length+' nodes, '+DATA.groups.length+' groups</span></div>'+
    '<div class="swarm-card" id="swarm-card"></div></div>';
  for(const b of app.querySelectorAll('.item'))b.classList.remove('sel');
  const wireSeg=(id,key)=>{for(const b of document.querySelectorAll('#'+id+' button'))b.onclick=()=>{
    SW[key]=b.dataset.v;
    for(const o of document.querySelectorAll('#'+id+' button')){o.classList.toggle('on',o===b);o.setAttribute('aria-pressed',o===b)}
    setHash('swarm:'+SW.by+':'+SW.x);swarmRender();}};
  wireSeg('sw-by','by');wireSeg('sw-x','x');
  const card=document.getElementById('swarm-card');
  let tip=document.getElementById('swarm-tip');
  if(!tip){tip=document.createElement('div');tip.id='swarm-tip';tip.className='swarm-tip';tip.hidden=true;document.body.appendChild(tip)}
  card.onmousemove=e=>{const g=e.target.closest('.d');if(!g){tip.hidden=true;return}
    const n=N[g.dataset.key];tip.hidden=false;
    tip.innerHTML='<span class="mono">'+short(n.key)+'</span> '+esc(n.title||'(no title)')+'<br><span class="muted">'+n.state.toLowerCase()+' · '+swMetric(n.key)+' '+SW_X.find(o=>o[0]===SW.x)[1].toLowerCase()+'</span>'+
      DATA.cleanup.filter((c,i)=>c.key===n.key&&!DONE.has(clId(c,i))).map(c=>'<br><span class="tip-cl">'+esc(c.text)+'</span>').join('');
    tip.style.left=(e.clientX+12)+'px';tip.style.top=(e.clientY+12)+'px'};
  card.onmouseleave=()=>{tip.hidden=true};
  card.onclick=e=>{const g=e.target.closest('.d');if(g){tip.hidden=true;select(g.dataset.key)}};
  setHash('swarm:'+SW.by+':'+SW.x);sel='swarm';
  requestAnimationFrame(swarmRender);
}
window.addEventListener('resize',()=>{if(view==='swarm')swarmRender()});

// Rank: the CLI's --prioritize score, recomputed live from editable weights.
const RK_DEFAULT=[3,2,2,2,1];
const RK_SIGNALS=[['comments','Comments','Discussion depth'],['participants','People','Distinct participants'],
  ['reactions','Reactions','Frustration signal'],['inboundRefs','Refs','Other items pointing here'],['age','Age','Per 30 days open, max 12']];
let RK=RK_DEFAULT.slice();
function heatParts(n){
  const h=n.heat;if(!h)return null;
  const v=[h.comments,h.participants,h.reactions,h.inboundRefs,Math.min(12,h.daysOpen/30)];
  return v.map((x,i)=>x*RK[i]);
}
function heatScore(n){const p=heatParts(n);return p?Math.round(p.reduce((a,b)=>a+b,0)*10)/10:0}
function rankRows(){
  return Object.values(N).filter(n=>n.heat).map(n=>({n,parts:heatParts(n),score:heatScore(n)}))
    .sort((a,b)=>b.score-a.score||a.n.key.localeCompare(b.n.key));
}
function rankHash(){return 'rank:'+RK.join(',')}
function rankRender(){
  const body=document.getElementById('rk-body');if(!body)return;
  const labels=groupLabels(),rows=rankRows(),max=Math.max(1,...rows.map(r=>r.score));
  // FLIP: remember where each row was, re-render, then animate from there
  const before={};for(const tr of body.children)before[tr.dataset.key]=tr.getBoundingClientRect().top;
  body.innerHTML=rows.map((r,i)=>{const n=r.n,h=n.heat;
    const bar=r.parts.map((p,j)=>p>0?'<span class="rk-s'+j+'" style="width:'+(p/max*100)+'%" title="'+RK_SIGNALS[j][1]+': '+Math.round(p*10)/10+'"></span>':'').join('');
    return '<tr data-key="'+esc(n.key)+'" tabindex="0">'+
      '<td class="rk-n">'+(i+1)+'</td>'+
      '<td class="rk-item"><span class="rk-top"><i class="dot '+kcls(n)+'"></i><span class="rk-key">'+short(n.key)+'</span>'+
        '<span class="rk-title">'+esc(n.title||'(no title)')+'</span></span>'+
        '<span class="rk-bar" aria-hidden="true">'+bar+'</span></td>'+
      '<td class="rk-grp"><span>'+esc(labels[n.key]||'Ungrouped')+'</span></td>'+
      '<td>'+h.comments+'</td><td>'+h.participants+'</td><td>'+h.reactions+'</td><td>'+h.inboundRefs+'</td><td>'+h.daysOpen+'</td>'+
      '<td class="rk-score">'+r.score+'</td></tr>';}).join('');
  const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(!reduce)for(const tr of body.children){const was=before[tr.dataset.key];if(was==null)continue;
    const dy=was-tr.getBoundingClientRect().top;if(!dy)continue;
    tr.style.transform='translateY('+dy+'px)';tr.style.transition='none';
    requestAnimationFrame(()=>{tr.style.transition='transform 500ms cubic-bezier(.2,.8,.2,1)';tr.style.transform=''});}
  for(const tr of body.children){tr.onclick=()=>select(tr.dataset.key);tr.onkeydown=e=>{if(e.key==='Enter')select(tr.dataset.key)}}
  const f=document.getElementById('rk-formula');
  if(f)f.innerHTML=RK_SIGNALS.map((sg,i)=>'<span class="rk-s'+i+'-t">'+sg[1].toLowerCase()+' × '+RK[i]+'</span>').join(' + ');
}
function rankView(w){
  if(w){const v=w.split(',').map(Number);if(v.length===5&&v.every(x=>Number.isFinite(x)&&x>=0&&x<=10))RK=v;}
  setView('rank');
  const sliders=RK_SIGNALS.map((sg,i)=>'<label class="rk-w"><span class="rk-w-top"><span><i class="rk-sw rk-s'+i+'"></i>'+sg[1]+'</span><output id="rk-o'+i+'">× '+RK[i]+'</output></span>'+
    '<input type="range" min="0" max="5" step="0.5" value="'+RK[i]+'" data-i="'+i+'" aria-label="'+sg[1]+' weight"/>'+
    '<span class="rk-w-sub">'+sg[2]+'</span></label>').join('');
  const n=Object.values(N).filter(x=>x.heat).length;
  app.querySelector('.main').innerHTML='<div class="rk">'+
    '<div class="swarm-head"><div><h1>Rank</h1><div class="muted">'+n+' open items ordered by triage score, the same one <code>--prioritize</code> prints. Drag a weight to change what counts; the order is a place to start reading, not a verdict.</div></div>'+
    '<div class="segs"><button class="cl-swarm" id="rk-swarm">Show heat in Swarm</button><button class="cl-swarm" id="rk-reset">Reset weights</button></div></div>'+
    '<div class="rk-weights">'+sliders+'</div>'+
    '<div class="rk-formula muted" id="rk-formula"></div>'+
    '<div class="rk-card"><table class="rk-table"><thead><tr><th class="rk-n">#</th><th>Item</th><th>Cluster</th><th>Comments</th><th>People</th><th>Reactions</th><th>Refs</th><th>Days</th><th class="rk-score">Score</th></tr></thead>'+
    '<tbody id="rk-body"></tbody></table></div></div>';
  for(const b of app.querySelectorAll('.item'))b.classList.remove('sel');
  for(const r of app.querySelectorAll('.rk-w input'))r.oninput=e=>{const i=+e.target.dataset.i;RK[i]=+e.target.value;
    document.getElementById('rk-o'+i).textContent='× '+RK[i];
    lastHash=rankHash();history.replaceState(null,'','#'+rankHash());rankRender();};
  document.getElementById('rk-reset').onclick=()=>{RK=RK_DEFAULT.slice();rankView();};
  document.getElementById('rk-swarm').onclick=()=>swarmView(undefined,'heat');
  setHash(rankHash());sel='rank';
  rankRender();
}

function setView(next){
  view=next;
  const explore=document.getElementById('explore-view'),impact=document.getElementById('impact-view');
  if(explore)explore.classList.toggle('active',view==='explore');
  if(impact)impact.classList.toggle('active',view==='impact');
  const swarm=document.getElementById('swarm-view');if(swarm)swarm.classList.toggle('active',view==='swarm');
  const rank=document.getElementById('rank-view');if(rank)rank.classList.toggle('active',view==='rank');
}

function wire(){
  const cb=document.getElementById('cleanup-btn');if(cb)cb.onclick=cleanupView;
  document.getElementById('explore-view').onclick=()=>exploreView();
  document.getElementById('impact-view').onclick=()=>impactView();
  document.getElementById('swarm-view').onclick=()=>swarmView();
  document.getElementById('rank-view').onclick=()=>rankView();
  for(const g of app.querySelectorAll('.grp'))g.addEventListener('toggle',()=>{
    g.classList.remove('anim');if(g.open){void g.offsetWidth;g.classList.add('anim')}});
  for(const b of app.querySelectorAll('.item')){b.onclick=()=>select(b.dataset.key);
    b.onmouseenter=()=>{const d=app.querySelector('.swarm .d[data-key="'+CSS.escape(b.dataset.key)+'"]');if(d)d.classList.add('hl')};
    b.onmouseleave=()=>{for(const d of app.querySelectorAll('.swarm .d.hl'))d.classList.remove('hl')};}
  app.addEventListener('click',e=>{const r=e.target.closest('.rellink');if(r&&r.dataset.key){e.preventDefault();
    const g=[...app.querySelectorAll('.grp')].find(d=>[...d.querySelectorAll('.item')].some(i=>i.dataset.key===r.dataset.key));
    if(g)g.open=true;select(r.dataset.key);
    const it=app.querySelector('.item[data-key="'+CSS.escape(r.dataset.key)+'"]');if(it)it.scrollIntoView({block:'nearest'});}});
  const f=document.getElementById('filter');
  f.oninput=()=>{const t=f.value.trim().toLowerCase();
    for(const it of app.querySelectorAll('.item')){it.style.display=(!t||it.dataset.t.includes(t))?'':'none';}
    for(const g of app.querySelectorAll('.grp')){const any=[...g.querySelectorAll('.item')].some(i=>i.style.display!=='none');
      g.style.display=any?'':'none';if(any&&t)g.open=true;}};
}

app.className='';
app.innerHTML='<div class="shell">'+sidebar()+'<div class="main"><div class="empty">Select a node to inspect its relationships</div></div></div>';
wire();
function route(){
  const h=decodeURIComponent(location.hash.slice(1));
  if(h===lastHash)return;
  if(h==='cleanup'&&DATA.cleanup.length)cleanupView();
  else if(h==='explore')exploreView();
  else if(h.startsWith('explore:'))exploreView(+h.slice(8));
  else if(h==='impact')impactView(null);
  else if(h.startsWith('impact:')&&N[h.slice(7)])impactView(h.slice(7));
  else if(h.startsWith('rank'))rankView(h.split(':')[1]);
  else if(h.startsWith('swarm'))swarmView(h.split(':')[1],h.split(':')[2]);
  else if(h&&N[h])select(h);
  else exploreView();
  lastHash=decodeURIComponent(location.hash.slice(1));
}
window.addEventListener('hashchange',route);
route();
`;
