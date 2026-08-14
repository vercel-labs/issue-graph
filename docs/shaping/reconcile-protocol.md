# Reconcile as an agent protocol

## Source

> A)

> si A + B dale

The selected direction combines A, xref as a deterministic protocol for agents, with B, xref as a continuous maintenance radar. A is the first implementation slice. B is the next slice and must reuse the same report contract.

## Frame

`xref reconcile` already inventories a live backlog and derives deterministic actions. Dogfooding exposed four trust gaps:

- evidence is human text instead of a stable reason code
- `nextSteps` are generic even when the backlog is empty or coverage is incomplete
- the schema says the command does not mutate while default snapshots write local state
- changing seed sets break repository-level history continuity

The first three gaps block reliable agent integration now. The fourth is the natural next slice once the report itself is trustworthy.

## Requirements

| ID | Requirement |
| --- | --- |
| R0 | Agents can branch on stable evidence codes without parsing prose. |
| R1 | Every evidence record preserves a human summary and related node keys. |
| R2 | Next steps reflect the actual report state and appear in deterministic order. |
| R3 | Incomplete coverage is surfaced before item-specific action. |
| R4 | An empty backlog routes to discovery instead of review or verification work. |
| R5 | The schema distinguishes GitHub mutations from local filesystem writes. |
| R6 | Markdown and JSON expose the same reasons and next-step semantics. |
| R7 | Read-only callers can use `--no-snapshot` and leave no local state. |
| R8 | Repository-level history remains comparable when the open seed set changes. |
| R9 | Future reports can expose action transitions, not only graph-node changes. |

## Direction spectrum

| Direction | Mechanism | Decision |
| --- | --- | --- |
| A. Agent protocol | Typed evidence, coverage-aware next steps, honest side-effect schema | Selected primary direction |
| B. Continuous radar | Repository-keyed snapshots and action deltas | Selected next slice |
| C. HTML cockpit | Visual maintenance surface over reconciliation history | Deferred until the protocol is stable |
| D. Scale layer | Pagination, batching, bounded concurrency | Deferred until current semantics are proven |

## Selected shape

### A1. Structured evidence

Each reconciliation item returns evidence objects with:

- `code`, a stable machine branch
- `summary`, a human-readable explanation
- `related`, the exact GitHub node keys supporting the explanation

The action remains the recommendation class. Evidence codes explain why the item received it.

### A2. Contextual next steps

Build `nextSteps` from report facts in this order:

1. incomplete seed or node coverage
2. failed graph fetches
3. nominated cleanup actions that need verification
4. open pull requests that need a review gate
5. linked or untracked issues that need monitoring or reproduction
6. empty backlog discovery

### A3. Honest side-effect contract

`xref schema` declares `githubMutations: false` for every command and lists possible `localWrites`. This preserves the important GitHub boundary without hiding snapshots or explicit output files.

### B1. Repository-level radar

Store reconcile history under a stable repository namespace rather than the current seed-set namespace. Compare the previous and current reports to emit action transitions such as:

- new actionable item
- action changed
- item resolved or no longer open
- coverage regressed or recovered

B1 is not part of A1-A3 because it changes snapshot identity and persistence semantics. It ships as a separate, independently reviewable slice.

## Breadboard

### Places

| # | Place | Description |
| --- | --- | --- |
| P1 | Caller terminal | Human or agent invokes `xref reconcile`. |
| P2 | GitHub | Live issue, pull request, and relationship source. |
| P3 | Local xref state | Optional snapshots and explicit output files. |

### UI affordances

| # | Place | Component | Affordance | Control | Wires Out | Returns To |
| --- | --- | --- | --- | --- | --- | --- |
| U1 | P1 | CLI | reconcile invocation | invoke | N1 | none |
| U2 | P1 | CLI | JSON or Markdown report | render | none | none |
| U3 | P1 | CLI | stderr coverage and persistence diagnostics | render | none | none |
| U4 | P1 | CLI | schema JSON | render | none | none |

### Code affordances

| # | Place | Component | Affordance | Control | Wires Out | Returns To |
| --- | --- | --- | --- | --- | --- | --- |
| N1 | P1 | `resolveSeeds()` | resolve live open backlog | call | N2 | U3 |
| N2 | P2 | `openBacklogSeeds()` and `crawl()` | fetch graph | call | N3 | N1 |
| N3 | P1 | `buildReconcileReport()` | classify actions and evidence | call | N4, N5 | U2 |
| N4 | P1 | contextual next-step builder | derive | none | U2 |
| N5 | P3 | `writeSnapshot()` | optional local write | call | S1 | U3 |
| N6 | P1 | `XREF_SCHEMA` | describe command effects | read | none | U4 |
| N7 | P3 | future report diff | compare | none | U2 |

### Data stores

| # | Place | Store | Description |
| --- | --- | --- |
| S1 | P3 | `~/.xref/` | Optional local snapshot history. |

## Slices

| # | Slice | Requirements | Demo |
| --- | --- | --- | --- |
| V1 | Trustworthy agent protocol | R0-R7 | Pipe an empty and an actionable repository to JSON, branch on evidence codes, inspect contextual next steps, and confirm `--no-snapshot` writes nothing. |
| V2 | Continuous repository radar | R8-R9 | Reconcile the same repo after its open set changes and see action transitions against the previous report. |
| V3 | Scale without semantic drift | R0-R9 | Reconcile a large backlog with complete pagination and bounded concurrency while preserving the same report contract. |

## Fit check

- V1 is useful without V2 because agents immediately gain stable reasons and honest effects.
- V2 builds on the same report and can be reviewed without changing classification semantics.
- V3 changes transport and performance only after the protocol and history behavior are proven.
- No slice requires a visual dashboard.

## Out of scope for V1

- repository-keyed snapshot migration
- action-delta schema
- organization-wide aggregation
- HTML dashboard changes
- GitHub mutations
- pagination or request batching
