# AGENTS.md

Use pnpm for repository commands and Biome for JavaScript, TypeScript, and JSON. Keep changes focused and preserve unrelated local work. Do not add coauthor trailers or comments that restate the code. Avoid emojis and decorative dashes in prose, and do not hard-wrap Markdown.

## Writing

Use the `technical-writer` skill (`.agents/skills/technical-writer/SKILL.md`) when you write or edit prose for this repo, including docs pages, READMEs, changelog entries, commit messages, PR descriptions, and issues.

## Documentation

When a change affects what users or agents can do, update these in the same change:

1. `apps/docs/content/docs/`: the docs site pages, which hold the full details
2. `README.md`: only when install, the quick start, or the commands table changes. The README links to the docs site instead of repeating it
3. `skill-data/core/SKILL.md` and `skill-data/core/references/workflows.md`: the guidance bundled with the CLI. See [Skill maintenance](CONTRIBUTING.md#skill-maintenance)
4. Command `--help` text and `issue-graph schema` when flags, outputs, or limits change

Do not edit generated files. The docs changelog comes from the root `CHANGELOG.md` through `pnpm --filter @issue-graph/docs sync:changelog`. `next dev` writes `apps/docs/AGENTS.md` and `apps/docs/CLAUDE.md`; they are committed so the tree stays clean.

## Checks

Run `pnpm check` before you push. For docs changes, also run `pnpm check:docs` and `pnpm build:docs`, and run `pnpm audit:docs` against a local production build when page structure changes. For packaging changes, run `pnpm test:package`. [Contributing](CONTRIBUTING.md) has the full list.

## Releases

A release is a pull request that changes the `package.json` version and the matching notes in `CHANGELOG.md`; merging it to `main` starts `release.yml`. Never retry an ambiguous publication by publishing again. If npm accepted the package but verification or the GitHub Release failed, rerun the failed jobs of the original run, as described in [Contributing](CONTRIBUTING.md#manual-verification-and-recovery).
