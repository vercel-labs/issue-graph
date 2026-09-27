# Contributing

Issues and focused pull requests are welcome.

Contributions use Apache-2.0 unless stated otherwise.

## Setup

To use the published CLI, run `npx issue-graph@latest --help` or `npm install --global issue-graph@latest`. For library use, run `npm install issue-graph@latest`. The package requires Node.js 20+. These docs track `main`; check installed help for available commands.

Use pnpm and Node.js 20.19.x or 22.12+ for source development; Node.js 24 is recommended. The compiled CLI still targets Node.js 20 or later. Authenticate the GitHub CLI for live API checks.

```bash
gh auth login
gh repo clone vercel-labs/issue-graph
cd issue-graph
pnpm install --frozen-lockfile
```

## Verify changes

```bash
pnpm check
```

For packaging changes, also run `pnpm test:package`. To test an existing archive without packing, building, or deleting the supplied file, set `EXPECTED_VERSION` to its reviewed source manifest version (the approved version for a release):

```bash
pnpm test:package --tarball "/absolute/path/issue-graph-${EXPECTED_VERSION}.tgz" --sha256 <sha256>
```

Both options are required for an existing archive. Verification checks identity, hashes, installed commands, exports, offline installation, and owned GitHub fixtures. Default mode packs once through `prepack`; supplied mode uses the archive without rebuilding.

Add or update tests for behavior changes. Keep filesystem and subprocess dependencies out of the runtime-agnostic core entry point.

For transport changes, compare both implementations against a live public repository:

```bash
pnpm exec tsx scripts/verify-transports.ts <number> <owner/repo> <depth>
```

## Skill maintenance

Maintain these skill files:

- `skills/issue-graph/SKILL.md` discovers the bundled guide. Keep its name and routing description, stay within 45 lines, and leave version and setup details in the docs. Load `skills get core` before commands, `--full` for references, and `skills list` for discovery. Report missing assets as a CLI/skill mismatch.
- `skill-data/core/SKILL.md` holds release-matched operational guidance, roughly 80 to 120 lines. Preserve routing, scope, counts, coverage, storage, exact dashboard links, and safety rules.
- `skill-data/core/references/workflows.md` holds detailed workflows and limits. Retrieve it through `issue-graph skills get core --full`.

When behavior changes, update the core and relevant reference together with the CLI. Keep setup/release availability in README and docs, not in the stub.

The package and `/skill.md` route use the canonical discovery stub. Run `pnpm --filter @issue-graph/docs sync:skill` after editing it to regenerate the checked-in well-known index and skill download. Docs development and build also run this generator; parity tests reject drift. Do not edit the generated public copies directly.

Preserve the discovery contract: `skills [list] [--json]`, `skills get core [--full] [--json]`, and `--help` under `skills`, `skills list`, and `skills get`. Default output is plain text/Markdown even in pipes; JSON is opt-in with `schemaVersion: 1`, `success: true`, and a `data` array for list/get. JSON help uses `data: {usage}`. List entries have `name` and `description`; get entries have `name` and `content`, adding `files: [{path, content}]` only with `--full`. A top-level `nextSteps` string array is optional. Unknown flags/names exit 2; missing assets exit 1. There is no `--all` or multi-skill form.

For CLI/packaging changes, verify discovery and retrieval from a packed installation outside the checkout, including `--full`, explicit JSON, piped text output, help, and errors. Assets must resolve from the package rather than the working directory, with no network or `gh` calls. Verify the stub's name/description and line budget, and that detailed safety guidance survives refactoring. Use the existing verification commands above; a source-only read does not prove that the assets ship in the package.

## Website deployment

The Vercel project uses `apps/docs` as its Root Directory, the Next.js framework preset, Node.js 24.x, and source files outside the Root Directory enabled. The latter is required for the workspace lockfile and canonical skill route. `apps/docs/vercel.json` installs from the workspace root and builds the docs with Corepack and the pinned pnpm version.

Connect the project to `vercel-labs/issue-graph` with production branch `main`. Domain assignment and production deployment require maintainer authorization. Website deployment and CLI publication are separate workflows.

## Release process

Merging a new stable version into canonical `main` starts `.github/workflows/release.yml` automatically. Update `package.json` and the current notes between the release markers in `CHANGELOG.md`, using a `## X.Y.Z` heading. Run `pnpm --filter @issue-graph/docs sync:changelog` to update the generated docs page. Do not edit `apps/docs/content/docs/changelog.mdx` directly.

Each push checks the commit and npm registry. An unpublished version must be newer than `latest`. Already-published versions skip the build and publication. Invalid identity, registry errors, and refs outside canonical `main` stop publication.

The build runs lint, typecheck, and tests with Node 24 and the pinned pnpm version, then packs once through `prepack`. Node 20/22/24 consumers test that exact tarball without rebuilding. Only after all consumers pass does the publish job send the same archive to npm through OIDC, with hooks disabled and no stored npm token. It installs no project dependencies. Metadata binds the package name, version, source SHA, filename, and SHA-256 to an immutable run-specific artifact retained for 30 days.

After publication, the workflow checks the registry identity, SHA-512 integrity, and downloaded SHA-256 against the retained archive. It then creates the `vX.Y.Z` tag and GitHub Release at the published commit using the changelog notes. An existing tag must resolve to that same commit. Verify-only runs create neither tags nor releases.

### One-time configuration

- Configure npm trusted publishing for package `issue-graph`, GitHub owner `vercel-labs`, repository `issue-graph`, workflow `release.yml`, and environment `Release`. Allow direct publishing rather than staged publishing.
- Restrict the GitHub `Release` environment to the `main` branch. Do not configure required reviewers or a wait timer: the reviewed merge is the release decision. Naming the environment in YAML does not configure these rules.
- Keep write permissions scoped to their jobs. Only `publish` requests OIDC; only `github-release` writes repository contents.

Releases are serialized without cancelling a running release. The registry is checked again immediately before publishing. There is no atomic registry compare-and-set; coordinate any out-of-band publisher.

### Manual verification and recovery

Manual dispatch remains available on `main`. Set `EXPECTED_SHA` to the full current main commit and `EXPECTED_VERSION` to its exact package version. Verification defaults to `publish=false` and skips the OIDC job:

```bash
gh workflow run release.yml --repo vercel-labs/issue-graph --ref main -f expected_sha="$EXPECTED_SHA" -f expected_version="$EXPECTED_VERSION" -F publish=false
```

Use `-F publish=true` to retry an unpublished version when the automatic run did not complete. A new dispatch builds and tests its own archive. A version already on npm is skipped.

If npm accepted the package but registry verification or GitHub Release creation failed, rerun the failed jobs in the original run while its artifact is retained:

```bash
gh run rerun "$RUN_ID" --repo vercel-labs/issue-graph --failed
```

The publish job checks whether the version now exists. If it does, it verifies that the published bytes match the retained archive and continues without another `npm publish`. A mismatch stops the run. Successful build and consumer jobs keep their original artifact ID. Rerunning all jobs or starting a new workflow is not a substitute for this recovery path.

Registry verification uses only HTTPS `registry.npmjs.org` URLs without credentials, nondefault ports, query strings, or fragments. Redirects are forbidden. Each request times out after 15 seconds; metadata is capped at 1 MiB and tarballs at the retained archive size. HTTP 404/408/429/500/502/503/504 receive at most 12 attempts, with exponential delays capped at 30 seconds. This allows npm processing time without an unbounded wait. Identity, integrity, byte, URL, malformed-data, and other network errors stop immediately. Verification never repacks, republishes, or changes registry tags.

To investigate without any writes to npm or GitHub, restore the original release context and artifact outputs, then run:

```bash
node scripts/release.ts verify-published "$RUNNER_TEMP/release"
```

Confirm the published package with a fresh install before updating installation claims.
