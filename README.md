# issue-graph

Find related issues and pull requests before you start work. For humans and agents.

<p>
  <a href="https://vercel.com/labs#active-experiments"><img alt="Vercel Labs Experiment" src="https://img.shields.io/badge/LABS-EXPERIMENT-0a0a0a.svg?style=for-the-badge&amp;logo=Vercel&amp;labelColor=000000" height="28"></a>
  <a href="https://www.npmjs.com/package/issue-graph"><img alt="npm version: issue-graph" src="https://img.shields.io/npm/v/issue-graph.svg?style=for-the-badge&amp;labelColor=000000" height="28"></a>
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg?style=for-the-badge&amp;labelColor=000000" height="28"></a>
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://issue-graph.dev/readme-hero-dark.png">
  <img alt="issue-graph: open issues and pull requests from vercel-labs/portless grouped into five root-cause clusters, such as proxy port allocation and TLS trust" src="https://issue-graph.dev/readme-hero-light.png">
</picture>

issue-graph reads GitHub issues and pull requests, or Linear issues, and follows the references between them: closing links, mentions, cross-references, and Linear relations. It shows existing fixes, competing PRs, and open follow-ups as one graph, groups open work into clusters, and opens the result in a local dashboard. It only reads from GitHub and Linear.

## Install

Install the CLI with [Node.js](https://nodejs.org) 20 or later:

```bash
npm install --global issue-graph@latest
```

To try it without installing, run `npx issue-graph@latest --help`. GitHub queries use your [GitHub CLI](https://cli.github.com) login, so run `gh auth login` first if `gh auth status` shows no account.

## Quick start

From a GitHub repository checkout:

```bash
issue-graph
# -> captures open issues and PRs, then opens the dashboard
```

Pass a repository, or one or more items, to choose the scope:

```bash
issue-graph open vercel-labs/portless
issue-graph graph vercel-labs/agent-browser#1113 --depth 1
```

For Linear, connect once in the browser, then capture an issue neighborhood or a whole project:

```bash
issue-graph linear login
issue-graph linear ENG-123 --workspace your-workspace --open
issue-graph linear --project <project-uuid> --open
```

The full walkthrough is in [Get started](https://issue-graph.dev/docs/get-started).

## How it works

Each run starts from seeds, such as open issues, a label, or specific items, and follows references up to a depth and node budget you set. An item with many references is fetched but not expanded further. The report lists missing references, failed reads, and crawl limits, so you can see what the graph does not cover.

The dashboard groups items into connected components by default. Your agent can propose root-cause clusters instead: `issue-graph cluster` prints the task, and `cluster --apply` loads the answer. The dashboard has four views: Explore, Impact, Swarm, and Rank. Rank orders open work by Heat, a weighted score of discussion activity with weights you control.

Runs save locally under `~/.issue-graph/`, and `issue-graph dashboard` shows every saved run with a project switcher. `issue-graph query` filters a saved capture from the CLI and returns a link to the exact dashboard view. See [Dashboard](https://issue-graph.dev/docs/dashboard).

## For AI agents

Install the agent skill from this repository:

```bash
npx skills@latest add vercel-labs/issue-graph
```

The skill tells the agent to load the guidance bundled with the installed CLI, so the instructions match its version:

```bash
issue-graph skills get core
```

Plan, query, reconcile, and status print JSON in a pipe, and `issue-graph schema` prints the command contract. See [Agents](https://issue-graph.dev/docs/agents).

## Commands

Run `issue-graph --help` for the full list, or `issue-graph <command> --help` for one command.

| Group | Commands | Docs |
| --- | --- | --- |
| Map work | `open`, `graph`, `linear` | [Graph](https://issue-graph.dev/docs/graph), [Linear](https://issue-graph.dev/docs/linear) |
| Prioritize | `rank`, `cluster`, `reconcile`, `plan` | [Backlog](https://issue-graph.dev/docs/backlog), [Agents](https://issue-graph.dev/docs/agents) |
| Dashboard | `dashboard`, `query`, `runs`, `config` | [Dashboard](https://issue-graph.dev/docs/dashboard) |
| Pull requests | `status` | [Status](https://issue-graph.dev/docs/status) |
| Setup | `auth`, `schema`, `skills` | [Reference](https://issue-graph.dev/docs/reference) |

## Library

Install the package as a dependency to use the graph core from your own code:

```bash
npm install issue-graph@latest
```

The core runs in any JavaScript runtime. Transports read GitHub through `gh`, or through `fetch` with a token. See [Library](https://issue-graph.dev/docs/library).

## Limits and privacy

Depth, node budgets, permissions, and API limits affect coverage. Check the linked code and current behavior before you close an issue or merge a PR.

Saved runs, HTML exports, and cluster prompts can contain private repository metadata, and anyone with an export can read the data embedded in it. See [Security](https://issue-graph.dev/docs/security) and [vulnerability reporting](SECURITY.md).

## Development

This repository is a pnpm workspace. The CLI and library are in `src/`, the dashboard is `apps/dashboard/`, and the docs site is `apps/docs/`. Use Node.js 20.19.x or 22.12 and later with pnpm:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm test:package
```

[Contributing](CONTRIBUTING.md) covers setup, the docs and dashboard dev servers, and the release process. [AGENTS.md](AGENTS.md) lists what to update with each change.

## Documentation

- [issue-graph.dev](https://issue-graph.dev/docs): get started, commands, dashboard, and Linear
- [Changelog](https://issue-graph.dev/docs/changelog)

## License

Apache-2.0
