# issue-graph

<p>
  <a href="https://vercel.com/labs#active-experiments"><img alt="Vercel Labs Experiment" src="https://img.shields.io/badge/LABS-EXPERIMENT-0a0a0a.svg?style=for-the-badge&amp;logo=Vercel&amp;labelColor=000000" height="28"></a>
  <a href="https://www.npmjs.com/package/issue-graph"><img alt="npm version: issue-graph" src="https://img.shields.io/npm/v/issue-graph.svg?style=for-the-badge&amp;labelColor=000000" height="28"></a>
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg?style=for-the-badge&amp;labelColor=000000" height="28"></a>
</p>

Find related issues, competing changes, and unresolved follow-ups before you start work.

`issue-graph` traces linked GitHub issues and pull requests, and can trace Jira work-item relationships through the customer-facing Atlassian Teamwork Graph CLI. Use it to find existing fixes, check PR status by author, and choose what to review next.

![issue-graph demo: related fixes and follow-ups, superseded PRs to review, and a per-author PR status ledger](https://issue-graph.dev/issue-graph-workflows.gif)

Illustrated workflows: Graph → Reconcile → PR status. [Static version](https://issue-graph.dev/issue-graph-workflows.png) · [Explore the workflows](https://issue-graph.dev/docs).

## Start here

Install the [npm package](https://www.npmjs.com/package/issue-graph) with [Node.js](https://nodejs.org) 20 or later. GitHub queries use your [GitHub CLI](https://cli.github.com) login. The optional Jira command uses an existing authenticated customer `twg` installation.

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

Trace public [agent-browser issue #1113](https://github.com/vercel-labs/agent-browser/issues/1113) without saving a snapshot:

```bash
issue-graph 1113 --repo vercel-labs/agent-browser --depth 1 --max-nodes 12 --no-snapshot
```

To use npx instead, replace `issue-graph` with `npx issue-graph@latest`. At the 2026-09-22 capture, issue #1113 was closed, [PR #1137](https://github.com/vercel-labs/agent-browser/pull/1137) was merged, [regression #1148](https://github.com/vercel-labs/agent-browser/issues/1148) was closed, and follow-ups [#1371](https://github.com/vercel-labs/agent-browser/issues/1371) and [#1607](https://github.com/vercel-labs/agent-browser/issues/1607) were open. Check the open follow-ups before assuming the fix covers them.

Check missing references and crawl limits in the report. Each run queries GitHub, so results can change. [Capture details](https://issue-graph.dev/docs/graph).

### Update an npm installation

```bash
npm install --global issue-graph@latest
```

Use `issue-graph --help` to check the commands supported by your installed release.

## Choose a workflow

| Need | Installed command |
| --- | --- |
| Inspect an issue or PR before starting work | `issue-graph 1113 --repo vercel-labs/agent-browser --depth 1 --max-nodes 12 --no-snapshot` |
| Trace related Jira work through TWG | `issue-graph jira PROJ-123 --site example --depth 1` |
| Survey labeled open issues | `issue-graph --label bug --repo owner/repo --prioritize` |
| Count open PRs by author | `issue-graph status --repo vercel-labs/portless --author ctate,Railly` |
| See PR evidence, assignees, and requested reviewers | `issue-graph status --repo vercel-labs/portless --author ctate --view prs` |
| Reconcile an open backlog, with or without labels | `issue-graph reconcile --repo owner/repo --format json --no-snapshot` |
| Select the next backlog action | `issue-graph plan --repo owner/repo --format json` |
| Inspect the machine contract | `issue-graph schema` |

Graph and plan default to compact human output in a terminal. Graph still prints Markdown in a pipe; plan prints versioned JSON. Use `--format text` for the human view outside a terminal, or `--format markdown` for Markdown. Plan also supports `--format json`. Human output wraps at up to 100 columns; monochrome bold/dim styling requires a TTY and is disabled by `NO_COLOR`, `CI`, or `TERM=dumb`.

Graph `--json PATH` writes a graph file; its legacy `--format json` still prints Markdown, not JSON. Reconcile keeps terminal Markdown and piped JSON defaults and does not support `--format text`. Status defaults to a terminal table or JSON in a pipe; its `--json` flag takes no filename.

## Explore and compare

Export a graph and a self-contained HTML explorer:

```bash
issue-graph 1113 --repo vercel-labs/agent-browser --depth 1 --max-nodes 12 --no-snapshot --json graph.json --html graph.html
```

Open `graph.html` directly in a browser to explore relationships, filter nodes, and review cleanup candidates.

Graph and reconcile runs save local history under `~/.issue-graph/` by default. Re-running the same graph seeds shows a snapshot diff; reconciliation tracks repository-level action changes. `--no-snapshot` skips saving history but does not prevent explicitly requested JSON or HTML exports. Plan writes no snapshots.

Status history is opt-in:

```bash
issue-graph status --repo vercel-labs/portless --author ctate,Railly --save
issue-graph status --repo vercel-labs/portless --author ctate,Railly --since last --save
```

Status reports unknown counts as `?` or `null`. Check coverage before using totals, and review CI and unresolved review threads separately before merging.

## Agents and integrations

Install the CLI with `npm install --global issue-graph@latest`, then install the agent skill separately:

```bash
npx skills@latest add vercel-labs/issue-graph
```

Choose your agent and project scope, preserving any local skill changes. If you cannot access the repository, use `npx skills@latest add https://issue-graph.dev`. The public site, `/skill.md`, and [repository skill](skills/issue-graph/SKILL.md) serve the same canonical skill. CLI installation and source authentication are separate setup steps: GitHub workflows use `gh`, while Jira workflows use an existing customer `twg` session.

Before operational commands, load and read the guidance bundled with the installed CLI:

```bash
issue-graph skills get core
issue-graph skills get core --full
```

Use `--full` for workflow references, `issue-graph skills list` for available guides, and command-specific `--help` for syntax. If the CLI or guidance is missing, report the error and ask for an authorized setup correction. See [Agents](apps/docs/content/docs/agents.mdx) for setup.

Use `--cluster` to print a root-cause clustering task for the calling agent. `--cluster-run claude` or `--cluster-run codex` sends it to an installed headless agent. Review the payload and the agent's permissions and data policy before using private repository evidence; the CLI does not sandbox that process.

Install the published library with `npm install issue-graph@latest`. It separates the runtime-agnostic core (`issue-graph`) from GitHub shell (`issue-graph/transport/shell`), GitHub HTTP (`issue-graph/transport/http`), and Jira shell (`issue-graph/transport/twg`) transports. The additive `crawlGraph` API accepts collector-defined node keys and fetchers; GitHub-specific analysis still uses `GraphNode`. See [Library](apps/docs/content/docs/library.mdx) for ESM imports, custom collectors, and credential boundaries.

## Documentation

Read the documentation at [issue-graph.dev/docs](https://issue-graph.dev/docs), or browse its source in this checkout:

- [Get started](apps/docs/content/docs/get-started.mdx): installation, authentication, and a first result
- [Graph](apps/docs/content/docs/graph.mdx): depth, caps, snapshots, and HTML
- [Jira through TWG](apps/docs/content/docs/jira.mdx): authentication boundary, sites, crawl limits, and coverage
- [Status](apps/docs/content/docs/status.mdx): counts, coverage, and history
- [Backlog](apps/docs/content/docs/backlog.mdx): reconcile and plan
- [Agents](apps/docs/content/docs/agents.mdx): skill setup and optional clustering
- [Library](apps/docs/content/docs/library.mdx): core, shell, and HTTP integrations
- [Security](apps/docs/content/docs/security.mdx): permissions and private data
- [Reference](apps/docs/content/docs/reference.mdx): commands and output contracts
- [Changelog](https://issue-graph.dev/docs/changelog): release notes

## Limits and privacy

The CLI reads GitHub data and, for the Jira command, Jira data through TWG. GitHub modes can save local snapshots or exports; Jira writes only to stdout/stderr. Depth, node caps, hubs, permissions, and per-node API limits affect coverage. Inspect linked code and current behavior before changing work items or merging a PR.

Snapshots, exports, logs, and cluster prompts can contain private repository metadata. Anyone with an HTML export can read its embedded data. Review content and storage permissions before sharing. See [security guidance](apps/docs/content/docs/security.mdx) and [vulnerability reporting](SECURITY.md).

## Source development

Source development uses the public `vercel-labs/issue-graph` repository. Use Node.js 20.19.x or 22.12+ (24 recommended), pnpm, and authenticated GitHub CLI access. For initial setup, follow [Contributing](CONTRIBUTING.md#setup).

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

`pnpm build` emits the Node CLI and library in `dist`. Package verification tests a packed local installation, or an existing archive in supplied-tarball mode. See [Contributing](CONTRIBUTING.md#release-process) for the retained-artifact release process. To compare transports against live GitHub data, use `pnpm exec tsx scripts/verify-transports.ts <number> <owner/repo> <depth>` with appropriate access.

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

The agent-readability audit may follow production canonical URLs from a localhost start URL. Check its destinations when comparing local changes. [is-agentic.com](https://is-agentic.com) requires a publicly reachable URL.

## License

Apache-2.0
