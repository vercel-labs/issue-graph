import { isSupersededVerdict } from "./classify.js";
import { components } from "./crawl.js";
import { fileOverlaps } from "./overlaps.js";
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
.side-top{padding:16px;border-bottom:1px solid var(--border)}
.brand{font-weight:600;font-size:15px}.logo{color:var(--accent)}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px}
.tile{background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius);padding:8px}
.tile-n{font-family:var(--mono);font-weight:600;font-size:18px;letter-spacing:-.03em}
.tile-l{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.tn-open{color:var(--open-fg)}.tn-warn{color:var(--warn-fg)}.tn-danger{color:var(--danger-fg)}
.filter{margin-top:12px;width:100%;height:36px;padding:0 12px;border:1px solid var(--border2);border-radius:var(--radius);background:var(--bg);color:var(--fg);font-family:var(--sans);font-size:14px}
.cleanup-pill{margin-top:8px;width:100%;height:36px;border:1px solid var(--warn-fg);border-radius:var(--radius);background:var(--warn-bg);color:var(--warn-fg);font-family:var(--sans);font-size:13px;font-weight:600;cursor:pointer;text-align:left;padding:0 12px}
.cleanup-pill:hover,.cleanup-pill.active{background:var(--warn-fg);color:#fff}
.cleanup-pill.active .muted{color:#fff}
.view-toggle{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:12px;padding:3px;background:var(--bg2);border:1px solid var(--border);border-radius:9px}
.view-btn{height:30px;border:0;border-radius:6px;background:transparent;color:var(--muted);font-family:var(--sans);font-size:12px;font-weight:500;cursor:pointer}
.view-btn:hover{color:var(--fg)}.view-btn.active{background:var(--bg);color:var(--fg);box-shadow:var(--shadow)}
.cleanlist{display:flex;flex-direction:column;gap:2px;margin-top:12px}
.clean{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg2)}
.clean input{margin-top:3px;flex-shrink:0}
.clean span{font-size:13px;line-height:19px}
.tree{overflow-y:auto;padding:8px;flex:1;min-height:0}
.grp{margin-bottom:4px}
.grp>summary{cursor:pointer;list-style:none;padding:8px;border-radius:var(--radius);font-weight:500;font-size:13px}
.grp>summary::-webkit-details-marker{display:none}
.grp>summary:hover{background:var(--bg2)}
.grp-sub{font-weight:400;color:var(--muted);font-size:11px;display:block;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.item{display:flex;align-items:center;gap:8px;width:100%;text-align:left;border:0;background:none;color:var(--fg);font-family:var(--sans);font-size:13px;padding:6px 8px 6px 16px;border-radius:var(--radius);cursor:pointer}
.item:hover{background:var(--bg2)}
.item.sel{background:var(--accent);color:#fff}
.item.sel .muted,.item.sel .dot{color:#fff}
.item .num{font-family:var(--mono);flex-shrink:0}
.item .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.dot{width:8px;height:8px;border-radius:9999px;flex-shrink:0}
.dot-OPEN{background:var(--open-fg)}.dot-MERGED{background:var(--merged-fg)}.dot-CLOSED{background:var(--closed-fg)}.dot-UNKNOWN{background:var(--muted)}
.fl{color:var(--warn-fg);flex-shrink:0}
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
svg .lbl{font-family:var(--mono);font-size:10px;fill:var(--fg)}
svg .center{font-weight:600}
.impact{max-width:1120px;margin:0 auto}
.impact-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:20px}
.impact-head h1{font-size:22px;letter-spacing:-.02em;margin:0 0 4px}
.impact-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px}
.impact-card{position:relative;min-width:0;min-height:150px;padding:14px;border:1px solid var(--border2);border-radius:var(--radius-md);background:var(--bg);color:var(--fg);text-align:left;font-family:var(--sans);cursor:pointer;overflow:hidden;transition:opacity .2s ease,border-color .2s ease,transform .2s ease,box-shadow .2s ease}
.impact-card:hover{border-color:var(--accent);transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,.08)}
.impact-card.selected{border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 25%,transparent),0 12px 32px rgba(0,107,255,.14)}
.impact-card.affected{border-color:var(--warn-fg);background:var(--warn-bg);animation:impact-pulse .55s ease both}
.impact-card.dim{opacity:.28}
.impact-card.selected::after{content:"";position:absolute;inset:50%;border-radius:999px;border:2px solid var(--accent);animation:impact-burst .65s ease-out both;pointer-events:none}
.impact-top{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.impact-num{font-family:var(--mono);font-size:32px;font-weight:600;line-height:1;letter-spacing:-.05em;color:var(--accent)}
.impact-label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-top:3px}
.impact-key{font-family:var(--mono);font-size:12px;color:var(--muted)}
.impact-title{font-size:13px;font-weight:500;line-height:18px;margin-top:14px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.impact-meta{font-size:11px;color:var(--muted);margin-top:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.impact-group{font-size:10px;color:var(--muted);margin-top:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.impact-panel{position:relative;padding:18px;margin-bottom:18px;border:1px solid var(--accent);border-radius:var(--radius-md);background:color-mix(in srgb,var(--accent) 5%,var(--bg));overflow:hidden}
.impact-panel h2{font-size:18px;margin:0 0 4px}
.impact-panel-top{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}
.impact-total{font-family:var(--mono);font-size:34px;font-weight:600;color:var(--accent);line-height:1}
.impact-total-label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;text-align:right}
.impact-breakdown{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:16px}
.impact-bucket{padding:10px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg)}
.impact-bucket strong{display:block;font-family:var(--mono);font-size:18px}
.impact-bucket span{font-size:11px;color:var(--muted)}
.impact-links{display:flex;gap:6px;flex-wrap:wrap;margin-top:14px}
.impact-link{border:1px solid var(--border2);border-radius:999px;background:var(--bg);color:var(--fg);font-family:var(--mono);font-size:11px;padding:4px 8px;cursor:pointer}
.impact-link:hover{border-color:var(--accent);color:var(--accent)}
.impact-actions{display:flex;gap:8px;margin-top:14px}
.impact-action{height:32px;padding:0 11px;border:1px solid var(--border2);border-radius:var(--radius);background:var(--bg);color:var(--fg);font-family:var(--sans);font-size:12px;font-weight:500;cursor:pointer}
.impact-action:hover{border-color:var(--accent);color:var(--accent)}
@keyframes impact-pulse{0%{transform:scale(.94);box-shadow:0 0 0 0 color-mix(in srgb,var(--warn-fg) 45%,transparent)}70%{transform:scale(1.025);box-shadow:0 0 0 9px transparent}100%{transform:scale(1)}}
@keyframes impact-burst{0%{inset:50%;opacity:.8}100%{inset:-55%;opacity:0}}
@media(max-width:820px){.impact-head{flex-direction:column}.impact-breakdown{grid-template-columns:1fr 1fr}.main{padding:24px 16px 60px}}
`;

const APP = `
const DATA=JSON.parse(document.getElementById('data').textContent);
const N=DATA.nodes;
const app=document.getElementById('app');
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const short=k=>{const n=String(k).split('#')[1];return n?'#'+n:k};
const tone=s=>s==='OPEN'?'open':s==='MERGED'?'merged':s==='CLOSED'?'closed':'muted';
let sel=null;
let view='explore';
let impactSel=null;

function sidebar(){
  const s=DATA.stats;
  const tiles=[['nodes',s.nodes,''],['open PR',s.openPRs,'tn-open'],['open iss',s.openIssues,''],
    ['superseded',s.superseded,'tn-warn'],['competing',s.competing,'tn-warn'],['no-close',s.noClose,'tn-danger']];
  const groups=DATA.groups.map((g,gi)=>{
    const items=g.members.map(k=>{const n=N[k];if(!n)return '';
      const fl=n.flags.length?'<span class="fl" title="'+esc(n.flags.join(' · '))+'">⚠</span>':'';
      const t=(n.key+' '+n.title+' '+(n.author||'')).toLowerCase();
      return '<button class="item" data-key="'+esc(k)+'" data-t="'+esc(t)+'">'+
        '<span class="dot dot-'+n.state+'"></span><span class="num">'+short(k)+'</span>'+
        '<span class="t">'+esc(n.title||'(no title)')+'</span>'+fl+'</button>';
    }).join('');
    return '<details class="grp" '+(DATA.groups.length<=12?'open':'')+' data-gi="'+gi+'">'+
      '<summary>'+esc(g.label)+' <span class="muted">('+g.members.length+')</span>'+
      (g.subtitle?'<span class="grp-sub">'+esc(g.subtitle)+'</span>':'')+'</summary>'+items+'</details>';
  }).join('');
  const cleanupBtn=DATA.cleanup.length
    ? '<button id="cleanup-btn" class="cleanup-pill">⚑ Cleanup <span class="muted">('+DATA.cleanup.length+')</span></button>'
    : '';
  return '<div class="side"><div class="side-top">'+
    '<div class="brand"><span class="logo">◆</span> issue-graph <span class="muted">· '+esc(DATA.repo)+'</span></div>'+
    '<div class="tiles">'+tiles.map(t=>'<div class="tile"><div class="tile-n '+t[2]+'">'+t[1]+'</div><div class="tile-l">'+t[0]+'</div></div>').join('')+'</div>'+
    '<div class="view-toggle"><button class="view-btn active" id="explore-view">Explore</button><button class="view-btn" id="impact-view">Impact</button></div>'+
    '<input class="filter" id="filter" placeholder="Filter by #, title, author…"/>'+cleanupBtn+'</div>'+
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

function cleanupView(){
  setView('explore');
  const items=DATA.cleanup.map(c=>{
    const link=c.key&&N[c.key]?' <a class="rellink" data-key="'+esc(c.key)+'">'+short(c.key)+'</a>':(c.key?' '+esc(short(c.key)):'');
    return '<label class="clean"><input type="checkbox"/><span>'+esc(c.text)+link+'</span></label>';
  }).join('');
  app.querySelector('.main').innerHTML='<div class="insp"><h1>⚑ Cleanup</h1>'+
    '<p class="muted">Close / supersede / retest, with the person to credit. Checkboxes are local scratch — nothing is posted to GitHub.</p>'+
    '<div class="cleanlist">'+items+'</div></div>';
  for(const b of app.querySelectorAll('.item'))b.classList.remove('sel');
  const cb=document.getElementById('cleanup-btn');if(cb)cb.classList.add('active');
  location.hash='cleanup';sel='cleanup';
}
function select(k){setView('explore');sel=k;location.hash=encodeURIComponent(k);const cb=document.getElementById('cleanup-btn');if(cb)cb.classList.remove('active');inspector(k);}

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

function impactCard(k,rank,active){
  const n=N[k],blast=blastRadius(k),labels=groupLabels();
  const affected=active&&blastRadius(active).keys.includes(k);
  const cls=active===k?'selected':affected?'affected':active?'dim':'';
  const delay=affected?' style="animation-delay:'+Math.min(rank*24,240)+'ms"':'';
  return '<button class="impact-card '+cls+'" data-impact="'+esc(k)+'"'+delay+'>'+
    '<div class="impact-top"><div><div class="impact-num">'+blast.total+'</div><div class="impact-label">nodes affected</div></div>'+
    '<span class="impact-key">'+short(k)+'</span></div>'+
    '<div class="impact-title">'+esc(n.title||'(no title)')+'</div>'+
    '<div class="impact-meta">'+blast.issues+' issue'+(blast.issues===1?'':'s')+' · '+blast.prCount+' PR'+(blast.prCount===1?'':'s')+'</div>'+
    '<div class="impact-group">'+esc(labels[k]||'Ungrouped')+'</div></button>';
}

function bucket(label,set){
  return '<div class="impact-bucket"><strong>'+set.size+'</strong><span>'+label+'</span></div>';
}

function impactPanel(k){
  if(!k||!N[k])return '';
  const n=N[k],blast=blastRadius(k);
  const links=blast.keys.map(x=>'<button class="impact-link" data-open-impact="'+esc(x)+'">'+short(x)+'</button>').join('');
  return '<div class="impact-panel"><div class="impact-panel-top"><div><h2>'+short(k)+' · '+esc(n.title)+'</h2>'+
    '<div class="muted">Projected blast radius if this '+(n.kind==='PullRequest'?'PR ships':'issue is resolved')+'. Derived from the current reference graph and shared files.</div></div>'+
    '<div><div class="impact-total">'+blast.total+'</div><div class="impact-total-label">affected nodes</div></div></div>'+
    '<div class="impact-breakdown">'+bucket('issues resolved',blast.resolves)+bucket('PRs to reconcile',blast.prs)+
    bucket('overlaps affected',blast.overlaps)+bucket('follow-ups touched',blast.followups)+'</div>'+
    (links?'<div class="impact-links">'+links+'</div>':'<div class="muted" style="margin-top:14px">No downstream effect is visible in this snapshot.</div>')+
    '<div class="impact-actions"><button class="impact-action" id="inspect-impact">Inspect evidence</button><button class="impact-action" id="clear-impact">Clear selection</button></div></div>';
}

function impactView(k){
  if(k!==undefined)impactSel=k;
  setView('impact');
  const candidates=Object.keys(N).filter(key=>N[key].state==='OPEN').sort((a,b)=>{
    const x=blastRadius(a),y=blastRadius(b);
    return y.total-x.total||y.resolves.size-x.resolves.size||y.prs.size-x.prs.size||a.localeCompare(b);
  });
  const cards=candidates.map((key,i)=>impactCard(key,i,impactSel)).join('');
  app.querySelector('.main').innerHTML='<div class="impact">'+
    '<div class="impact-head"><div><h1>Impact</h1><div class="muted">Click a node to simulate its blast radius. Highest leverage appears first.</div></div>'+
    '<span class="badge b-muted">projection, not proof</span></div>'+
    impactPanel(impactSel)+'<div class="impact-grid">'+cards+'</div></div>';
  for(const b of app.querySelectorAll('.item'))b.classList.remove('sel');
  const cb=document.getElementById('cleanup-btn');if(cb)cb.classList.remove('active');
  for(const b of app.querySelectorAll('.impact-card'))b.onclick=()=>impactView(b.dataset.impact);
  for(const b of app.querySelectorAll('[data-open-impact]'))b.onclick=()=>select(b.dataset.openImpact);
  const inspect=document.getElementById('inspect-impact');if(inspect)inspect.onclick=()=>select(impactSel);
  const clear=document.getElementById('clear-impact');if(clear)clear.onclick=()=>{impactSel=null;impactView()};
  location.hash=impactSel?'impact:'+encodeURIComponent(impactSel):'impact';sel='impact';
}

function setView(next){
  view=next;
  const explore=document.getElementById('explore-view'),impact=document.getElementById('impact-view');
  if(explore)explore.classList.toggle('active',view==='explore');
  if(impact)impact.classList.toggle('active',view==='impact');
}

function wire(){
  const cb=document.getElementById('cleanup-btn');if(cb)cb.onclick=cleanupView;
  document.getElementById('explore-view').onclick=()=>{
    if(sel&&sel!=='impact'&&sel!=='cleanup'&&N[sel])select(sel);
    else if(DATA.cleanup.length)cleanupView();
    else{setView('explore');app.querySelector('.main').innerHTML='<div class="empty">Select a node to inspect its relationships</div>';location.hash=''}
  };
  document.getElementById('impact-view').onclick=()=>impactView();
  for(const b of app.querySelectorAll('.item'))b.onclick=()=>select(b.dataset.key);
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
const initial=decodeURIComponent(location.hash.slice(1));
if(initial==='cleanup'&&DATA.cleanup.length)cleanupView();
else if(initial==='impact')impactView();
else if(initial.startsWith('impact:')&&N[initial.slice(7)])impactView(initial.slice(7));
else if(initial&&N[initial])select(initial);
else if(DATA.cleanup.length)cleanupView();
`;
