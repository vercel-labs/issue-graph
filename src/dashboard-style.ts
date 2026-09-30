export const DASHBOARD_CSS = `
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
.filterbar{flex:none}
.filterbar button{cursor:pointer;font:12px var(--sans)}
.filter-trigger{display:flex;align-items:center;justify-content:center;gap:5px;height:32px;padding:0 7px;border:1px solid transparent;border-radius:6px;background:none;color:var(--fg2)}
.filter-trigger:hover,.filter-trigger[aria-expanded=true]{background:var(--bg2);border-color:var(--border)}
.filter-trigger svg{width:14px;height:14px}
.filter-badge{display:grid;place-items:center;min-width:16px;height:16px;border-radius:4px;background:var(--fg);color:var(--bg);font-size:10px;font-variant-numeric:tabular-nums}
.filterbar button:focus-visible,.filterbar input:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.filter-menu{position:fixed;width:232px;max-width:calc(100vw - 16px);max-height:calc(100dvh - 16px);padding:5px;border:1px solid var(--border2);border-radius:8px;background:var(--bg);box-shadow:0 4px 6px #00000008,0 12px 32px #00000014;z-index:30;overflow:auto}
.filter-submenu{width:280px;z-index:31}
.filter-menu-item{display:flex;align-items:center;gap:8px;width:100%;min-height:32px;padding:7px 8px;border:0;border-radius:4px;background:none;color:var(--fg2);text-align:left;line-height:18px}
.filter-menu-item:hover,.filter-menu-item:focus-visible,.filter-menu-item[aria-expanded=true]{background:var(--bg2);color:var(--fg)}
.filter-menu-item:disabled{opacity:.4;cursor:default}
.filter-menu-item .name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.filter-menu-item .value{max-width:92px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg2);font-size:11px}
.filter-menu-item .value.on{color:var(--fg)}
.filter-menu-item .arrow{width:12px;height:12px;flex:none;color:var(--muted)}
.filter-menu-item .group-swatch{width:6px;height:6px;margin:0;flex:none}
.filter-menu-item .count{color:var(--fg2);font-size:11px;font-variant-numeric:tabular-nums}
.filter-check{display:grid;place-items:center;width:13px;height:13px;border:1px solid var(--border2);border-radius:3px;flex:none;color:transparent}
[aria-checked=true]>.filter-check{background:var(--fg);border-color:var(--fg);color:var(--bg)}
.filter-check svg{width:10px;height:10px}
.filter-separator{height:1px;margin:5px -5px;background:var(--border)}
.filter-menu input[type=search]{width:100%;height:32px;background:none;border:0;border-bottom:1px solid var(--border);border-radius:0;padding:0 8px;color:var(--fg);font:12px var(--sans)}
.filter-options{max-height:260px;overflow:auto}
.filter-no-results{padding:14px 8px;font-size:12px;color:var(--fg2)}
.filter-back{display:none}
.filter-summary{padding:6px 8px;font-size:11px;color:var(--fg2);font-variant-numeric:tabular-nums}
.heat-field{display:flex;align-items:center;justify-content:space-between;padding:6px;font-size:12px}
.heat-field input{width:86px;padding:5px 7px;border:1px solid var(--border2);border-radius:5px;font:12px var(--mono);color:var(--fg);background:var(--bg)}
.filter-note{font-size:11px;line-height:16px;color:var(--fg2);margin:6px}
.context-back{background:none;border:0;color:var(--fg2);padding:4px 7px;border-radius:5px;font:12px var(--sans);cursor:pointer}
.context-back:hover{background:var(--bg2);color:var(--fg)}
.filter-context{opacity:.4}
.filter-context:hover{opacity:1}
.context-note{font-size:12px;color:var(--muted);margin-bottom:14px}
.context-note:has(.filterbar){display:flex;align-items:center;gap:8px}
.context-note>.segs{margin-left:auto}
.main>.segs{justify-content:flex-end;margin-bottom:16px}
.filter-empty{padding:56px 16px;text-align:center;color:var(--muted)}
.filter-empty strong{display:block;color:var(--fg2);font-weight:500;margin-bottom:6px}
[hidden]{display:none!important}
@media(max-width:600px){.filter-menu{width:300px}.filter-back{display:flex;font-weight:500!important;border-bottom:1px solid var(--border);border-radius:0;margin-bottom:4px}.filter-back .arrow{transform:rotate(180deg)}}
@media(max-width:820px){.shell{grid-template-columns:1fr;height:auto}}
/* sidebar */
.side{border-right:1px solid var(--border);display:flex;flex-direction:column;min-height:0;min-width:0;background:var(--bg)}
.side-top{padding:20px 16px 16px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:16px}
.brand{display:flex;flex-direction:column;gap:4px}
.brand-row{display:flex;align-items:center;gap:8px}
.labs{display:inline-flex;color:var(--fg);border-radius:4px}.labs:hover{text-decoration:none;opacity:.8}
.labs:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.labs-mark{height:16px;width:auto;display:block}
.project-row{position:relative;display:flex;align-items:center;gap:4px;min-width:0}
.project{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:100%;height:26px;font-family:var(--mono);font-size:12px;color:var(--muted)}
.pname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.project-gh{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:6px;color:var(--muted);font-size:12px;flex-shrink:0}
.project-gh:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.project-gh:hover{background:var(--bg2);color:var(--fg);text-decoration:none}
.pbtn{height:26px;padding:0 6px;margin-left:-6px;border:0;border-radius:6px;background:none;cursor:pointer;transition:background 150ms,color 150ms}
.pbtn:hover,.pbtn[aria-expanded="true"]{background:var(--bg2);color:var(--fg)}
.pbtn:focus-visible,.ropt:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.pchev{width:12px;height:12px;flex-shrink:0;transition:transform 200ms cubic-bezier(.2,.8,.2,1)}
.pbtn[aria-expanded="true"] .pchev{transform:rotate(180deg)}
.repo-menu{position:absolute;top:30px;left:-6px;z-index:20;width:calc(100% + 12px);max-height:320px;overflow-y:auto;padding:4px;background:var(--bg);border:1px solid var(--border2);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.12);transform-origin:top left;animation:menu-in 160ms cubic-bezier(.2,.8,.2,1)}
@keyframes menu-in{from{opacity:0;transform:translateY(-4px) scale(.98)}}
.ropt{display:grid;grid-template-columns:16px minmax(0,1fr) auto;gap:6px;align-items:center;width:100%;height:32px;padding:0 8px;border:0;border-radius:6px;background:none;color:var(--fg);font-family:var(--sans);font-size:13px;text-align:left;cursor:pointer}
.ropt:hover,.ropt:focus{background:var(--bg2);outline:none}
.ropt b{font-weight:400;color:var(--muted);font-variant-numeric:tabular-nums}
.rname{display:inline-flex;align-items:center;gap:6px;min-width:0;overflow:hidden}.rname .mono{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rname svg{width:13px;height:13px}
.rcheck{font-size:12px;color:var(--fg)}
@media (prefers-reduced-motion:reduce){.repo-menu,.pchev{animation:none;transition:none}}
.gh-mark,:where(.project>svg:first-child,.rname>svg,.pv-link>svg){width:14px;height:14px;flex-shrink:0;display:block}
.snapshot{position:relative;margin-left:auto;flex:none;font-size:12px;color:var(--fg2)}
.snapshot>summary{display:grid;place-items:center;width:24px;height:24px;border-radius:5px;cursor:pointer;list-style:none}
.snapshot>summary::-webkit-details-marker{display:none}
.snapshot>summary:hover,.snapshot[open]>summary{background:var(--bg2);color:var(--fg)}
.snapshot>summary:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.snapshot>summary svg{width:15px;height:15px}
.snapshot.partial>summary{color:var(--warn-fg)}
.snapshot-panel{position:absolute;top:29px;right:0;z-index:21;width:282px;max-width:calc(100vw - 32px);max-height:70dvh;overflow:auto;padding:12px 14px;background:var(--bg);border:1px solid var(--border2);border-radius:8px;box-shadow:0 8px 24px #00000014;font-weight:400;line-height:18px}
.snapshot-panel strong{font-weight:500;color:var(--fg)}
.snapshot-panel p{margin:6px 0}
.snapshot-panel ul{margin:6px 0;padding-left:16px}
.signals{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;padding-top:12px;border-top:1px solid var(--border)}
.signal{--signal-color:var(--warn-fg);display:flex;flex-direction:column;gap:6px;min-width:0;font-size:12px;color:var(--fg2)}
.signal-label{display:flex;align-items:center;justify-content:space-between;gap:4px;white-space:nowrap}
.signal-label b{font-weight:500;font-variant-numeric:tabular-nums;color:var(--fg)}
.signal.zero .signal-label b{color:var(--fg2)}
.signal-track{height:3px;border-radius:2px;background:var(--border);overflow:hidden}
.signal-track i{display:block;height:100%;border-radius:2px;background:var(--signal-color);min-width:3px}
.signal.zero .signal-track i{min-width:0}
.pv-link{display:inline-flex;align-items:center;gap:6px}.pv-link svg{width:13px;height:13px}
.brand-sep{color:var(--border2);font-size:18px;font-weight:300;line-height:1}
.brand-name{font-weight:600;font-size:15px;letter-spacing:-.01em}
.mix{display:flex;flex-direction:column;gap:8px}
.mix-bar{display:flex;height:6px;border-radius:9999px;overflow:hidden;gap:2px}
.mix-bar span{display:block;height:100%;border-radius:9999px;transition:flex-grow 600ms cubic-bezier(.2,.8,.2,1)}
.mix-legend{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px;color:var(--fg2)}
.mix-legend span{display:inline-flex;align-items:center;gap:5px}
.mix-legend b{font-weight:500;color:var(--muted);font-variant-numeric:tabular-nums}
.view-toggle{display:grid;grid-template-columns:repeat(4,1fr);gap:2px;padding:2px;background:var(--bg2);border:1px solid var(--border);border-radius:9999px}
.read-coverage{font-size:12px;color:var(--fg2)}
.read-coverage summary{cursor:pointer}
.read-coverage.partial{padding:12px 14px;border:1px solid var(--warn-fg);border-radius:6px}
.read-coverage ul{padding-left:18px;margin:6px 0 0}
.view-btn{height:28px;border:0;border-radius:9999px;background:transparent;color:var(--muted);font-family:var(--sans);font-size:13px;cursor:pointer;transition:color 150ms,background 150ms}
.view-btn:hover{color:var(--fg)}.view-btn.active{background:var(--bg);color:var(--fg);box-shadow:0 0 0 1px var(--border2)}
.view-btn:focus-visible,.item:focus-visible,.cleanup-pill:focus-visible,.grp>summary:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.filter{width:100%;height:32px;padding:0 12px;border:1px solid var(--border2);border-radius:9999px;background:var(--bg);color:var(--fg);font-family:var(--sans);font-size:13px}
.filter:focus{outline:2px solid var(--accent);outline-offset:0;border-color:transparent}
.cleanup-pill{display:flex;align-items:center;justify-content:space-between;width:100%;height:32px;border:1px solid var(--border2);border-radius:9999px;background:var(--bg);color:var(--fg);font-family:var(--sans);font-size:13px;cursor:pointer;padding:0 6px 0 12px;transition:background 150ms}
.cleanup-pill:hover{background:var(--bg2)}
.cleanup-pill+.cleanup-pill{margin-top:6px}
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
.k-iss{background:var(--open-fg)}.k-pr{background:var(--accent)}.k-merged{background:var(--merged-fg)}.k-closed{background:var(--danger-fg)}
.k-sup-outline{background:transparent;box-shadow:inset 0 0 0 1.5px var(--accent)}
.dot-OPEN{background:var(--open-fg)}.dot-MERGED{background:var(--merged-fg)}.dot-CLOSED{background:var(--danger-fg)}.dot-UNKNOWN{background:var(--muted)}
.fl{color:var(--warn-fg);flex-shrink:0;font-size:12px}
.swarm .d.hl .mark{stroke:var(--fg);stroke-width:2.5}
.swarm .d.hl{filter:drop-shadow(0 0 0 var(--fg))}
@media (prefers-reduced-motion:reduce){.chev,.mix-bar span,.grp.anim .grp-items .item{transition:none;animation:none}}
/* main */
.main{overflow-y:auto;padding:32px 40px 80px;min-height:0;min-width:0}
.empty{color:var(--muted);display:flex;height:100%;align-items:center;justify-content:center}
.insp h1{font-size:22px;font-weight:600;letter-spacing:-.02em;margin:0 0 4px;display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.insp h1 .num{font-family:var(--mono);color:var(--muted);font-size:18px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0}
.sec{margin-top:24px}
.sec h3{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:0 0 8px;font-weight:600}
.rel{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)}
.rel>a[href]{overflow-wrap:anywhere;min-width:0}
.rel .via{font-family:var(--mono);font-size:11px;padding:1px 6px;border-radius:4px;background:var(--closed-bg);color:var(--fg2);min-width:78px;text-align:center}
.rel .via-closes,.rel .via-closed-by{background:var(--merged-bg);color:var(--merged-fg)}
.rel .via-competes,.rel .via-overlaps{background:var(--warn-bg);color:var(--warn-fg)}
.rellink{cursor:pointer;font-family:var(--mono)}
.verdict{padding:12px 14px;border-radius:var(--radius-md);background:var(--warn-bg);color:var(--warn-fg);font-weight:500;border:1px solid var(--border)}
.badge{font-size:12px;font-weight:500;padding:2px 8px;border-radius:9999px;white-space:nowrap}
.b-open{background:var(--open-bg);color:var(--open-fg)}.b-merged{background:var(--merged-bg);color:var(--merged-fg)}
.b-closed{background:var(--danger-bg);color:var(--danger-fg)}.b-warn{background:var(--warn-bg);color:var(--warn-fg)}
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
.swarm-legend{display:flex;gap:8px 16px;flex-wrap:wrap;align-items:center;font-size:13px;color:var(--fg2);margin:4px 0 12px;max-height:112px;overflow:auto}
.swarm-legend .lg{display:inline-flex;align-items:center;gap:6px}
.swarm-legend svg{flex-shrink:0}
.group-swatch{display:inline-block;width:8px;height:8px;border-radius:50%;flex-shrink:0;margin-right:8px;vertical-align:middle}
.swarm-legend .lg b{font-weight:500;color:var(--muted);font-variant-numeric:tabular-nums}
.swarm-legend .tot{margin-left:auto;color:var(--muted);font-variant-numeric:tabular-nums}
#sw-legend{height:32px;max-height:32px;flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden}
#sw-legend>*{flex-shrink:0;white-space:nowrap}
.swarm-legend .mark{stroke-width:1.5}
.swarm-card{overflow:auto;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--bg);padding:16px 20px}
.swarm svg{display:block;overflow:visible}
.swarm .row-lbl{font-family:var(--sans);font-size:12px;fill:var(--fg2)}
.swarm .row-n{font-family:var(--sans);font-size:12px;fill:var(--muted)}
.swarm .grid{stroke:var(--border)}
.swarm .tick{font-family:var(--mono);font-size:11px;fill:var(--muted)}
.swarm .axis-t{font-family:var(--sans);font-size:12px;fill:var(--fg2)}.swarm .muted-t{fill:var(--muted)}
.swarm .d{cursor:pointer;transition:transform 700ms cubic-bezier(.2,.8,.2,1),opacity 300ms}
.swarm .d .mark{stroke-width:1.5}
.swarm .d:hover .mark{stroke:var(--fg);stroke-width:2}
.swarm .d.gone{opacity:0;pointer-events:none}
.c-iss{fill:var(--open-fg);stroke:var(--open-fg)}.c-pr{fill:var(--accent);stroke:var(--accent)}
.c-merged{fill:var(--merged-fg);stroke:var(--merged-fg)}.c-closed{fill:var(--danger-fg);stroke:var(--danger-fg)}
.c-canceled{fill:var(--danger-fg);stroke:var(--danger-fg)}.c-archived{fill:var(--warn-fg);stroke:var(--warn-fg)}
.c-duplicate{fill:#bf5af2;stroke:#bf5af2}.c-unknown{fill:var(--muted);stroke:var(--muted)}
.c-sup-outline{fill:var(--bg);stroke:#6486ac}
.c-group{fill:var(--group-color);stroke:var(--group-color)}
.k-canceled{background:var(--danger-fg)}.k-archived{background:var(--warn-fg)}.k-duplicate{background:#bf5af2}.k-unknown{background:var(--muted)}
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
.view-in:has(.filter-menu:not([hidden])){animation:none}
@keyframes view-in{from{opacity:0;transform:translateY(4px)}}
/* sweep: work one decision resolves */
.sw-tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:4px 0 14px}
.sw-tile{display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:12px 14px;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--bg);color:var(--fg);font-family:var(--sans);text-align:left;cursor:pointer;transition:border-color 150ms,background 150ms,box-shadow 200ms,transform 200ms cubic-bezier(.2,.8,.2,1)}
.sw-tile:hover:not(:disabled){border-color:var(--border2);transform:translateY(-1px);box-shadow:0 4px 16px rgba(0,0,0,.06)}
.sw-tile.active{border-color:var(--fg);box-shadow:0 0 0 1px var(--fg) inset}
.sw-tile:disabled{opacity:.45;cursor:default}
.sw-tile:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.sw-tile-n{font-size:24px;font-weight:600;line-height:1.1;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.sw-tile-l{font-size:13px;color:var(--muted)}
.sw-sub{display:flex;justify-content:space-between;align-items:baseline;gap:16px;margin:0 0 12px;font-size:13px;color:var(--muted)}
.sw-sum{font-family:var(--mono);font-size:12px;white-space:nowrap;font-variant-numeric:tabular-nums}
.sw-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:12px}
.sw-card{display:flex;flex-direction:column;gap:12px;padding:16px;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--bg);min-width:0;animation:view-in 360ms cubic-bezier(.2,.8,.2,1) both;transition:border-color 150ms,box-shadow 200ms,transform 200ms cubic-bezier(.2,.8,.2,1)}
.sw-card:hover{border-color:var(--border2);box-shadow:0 4px 16px rgba(0,0,0,.06);transform:translateY(-1px)}
.sw-card-top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
.sw-issue{display:flex;align-items:baseline;gap:8px;min-width:0;font-size:14px;line-height:1.4}
.sw-issue .dot{flex-shrink:0;transform:translateY(-1px)}
.sw-issue-title{font-weight:500;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.sw-key{font-family:var(--mono);font-size:12px;flex-shrink:0;color:var(--fg2)}
a.sw-key{cursor:pointer;text-decoration:none}a.sw-key:hover{color:var(--accent);text-decoration:underline}
.sw-resolves{flex-shrink:0;font-size:12px;color:var(--open-fg);background:var(--open-bg);border-radius:9999px;padding:2px 9px;white-space:nowrap}
.sw-resolves b{font-weight:600;font-variant-numeric:tabular-nums}
.sw-prs{list-style:none;margin:0;padding:10px 0 0;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:8px}
.sw-pr{display:flex;align-items:center;gap:8px;min-width:0;font-size:13px}
.sw-pr .dot{flex-shrink:0}
.sw-pr-title{flex:1;min-width:0;color:var(--fg2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sw-pr.stale .sw-pr-title{color:var(--muted)}
.sw-chip{flex-shrink:0;font-size:11px;font-weight:500;padding:1px 7px;border-radius:9999px;background:var(--closed-bg);color:var(--fg2);white-space:nowrap}
.sw-chip.warn{background:var(--warn-bg);color:var(--warn-fg)}
.sw-chip.danger{background:var(--danger-bg,var(--closed-bg));color:var(--danger-fg,var(--closed-fg))}
.sw-size{flex-shrink:0;font-family:var(--mono);font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums;min-width:74px;text-align:right}
.sw-size em{font-style:normal;opacity:.5;margin:0 1px}
@media(max-width:820px){.sw-tiles{grid-template-columns:1fr}.sw-grid{grid-template-columns:1fr}}
@media (prefers-reduced-motion:reduce){.sw-card,.sw-tile{animation:none;transition:none}.sw-card:hover,.sw-tile:hover{transform:none}}
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
#im-side{position:sticky;top:0;align-self:start}
.im-panel{border:1px solid var(--border);border-radius:var(--radius-md);background:var(--bg);padding:16px;max-height:calc(100vh - 64px);overflow-y:auto;overscroll-behavior:contain}
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
.im-rip .arc{fill:none;stroke-width:3;opacity:.35;stroke-linecap:round}
.im-rip .arc.s-resolves{stroke:var(--open-fg)}.im-rip .arc.s-prs{stroke:var(--accent)}.im-rip .arc.s-overlaps{stroke:var(--warn-fg)}.im-rip .arc.s-followups{stroke:var(--merged-fg)}.im-rip .arc.s-related{stroke:var(--closed-fg)}
.im-rip .more-t{font-family:var(--sans);font-size:11px;fill:var(--muted)}
.im-hot{font-size:12px;line-height:18px;color:var(--fg2);background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-top:12px}
.im-aff{margin-top:12px;max-height:320px;overflow-y:auto;border-top:1px solid var(--border)}
.im-aff-g>summary{list-style:none;display:flex;align-items:center;gap:6px;font-size:12px;font-weight:500;color:var(--fg2);padding:8px 0;cursor:pointer}
.im-aff-g>summary::-webkit-details-marker{display:none}
.im-aff-g>summary i{width:8px;height:8px;border-radius:9999px}
.im-aff-g>summary b{margin-left:auto;font-weight:400;color:var(--muted);font-variant-numeric:tabular-nums}
.im-aff-row{display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 8px;width:100%;padding:6px 8px;border:0;border-radius:6px;background:none;color:var(--fg);font-family:var(--sans);font-size:12px;text-align:left;cursor:pointer}
.im-aff-row:hover{background:var(--bg2)}
.im-aff-row .k{font-family:var(--mono);color:var(--muted)}
.im-aff-row .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.im-aff-row .why{grid-column:2;color:var(--muted);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.im-aff-row .why code{font-size:11px;padding:0 4px}
.im-legend{display:grid;grid-template-columns:1fr 1fr;gap:6px 16px;font-size:12px;color:var(--fg2)}
.im-legend span{display:flex;align-items:center;gap:6px}.im-legend b{margin-left:auto;font-weight:500;font-variant-numeric:tabular-nums;color:var(--fg)}
.im-legend i{width:8px;height:8px;border-radius:9999px;display:block}
.im-actions{display:flex;gap:8px;margin-top:14px}
.im-hint{font-size:12px;color:var(--muted);margin-top:8px}
@media (prefers-reduced-motion:reduce){.view-in,.stagger>*,.ex-graph .e.draw,.ex-graph .n circle,.im-lane span,.im-rip .ray,.im-rip .sat circle,.im-rip .wave{animation:none;stroke-dashoffset:0}}
@media(max-width:820px){.impact-head{flex-direction:column}.impact-breakdown{grid-template-columns:1fr 1fr}.main{padding:24px 16px 60px}}
`;
