import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Node = {
  key: string;
  repo: string;
  number: number;
  kind: string;
  title: string;
  state: string;
  url: string;
  fetched: boolean;
  hub?: boolean;
  edges: { to: string; via: string }[];
};

type Export = {
  seeds: string[];
  depth: number;
  nodes: Node[];
  cappedOut: string[];
};

type Capture = {
  repository: string;
  visibility: string;
  visibilityCheckedAt: string;
  startedAt: string;
  completedAt: string;
  cliVersion: string;
  exitCode: number;
  args: string[];
};

export function prepareExample(graph: Export, stdout: string, capture: Capture) {
  const repository = "vercel-labs/agent-browser";
  const seed = `${repository}#1113`;
  const args = ["1113", "--repo", repository, "--depth", "1", "--max-nodes", "12", "--no-snapshot"];
  assert.deepEqual(graph.seeds, [seed]);
  assert.equal(graph.depth, 1);
  assert.equal(capture.repository, repository);
  assert.equal(capture.visibility, "PUBLIC");
  assert.equal(capture.exitCode, 0);
  assert.equal(capture.cliVersion, "0.2.0");
  assert.deepEqual(capture.args.slice(0, args.length), args);
  assert.equal(capture.args.length, args.length + 2);
  assert.equal(capture.args[args.length], "--json");
  for (const date of [capture.visibilityCheckedAt, capture.startedAt, capture.completedAt]) {
    assert(Number.isFinite(Date.parse(date)), "Capture timestamps must be explicit.");
  }
  assert(Date.parse(capture.visibilityCheckedAt) <= Date.parse(capture.startedAt));
  assert(Date.parse(capture.startedAt) <= Date.parse(capture.completedAt));
  assert(graph.nodes.length > 1 && graph.nodes.length <= 12);
  assert.equal(graph.cappedOut.length, 0, "Choose an uncapped example.");
  const keys = new Set(graph.nodes.map((node) => node.key));
  assert.equal(keys.size, graph.nodes.length);
  assert(keys.has(seed));
  const nodes = graph.nodes.map((node) => {
    const url = new URL(node.url);
    assert(node.fetched);
    assert(!node.hub, "Choose an example without unexpanded hubs.");
    assert.equal(node.repo, "agent-browser");
    assert.equal(node.key, `${repository}#${node.number}`);
    assert(["Issue", "PullRequest"].includes(node.kind));
    assert(["OPEN", "CLOSED", "MERGED"].includes(node.state));
    assert(node.kind === "PullRequest" || node.state !== "MERGED");
    assert.equal(
      url.toString(),
      `https://github.com/${repository}/${node.kind === "Issue" ? "issues" : "pull"}/${node.number}`,
    );
    return {
      key: node.key,
      repository: node.repo,
      number: node.number,
      kind: node.kind,
      title: node.title,
      state: node.state,
      url: url.toString(),
    };
  });
  assert(nodes.some((node) => node.kind === "Issue"));
  assert(nodes.some((node) => node.kind === "PullRequest"));
  const allEdges = graph.nodes.flatMap((node) =>
    node.edges.map((edge) => {
      assert(["text", "cross-ref", "connected", "closes"].includes(edge.via));
      return { from: node.key, to: edge.to, via: edge.via };
    }),
  );
  const edges = allEdges.filter((edge) => keys.has(edge.to));
  const omittedEdges = allEdges.filter((edge) => !keys.has(edge.to));
  assert(edges.some((edge) => edge.via === "closes" && edge.to === seed));
  assert(stdout.startsWith(`# Reference graph: ${seed}\n`));
  assert(stdout.includes(`\nNodes: ${nodes.length}\n`));
  const nodeSection = stdout.split("## Nodes\n")[1]?.split("\n## ")[0];
  const checklist = stdout.split("## Orphan checklist (classified)\n")[1]?.split("\n## ")[0];
  assert(nodeSection && checklist, "Supply the actual rendered CLI stdout.");
  const nodeLines = nodeSection
    .split("\n")
    .filter((line) => line.startsWith("- **") || line.startsWith("    - closes →"))
    .map((line) => line.replace(/ _by @\S+_/, "").replace(/ _\(@[^)]*\)_/g, ""));
  for (const node of nodes) {
    assert(nodeLines.some((line) => line.startsWith(`- **${node.key}** `)));
  }
  const checklistLines = checklist
    .split("\n")
    .filter((line) => !line.startsWith("- [ ] external (unread)"));
  const terminalOutput = `${stdout.split("## Nodes\n")[0]}## Nodes\n\n${nodeLines.join("\n")}\n\n## Orphan checklist (classified)\n${checklistLines.join("\n").trimEnd()}\n`;
  assert(!terminalOutput.includes("@"), "Do not publish account attribution.");
  assert(!terminalOutput.includes("https://"), "Do not publish external metadata.");
  const referencedKeys = terminalOutput.match(/[\w.-]+\/[\w.-]+#\d+/g) ?? [];
  assert(referencedKeys.every((key) => keys.has(key)));
  return {
    capturedAt: capture.completedAt,
    captureStartedAt: capture.startedAt,
    repository,
    repositoryVisibility: capture.visibility,
    visibilityCheckedAt: capture.visibilityCheckedAt,
    cliVersion: capture.cliVersion,
    command: `issue-graph ${args.join(" ")}`,
    seed,
    limits: { depth: 1, maxNodes: 12, hubThreshold: 12, concurrency: 4 },
    coverage: {
      completeHistory: false,
      allCapturedNodesIncluded: true,
      capturedNodes: nodes.length,
      omittedNodes: 0,
      crossRepoNodesFiltered: 0,
      cappedNodes: graph.cappedOut.length,
      unexpandedHubs: 0,
      beyondDepthReferences: new Set(omittedEdges.map((edge) => edge.to)).size,
      omittedEdges: omittedEdges.length,
      note: "Bounded depth-1 capture, not complete history. All fetched nodes are shown; edges to unfetched references are omitted. GitHub states were read during the capture window, not atomically.",
    },
    nodes,
    edges,
    terminalOutput,
    terminalExcerpt: {
      source: "CLI stdout",
      excerpt: true,
      attributionRemoved: true,
      omitted: [
        "Non-closing edge lines",
        "PR review metadata and mention attribution",
        "External links",
        "Beyond-depth reference list",
        "Snapshot comparison section",
      ],
      stdoutSha256: createHash("sha256").update(stdout).digest("hex"),
      note: "Actual CLI stdout excerpt. Author and edge-actor attribution removed; node summaries, closing links and the issue/PR orphan checklist retained. No model inference.",
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, terminal, metadata] = process.argv.slice(2);
  assert(input && terminal && metadata, "Provide graph.json, stdout.txt and capture.json.");
  const output = prepareExample(
    JSON.parse(await readFile(input, "utf8")),
    await readFile(terminal, "utf8"),
    JSON.parse(await readFile(metadata, "utf8")),
  );
  await writeFile(
    new URL("../src/lib/example-graph.json", import.meta.url),
    `${JSON.stringify(output, null, 2)}\n`,
  );
  console.log(
    `Prepared ${output.nodes.length} public single-repo nodes and ${output.edges.length} typed edges; ${output.coverage.beyondDepthReferences} beyond-depth references disclosed.`,
  );
}
