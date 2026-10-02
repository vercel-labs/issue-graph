import { isSupersededVerdict } from "./classify.js";
import { components } from "./crawl.js";
import { fileOverlaps } from "./overlaps.js";
import type { GraphNode, NodeKey, Via } from "./types.js";

/** Compact one-line PR triage summary: review state, size, staleness, hazards. */
export function prSummary(n: GraphNode): string {
  if (!n.pr) return "";
  const p = n.pr;
  const bits: string[] = [];
  if (p.isDraft) bits.push("DRAFT");
  bits.push(`review: ${p.reviewDecision || "none"}`);
  if (p.mergeable === "CONFLICTING") bits.push("CONFLICTING");
  bits.push(`+${p.additions}/-${p.deletions} across ${p.changedFiles}f`);
  if (p.updatedAt) bits.push(`updated ${p.updatedAt.slice(0, 10)}`);
  return bits.join(", ");
}

export const stateIcon = (s: string): string =>
  ({ OPEN: "🟢 OPEN", CLOSED: "🟣 CLOSED", MERGED: "🟪 MERGED" })[s] ?? `⚪ ${s}`;

export const kindTag = (k: string): string =>
  k === "PullRequest" ? "PR" : k === "Issue" ? "issue" : k;

export const viaTag = (v: Via | string): string =>
  ({
    closes: "closes",
    "cross-ref": "cross-ref",
    connected: "linked",
    text: "mentions",
    "sub-issue": "sub-issue of",
  })[v] ?? v;

/** Render the graph body: header, components (multi-seed), nodes, beyond-depth, orphan checklist. */
export function render(
  nodes: Map<NodeKey, GraphNode>,
  seedKeys: NodeKey[],
  multi: boolean,
): string {
  const out: string[] = [];
  out.push(`# Reference graph${multi ? " (backlog slice)" : `: ${seedKeys[0]}`}`);
  out.push(`\nSeeds: ${seedKeys.join(", ")}\nNodes: ${nodes.size}\n`);

  const ordered = [...nodes.values()].sort(
    (a, b) => a.depth - b.depth || a.key.localeCompare(b.key),
  );

  if (multi) {
    const comps = components(nodes);
    out.push(`## Connected components: ${comps.length}\n`);
    comps.forEach((c, i) => {
      const hub = c.map((k) => nodes.get(k)).filter((n): n is GraphNode => !!n);
      const top = hub.sort((a, b) => b.edges.length - a.edges.length)[0];
      out.push(`- Component ${i + 1} (${c.length} nodes, hub ${top.key} — ${top.title})`);
    });
    out.push("");
  }

  out.push("## Nodes\n");
  for (const n of ordered) {
    const hub = n.hub ? " ⭐ _(hub — not expanded)_" : "";
    const auth = n.author ? ` _by @${n.author}_` : "";
    out.push(
      `- **${n.key}** ${kindTag(n.kind)} ${stateIcon(n.state)} — ${n.title || "(no title)"}${auth}  _(depth ${n.depth})_${hub}`,
    );
    if (n.pr) out.push(`    - PR: ${prSummary(n)}`);
    for (const f of n.flags ?? []) out.push(`    - ⚠ ${f}`);
    if (n.mentionedBy?.length)
      out.push(`    - mentioned by: ${n.mentionedBy.map((u) => `@${u}`).join(", ")}`);
    for (const e of n.edges) {
      const target = nodes.get(e.to);
      const who = e.by ? ` _(@${e.by}${e.at ? `, ${e.at.slice(0, 10)}` : ""})_` : "";
      out.push(
        `    - ${viaTag(e.via)} → ${e.to}${target ? ` ${stateIcon(target.state)}` : " _(beyond depth)_"}${who}`,
      );
    }
    for (const x of n.externalLinks) out.push(`    - external → ${x}`);
  }

  const uncrawled = new Set<NodeKey>();
  for (const n of nodes.values()) {
    for (const e of n.edges) if (!nodes.has(e.to)) uncrawled.add(e.to);
    for (const k of n.subIssues ?? []) if (!nodes.has(k)) uncrawled.add(k);
  }
  if (uncrawled.size) {
    out.push(`\n## Beyond depth limit (${uncrawled.size} refs not crawled)\n`);
    for (const k of [...uncrawled].sort()) out.push(`- ${k}`);
  }

  // file-level overlap between open PRs: the objective duplicate/conflict signal
  const overlaps = fileOverlaps(nodes);
  if (overlaps.length) {
    out.push("\n## Possible duplicate / overlapping PRs (shared files)\n");
    for (const o of overlaps) {
      const dup = o.sharedIssue ? ` — both close ${o.sharedIssue} (likely duplicate)` : "";
      const preview = o.shared.slice(0, 4).join(", ");
      const more = o.shared.length > 4 ? ` +${o.shared.length - 4} more` : "";
      out.push(
        `- ${o.a} ⇄ ${o.b}${dup}\n      shares ${o.shared.length} file(s): ${preview}${more}`,
      );
    }
  }

  const orphans = ordered.filter((n) => !seedKeys.includes(n.key) && n.state === "OPEN");
  const superseded = orphans.filter((n) => isSupersededVerdict(n.verdict));
  const rest = orphans.filter((n) => !isSupersededVerdict(n.verdict));
  const externals = [...new Set(ordered.flatMap((n) => n.externalLinks))];
  out.push("\n## Orphan checklist (classified)\n");
  if (!orphans.length && !externals.length) out.push("- (none)");
  const flagLines = (n: GraphNode) => (n.flags ?? []).map((f) => `\n      ⚠ ${f}`).join("");
  for (const n of superseded)
    out.push(
      `- [ ] ⚠️  ${n.key} ${kindTag(n.kind)} — ${n.title}\n      → ${n.verdict}${flagLines(n)}`,
    );
  for (const n of rest)
    out.push(
      `- [ ] ${n.key} ${kindTag(n.kind)} 🟢 OPEN — ${n.title}\n      → ${n.verdict}${flagLines(n)}`,
    );
  for (const u of externals) out.push(`- [ ] external (unread) — ${u}`);

  return `${out.join("\n")}\n`;
}
