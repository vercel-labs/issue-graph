---
name: issue-graph
description: Read-only GitHub PR status and reference graphs for maintainers and agents. Use whenever the user asks for PR counts or status by author, project, repository, or review state; approved, changes-requested, conflicting, draft, ready-for-review, or unassigned PRs; a compact portfolio table; or counts for named contributors, even without naming issue-graph. Spanish triggers include cuantas PRs, conteo por autor, tabla por proyecto, pendientes de revision, conflictos, and sin asignar. Also use before working an issue or PR, tracing references, finding duplicate or superseded work, reconciling an unlabeled backlog, prioritizing issues, and checking changes since a snapshot. Route counts to issue-graph status, references to graph, and backlog actions to reconcile or plan. Never infer code correctness or merge readiness from counts.
compatibility: Requires the `issue-graph` command on PATH. Install from source with `gh repo clone vercel-labs/issue-graph && cd issue-graph && bun install --frozen-lockfile && bun link`. Also needs an authenticated `gh`, Bun, and network access to the GitHub API. Snapshots persist under ~/.issue-graph/. Clustering runs in the calling agent's context, or shells out to `claude` or `codex` with `--cluster-run`.
---

# issue-graph

Take a **snapshot** of everything a GitHub PR/issue connects to, so no **orphan** gets left behind — and so you never open a PR that duplicates work already in flight. The CLI is the hands (crawls, guards, classifies, attributes, persists); you are the brain (read the graph, run the one semantic step it hands back). `issue-graph` is a globally-installed command (if it is missing, install it per compatibility above).

## Choose the command first

For PR counts or status tables, go directly to **Status mode** below; skip the graph steps. Resolve explicit repository and author scope from the request and available context, rather than enumerating an entire organization or guessing its members. Run `issue-graph status --help` if the installed CLI contract is uncertain. If status is unavailable, report the version mismatch instead of fabricating counts.

| Request | Route |
|---|---|
| PR counts by author/project/state, including ready-for-review or unassigned PRs | `issue-graph status --repo owner/repo --author login,other --format markdown` |
| Underlying PRs, assignees, or requested reviewers | Same scope with `--view prs` |
| Project-level summary | Same scope with `--view projects` |
| What changed since the previous PR status capture | Same scope with `--since last`; add `--save` to retain the new capture |
| Linked work, competing fixes, or reference graph | Graph steps below |
| Full backlog reconciliation or next-action queue | `issue-graph reconcile --repo owner/repo` or `issue-graph plan --repo owner/repo`; inspect their `--help` before use |

Ready-for-review means non-draft, not approved or merge-ready. For a ready-for-review/unassigned intersection, filter `pullRequests` from `--json` using `isDraft === false` and an explicitly empty `assignees` array. Do not subtract independent totals or treat unknown metadata as empty. The status command does not inspect bot review findings or CI checks; those need a separate review inspection.

## Steps

1. **Crawl the seed.**
   ```bash
   issue-graph <url|number> --repo owner/repo [--depth N] [--cluster] [--prioritize]
   ```
   Multi-seed / backlog survey: `--seeds 1,2,3` or `--label <label>`. Add `--prioritize` when the ask is "what should I fix first". `issue-graph --help` lists every flag.
   Done when the CLI has printed the Nodes list and the orphan checklist.

   Map the ask onto the invocation:

   | The user asks | Run |
   | --- | --- |
   | "what's attached to this issue/PR", "check before I fix it" | `issue-graph <n> --repo <o/r> --depth 2` |
   | "what should I fix first", "most impactful issues" | `issue-graph --label <label> --repo <o/r> --prioritize` |
   | "which PRs are duplicating each other" | `issue-graph --seeds <n,n,n> --repo <o/r>` and read the overlap section |
   | "which issues have no PR" / "which have competing PRs" | `issue-graph --label <label> --repo <o/r>` and read the orphan checklist and flags |
   | "clean/reconcile the whole backlog", including repos without labels | `issue-graph reconcile --repo <o/r> --format markdown` |
   | "what should happen next until the backlog is empty" | `issue-graph plan --repo <o/r> --format markdown` |
   | "cluster my backlog by root cause" | `issue-graph --seeds <n,n,n> --repo <o/r> --cluster` |
   | "what changed since last time" | re-run the same seeds; the snapshot diff is automatic |

2. **Surface the orphans and hazards.** Relay the orphan checklist to the user, most-actionable first:
   - ⚠️ **SUPERSEDED** PRs — a merged PR already shipped this work; candidate to close *with credit*.
   - ⚠️ **POSSIBLY SUPERSEDED** PRs — the PR is structurally linked to an issue that a later merged PR closed; verify scope, then close with credit if the merged work covers it.
   - ⚠ **competing** PRs — two open PRs close the same issue; pick one, credit both.
   - ⚠ **claims-close-no-link** — a PR says `fixes #N` (often in the title) but has no structural closing link, so merging it silently won't auto-close the issue.
   - Then the remaining open related issues/PRs.
   Done when every open, superseded, competing, and flagged node is named — silence on a node is a miss.

3. **Read the overlap section.** If a "Possible duplicate / overlapping PRs (shared files)" section is present, relay it: each pair of open PRs that touch the same files is a likely duplicate or merge conflict, and a pair that also closes the same issue is a near-certain duplicate. This is the objective duplication signal — trust it over title similarity.

4. **Relay the triage priority.** With `--prioritize`, the output ends with a "Triage priority" ranking of every open node by discussion heat — `comments×3 + participants×2 + reactions×2 + inbound refs×2 + min(12, daysOpen/30)`. This encodes "fix the most impactful issues, not inbox zero": lots of discussion and/or obvious frustration first. Relay the top of the ranking with each node's raw signals (they are printed next to the score) so the user can override the order; the score is a sort key, not a verdict.

5. **Run the cluster step.** With `--cluster`, the CLI prints a fenced `cluster-prompt` block listing each node's edges in `[brackets]`. That block is a sub-task addressed to you: cluster by the edge structure and shared defect (not title keywords), then present the root-cause clusters. This step is done only once the clusters exist in your reply — showing the CLI output is not doing it. (For unattended runs, pass `--cluster-run claude|codex` so the CLI shells out instead.)

6. **Offer the hub re-seeds.** If the output has a "Hubs not expanded" section, give the user the exact re-seed command it printed for each hub — that is how the neighborhood behind a tracking issue gets explored without pulling the whole tracker.

7. **Report what changed.** If a "Since last snapshot" diff is present, relay the new nodes, state changes, and new mentions/links with who made them.

## Status mode

Use `issue-graph status` for counts of open PRs by explicit repository and author, not graph discovery or prioritization. Do not reconstruct these counts through ad hoc queries when this command is available.

```bash
issue-graph status --repo vercel-labs/agent-browser --repo vercel-labs/wterm --author ctate,Railly
issue-graph status --repo vercel-labs/agent-browser --author ctate,Railly --view projects
issue-graph status --repo vercel-labs/agent-browser --author ctate --view prs
issue-graph status --repo vercel-labs/agent-browser --author ctate,Railly --json
```

The default author view retains zero rows. `projects` summarizes each repository; `prs` provides titles, URLs, exact heads, assignees, reviewer requests, and runnable graph commands. Repeated `--repo` and repeated/comma-separated `--author` define scope; matching is case-insensitive. Never silently widen that scope to an organization.

TTY output is a table, pipes default to versioned JSON. `--format table|markdown|json` overrides it. In status only, `--json` is boolean and does not write a file. Legacy graph `--json PATH` is unchanged. `NO_COLOR` disables styling. Status never mutates GitHub and writes no snapshots by default. `--save` opts into local snapshots; `--no-snapshot` forbids writes and conflicts with `--save`.

Every metric includes `count`, `prIds`, and `unknownIds`. Null counts and `?` mean unknown; known IDs can be lower bounds. Check `coverageComplete` and per-repository `coverage` before claiming complete totals. Exit 1 means incomplete/runtime failure, not an empty backlog; exit 2 means usage error. Complete sibling repositories remain useful after another repository fails. Review states partition open PRs; drafts, conflicts, and unassigned are overlapping flags. Approval is not merge readiness. Unknown mergeability is not conflict-free. This version does not inspect CI checks or bot review threads.

Pagination uses PR connections rather than the search ceiling. Defaults: 50 PRs per page, 100 pages per connection, 4 concurrent repositories. `--max-pages 1..1000` and `--concurrency 1..32` bound work; caps and detectable pagination drift appear as incomplete coverage. Assignee/reviewer connections are also paginated. Treat timestamps as a query window, not an atomic snapshot.

### Compare status captures

```bash
issue-graph status --repo vercel-labs/agent-browser --author ctate,Railly --save
issue-graph status --repo vercel-labs/agent-browser --author ctate,Railly --since last --save
```

Save only when the user wants local history. Captures live under `~/.issue-graph/status/<scope-hash>/`, or `ISSUE_GRAPH_HOME/status` when configured. `--since last` loads the prior matching-scope capture before fetching/saving the new one; `--since PATH` also accepts a previous JSON report. Missing/corrupt/future/mismatched baselines fail, not silently reset. Repositories/authors must match, ignoring order/case.

Use `history.changes`, `history.added`, `history.departures`, `history.uncertain`, and per-row/totals deltas rather than comparing formatted tables. A vanished PR is only called MERGED/CLOSED after an explicit GitHub lookup. Unknown metadata and incomplete captures cannot prove additions or transitions. Reconstructed baselines must retain `provenance.kind: reconstructed`, source references, and unknown fields; never backfill historical facts from today's response. Exit 1 can also mean incomplete comparison. Do not attribute a state change to a reviewer without separate review evidence.

## Reconcile mode

Use `issue-graph reconcile --repo owner/repo --format json` when another tool or agent will consume the result. Add `--no-snapshot` when the caller must leave local state unchanged. The JSON carries `schemaVersion`, counts, ordered items, structured evidence, crawl limits, repository-level history, and contextual next steps. Each evidence object has a stable `code`, a human `summary`, and exact `related` node keys. `history` compares against the previous report for the same repository and exposes added, changed, and resolved actions plus coverage regression or recovery. Run `issue-graph schema` before building a durable integration and inspect both `githubMutations` and `localWrites`.

Treat its actions as a verification queue:

- `close-superseded`: verify scope parity, credit the contributor, then close if fully covered.
- `verify-superseded`: compare both implementations before deciding.
- `resolve-competing`: select one implementation path and respond to every contributor.
- `repair-closing-link`: correct the GitHub closing relationship before merge.
- `verify-completed`: check current `main`, acceptance criteria, and live behavior before closing the issue.
- `review-open-pr`: run the repository's exact-SHA review gate.
- `keep-linked`: leave it open while linked work is active.
- `keep-untracked`: reproduce or inspect before prioritizing.

If `limits.seedLimitReached` is true, `limits.cappedOut` is non-empty, or `limits.fetchFailures` is non-empty, report the incomplete coverage. Increase `--max-nodes`, re-seed the omitted neighborhood, or retry failed nodes before claiming the backlog was fully reconciled.

## Plan mode

Use `issue-graph plan --repo owner/repo --format json` when a human or agent needs the next safe backlog action. It returns a ready execution queue, an investigation queue, blocked work, a single `next` item when coverage permits, and a structured `decision` for its observed neighborhood. Competing pull requests include comparable draft, review, mergeability, diff, file-count, and update signals. A `reviewFirst` value orders inspection only; it never proves correctness or chooses the winning implementation. Failed neighbor references are quarantined to their affected items. The ordering is deterministic and uses reconcile action, PR readiness, discussion heat, and visible inbound references.

The MVP does not infer semantic dependencies from issue prose. Treat `blockedBy` as visible graph evidence only, and re-run after each merge or closure.

## Flags

- `--repo owner/repo` — required for bare numbers, `--seeds`, `--label`.
- `--depth N` (default 2) — same-repo recursion; cross-repo refs are fetched one hop, not expanded.
- `--seeds a,b,c` / `--label L` — backlog mode; output adds connected components.
- `--max-nodes N` (80), `--hub-threshold N` (12) — crawl guards.
- `--prioritize` — rank open nodes by discussion heat (comments, participants, reactions, inbound refs, time open); the ranking is also always present in `--json` output as `priorities`.
- `--cluster` emits the prompt for you; `--cluster-run claude|codex` shells out.
- `reconcile --repo owner/repo` inventories the open backlog without labels; `--format auto|json|markdown` controls its versioned output.
- `plan --repo owner/repo` turns that reconciliation into execution, investigation, and blocked queues without writing snapshots.
- `--json out.json` writes the machine-readable graph (now includes `components` and `overlaps`); `--no-snapshot` skips persistence.
- `--html out.html` writes a self-contained master–detail explorer (Geist-styled, no server — `open` it). `--clusters clusters.json` groups the explorer by agent-named clusters and pins a **Cleanup** checklist as the default view. The file is either `[{label, root_cause?, members:[{key, verdict?}]}]` or `{clusters:[…], cleanup:[{key?, text}]}` — the same shape the `--cluster` step produces, so feed your whole triage (clusters + the close/credit cleanup list) back into the UI.

## How it reads the graph

- **Two edge sources.** Text mentions (body + comments) and structural links (timeline cross-references, connected events, closing refs) via GraphQL. Structural links catch attached PRs that never appear in the body text — the reason a text grep alone misses orphans.
- **PR triage metadata.** Each PR node carries `review`, draft/mergeable state, `+adds/-dels across Nf`, `updated <date>` (staleness), and the file paths it touches — all in the one node query, no extra requests.
- **Heat signals.** Every node also carries comment count, distinct participants, reactions, and createdAt in the same query — the inputs to `--prioritize`.
- **File-overlap detection.** Open PRs whose changed-file sets intersect are paired as possible duplicates/conflicts; a shared closing issue promotes the pair to a likely duplicate.
- **Derived triage.** Open PRs are marked superseded when they share a closing target with merged work, or possibly superseded when they are structurally linked to an issue closed by a later merged PR. `competing` (>1 open PR closes an issue) and `claims-close-no-link` (a `fixes #N` that won't auto-close) are computed and attached per node.
- **Attribution.** Each node carries its author and who mentioned it; each edge carries the actor and date.
- **State is fetched live per node** (OPEN/CLOSED/MERGED), never trusted from a cross-reference event, which can be stale.
- **Snapshot + diff.** Graph runs compare the same seeds. Reconcile runs compare the repository even when its open seed set changes, including a transition to zero open items. Incomplete coverage suppresses unsafe new or resolved claims. Every run persists to `~/.issue-graph/` unless `--no-snapshot` is set.

## Guardrails

- Report the graph to the user. Never post a comment, review, edit, or other mutation to GitHub.
- A merged relationship is not behavioral proof. Never close an issue from `verify-completed` without checking current code and behavior.
- Before opening a PR for an issue, run issue-graph on it first: an existing open PR, a superseded one, or a file-overlap pair means the work may already be done — coordinate and credit instead of duplicating.
- Cross-repo refs are fetched one hop and shown; external non-GitHub links are collected, with loopback/example/CI hosts filtered as noise.
