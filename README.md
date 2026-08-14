# xref

Find the full reference graph around a GitHub pull request or issue: comments, mentions, linked pull requests, cross-referenced issues, closing references, and external links, recursively and across repositories.

Run it before you work on an issue or PR. A text search finds what mentions your issue; this finds what is *attached* to it, which is where the duplicate PR and the already-merged fix hide.

The CLI crawls, classifies, attributes, and saves the graph. Everything it reports is derived from the data, not guessed by a model. It can also hand the one genuinely semantic step, grouping nodes by root cause, back to a calling agent.

## Install

Not published to a registry. Install from source. You need [Bun](https://bun.sh) and an authenticated [`gh`](https://cli.github.com).

```bash
gh repo clone vercel-labs/xref && cd xref
bun install
bun link
```

That puts an `xref` command on your `PATH`. `xref --help` lists every flag.

Using it as a library needs neither Bun nor `gh`, only `fetch` and a token. See [Use as a library](#use-as-a-library).

## What you would ask it

Each of these is a real question, and the command that answers it. Substitute your own `owner/repo`.

**"Before I fix this issue, what else is attached to it?"**

```bash
xref 260 --repo owner/repo --depth 2
```

**"Which of these open PRs are duplicating each other?"**
The answer comes from changed-file overlap, not title similarity.

```bash
xref --seeds 64,246,281 --repo owner/repo
```

**"Which issues have no PR, and which have several fighting over them?"**
The orphan checklist names the untracked issues; the `competing` flag marks an issue that more than one open PR claims to close.

```bash
xref --label bug --repo owner/repo
```

**"Which open issues and PRs can I clean up safely?"**
Inventories the whole open backlog without requiring labels, then emits evidence-backed actions. It never changes GitHub state.

```bash
xref reconcile --repo owner/repo
```

Interactive terminals receive Markdown. Pipes and agents receive versioned JSON by default. Every item includes stable evidence codes, human summaries, and related node keys. Use `--format markdown|json` to choose explicitly, and `xref schema` to inspect the machine contract and local-write behavior.

**"What should I fix first?"**
Ranks open nodes by discussion heat, so triage is by impact rather than by inbox order.

```bash
xref --label bug --repo owner/repo --prioritize
```

**"Cluster my backlog by root cause."**
Prints a prompt for the calling agent, which clusters by edge structure and shared defect. `--cluster-run` shells out to a headless agent instead, for unattended use.

```bash
xref --seeds 64,246,281 --repo owner/repo --cluster
```

**"What changed since I last looked?"**
Every run is saved. The next run over the same starting points diffs against it and reports new nodes, state changes, and new references, with who made them.

```bash
xref 260 --repo owner/repo --depth 2   # again, a day later
```

Repository reconciliation keeps a separate history keyed only by `owner/repo`, so the comparison survives a changing open backlog. Its `history` object reports new items, action changes, resolved items, and whether crawl coverage regressed or recovered. It suppresses unsafe new or resolved claims when the relevant comparison side had incomplete coverage.

```bash
xref reconcile --repo owner/repo   # again, after the queue changes
```

## What the output looks like

Three sections carry most of the value. All of the output below is real, from a
crawl of a public repository.

Open PRs whose changed files intersect. A pair here is a likely duplicate or a
guaranteed merge conflict, and a pair that also closes the same issue is a
near-certain duplicate:

```
## Possible duplicate / overlapping PRs (shared files)

- owner/repo#238 ⇄ owner/repo#366
      shares 3 file(s): src/cli-utils.test.ts, src/cli-utils.ts, src/cli.ts
- owner/repo#278 ⇄ owner/repo#360
      shares 2 file(s): src/proxy.test.ts, src/proxy.ts
```

Every reachable open node, with a verdict. "Referenced by merged work" is the
one worth reading twice: someone shipped something adjacent and may have
already fixed it:

```
## Orphan checklist (classified)

- [ ] owner/repo#226 issue 🟢 OPEN — Recommended setup for monorepo projects?
      → OPEN issue — related, untracked
- [ ] owner/repo#39 issue 🟢 OPEN — Feature Request: Add mDNS support for local HTTPS development
      → OPEN issue — referenced by merged work, verify if resolved
- [ ] other-org/other-repo#97 issue 🟢 OPEN — Support custom hostname for URL compatibility
      → OPEN issue — related, untracked
```

With `--prioritize`, the ranking prints the raw signals next to each score, so
you can overrule the order. The score is a sort key, not a verdict:

```
## Triage priority (open nodes, most discussion/frustration first)

1. **owner/repo#120** issue — Feature Request: Add stealth mode via env variable  _(score 113.3)_
    - 13 comments · 12 participants · 14 reactions · 8 inbound refs · open 190d
2. **owner/repo#25** issue — Bug: "System cannot find the path specified" on install  _(score 104.4)_
    - 18 comments · 16 participants · 0 reactions · 6 inbound refs · open 193d

_score = comments×3 + participants×2 + reactions×2 + inbound×2 + min(12, daysOpen/30)_
```

Two issues open for six months, each with a dozen people in the thread. That is
the case for ranking by heat instead of by date.

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `--repo owner/repo` | none | Required when you use a bare number, `--seeds`, or `--label` |
| `--depth N` | `2` | Same-repository crawl depth. Cross-repository references are fetched one hop and not expanded |
| `--seeds a,b,c` | none | Starting points for a multi-seed graph. Output includes connected components |
| `--label L` | none | Use every open issue with this label as a starting point |
| `--max-nodes N` | `80` | Stop after this many nodes, from 1 through 1000 |
| `--hub-threshold N` | `12` | Fetch high-degree non-seed nodes, but do not expand them |
| `--concurrency N` | `4` | Bound GitHub node requests in flight, from 1 through 32 |
| `--prioritize` | off | Rank open nodes by discussion heat: `comments×3 + participants×2 + reactions×2 + inbound refs×2 + min(12, daysOpen/30)` |
| `--cluster` | off | Print a clustering prompt for the calling agent |
| `--cluster-run claude\|codex` | none | Run a headless agent to cluster the graph |
| `--json path` | none | Write the graph as JSON (includes `components` and `overlaps`) |
| `--html path` | none | Write a self-contained master–detail explorer (Geist-styled, no server) |
| `--clusters path` | none | JSON of agent-named clusters to group the explorer by; falls back to connected components |
| `--format auto\|json\|markdown` | `auto` | Output for `reconcile`. Auto selects Markdown for a TTY and JSON otherwise |
| `--no-snapshot` | off | Do not save this run |

## Output

Each run produces:

- a node list with every reachable issue or pull request, its current state, author, referrers, and outgoing edges
- for each pull request, a triage summary: review decision, draft/conflicting state, `+adds/-dels across Nf`, and last-updated date (staleness)
- a "possible duplicate / overlapping PRs" section pairing open PRs that touch the same files — the objective duplication and merge-conflict signal
- derived flags on nodes: `competing` (more than one open PR closes an issue) and `claims-close-no-link` (a `fixes #N` that has no closing link, so a merge won't auto-close it)
- an orphan checklist that identifies open, superseded, possibly superseded, competing, and flagged nodes, including open pull requests structurally linked to an issue closed by later merged work
- connected components in multi-seed mode, grouped by root-cause cluster
- with `--prioritize`, a triage-priority ranking of the open nodes by discussion heat — comment count, distinct participants, reactions, inbound references, and time open — with the raw signals printed next to each score so a human can override the order
- a diff from the previous snapshot, including new nodes, state changes, and new references

The `--json` file additionally includes the computed `components`, `overlaps`, and `priorities` so downstream tooling does not recompute them.

`xref reconcile --repo owner/repo` searches open issues and pull requests up to the configured node limit, paginates seed discovery beyond GitHub's 100-item page, crawls reference-graph levels with bounded concurrency, and groups them into deterministic actions such as `verify-completed`, `close-superseded`, `resolve-competing`, `repair-closing-link`, and `keep-untracked`. Evidence is structured as `{ code, summary, related }` so agents can branch on stable reasons without parsing prose. Repository-keyed history reports action deltas even as the open seed set changes, including the transition to an empty backlog. It reports seed truncation, omitted references, and fetch failures before item-specific next steps. A graph relationship is evidence, not proof of working behavior, so every close candidate requires verification against current `main`, acceptance criteria, and the live product.

The command never mutates GitHub. It saves repository history under `~/.xref/reconcile-owner-repo/` unless `--no-snapshot` is set. `xref schema` reports GitHub mutations and local writes separately so automated callers can enforce their own state boundary.

## HTML explorer

`--html report.html` writes a self-contained, Geist-styled **master–detail explorer** (no server, no build — just `open` it). The left pane is a filterable tree of connected components, or of agent-named clusters when you pass `--clusters clusters.json`. Selecting a node opens an inspector with its PR triage metadata, derived flags, verdict, a small typed **ego-graph** of its neighborhood, and its relationships grouped by kind (closes / closed by / overlaps / references). Node links deep-link via the URL hash.

The `--clusters` file is either an array of `{ label, root_cause?, members: [{ key, verdict? }] }`, or an object `{ clusters: [...], cleanup: [{ key?, text }] }` that also carries a **Cleanup** checklist. The explorer pins Cleanup as its default view: the actionable close/supersede/retest list with the person to credit, each line linking to its node. This is exactly the shape the `--cluster` triage step produces, so an agent can cluster the graph and feed the result — clusters and cleanup — straight back into the explorer.

## How it finds references

`xref` uses two sources:

- text references in issue and pull request bodies and comments, including `#123`, `owner/repo#123`, and URLs
- structural references from the GitHub GraphQL API, including cross-references, connected events, and closing references

Structural references catch attached pull requests that never appear in the text. That prevents the tool from missing related work.

The CLI fetches each node's current state directly. It does not rely on a cross-reference event, which may be stale.

A node limit and hub limit prevent a deep crawl from pulling in an entire tracker. When the CLI skips expanding a hub, it reports a command you can use to start from that node.

Each node records its author and the accounts that referenced it. Each edge records the actor and date.

Runs are saved in `~/.xref/`. A later run over the same starting points shows what changed.

With `--cluster`, the CLI prints a prompt and compact payload for the calling agent. The agent does the root-cause analysis in its own context. The CLI does not need an API key. `--cluster-run` can call a headless `claude` or `codex` process for unattended runs.

## Use as a library

The graph logic is separate from the code that talks to GitHub, so the same
crawl runs from a laptop with an authenticated `gh` and from a server that only
has a token. You pick the transport.

Since this is not on a registry, depend on it from a local checkout, a git
dependency, or a workspace. The package name is `@vercel-labs/xref`, so the
import specifiers below work once it resolves.

```ts
import { classify, crawl, fileOverlaps, makeFetchNode, prioritize } from "@vercel-labs/xref";
import { httpTransport } from "@vercel-labs/xref/transport/http";

const repo = { owner: "owner", repo: "repo" };
const transport = httpTransport({ token: process.env.GITHUB_TOKEN! });

const { nodes } = await crawl(
  [{ ...repo, number: 352 }],
  { maxDepth: 2, maxNodes: 80, hubThreshold: 12, primaryRepo: repo },
  makeFetchNode(transport),
);

classify(nodes);
const ranked = prioritize(nodes, new Date());   // heat ranking
const dupes = fileOverlaps(nodes);              // duplicate/conflict pairs
```

Three entry points, one per set of requirements:

| Import | What it needs |
| --- | --- |
| `@vercel-labs/xref` | Nothing. Types, crawl, classify, prioritize, overlaps, renderers. No Node builtins, so it bundles anywhere, including an edge runtime. |
| `@vercel-labs/xref/transport/http` | `fetch` and a token. Retries on 5xx, honors `retry-after` and the rate-limit reset, caps requests in flight. |
| `@vercel-labs/xref/transport/shell` | An authenticated `gh` on `PATH`. What the CLI uses. |

Snapshot persistence and the cluster shell-out are CLI internals and are
deliberately not exported: they need a filesystem and a subprocess, and a
library consumer wanting either is better served owning its own.

`token` also accepts a function, sync or async, so a short-lived credential can
be resolved per request rather than held for the life of the process.

A transport failure throws rather than degrading to an empty graph. This
matters for unattended runs: a rate-limited crawl that swallowed its errors
would report a quiet backlog instead of a failure, which is worse than no
report. A reference to a node that no longer exists is not a transport failure
and still degrades to a single `FETCH_ERROR` node.

## Develop

```bash
bun test
bun run typecheck
bun run lint
bun run build
```

`scripts/verify-transports.ts` crawls one seed through both transports and
compares the graphs. It needs the network, so it is a script rather than a
test. Run it after touching either transport.

```bash
bun run scripts/verify-transports.ts <number> <owner/repo> <depth>
```

## Use with a coding agent

`skills/xref/` is a Claude Code skill that wraps this CLI. It lets an agent run
the graph from intent ("what should I fix first in this repo", "does this issue
already have a PR") and then perform the clustering step in its own context.
Symlink or copy it into your agent's skills directory.
