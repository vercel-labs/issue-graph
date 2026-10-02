#!/usr/bin/env -S node --import tsx
/**
 * Live equivalence check: crawl the same seed through both transports and
 * assert the graphs match.
 *
 * This is a script rather than a unit test because it needs the network and a
 * token, and a flaky network failure should not read as a broken build. Run it
 * by hand after touching either transport.
 *
 *   pnpm exec tsx scripts/verify-transports.ts 352 owner/repo 2
 *
 * Pick a seed with a busy graph. A two-node graph proves almost nothing; the
 * interesting cases are a deleted reference and a hub, which only show up once
 * the crawl is more than a hop deep.
 */
import assert from "node:assert/strict";
import { crawl, makeFetchNode } from "../src/index.js";
import { httpTransport } from "../src/transports/http.js";
import { gh, shellTransport } from "../src/transports/shell.js";
import type { GraphNode } from "../src/types.js";

assert.equal(process.release.name, "node", "transport verification requires Node.js");
const [numberArg, repoArg, depthArg = "2"] = process.argv.slice(2);
if (!numberArg || !repoArg) {
  console.error("usage: verify-transports.ts <number> <owner/repo> [depth]");
  process.exit(1);
}
const [owner, repo] = repoArg.split("/");
const seeds = [{ owner, repo, number: Number(numberArg) }];
const opts = {
  maxDepth: Number(depthArg),
  maxNodes: 80,
  hubThreshold: 12,
  primaryRepo: { owner, repo },
};

/** Drop fields that legitimately move between two calls seconds apart. */
function normalize(nodes: Map<string, GraphNode>) {
  return [...nodes.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((n) => ({
      key: n.key,
      kind: n.kind,
      state: n.state,
      title: n.title,
      author: n.author,
      fetched: n.fetched,
      hub: n.hub ?? false,
      edges: [...n.edges].sort((a, b) => a.to.localeCompare(b.to)).map((e) => `${e.via} ${e.to}`),
      files: n.pr?.files?.slice().sort(),
      claimsClose: n.claimsClose?.slice().sort(),
      subIssues: n.subIssues?.slice().sort(),
      subIssueTotal: n.subIssueTotal,
    }));
}

const token = gh(["auth", "token"]).trim();

const viaShell = await crawl(seeds, opts, makeFetchNode(shellTransport()));
const viaHttp = await crawl(seeds, opts, makeFetchNode(httpTransport({ token })));

const a = JSON.stringify(normalize(viaShell.nodes), null, 2);
const b = JSON.stringify(normalize(viaHttp.nodes), null, 2);

if (a === b) {
  console.log(`transports agree on ${viaShell.nodes.size} node(s) for ${repoArg}#${numberArg}`);
  process.exit(0);
}
console.error(`transports disagree\n--- shell ---\n${a}\n--- http ---\n${b}`);
process.exit(1);
