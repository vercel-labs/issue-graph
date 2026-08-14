# xref North

## Promise

xref gives maintainers and coding agents a deterministic, evidence-backed view of the work connected to a GitHub issue, pull request, or repository backlog.

## Direction

Build xref as an agent protocol first and a continuous maintenance radar second.

The protocol must expose stable actions, structured reasons, explicit coverage limits, honest side effects, and contextual next steps. The radar should later show what changed between repository-level reconciliations without requiring a separate dashboard.

## Principles

- Derive facts from live GitHub structure and content, not model guesses.
- Keep graph evidence separate from behavioral proof.
- Make incomplete coverage impossible to mistake for an empty or reconciled backlog.
- Keep GitHub read-only unless a separate maintainer workflow receives explicit authority.
- Prefer stable machine contracts that remain legible to humans.
- Add one independently useful vertical slice at a time.

## Boundaries

- xref does not comment, label, close, approve, merge, or otherwise mutate GitHub.
- xref does not decide product direction or replace human maintainer judgment.
- xref does not claim a merged relationship proves correctness.
- Organization-wide orchestration belongs to the caller.
- A visual cockpit is optional and follows a trustworthy protocol, not the other way around.

## Current sequence

1. Agent protocol: structured evidence and contextual next steps.
2. Continuous radar: repository-keyed history and action deltas.
3. Scale: pagination, batching, and bounded concurrency.
4. Optional cockpit over the same contract.
