# issue-graph

<p>
  <a href="https://vercel.com/labs#active-experiments"><img alt="Vercel Labs Experiment" src="https://img.shields.io/badge/LABS-EXPERIMENT-0a0a0a.svg?style=for-the-badge&amp;logo=Vercel&amp;labelColor=000000" height="28"></a>
  <a href="https://www.npmjs.com/package/issue-graph"><img alt="npm version: issue-graph" src="https://img.shields.io/npm/v/issue-graph.svg?style=for-the-badge&amp;labelColor=000000" height="28"></a>
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg?style=for-the-badge&amp;labelColor=000000" height="28"></a>
</p>

Find related GitHub issues, competing pull requests, and unresolved follow-ups before you start work.

`issue-graph` follows text mentions and GitHub's structural links across repositories. Use it to inspect one issue's neighborhood, count open PRs by author and project, or turn a backlog into a verification queue. Crawling, graph classification, and ranking need no model. Semantic `classify` inference can incur charges; preview it first with `--dry-run`. Root-cause clustering is an optional agent step.

## Start here

[`issue-graph`](https://www.npmjs.com/package/issue-graph) is published on npm with a CLI and library. Use [Node.js](https://nodejs.org) 20 or later with npm/npx. GitHub queries also need an authenticated [GitHub CLI](https://cli.github.com). No source checkout is required.

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

Inspect an issue in your repository without saving a snapshot:

```bash
issue-graph 123 --repo owner/repo --depth 1 --max-nodes 12 --no-snapshot
```

To use npx instead, replace `issue-graph` with `npx issue-graph@latest`. Check failed fetches, node caps and unexpanded hubs before drawing conclusions. A closed seed or merged fix does not prove related follow-ups are resolved.

### Update an npm installation

After reviewing the release you want to use:

```bash
npm install --global issue-graph@latest
```

`@latest` selects the latest published release. A newer source checkout may contain unreleased features; check the installed command's help rather than assuming source capabilities are published.

## Choose a workflow

| Need | Installed command |
| --- | --- |
| Inspect an issue or PR before starting work | `issue-graph 123 --repo owner/repo --depth 1 --max-nodes 12 --no-snapshot` |
| Survey labeled open issues | `issue-graph --label bug --repo owner/repo --prioritize` |
| Count open PRs by author | `issue-graph status --repo owner/repo --author login,other` |
| See PR evidence, assignees, and requested reviewers | `issue-graph status --repo owner/repo --author login --view prs` |
| Reconcile an open backlog, with or without labels | `issue-graph reconcile --repo owner/repo --format json --no-snapshot` |
| Select the next backlog action | `issue-graph plan --repo owner/repo --format json` |
| Inspect the machine contract | `issue-graph schema` |

Graph mode prints Markdown, even when piped; `--json PATH` writes a graph file. Reconcile and plan default to Markdown in a terminal and versioned JSON in a pipe. Status defaults to a terminal table or JSON in a pipe; its `--json` is a boolean stdout flag, not a filename.

## Semantic suggestions

`classify` suggests request types, components and reported signals for open issues in one public repository. Every suggestion requires human review; probabilities are uncalibrated, reported impact is not verified severity, and errors are not categories. It never changes GitHub.

Preview evidence, taxonomy and cache eligibility before authorizing inference. Preview queries GitHub but makes no Gateway calls, reads no Gateway key and writes nothing:

```bash
issue-graph classify --repo owner/repo --dry-run --limit 1 --max-calls 1 --format json
```

After review, explicitly allow a small number of new calls, or reuse results without new inference:

```bash
issue-graph classify --repo owner/repo --limit 1 --max-calls 1 --format json
issue-graph classify --repo owner/repo --limit 1 --max-calls 0 --format json
issue-graph classify --repo owner/repo --limit 1 --cached --format json
```

- New inference needs environment `AI_GATEWAY_API_KEY`. Never put keys in commands or chat. `--max-calls` caps HTTP attempts, not spending; configure an account spending limit. Unknown costs are not zero, and historical cache costs are separate from current spending.
- Routing is fixed: `https://ai-gateway.vercel.sh/v1/evaluate`, model `typesafe-ai/jev`, `providerOptions.gateway.only: ["typesafe-ai"]`. There is no provider/model fallback. Requests are capped at 24,000 UTF-8 bytes, with a 30-second deadline and 256 KiB response cap; oversized evidence is not truncated.
- `--max-calls 0` still queries GitHub and can save eligible public evidence. `--cached` uses the same saved repository and limit without network, keys or writes. It is not live verification and exits 1 even when all saved answers hit. Missing evidence fails without network fallback.
- Response reuse expires 24 hours after evaluation and rechecks input identity, receipts, locks and current policy. `--refresh` requests fresh evidence/evaluation but cannot bypass locks or unsafe storage. Do not blindly retry unknown outcomes or delete locks.
- Active inference sends titles, bodies and comments to Gateway. Local evidence snapshots also contain public text; reports, receipts and response cache exclude raw bodies/comments. Review provider policy and local retention. `ISSUE_GRAPH_HOME` defaults to `~/.issue-graph`, with owned `0700` directories and regular single-link `0600` files, no symlinks. Permissions are not encryption.
- `--no-snapshot` disables evidence/cache/receipt storage and durable locks, not the `classify/STOP` check. It has no crash recovery and is not a safe bypass for unknown requests. STOP blocks new calls, not valid hits or in-flight completion.

For component suggestions, adapt the fictional [taxonomy example](skill-data/core/examples/taxonomy.json) and pass the same `--taxonomy PATH` to preview and inference. It uses `schemaVersion: 1` and catalog version `"1"`; it is not a maintainer-approved catalog. Without it, components are unavailable rather than invented.

Output is Markdown in a terminal and schemaVersion 1 JSON in pipes; `--json` is boolean. Exit 0 means complete live scope, including valid abstentions or zero-call reuse; 1 means partial coverage, failure, deferred work or saved-only `--cached`; 2 means invalid usage/configuration. No exit code authorizes acceptance or GitHub changes.

See [Semantic suggestions](skill-data/core/references/workflows.md#semantic-suggestions) for taxonomy limits, scheduling, review policy, cache provenance and storage behavior. Agents can retrieve it with `issue-graph skills get core --full`.

## Explore and compare

Export a graph and a self-contained HTML explorer:

```bash
issue-graph 123 --repo owner/repo --depth 1 --max-nodes 12 --no-snapshot --json graph.json --html graph.html
```

Open `graph.html` in a browser. It includes typed relationships, node evidence, a cleanup checklist, and an Impact view projecting relationships visible in this graph. No server is needed. Impact is not proof of causality.

Graph and reconcile runs save local history under `~/.issue-graph/` by default. Re-running the same graph seeds shows a snapshot diff; reconciliation tracks repository-level action changes. `--no-snapshot` skips saving history but does not prevent explicitly requested JSON or HTML exports. Plan writes no snapshots.

Status history is opt-in:

```bash
issue-graph status --repo owner/repo --author login,other --save
issue-graph status --repo owner/repo --author login,other --since last --save
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

For source development, use a local checkout. Use Node.js 20.19.x or 22.12+ (24 recommended), pnpm, and authenticated GitHub CLI access. For initial setup, follow [Contributing](CONTRIBUTING.md#setup).

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
