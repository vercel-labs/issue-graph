# issue-graph

Map the complete reference graph around a GitHub issue, pull request, or
repository backlog before you start working on it.

`issue-graph` follows text mentions and GitHub's structural links across repositories,
then classifies the graph so humans and coding agents can see related work,
duplicate pull requests, competing fixes, superseded work, and unresolved
follow-ups.

The crawl and classifications are deterministic. No model is required. An agent
is only used when you explicitly ask `issue-graph` to group the graph by root cause.

## Install from source

`issue-graph` is not published to a package registry yet. You need
[Bun](https://bun.sh) and an authenticated [GitHub CLI](https://cli.github.com).

```bash
gh repo clone vercel-labs/issue-graph
cd issue-graph
bun install --frozen-lockfile
bun link
```

The `issue-graph` command is now available on your `PATH`.

```bash
issue-graph --help
```

To update:

```bash
git pull --ff-only
bun install --frozen-lockfile
bun link
```

## Quick start

Trace one issue or pull request:

```bash
issue-graph 260 --repo owner/repo
issue-graph https://github.com/owner/repo/pull/260
```

Survey several related items:

```bash
issue-graph --seeds 64,246,281 --repo owner/repo
```

Survey all open issues with a label and rank them by discussion heat:

```bash
issue-graph --label bug --repo owner/repo --prioritize
```

Reconcile the whole open backlog, including repositories without labels:

```bash
issue-graph reconcile --repo owner/repo
```

Turn that backlog into a deterministic next-action queue:

```bash
issue-graph plan --repo owner/repo
```

Interactive terminals receive Markdown. Pipes and agents receive versioned JSON
by default. Use `--format markdown|json` to choose explicitly, and `issue-graph schema`
to inspect the machine contract and local-write behavior.

Generate JSON and a self-contained HTML explorer:

```bash
issue-graph 260 --repo owner/repo --json graph.json --html graph.html
open graph.html
```

## PR status by author and project

Count open PRs without a graph crawl:

```bash
issue-graph status \
  --repo vercel-labs/agent-browser \
  --repo vercel-labs/wterm \
  --repo vercel-labs/portless \
  --repo vercel-labs/emulate \
  --repo vercel-labs/json-render \
  --author ctate,Railly
```

The default human view groups rows by repository and author, including zero rows. Use `--view projects` for project totals and per-author open counts, or `--view prs` for the underlying PRs, titles, URLs, heads, assignees, and requested reviewers. Filter by supplying fewer repositories or authors. Author matching and scope deduplication are case-insensitive.

```bash
issue-graph status --repo vercel-labs/agent-browser --author ctate,Railly --view projects
issue-graph status --repo vercel-labs/agent-browser --author ctate --view prs
issue-graph status --repo vercel-labs/agent-browser --author ctate,Railly --format markdown
issue-graph status --repo vercel-labs/agent-browser --author ctate,Railly --json
```

TTY output defaults to an aligned table, with narrow-terminal fallback and `NO_COLOR` support. Piped output defaults to JSON; `--format table|markdown|json` overrides it. Progress and the TTY heading go to stderr. In **status only**, `--json` takes no filename and prints JSON on stdout; graph's existing `--json PATH` still writes a file.

Review-required, changes-requested, approved, no-review-required, and unknown review states partition open PRs. Drafts, conflicts, and unassigned PRs are independent indicators. Approval is not a promise of merge readiness. The command does not infer organization membership from authors or read CI checks or coding-review threads.

Status paginates repository PR connections directly, not search results. `--concurrency` bounds concurrent repositories (default 4, maximum 32). `--max-pages` bounds each connection (default 100, maximum 1000; 50 PRs per repository page). Assignees and review requests are also paginated. Caps, access failures, malformed responses, and detectable inventory drift are reported explicitly.

JSON schema version 1 includes scope, query timestamps, per-repository coverage, PR evidence, author rows, project rows, totals, and runnable next steps. Each metric carries `{ count, prIds, unknownIds }`: `count: null` means unknown, while `prIds` retains known matches as a lower bound. Human views display `?`, never a fabricated zero. Failed repositories invalidate their own aggregate counts and portfolio totals, not complete sibling repositories. The query window is not an atomic GitHub snapshot.

Exit codes: 0 for complete inventory/comparison, 1 for incomplete evidence or runtime failures, 2 for invalid arguments. Status never mutates GitHub. Local writes are opt-in through `--save`; `--no-snapshot` forbids them and conflicts with `--save`. The same captured evidence produces the same ordering and aggregation without a model.

### Compare with the previous capture

```bash
issue-graph status --repo vercel-labs/agent-browser --author ctate,Railly --save
issue-graph status --repo vercel-labs/agent-browser --author ctate,Railly --since last --save
issue-graph status --repo vercel-labs/agent-browser --author ctate,Railly --since /path/to/previous.json --json
```

`--save` stores immutable, private JSON under `~/.issue-graph/status/<scope-hash>/`; set `ISSUE_GRAPH_HOME` to use another root. `--since last` loads the latest capture for exactly the same repositories and authors before collecting or saving anything new. Different order/case is accepted, different scope is not. `--since PATH` also accepts an older exported status JSON report. A missing, corrupt, future, or mismatched baseline fails explicitly instead of claiming no changes.

The Changes appendix shows review, draft, conflict, head, assignment, and reviewer-request transitions plus count deltas. JSON adds `history` when comparing and `snapshot` with the saved path when saving. Missing PRs are queried explicitly to distinguish merged, closed, and unverified; absence alone never means merged. Unknown metadata and incomplete prior captures remain uncertain. Reconstructed baselines carry their provenance rather than pretending to be live exports. This tracks observed state, not who authored a review or whether their comments were addressed.

## What it finds

- Text mentions in issue and pull request bodies and comments
- GitHub cross-references, connected events, and closing references
- References across repositories
- Open pull requests that touch the same files
- Multiple pull requests competing to close the same issue
- Pull requests that may already be superseded by merged work
- Closing claims such as `fixes #123` without a structural closing link
- Open nodes ranked by comments, participants, reactions, inbound references,
  and time open
- Changes since the previous graph or repository reconciliation

Every node includes its current state, author, referrers, outgoing edges, and
pull request metadata when available. Every edge records its source and
attribution.

## Reconcile as an agent protocol

`issue-graph reconcile` searches the open backlog, paginates seed discovery, crawls
reference-graph levels with bounded concurrency, and produces deterministic
actions such as:

- `verify-completed`
- `close-superseded`
- `resolve-competing`
- `repair-closing-link`
- `review-open-pr`
- `keep-linked`
- `keep-untracked`

Evidence is structured as `{ code, summary, related }`, so agents can branch on
stable reasons without parsing prose. Repository-keyed history reports new
items, action changes, resolved items, and coverage regressions or recoveries.

A graph relationship is evidence, not proof of working behavior. Close
candidates still require verification against current code, acceptance
criteria, and live behavior.

The command never mutates GitHub. It saves local repository history under
`~/.issue-graph/reconcile-owner-repo/` unless `--no-snapshot` is set.

## Plan the backlog

`issue-graph plan` reuses the live reconciliation and discussion signals to separate
the backlog into:

- a ready execution queue
- an investigation queue for issues without enough evidence
- blocked work such as draft or conflicting pull requests and issues with
  active related work

Cleanup and verification actions come before implementation review. Within
each lane, issue-graph uses readiness, discussion heat, and visible inbound references
as deterministic sort keys. Missing open seeds or capped crawl neighborhoods
make the queue provisional and suppress the single `next` recommendation.
Failed neighbor references are quarantined to the affected items so unrelated
work can still proceed.

When the next action involves competing pull requests, the report includes a
structured `decision` object. It labels each relationship, compares draft,
review, mergeability, diff size, changed files, and update time, and may name a
pull request to review first. That ordering is a review shortcut, not a claim
that the pull request is correct or should win. Acceptance criteria and
repository-specific behavior still require human or review-gate verification.

The MVP does not infer product dependencies from prose. Its `blockedBy` entries
come only from visible active GitHub relationships. Re-run the command after
each merge or closure to refresh the queue.

## Built for software factories

Use graph mode as a preflight before an agent plans or implements one issue:

```bash
issue-graph "$ISSUE_URL" --json /tmp/issue-graph.json --no-snapshot
```

Use reconcile mode for repository maintenance:

```bash
issue-graph reconcile --repo owner/repo --format json --no-snapshot
```

Use plan mode to select the next safe action:

```bash
issue-graph plan --repo owner/repo --format json
```

A factory can use the evidence to:

1. Stop when another pull request already implements the issue.
2. Route competing or overlapping work to review.
3. Give an implementation agent the full issue and pull request neighborhood.
4. Build a verification queue from stable reconcile actions.
5. Re-run later and detect graph, action, or coverage changes.

The graph core is separate from GitHub access. The CLI uses an authenticated
`gh` process, while server integrations can use the HTTP transport with `fetch`
and a token.

## Agent-assisted clustering

Print a compact root-cause clustering task for the calling agent:

```bash
issue-graph --seeds 64,246,281 --repo owner/repo --cluster
```

For unattended use, `--cluster-run claude` and `--cluster-run codex` can run the
same task through an installed headless agent.

The repository also includes an agent skill in [`skills/issue-graph`](skills/issue-graph).
Copy or symlink it into your agent's skills directory after installing the CLI.

## HTML explorer

`--html graph.html` creates a single file with no server or build step. It
includes:

- A filterable graph grouped by connected component or agent-provided cluster
- Node evidence and typed relationships
- A cleanup checklist for superseded or competing work
- An Impact view that projects the visible blast radius of resolving a node

Impact is a projection from the current graph, not proof of causality. The
explorer never changes GitHub.

## Use as a library

Registry publishing is intentionally disabled for now. To use `issue-graph` as a local
dependency, build this checkout and reference it from a workspace or file
dependency:

```bash
cd path/to/issue-graph
bun install --frozen-lockfile
bun run build
```

```json
{
  "dependencies": {
    "@vercel-labs/issue-graph": "file:../issue-graph"
  }
}
```

```ts
import { classify, crawl, fileOverlaps, makeFetchNode, prioritize } from "@vercel-labs/issue-graph";
import { httpTransport } from "@vercel-labs/issue-graph/transport/http";

const repo = { owner: "owner", repo: "repo" };
const transport = httpTransport({ token: process.env.GITHUB_TOKEN! });

const { nodes } = await crawl(
  [{ ...repo, number: 260 }],
  { maxDepth: 2, maxNodes: 80, hubThreshold: 12, primaryRepo: repo },
  makeFetchNode(transport),
);

classify(nodes);
const priorities = prioritize(nodes, new Date());
const overlaps = fileOverlaps(nodes);
```

Available entry points:

| Import | Requirements |
| --- | --- |
| `@vercel-labs/issue-graph` | Runtime-agnostic graph core |
| `@vercel-labs/issue-graph/transport/http` | `fetch` and a GitHub token |
| `@vercel-labs/issue-graph/transport/shell` | An authenticated `gh` on `PATH` |

## Development

```bash
bun install --frozen-lockfile
bun run check
```

To compare the shell and HTTP transports against a live repository:

```bash
bun run scripts/verify-transports.ts <number> <owner/repo> <depth>
```

## License

Apache-2.0
