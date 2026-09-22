# issue-graph

<p>
  <a href="https://vercel.com/labs#active-experiments"><img alt="Vercel Labs Experiment" src="https://img.shields.io/badge/LABS-EXPERIMENT-0a0a0a.svg?style=for-the-badge&amp;logo=Vercel&amp;labelColor=000000" height="28"></a>
  <a href="https://www.npmjs.com/package/issue-graph"><img alt="npm version: issue-graph" src="https://img.shields.io/npm/v/issue-graph.svg?style=for-the-badge&amp;labelColor=000000" height="28"></a>
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg?style=for-the-badge&amp;labelColor=000000" height="28"></a>
</p>

Find related GitHub issues, competing pull requests, and unresolved follow-ups before you start work.

`issue-graph` follows text mentions and GitHub's structural links across repositories. Use it to inspect one issue's neighborhood, count open PRs by author and project, or turn a backlog into a verification queue. Crawling, graph classification, and ranking need no model. Semantic `classify` inference can incur charges; preview it first with `--dry-run`. Root-cause clustering is an optional agent step.

![Bounded agent-browser graph: closed issue 1113, merged fix PR 1137, closed regression 1148, and open follow-ups 1371 and 1607.](apps/docs/public/issue-graph-demo.svg)

Public reference data captured on 2026-09-22, not a live feed or complete history. All five fetched nodes are in `vercel-labs/agent-browser`; 19 references remain beyond the depth boundary and 22 edges to unfetched references are omitted from the displayed graph. Re-run the bounded command below to inspect current evidence, which may differ from the capture.

## Start here

[`issue-graph`](https://www.npmjs.com/package/issue-graph) is published on npm with a CLI and library. Use [Node.js](https://nodejs.org) 20 or later with npm/npx. GitHub queries also need an authenticated [GitHub CLI](https://cli.github.com). No source checkout is required; the source repository remains **INTERNAL**, and installing the public package does not grant repository access.

Try the CLI without a global installation:

```bash
npx issue-graph@latest --help
```

For the installed command used below:

```bash
npm install --global issue-graph@latest
issue-graph --help
gh auth login
gh auth status
```

Run a bounded graph around public [agent-browser issue #1113](https://github.com/vercel-labs/agent-browser/issues/1113) without saving a snapshot:

```bash
issue-graph 1113 --repo vercel-labs/agent-browser --depth 1 --max-nodes 12 --no-snapshot
```

To use npx instead, replace `issue-graph` with `npx issue-graph@latest`. At the 2026-09-22 capture, issue #1113 was closed, [PR #1137](https://github.com/vercel-labs/agent-browser/pull/1137) was merged, [regression #1148](https://github.com/vercel-labs/agent-browser/issues/1148) was closed, and follow-ups [#1371](https://github.com/vercel-labs/agent-browser/issues/1371) and [#1607](https://github.com/vercel-labs/agent-browser/issues/1607) were open. A merged fix and closed seed do not establish that related follow-ups are resolved.

Read the nodes, typed references, and cleanup candidates, then check for failed fetches, node caps, and unexpanded hubs before drawing conclusions. States were read during a capture window, not atomically. New runs query current GitHub evidence, not a fixed demo output.

### Update an npm installation

After reviewing the release you want to use:

```bash
npm install --global issue-graph@latest
```

`@latest` selects the latest published release. A newer source checkout may contain unreleased features; check the installed command's help rather than assuming source capabilities are published.

## Choose a workflow

| Need | Installed command |
| --- | --- |
| Inspect an issue or PR before starting work | `issue-graph 1113 --repo vercel-labs/agent-browser --depth 1 --max-nodes 12 --no-snapshot` |
| Survey labeled open issues | `issue-graph --label bug --repo owner/repo --prioritize` |
| Count open PRs by author | `issue-graph status --repo vercel-labs/portless --author ctate,Railly` |
| See PR evidence, assignees, and requested reviewers | `issue-graph status --repo vercel-labs/portless --author ctate --view prs` |
| Reconcile an open backlog, with or without labels | `issue-graph reconcile --repo owner/repo --format json --no-snapshot` |
| Select the next backlog action | `issue-graph plan --repo owner/repo --format json` |
| Inspect the machine contract | `issue-graph schema` |

Graph mode prints Markdown, even when piped; `--json PATH` writes a graph file. Reconcile and plan default to Markdown in a terminal and versioned JSON in a pipe. Status defaults to a terminal table or JSON in a pipe; its `--json` is a boolean stdout flag, not a filename.

## Semantic suggestions (V3, source build only)

`classify` reuses validated evaluations by default. These capabilities require a source build and are not yet part of the published package. Without `--dry-run` or `--cached`, inference can incur charges on cache misses when the call budget is positive. Preview first:

```bash
issue-graph classify --repo vercel-labs/agent-browser --dry-run --limit 1 --max-calls 1 --format json
```

The preview captures GitHub evidence, prepares requests and may read cache entries, locks and receipts. It reads no Gateway key, makes zero Gateway calls and performs zero local writes. Inspect coverage, exclusions, taxonomy and item `cacheStatus`: `hit`, `miss`, `expired`, `refresh`, `blocked`, `invalid`, `disabled` or `not-checked`. The pure library builder `buildClassificationPreview` does not read storage and leaves cache status `not-checked`; the CLI uses `runSemanticPreview` for read-only cache inspection.

Only after review, explicitly choose a low-budget active run. New inference requires `AI_GATEWAY_API_KEY` supplied through the environment, never a key literal in a command or chat. Configure an account spending limit separately: `--max-calls` is an HTTP-attempt limit, not a monetary cap.

```bash
issue-graph classify --repo vercel-labs/agent-browser --limit 1 --max-calls 1 --format json
```

Then reuse available evaluations without allowing new inference:

```bash
issue-graph classify --repo vercel-labs/agent-browser --limit 1 --max-calls 0 --format json
```

`--max-calls 0` is LIVE, not offline: it still captures/revalidates GitHub evidence and can persist the first eligible public-evidence snapshot before any inference. An ordinary unchanged warm run deduplicates evidence and writes zero files, makes zero Gateway calls, reads no Gateway key, creates no new receipt and has current reported cost 0. A successful cold evaluation without retries makes one Gateway call per eligible issue. `--max-calls` accepts 0..500 (default 50) and counts all HTTP attempts, including retries across workers; previews bound planned new calls only. Zero reuses valid hits and defers misses, expired entries and explicit refresh. Complete live scope with no failed/deferred work can exit 0; small limits can leave coverage incomplete.

For an explicitly offline saved view of that same repository and limit:

```bash
issue-graph classify --repo vercel-labs/agent-browser --limit 1 --cached --format json
```

`--cached` makes no GitHub or Gateway calls, reads no key and writes nothing. It uses saved evidence with the supplied taxonomy and validated response cache, honoring the original 24h TTL, input hash, successful source receipts, pending/unknown locks and current policy. Missing/expired answers defer; missing evidence fails without network fallback. It forces zero calls and conflicts with `--dry-run`, `--refresh`, `--no-snapshot` and explicit positive `--max-calls`. This is saved evidence, NOT live verification: `evidenceSource` includes `mode: cached`, `capturedAt`, `ageMs` and `liveRevalidated: false`. All items require review; cached reports deliberately retain `coverageComplete: false` and exit 1, even if every saved answer hits.

Explicitly request fresh inference only when intended:

```bash
issue-graph classify --repo vercel-labs/agent-browser --limit 1 --max-calls 1 --refresh --format json
```

`--refresh` bypasses evidence-body reuse and ignores saved response bytes without deleting immutable history. It does not bypass pending/unknown locks or unsafe filesystem checks; `--refresh --max-calls 0` makes no Gateway calls but still captures live evidence. V3 remains review-only, never GitHub mutations, automatic fixes or acceptance. This requires a source build, not a package publication or version bump.

Only one explicitly public repository is accepted, even when `gh` can access private/internal repositories. OPEN issues use cursor pagination in stable creation order, 20 issues per batch, with default `--limit 50` (1..500). Each initial issue page includes the first 10 comments per issue; continuation pages request 100/100/90, at most four pages and 300 comments per issue. Metadata revalidation batches up to 20 issues. Coverage retains count changes, duplicate IDs, cursor/page drift, failures and caps; bounded capture windows are not atomic snapshots. Attachments, external URLs, PR targets and relationships are not fetched, and text is never silently truncated.

Body reuse requires live verification of PUBLIC visibility, issue identity/title/state/version and ALL captured comment identities, URLs, authors, order, versions and collection membership/coverage. Comment edits, additions and deletions invalidate reuse even when the parent's `updatedAt` is unchanged; affected evidence is fetched again or marked `needs-refresh`, never silently replaced with stale evidence after a read error. Pre-send/post-evaluation guards remain. Supplied mixed-case repository scope is preserved in the wire input; only storage scope/path lookup normalizes repository case. Canonical serialized comment property order remains `id,url,body,updatedAt,author`, preserving historic request hashes. Titles, bodies and comments are untrusted evidence, not instructions. Active inference sends prepared evidence to Gateway; reports, receipts and the response cache exclude raw bodies/comments, but the new evidence cache explicitly stores public issue/comment text.

Taxonomy is an explicit UTF-8 JSON file, never code or implicit cwd configuration:

```json
{
  "schemaVersion": 1,
  "repo": "owner/repo",
  "version": "1",
  "components": [
    { "id": "cli", "description": "Command parsing and terminal output.", "examples": ["An option is rejected."] }
  ]
}
```

This is a synthetic example, not a maintainer-approved taxonomy. Pass it with `--taxonomy taxonomy.json` in both preview and active runs. Files are limited to 64 KiB and 1..64 components with unique lowercase IDs, descriptions of 1..2000 characters, and up to five examples of 1..500 characters. `multiple`, `new`, `insufficient`, `constructor` and `prototype` are reserved. Unknown fields, wrong repositories and invalid local data fail before GitHub access. Without a taxonomy, the component question is omitted with `componentStatus: unavailable` / `taxonomy-missing`.

`inputBytes` measures the exact complete serialized HTTP request body in UTF-8, including questions and provider routing, capped at 24,000 bytes, not tokens. Oversized input is flagged, never silently truncated. In active runs it remains `needs-review`, increments both `totals.deferred` and `totals.oversized`, and causes CLI exit 1 without inference: this is not a legitimate model abstention. A complete dry-run may exit 0 while explicitly reporting oversized input. Requests go only to `https://ai-gateway.vercel.sh/v1/evaluate`, with model `typesafe-ai/jev` and `providerOptions.gateway.only: ["typesafe-ai"]`. The 30-second request deadline includes response reading; the response cap remains 256 KiB. There is no provider/model fallback. Item provenance `modelResolved` is the exact reported alias when present, otherwise null; it is not immutable weights pinning.

Scheduling is opt-in: `--concurrency 1..4` (default 1), `--max-retries 0..3` (default 0), `--min-interval-ms 0..60000` (default 0). Only an explicit HTTP 429 with a known failed outcome is retryable when enabled. A shared pause starts when error headers arrive, before diagnostic-body reading; numeric or HTTP-date `Retry-After` is honored with bounded exponential backoff. Hints requiring more than 30s defer instead of retrying early. Pacing/backoff waits occur outside each request's 30s timer, with STOP/abort checks during waiting and again before dispatch. Every retry consumes the shared `--max-calls` budget and gets its own pending/final receipt; earlier failures and unknown costs remain visible. Network errors, timeouts, aborts, invalid replies and pending/unknown outcomes are never automatically retried. Already in-flight requests retain their actual outcomes.

Bounded, redacted diagnostics expose only code/type, opaque request/routing IDs and `providerReported` identifiers, all untrusted. Arbitrary provider prose or `message` is omitted by the privacy-review fix; neither status 429 nor reported cost 0 proves its origin, account tier or quota. Real tier/quota remain UNKNOWN, not checked live. Optional per-item `attempts`, diagnostics and timing retain attempt-level failures separately from item outcomes. Optional root `performance.githubCalls` counts logical transport invocations, not necessarily underlying HTTP requests; `githubRequestMs` is aggregate transport I/O time, while `captureMs`, `evaluationMs` and `totalMs` are phase/run wall times. Per-attempt `headersMs`/`totalMs` are client timings, not pure model latency.

Answers are strictly validated against the requested question IDs, types and distributions. The rubric covers request type, optional component, reproduction steps, expected/actual behavior, reported regression and ordinal reported impact. `topProbability`, `margin` and nullable `providerConfidence` are uncalibrated diagnostics, not measured accuracy. `impactReported` is retained only for a `bug` request type, not as verified severity or priority. Policy exceptions, ties, inconsistent signals/distributions and incomplete comment evidence produce `needs-review`; even `suggested` items have `reviewRequired: true`. Errors are failures, not semantic categories.

### Component-oriented review

Markdown groups suggestions by the supplied component catalog, with separate exception/failure/deferred/unknown groups. Each item appears once; original outcomes and the JSON contract are preserved. Rows show reproduction, expected/observed and regression probabilities. These signals are not verified facts. Ties and selected-choice mismatches remain visible; complete distributions stay in JSON.

A **provisional and not human-approved** wterm example is bundled at [skill-data/core/examples/wterm-taxonomy.json](skill-data/core/examples/wterm-taxonomy.json). Review each component against the repository's current architecture before use. From this checkout:

```bash
bun --no-env-file run start classify --repo vercel-labs/wterm --taxonomy skill-data/core/examples/wterm-taxonomy.json --dry-run --limit 13 --max-calls 13 --json
```

Policy version 2 preserves raw distributions whose mass differs from one by at most 0.001. A bounded local compatibility exception permits two-decimal distributions whose clamped rounding intervals contain unit mass, with absolute sum error at most `min(0.005 * optionCount, 0.02)`. Such answers always produce `needs-review` and `<questionId>-distribution-rounded`; no normalization or automatic acceptance occurs. This is not a provider-guaranteed rounding contract. Malformed keys, out-of-range values, unsupported precision outside the original tolerance and larger mass errors still fail.

The cache epoch and request fingerprint do not change for this validation/policy update: no wire request or cached answer shape changed, and formerly accepted answers remain compatible. Existing pending/unknown receipts are not recovered or bypassed. Current policy is reapplied on every hit.

### Cache identity, provenance and cost

The alias cache TTL is 24 hours from the original evaluation, not the last read: valid just before expiry, expired at `now >= evaluatedAt + 24h`. Report `cacheEpoch` is the internal version string `"1"`; there is no CLI cache-epoch flag. Neither the TTL nor epoch pins immutable model weights.

Current `inputHash` uses `fingerprintEvaluation`: the whole wire request (including text, questions, model and routing), taxonomy, adapter version, cache epoch, rubric and projection versions. Issue/comment edits reflected in the captured input change identity; capture timestamps, page counters and policy version do not. Full comment-version/membership checks precede body reuse, but the last-checked window is not an atomic snapshot. The legacy `fingerprintInput` helper hashes the local projection and is not the cache identity. Reuse validates the stored response against the current request and recomputes the current review policy, not a saved decision.

Hits retain original `provenance.evaluatedAt`, model/usage/cost and `cacheSourceRequestId`, with `provenance.cacheHit: true`. `totals.evaluated` counts only fresh valid provider responses; `totals.cacheHits` counts reuse separately. `totals.reportedCostUsd` is the known current-attempt subtotal, with `hasUnknownCost` for unknown current charges. `cachedHistoricalCostUsd` and `hasUnknownHistoricalCost` describe reused evaluations separately. Missing usage/cost remains null: a warm current cost of 0 never means the original unknown-cost inference was free.

### Cache, receipts and stop control

Evidence snapshots, response cache and durable receipts share `ISSUE_GRAPH_HOME` (default `~/.issue-graph`). New evidence storage is separate: `classify/evidence/<scopeHash>/<uuid>.json` retains version-1 capture history and `current.json` is its atomic pointer. The scope hash uses normalized repo+limit, without lowercasing captured wire scope. These bounded 16 MiB snapshots explicitly contain public issue/comment bodies, capture time, savedAt and checksum, unlike the body-free response cache. Only complete captures or an explicitly issue-limit-capped cohort with every captured item/comment ready and complete can publish, before inference; that cohort still has incomplete repository coverage. Other incomplete/drifting/failed captures leave the previous snapshot untouched. Reads create nothing; unsafe permissions/corruption fail closed, without chmod or automatic recovery. Semantically unchanged evidence does not rewrite history/pointers or slide saved capture timestamps. No credentials/provider key are intentionally persisted, and private permissions are not encryption or a guarantee that public text is non-sensitive. All managed directories, **including that home itself**, must be owned directories with mode `0700`; managed files must be owned regular files with mode `0600`, no symlinks or multiple hard links. Existing incompatible directories are rejected, not silently chmodded. If a legacy home has incompatible permissions, choose a new dedicated private `ISSUE_GRAPH_HOME` rather than blindly changing permissions on shared/global directories.

Relative paths are `classify/cache/<inputHash>/<requestId>.json` for immutable response history and `classify/cache/<inputHash>/current.json` for the atomic pointer; receipts remain at `classify/receipts/YYYY-MM-DD/requestId/{pending,final}/receipt.json`, locks at `classify/locks/<inputHash>.json`. Cache stores validated minimal responses, provenance and a checksum, not bodies, comments, credentials, questions, criteria or score-level prose; levels are reconstructed from the current request. The checksum detects corruption; it does not authenticate the writer. No automatic cache garbage collection or retention policy is implied.

Hits require full validation, unexpired evaluation time, matching successful known-final source receipts and no other lock; live mode additionally verifies current public issue/comment metadata, while `--cached` is explicitly saved/not live. Pending receipts and locks precede fetch. Cache publishes under the owned lock **before** successful finalization releases it: pending, writer-in-progress and crashed/uncommitted results are not reusable. A second read under the owned lease catches a cold-miss race; unlike ordinary warm hits, this raced hit may create pending and `not-sent` final receipts without HTTP. Preview, ordinary warm reuse and owned-lease hits reread cache again after awaiting metadata verification, before crediting reuse. A later lock or corruption prevents use; expiry or disappearance follows the miss/budget path, deferring with zero budget. Reuse describes the last-checked state window, not an atomic global snapshot. Cache-write failure keeps pending/lock state, stops the batch and skips final release; finalization failure leaves uncommitted cache blocked. Unknown outcomes retain locks. There is no automatic orphan cleanup: inspect receipts and provider/account evidence, never blindly retry or delete locks, even after abort.

`--no-snapshot` disables evidence storage, response caching, all evidence/cache/receipt filesystem access and durable locks, using memory-only receipts with no crash recovery or cross-process exclusion. It is not a safe bypass for an unknown durable request. It still checks `ISSUE_GRAPH_HOME/classify/STOP` (default `~/.issue-graph/classify/STOP`). Creating STOP prevents new inference, including memory-only mode, but does not block validated cache hits or abort an already-in-flight request.

Output is Markdown in a terminal and schemaVersion 1 JSON in pipes; `--json` is a boolean alias. Kinds are `classification-preview`, `classification-report` and `classification-error`. Exit 0 means complete scope, including legitimate abstentions; 1 means partial coverage, provider/runtime failure or deferred call-budget work; 2 means invalid local usage/configuration. No exit code authorizes GitHub changes.

The 76-item low-comment fixture measures 11 capture calls and 15 with warm response-cache revalidation. These fixture counts are not live timing or general latency promises. Tests cover synthetic provider responses, cache safety, version checks, bounded scheduling and CLI/package behavior without paid inference. A successful functional run is not evidence of human accuracy or maintainer time savings. Semantic quality, Node 20/22 compatibility of this extension and release readiness require separate verification. See the [workflow reference](skill-data/core/references/workflows.md#semantic-suggestions-v3) for detailed operation.

## Explore and compare

Export a graph and a self-contained HTML explorer:

```bash
issue-graph 1113 --repo vercel-labs/agent-browser --depth 1 --max-nodes 12 --no-snapshot --json graph.json --html graph.html
```

Open `graph.html` in a browser. It includes typed relationships, node evidence, a cleanup checklist, and an Impact view projecting relationships visible in this graph. No server is needed. Impact is not proof of causality.

Graph and reconcile runs save local history under `~/.issue-graph/` by default. Re-running the same graph seeds shows a snapshot diff; reconciliation tracks repository-level action changes. `--no-snapshot` skips saving history but does not prevent explicitly requested JSON or HTML exports. Plan writes no snapshots.

Status history is opt-in:

```bash
issue-graph status --repo vercel-labs/portless --author ctate,Railly --save
issue-graph status --repo vercel-labs/portless --author ctate,Railly --since last --save
```

Status reports unknown counts as `?` or `null`, never a fabricated zero. Check coverage before using totals. Approval is not merge readiness: status does not inspect CI checks or coding-review threads, and a missing PR is not assumed merged.

## Agents and integrations

Install the CLI with `npm install --global issue-graph@latest`, then install the agent skill separately:

```bash
npx skills@latest add https://issue-graph.dev
```

The well-known download, `/skill.md`, and [repository skill](skills/issue-graph/SKILL.md) contain the same canonical discovery guidance. Choose the intended agent and project scope, and compare existing local changes before replacing a skill. Skill installation does not install the CLI or authenticate GitHub; public package and skill installation do not require source repository access.

Before operational commands, load and read the guidance bundled with the installed CLI:

```bash
issue-graph skills get core
issue-graph skills get core --full
```

The core provides operational guidance; `--full` adds detailed workflow references. Use `issue-graph skills list` for discovery and command-specific `--help` for syntax. If the executable or guidance is unavailable, stop and report the mismatch rather than inventing instructions or automatically installing/upgrading anything. Ask for an authorized setup correction. See [Agents](apps/docs/content/docs/agents.mdx) for setup and evidence-handling details.

Use `--cluster` to print a root-cause clustering task for the calling agent. `--cluster-run claude` or `--cluster-run codex` sends it to an installed headless agent. Review the payload and the agent's permissions and data policy before using private repository evidence; the CLI does not sandbox that process.

Install the published library with `npm install issue-graph@latest`. It separates the runtime-agnostic core (`issue-graph`) from shell (`issue-graph/transport/shell`, using `gh`) and HTTP (`issue-graph/transport/http`, using `fetch` plus a token) transports. See [Library](apps/docs/content/docs/library.mdx) for ESM imports and server-side credential handling.

## Documentation

Read the documentation at [issue-graph.dev/docs](https://issue-graph.dev/docs), or browse its source in this checkout:

- [Get started](apps/docs/content/docs/get-started.mdx): installation, authentication, and a first result
- [Graph](apps/docs/content/docs/graph.mdx): depth, caps, snapshots, and HTML
- [Status](apps/docs/content/docs/status.mdx): counts, coverage, and history
- [Backlog](apps/docs/content/docs/backlog.mdx): reconcile and plan
- [Agents](apps/docs/content/docs/agents.mdx): skill setup and optional clustering
- [Library](apps/docs/content/docs/library.mdx): core, shell, and HTTP integrations
- [Security](apps/docs/content/docs/security.mdx): permissions and private data
- [Reference](apps/docs/content/docs/reference.mdx): commands and output contracts

## Limits and privacy

The CLI is read-only **on GitHub**, not side-effect-free locally. Graphs are bounded by depth, node caps, hubs, permissions, and per-node API limits. Shared files or closing targets are candidates for review, not guarantees of duplicate accuracy, correctness, or scope parity. Verify current code and behavior before closing or merging anything.

Snapshots, exports, logs, and cluster prompts can contain private repository metadata. A self-contained HTML file is portable, not automatically safe to publish. Review content and storage permissions before sharing. See [security guidance](apps/docs/content/docs/security.mdx) and [vulnerability reporting](SECURITY.md).

## Source development

Source development is optional and requires access to the **INTERNAL** `vercel-labs/issue-graph` repository. Use Node.js 20.19.x or 22.12+ (24 recommended), pnpm, and authenticated GitHub CLI access. For initial setup, follow [Contributing](CONTRIBUTING.md#setup).

From an authorized checkout, after preserving local changes, update a source installation with:

```bash
git pull --ff-only
pnpm install --frozen-lockfile
pnpm build
pnpm link --global
```

Contributor checks:

```bash
pnpm check
pnpm test:package
```

`pnpm build` emits the Node CLI and library in `dist`. By default, package verification builds and exercises a packed local installation; supplied-tarball mode tests an existing archive without rebuilding. Neither is evidence of registry publication. See [Contributing](CONTRIBUTING.md#release-process) for the retained-artifact release process. To compare transports against live GitHub data, use `pnpm exec tsx scripts/verify-transports.ts <number> <owner/repo> <depth>` with appropriate access.

### Local website development

From the repository root, start the docs website on a fixed local port:

```bash
pnpm dev:docs --hostname 127.0.0.1 --port 3399
```

Validate the production build separately. The HTTP suite checks production cache behavior, which differs from the development server:

```bash
pnpm check:docs
pnpm build:docs
pnpm --filter @issue-graph/docs test:ci
```

The last command starts and stops its own test server. For a manual browser session or audit, stop the development server and run `pnpm --filter @issue-graph/docs start --hostname 127.0.0.1 --port 3399`. In another terminal:

```bash
DOCS_TEST_URL=http://127.0.0.1:3399 pnpm test:docs:routes
DOCS_TEST_URL=http://127.0.0.1:3399 pnpm audit:docs
```

The agent-readability audit may follow production canonical URLs even when started against localhost. Before deployment, those requests can fail or inspect a different deployment; a local audit is not necessarily local-only. [is-agentic.com](https://is-agentic.com) requires a publicly reachable URL, not localhost. Audit scores are diagnostic signals, not certification of agent compatibility, accessibility, security, or production readiness.

## License

Apache-2.0
