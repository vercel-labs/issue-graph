# Status inventory

## Source

> good, hagamoslo pero primero a diseniar la mejor ux de la tabla please dame propuestas

> me encanta hagamoslo!

## Contract origin

Mixed: xref owns the report and rendering contract. The GitHub boundary reuses `GhTransport.graphql` and the PR fields verified during the September 9 portfolio reconciliation. Repository PR connections replace search to avoid the search result ceiling. No organization discovery, graph crawl, GitHub writes, local snapshots, or LLM calls.

## Selected direction

A repository-by-author table is the primary human view. A project summary and a PR ledger are explicit alternate views of the same report. This advances NORTH's evidence-backed protocol; the caller still supplies the repository list.

## Requirements

| ID | Requirement |
|---|---|
| R0 | Count all open PRs for explicitly selected repositories and authors, including zero rows. |
| R1 | Separate review states from overlapping draft, conflict, and assignment indicators. |
| R2 | Preserve unknown metadata and incomplete inventory instead of displaying fabricated zeros. |
| R3 | Produce identical aggregation and ordering for the same captured input. |
| R4 | Retain the exact PR IDs, URLs, and head SHAs behind each count. |
| R5 | Keep legacy graph/reconcile/plan output and file semantics unchanged. |
| R6 | Support aligned terminal tables, Markdown, versioned JSON, and explicit drill-down without a TUI. |

## Surface

`xref status --repo owner/repo [--repo owner/other] --author ctate,Railly`

- Repeated `--repo` and repeated/comma-separated `--author`; case-insensitive deduplication. Explicit scope is required.
- `--view authors|projects|prs`, default authors. JSON always includes all views and evidence.
- `--format auto|table|markdown|json`; auto selects table for TTY, JSON otherwise. Status-only `--json` aliases `--format json`, with no path operand. Legacy graph `--json PATH` is unchanged.
- `--concurrency 1..32`, default 4, across repositories; cursor pagination inside each repository.
- `--max-pages 1..1000`, default 100, with 50 PRs per page. A cap or failure means incomplete, never an empty backlog.
- `--no-snapshot` is accepted as an explicit no-op: status never writes snapshots.
- Complete success exits 0; incomplete coverage/runtime failures exit 1; invalid arguments exit 2.

## JSON v1

The report contains `schemaVersion`, `startedAt`, `generatedAt`, `scope`, `coverageComplete`, `coverage`, `pullRequests`, `rows`, `projects`, `totals`, and `nextSteps`.

A count is `{ count: number | null, prIds: string[], unknownIds: string[] }`. `prIds` are known matches, including lower bounds when a count is unknown. Null counts are rendered as `?`, not zero. A failed repository invalidates its aggregate counts and the corresponding portfolio totals, without invalidating complete sibling repositories.

Review buckets: required, changes-requested, approved, not-required, unknown. Null GitHub reviewDecision means no requirement, absent/unrecognized metadata means unknown. Drafts are independent of review buckets. UNKNOWN mergeability is not conflict-free. Missing assignment/reviewer data is not an empty list.

PR evidence retains repository, number, author, title, URL, head SHA, update time, draft state, review state, mergeability, assignees, and requested reviewers. The inventory is a query window, not an atomic GitHub transaction. Pagination drift is reported when detectable.

## Wiring

| Input | Mechanism | Output |
|---|---|---|
| CLI status arguments | Dedicated parser and runner before legacy dispatch | Validated explicit scope |
| Scope and GhTransport | Paginated PR inventory with bounded concurrency | PR evidence and per-repository coverage |
| Captured evidence and timestamps | Pure aggregation, canonical sorting and deduplication | Versioned report and count provenance |
| Report and selected view | Pure table/Markdown rendering; CLI-controlled color | Human views or unchanged JSON report |
| PR ledger IDs | Existing xref graph command | Focused reference exploration |

## Independently mergeable slice

One slice delivers inventory, aggregation, three views, schema, tests, docs, and live read-only verification. Excluded: bot review interpretation, CI checks, organization discovery, automatic prioritization, snapshots/deltas, interactive UI, mutations, and releases. Rollback removes the status dispatch and status modules without altering existing commands.

## Validation

Fixtures cover mixed case, duplicate PRs, zero rows, draft/approval overlap, unknown review and mergeability, incomplete repositories, multi-page and >1000-item discovery, secondary connection pagination, GraphQL errors, cursor stalls, caps, deterministic ordering, evidence IDs, format/flag errors, safe text, color/plain alignment, and pipeline JSON. Live smoke uses the five explicitly requested Vercel Labs repositories without writes.

## Implementation receipt · 2026-09-09

- Implemented `src/status.ts` (paginated inventory and pure aggregation), `src/status-render.ts` (three human views), and `src/status-cli.ts` (dedicated parser/runner). CLI dispatch, core exports, schema, README, companion skill, and NORTH are connected. No dependencies added.
- Independent review caught object-property-order false drift, reconstruction of canonical URLs, and two test type errors. All were corrected; regression tests cover reordered fields/people and renamed or enterprise-hosted canonical URLs.
- The first 80-column TTY smoke produced verbose blocks. Adaptive spacing now keeps the normal ten-row view in a table, with fallback only when the columns cannot fit. Styling pads before applying ANSI. Markdown and pipe JSON are unstyled.
- Final `bun run check`: exit 0, Biome clean, typecheck passed, 191 tests passed, 0 failed, build passed. `git diff --check`: exit 0. Built `dist/index.js` exports were also imported with Node successfully.
- `xref` was already linked to this checkout. `xref status --help` and real command dispatch were verified through PATH, without relinking or changing the global environment.

Live author-table command, successful exit 0 in a real 80-column TTY:

```bash
xref status --repo vercel-labs/agent-browser --repo vercel-labs/wterm --repo vercel-labs/portless --repo vercel-labs/emulate --repo vercel-labs/json-render --author ctate,Railly
```

The 14:06:50–14:07:04 UTC query scanned 357 Agent Browser PRs, 56 Emulate, 36 JSON Render, 60 Portless, and 12 WTerm. All repository inventories were complete. Selected author totals: 12 open, 9 review-required, 2 changes-requested, 1 approved, 6 conflicting, 0 drafts, 12 unassigned. This differs from the earlier 10/1/1 review snapshot because GitHub changed during development; counts are not fixtures baked into the command.

The same five-repo invocation with `NO_COLOR=1`, `--view projects --format table` passed, exit 0, at 14:06:53–14:07:07 UTC.

Additional successful checks:

```bash
xref status --repo vercel-labs/wterm --author ctate,Railly
xref status --repo vercel-labs/wterm --author ctate,Railly --view prs --format markdown
```

The first was captured through a pipe: valid schema-v1 JSON, empty stderr, no ANSI, two PRs with exact provenance. The second showed both canonical links and exact heads in the ledger. Both exited 0.

Expected incomplete-inventory check:

```bash
xref status --repo vercel-labs/agent-browser --author ctate,Railly --max-pages 1 --json
```

Observed exit 1, `coverageComplete: false`, `totals.open.count: null`, and `PAGE_LIMIT`. The surrounding assertion harness exited 0. No false zero or success was reported.

No commits, pushes, PR creation, GitHub mutations, release changes, or snapshots were performed. CI checks and coding-review thread interpretation remain explicitly outside this slice.
