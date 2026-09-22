---
name: issue-graph
description: Read-only GitHub PR status and reference graphs for maintainers and agents. Use whenever the user asks for PR counts or status by author, project, repository, or review state; approved, changes-requested, conflicting, draft, ready-for-review, or unassigned PRs; a compact portfolio table; or counts for named contributors, even without naming issue-graph. Spanish triggers include cuantas PRs, conteo por autor, tabla por proyecto, pendientes de revision, conflictos, and sin asignar. Also use before working an issue or PR, tracing references, finding duplicate or superseded work, reconciling an unlabeled backlog, prioritizing issues, and checking changes since a snapshot. Route counts to issue-graph status, references to graph, and backlog actions to reconcile or plan. Never infer code correctness or merge readiness from counts.
---

# issue-graph

Before running operational commands, load and read the guidance bundled with the CLI:

```bash
issue-graph skills get core
```

Follow the returned core guidance. When detailed workflows or references are needed,
load and read them through the CLI:

```bash
issue-graph skills get core --full
```

Discover available guidance with `issue-graph skills list`. Inspect command syntax
with `issue-graph skills --help`, `issue-graph skills list --help`, or
`issue-graph skills get --help`.

If the executable, skills command, core, or referenced assets are unavailable, stop
and report the CLI/skill mismatch and the observed error. Do not fabricate operational
guidance, fall back to remembered instructions, or automatically install or upgrade
anything. Ask for an explicitly authorized setup correction before proceeding.
