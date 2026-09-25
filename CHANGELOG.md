# Changelog

<!-- release:start -->
## 0.3.2

### Improvements

- Monochrome Graph, PR status, and Backlog plan terminal views with bold/dim hierarchy, grouped states, and clearer next actions.
- Compact status tables, readable UTC capture times, and width-aware wrapping that preserves identifiers, counts, uncertainty, and follow-up details.
- Explicit `--format text` for Graph and Plan. Existing JSON/Markdown contracts remain unchanged, including piped defaults and Graph `--json PATH` exports.
- Plain output in pipes and when `NO_COLOR`, `CI`, or `TERM=dumb` disables terminal styling.
- Narrower docs examples with the same human-output hierarchy and natural title wrapping.
- Additive source-neutral `crawlGraph` library API for bounded traversal of collector-defined node keys while preserving the existing GitHub crawler.
- Read-only `issue-graph jira ISSUE-KEY` workflow through the customer-facing TWG CLI, with explicit site selection, confidence-aware cross-project traversal, versioned JSON coverage, and a packaged `issue-graph/transport/twg` adapter.
- Preserve minimum-depth BFS admission when source policies jump depths, and escape untrusted Jira Markdown text while normalizing HTTP(S) link destinations.

<!-- release:end -->

## 0.3.1

### Improvements

- Shorter, English-only agent skill descriptions and consistent core catalog metadata.
- Static Graph, PR status, and Backlog demos with minimal command highlighting.
- Updated README screenshot, product-first metadata, and Vercel icons.
- Release notes available in the docs and GitHub Releases.
