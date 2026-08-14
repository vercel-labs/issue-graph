# Friction

- The CLI has no command-level schema and graph mode always prints Markdown. Reconciliation needs a stable machine contract without changing legacy output.
- Graph evidence can nominate completed or superseded candidates, but it cannot prove code or live behavior. Recommendations must require verification.
- Repositories without labels still need useful cleanup. Reconciliation should derive state from the live reference graph instead of requiring taxonomy.
- Organization-wide sweeps belong to the caller. xref should stay repository-scoped and deterministic.
- Dogfooding against `crafter-station/petdex` showed that a merged cross-reference is useful but weaker than a structural closing link, so it remains low-confidence verification evidence.
- Seeding an entire backlog can consume most of the node budget before relationships are expanded. The report must expose both seed-search and crawl-cap coverage.
- Dogfooding showed that generic `nextSteps` told an empty backlog to verify candidates and run PR review gates. Next steps must be derived from the report state.
- Free-form evidence forced agents to parse English to understand why an action was nominated. Evidence needs stable codes while preserving summaries and exact related nodes.
- The schema described reconcile as non-mutating while snapshots were written by default. GitHub mutations and local filesystem writes are separate contract dimensions.
- Reconcile snapshots inherit the changing open seed set, so repeated repository sweeps do not share history. Repository-keyed action deltas are the next slice after the report contract is stable.
- A live Petdex reconciliation needed roughly one node query per graph node and reached the node cap. Pagination and bounded concurrency remain a later scale slice so they do not blur the protocol change.
- Repository deltas cannot call an absent item resolved when the current crawl is incomplete, or call an observed item new when the previous crawl was incomplete. Coverage gates both claims.
