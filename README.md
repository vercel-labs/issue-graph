# xref

Map the complete reference graph around a GitHub issue, pull request, or
repository backlog before you start working on it.

`xref` follows text mentions and GitHub's structural links across repositories,
then classifies the graph so humans and coding agents can see related work,
duplicate pull requests, competing fixes, superseded work, and unresolved
follow-ups.

The crawl and classifications are deterministic. No model is required. An agent
is only used when you explicitly ask `xref` to group the graph by root cause.

## Install from source

`xref` is not published to a package registry yet. You need
[Bun](https://bun.sh) and an authenticated [GitHub CLI](https://cli.github.com).

```bash
gh repo clone vercel-labs/xref
cd xref
bun install --frozen-lockfile
bun link
```

The `xref` command is now available on your `PATH`.

```bash
xref --help
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
xref 260 --repo owner/repo
xref https://github.com/owner/repo/pull/260
```

Survey several related items:

```bash
xref --seeds 64,246,281 --repo owner/repo
```

Survey all open issues with a label and rank them by discussion heat:

```bash
xref --label bug --repo owner/repo --prioritize
```

Reconcile the whole open backlog, including repositories without labels:

```bash
xref reconcile --repo owner/repo
```

Turn that backlog into a deterministic next-action queue:

```bash
xref plan --repo owner/repo
```

Interactive terminals receive Markdown. Pipes and agents receive versioned JSON
by default. Use `--format markdown|json` to choose explicitly, and `xref schema`
to inspect the machine contract and local-write behavior.

Generate JSON and a self-contained HTML explorer:

```bash
xref 260 --repo owner/repo --json graph.json --html graph.html
open graph.html
```

## PR status by author and project

Count open PRs without a graph crawl:

```bash
xref status \
  --repo vercel-labs/agent-browser \
  --repo vercel-labs/wterm \
  --repo vercel-labs/portless \
  --repo vercel-labs/emulate \
  --repo vercel-labs/json-render \
  --author ctate,Railly
```

The default human view groups rows by repository and author, including zero rows. Use `--view projects` for project totals and per-author open counts, or `--view prs` for the underlying PRs, titles, URLs, heads, assignees, and requested reviewers. Filter by supplying fewer repositories or authors. Author matching and scope deduplication are case-insensitive.

```bash
xref status --repo vercel-labs/agent-browser --author ctate,Railly --view projects
xref status --repo vercel-labs/agent-browser --author ctate --view prs
xref status --repo vercel-labs/agent-browser --author ctate,Railly --format markdown
xref status --repo vercel-labs/agent-browser --author ctate,Railly --json
```

TTY output defaults to an aligned table, with narrow-terminal fallback and `NO_COLOR` support. Piped output defaults to JSON; `--format table|markdown|json` overrides it. Progress and the TTY heading go to stderr. In **status only**, `--json` takes no filename and prints JSON on stdout; graph's existing `--json PATH` still writes a file.

Review-required, changes-requested, approved, no-review-required, and unknown review states partition open PRs. Drafts, conflicts, and unassigned PRs are independent indicators. Approval is not a promise of merge readiness. The command does not infer organization membership from authors or read CI checks or coding-review threads.

Status paginates repository PR connections directly, not search results. `--concurrency` bounds concurrent repositories (default 4, maximum 32). `--max-pages` bounds each connection (default 100, maximum 1000; 50 PRs per repository page). Assignees and review requests are also paginated. Caps, access failures, malformed responses, and detectable inventory drift are reported explicitly.

JSON schema version 1 includes scope, query timestamps, per-repository coverage, PR evidence, author rows, project rows, totals, and runnable next steps. Each metric carries `{ count, prIds, unknownIds }`: `count: null` means unknown, while `prIds` retains known matches as a lower bound. Human views display `?`, never a fabricated zero. Failed repositories invalidate their own aggregate counts and portfolio totals, not complete sibling repositories. The query window is not an atomic GitHub snapshot.

Exit codes: 0 for complete inventory, 1 for incomplete inventory/runtime failures, 2 for invalid arguments. Status never mutates GitHub or writes snapshots; `--no-snapshot` is accepted as a no-op. The same captured evidence produces the same ordering and aggregation without a model. See [the contract](docs/shaping/status.md).

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

`xref reconcile` searches the open backlog, paginates seed discovery, crawls
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
`~/.xref/reconcile-owner-repo/` unless `--no-snapshot` is set.

## Plan the backlog

`xref plan` reuses the live reconciliation and discussion signals to separate
the backlog into:

- a ready execution queue
- an investigation queue for issues without enough evidence
- blocked work such as draft or conflicting pull requests and issues with
  active related work

Cleanup and verification actions come before implementation review. Within
each lane, xref uses readiness, discussion heat, and visible inbound references
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
xref "$ISSUE_URL" --json /tmp/xref.json --no-snapshot
```

Use reconcile mode for repository maintenance:

```bash
xref reconcile --repo owner/repo --format json --no-snapshot
```

Use plan mode to select the next safe action:

```bash
xref plan --repo owner/repo --format json
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
xref --seeds 64,246,281 --repo owner/repo --cluster
```

For unattended use, `--cluster-run claude` and `--cluster-run codex` can run the
same task through an installed headless agent.

The repository also includes an agent skill in [`skills/xref`](skills/xref).
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

Registry publishing is intentionally disabled for now. To use `xref` as a local
dependency, build this checkout and reference it from a workspace or file
dependency:

```bash
cd path/to/xref
bun install --frozen-lockfile
bun run build
```

```json
{
  "dependencies": {
    "@vercel-labs/xref": "file:../xref"
  }
}
```

```ts
import { classify, crawl, fileOverlaps, makeFetchNode, prioritize } from "@vercel-labs/xref";
import { httpTransport } from "@vercel-labs/xref/transport/http";

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
| `@vercel-labs/xref` | Runtime-agnostic graph core |
| `@vercel-labs/xref/transport/http` | `fetch` and a GitHub token |
| `@vercel-labs/xref/transport/shell` | An authenticated `gh` on `PATH` |

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
