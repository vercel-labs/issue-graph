/**
 * Builds the landing page snapshot from a saved, clustered dashboard model.
 *
 *   ISSUE_GRAPH_HOME=/tmp/ig issue-graph cluster vercel-labs/portless --agent claude --no-open
 *   pnpm exec tsx scripts/generate-showcase.ts /tmp/ig/dashboard/vercel-labs_portless.json
 */
import { readFileSync, writeFileSync } from "node:fs";

interface ModelNode {
  num: number;
  kind: "Issue" | "PullRequest";
  state: string;
  title: string;
  url: string;
  heat?: Partial<
    Record<"comments" | "participants" | "reactions" | "inboundRefs" | "daysOpen", number>
  >;
  out: Array<{ to: string }>;
}

interface Model {
  repo: string;
  grouping?: string;
  groups: Array<{ label: string; subtitle?: string; members: string[] }>;
  nodes: Record<string, ModelNode>;
  stats: { nodes: number };
  openCount: { value: number; issues: number; pullRequests: number; observedAt: string };
}

const CLUSTERS = 5;
const source = process.argv[2];
if (!source) throw new Error("usage: generate-showcase.ts <saved-dashboard-model.json>");
const model = JSON.parse(readFileSync(source, "utf8")) as Model;
if (model.grouping !== "themes") throw new Error("expected a model with agent-proposed clusters");

// Catch-all groups ("misc", "other") are not root causes, so the landing skips them.
const catchAll = /\b(?:misc|miscellaneous|other|standalone)\b/i;
const groups = model.groups
  .map((group, order) => ({ ...group, order }))
  .filter((group) => !catchAll.test(`${group.label} ${group.subtitle ?? ""}`))
  .sort((a, b) => b.members.length - a.members.length || a.order - b.order)
  .slice(0, CLUSTERS);

const keys = new Set(groups.flatMap((group) => group.members));
const items = groups.flatMap((group, cluster) =>
  group.members.map((key) => {
    const node = model.nodes[key];
    if (!node) throw new Error(`missing node ${key}`);
    const heat = node.heat ?? {};
    return {
      number: node.num,
      kind: node.kind,
      state: node.state,
      title: node.title,
      url: node.url,
      cluster,
      heat: {
        comments: heat.comments ?? 0,
        participants: heat.participants ?? 0,
        reactions: heat.reactions ?? 0,
        inboundRefs: heat.inboundRefs ?? 0,
        daysOpen: heat.daysOpen ?? 0,
      },
    };
  }),
);

const pairs = new Set<string>();
for (const key of keys)
  for (const edge of model.nodes[key]?.out ?? [])
    if (keys.has(edge.to)) {
      const a = model.nodes[key].num;
      const b = model.nodes[edge.to].num;
      if (a !== b) pairs.add([a, b].sort((x, y) => x - y).join("-"));
    }

const showcase = {
  repo: model.repo,
  command: `issue-graph cluster ${model.repo} --agent claude`,
  capturedAt: model.openCount.observedAt.slice(0, 10),
  captured: model.stats.nodes,
  open: {
    total: model.openCount.value,
    issues: model.openCount.issues,
    pullRequests: model.openCount.pullRequests,
  },
  clusterCount: model.groups.length,
  clusters: groups.map((group) => ({
    label: group.label,
    rootCause: group.subtitle ?? "",
    size: group.members.length,
    members: group.members.map((key) => model.nodes[key].num),
  })),
  items,
  edges: [...pairs].sort().map((pair) => pair.split("-").map(Number)),
};

const out = new URL("../src/lib/example-showcase.json", import.meta.url);
writeFileSync(out, `${JSON.stringify(showcase, null, 2)}\n`);
console.log(
  `wrote ${items.length} items, ${showcase.edges.length} edges, ${groups.length} clusters`,
);
