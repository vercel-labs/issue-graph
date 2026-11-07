# AGENTS.md

## Writing

Use the `technical-writer` skill (`.agents/skills/technical-writer/SKILL.md`) when you write or edit prose for this repo, including docs pages, READMEs, changelog entries, commit messages, PR descriptions, and issues.

## Documentation

When a change affects what users or agents can do, update these in the same change:

1. `apps/docs/content/docs/`: the docs site pages, which hold the full details
2. `README.md`: only when install, the quick start, or the commands table changes. The README links to the docs site instead of repeating it
3. `skill-data/core/SKILL.md` and `skill-data/core/references/workflows.md`: the guidance bundled with the CLI. See [Skill maintenance](CONTRIBUTING.md#skill-maintenance)
4. Command `--help` text and `issue-graph schema` when flags, outputs, or limits change

## Checks

Run `pnpm check` before you push. For docs changes, also run `pnpm check:docs` and `pnpm build:docs`. For packaging changes, run `pnpm test:package`. [Contributing](CONTRIBUTING.md) has the full list and the release process.
