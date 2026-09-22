# Contributing

Issues and focused pull requests are welcome.

Unless explicitly stated otherwise, contributions submitted for inclusion in
this project are licensed under Apache-2.0.

## Setup

To use the latest published CLI without contributing to source, run `npx issue-graph@latest --help` or install it with `npm install --global issue-graph@latest`. Library consumers can use `npm install issue-graph@latest`. The public npm package requires Node.js 20 or later and does not require or grant source access. Check the installed command's help before relying on source-only features; `@latest` does not promise unreleased capabilities.

Use pnpm and Node.js 20.19.x or 22.12+ for source development; Node.js 24 is recommended. The compiled CLI still targets Node.js 20 or later. Cloning the INTERNAL `vercel-labs/issue-graph` repository requires access and an authenticated GitHub CLI.

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

Both options are required in supplied mode. Verification checks the archive's name and version against the source manifest, SHA-256 before and after consumption, installed CLI and exports, offline pnpm installation/dlx, and owned GitHub fixtures. Default mode packs once through `prepack`; supplied mode never packs or rebuilds.

Add or update tests for behavior changes. Keep the graph core runtime-agnostic,
and keep filesystem or subprocess dependencies out of the main package entry
point.

For transport changes, also compare both implementations against a live public
repository:

```bash
pnpm exec tsx scripts/verify-transports.ts <number> <owner/repo> <depth>
```

## Skill maintenance

Keep the two skill layers separate:

- `skills/issue-graph/SKILL.md` is the evergreen discovery stub. Preserve its name and routing description, keep it at most 45 lines, and avoid version, release, installation, or prerequisite facts. It must load `issue-graph skills get core` before operational commands, use `--full` for references, and point to `skills list` for discovery. Missing commands/assets should report a CLI/skill mismatch, never fabricated guidance or automatic installation.
- `skill-data/core/SKILL.md` is compact operational guidance versioned with the CLI (roughly 80–120 lines). Maintain status-first routing, explicit scope, unknown counts and coverage, snapshot defaults, GitHub read-only boundaries, and untrusted-evidence/privacy rules here.
- `skill-data/core/references/workflows.md` holds detailed workflows, flags, limits, and safety details. Retrieve it through `issue-graph skills get core --full`; do not require agents to know source paths or copy reference files into their discovery directory.

When behavior changes, update the core and relevant reference together with the CLI. Keep setup/release availability in README and docs, not in the stub.

The package and `/skill.md` route use the canonical discovery stub. Run `pnpm --filter @issue-graph/docs sync:skill` after editing it to regenerate the checked-in well-known index and skill download. Docs development and build also run this generator; parity tests reject drift. Do not edit the generated public copies directly.

Preserve the discovery contract: `skills [list] [--json]`, `skills get core [--full] [--json]`, and `--help` under `skills`, `skills list`, and `skills get`. Default output is plain text/Markdown even in pipes; JSON is opt-in with `schemaVersion: 1`, `success: true`, and a `data` array for list/get. JSON help uses `data: {usage}`. List entries have `name` and `description`; get entries have `name` and `content`, adding `files: [{path, content}]` only with `--full`. A top-level `nextSteps` string array is optional. Unknown flags/names exit 2; missing assets exit 1. There is no `--all` or multi-skill form.

For CLI/packaging changes, verify discovery and retrieval from a packed installation outside the checkout, including `--full`, explicit JSON, piped text output, help, and errors. Assets must resolve from the package rather than the working directory, with no network or `gh` calls. Verify the stub's name/description and line budget, and that detailed safety guidance survives refactoring. Use the existing verification commands above; a source-only read does not prove that the assets ship in the package.

## Website deployment

The Vercel project uses `apps/docs` as its Root Directory, the Next.js framework preset, Node.js 24.x, and source files outside the Root Directory enabled. The latter is required for the workspace lockfile and canonical skill route. `apps/docs/vercel.json` installs from the workspace root and builds the docs with Corepack and the pinned pnpm version.

Connect the project to `vercel-labs/issue-graph` with production branch `main`. Domain assignment and production deployment require maintainer authorization. Website deployment does not publish the CLI or make the GitHub repository public.

## Release process

The repository remains INTERNAL; public package availability does not authorize another release or change repository visibility. The current source may contain unreleased changes despite retaining the same version as a published package. Check registry state rather than inferring publication from source, documentation, or a deployment. Never attempt to republish an existing version: the workflow rejects any existing exact version, including in verify-only mode.

`.github/workflows/release.yml` has only `workflow_dispatch`, with required `expected_sha` and `expected_version` inputs and a boolean `publish` input defaulting to `false`. `expected_version` deliberately has no default; each dispatch must supply the exact approved version. Obtain approval for an unpublished version newer than registry latest and update the source identity through review. After the release changes merge, review the commit on canonical `main`, set `EXPECTED_SHA` to its full 40-character SHA, and set `EXPECTED_VERSION` to the matching, reviewed, approved `package.json` version. Merging the PR does not dispatch the workflow or authorize publication. The commands below do not select a version or authorize a dispatch.

### Verify-only dispatch

Leave `publish` false to run the real GitHub build, retain the artifact, and exercise the Node 20/22/24 consumers. The publish job is skipped, so this mode neither requests Release environment approval nor runs a job with OIDC write permission. After the workflow is committed, an authorized maintainer can request this verification without authorizing npm publication:

```bash
gh workflow run release.yml --repo vercel-labs/issue-graph --ref main -f expected_sha="$EXPECTED_SHA" -f expected_version="$EXPECTED_VERSION" -F publish=false
```

### Publish dispatch

Publishing requires a separate explicit `publish=true` dispatch and Release environment approval. Before that dispatch, maintainers must configure and verify:

- npm trusted publishing for package `issue-graph`, GitHub owner `vercel-labs`, repository `issue-graph`, workflow filename `release.yml`, and environment `Release`, with direct `npm publish` allowed, not only staged publishing.
- The GitHub `Release` environment restricted to `main`, with required maintainer approval. Merely naming an environment in YAML does not configure its protection rules.
- Separate authorization to publish the reviewed SHA and exact version.

Only after publication is authorized:

```bash
gh workflow run release.yml --repo vercel-labs/issue-graph --ref main -f expected_sha="$EXPECTED_SHA" -f expected_version="$EXPECTED_VERSION" -F publish=true
```

The publish dispatch builds and tests its own retained artifact; it does not promote or reuse an artifact from the earlier verify-only run. Both modes reject noncanonical repositories, non-main refs, mismatched source identities, an existing exact registry version, and registry/network errors. Preflight requires a canonical stable `dist-tags.latest` value (`major.minor.patch`) present in registry version history, and the target must be strictly newer. Missing, malformed, prerelease, or build-metadata latest tags fail closed. Releases are serialized without cancelling a running release. Preflight is repeated immediately before publishing, but there is no atomic registry compare-and-set: coordinate out-of-band publishers to avoid a race after that final check.

The build job uses Node 24 and the pinned pnpm with a frozen lockfile, runs lint/typecheck/tests, and calls `pnpm pack` exactly once. `prepack` supplies the only build. It retains one tarball plus `release.json` and `SHA256SUMS` in an immutable, run-specific artifact for 30 days. Metadata binds name, version, source SHA, filename, and SHA-256.

Node 20/22/24 consumers download that exact artifact ID, verify its metadata and digest, and smoke-test the supplied tarball without rebuilding. Only after every consumer passes can the protected publish job download the same artifact, recheck identity and registry state, and publish that tarball with hooks disabled. It installs no project dependencies and creates no tags or GitHub releases. If a publish succeeded but a later step failed, a rerun fails closed on the existing version; inspect the registry rather than attempting replacement.

Development and tests use pnpm and Node. The publishing job alone uses the npm client for OIDC, requiring npm >=11.5.1 on Node 24 and `id-token: write` only in that job. There are no npm token secrets. It deliberately omits `--provenance` for INTERNAL sources and does not force provenance off: npm trusted publishing generates provenance automatically when both source repository and package are public. Any visibility change requires separate approval.

### Read-only post-publish verification

After a successful publish, the workflow runs:

```bash
node scripts/release.ts verify-published "$RUNNER_TEMP/release"
```

This command uses the same approved release context (`EXPECTED_SHA`, `EXPECTED_VERSION`, GitHub repository/ref/SHA context, and `EXPECTED_TARBALL_SHA256` from the build output). It first verifies the retained metadata, source identity, and archive digest. It then GETs the exact registry version, checks its name/version and `dist.integrity` against SHA-512 of the retained bytes, and GETs the registry tarball to compare its SHA-256 against the approved artifact. The original archive is checked again afterwards, including on failure.

Only HTTPS `registry.npmjs.org` URLs without credentials, nondefault ports, query strings, or fragments are allowed. Redirects are forbidden. Requests time out after 15 seconds; metadata is capped at 1 MiB and the downloaded tarball at the approved archive's size. Only HTTP 404/408/429/500/502/503/504 are retried for propagation, with at most five attempts and delays of 1, 2, 4, and 8 seconds. Identity, integrity, URL, byte, malformed-data, and other network failures stop immediately. No retry rebuilds, repacks, republishes, or changes registry tags.

If this verification fails after publication, retain the artifact and investigate. Re-run only the read-only verification with the same approved context, not the publish workflow; the latter intentionally rejects the already-existing version.

Do not set the site's `packageReleasePending` to false until actual publication is verified, or `repositoryIsPublic` to true while the repository is internal. Confirm a fresh install after publication before updating installation claims.
