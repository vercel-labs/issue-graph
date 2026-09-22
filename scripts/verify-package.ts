import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assertChecksum, parseTarballInput, selectTarball, verifyArchive } from "./release.js";

assert.equal(process.release.name, "node", "package verification requires Node.js");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceManifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const packageName = sourceManifest.name;
const suppliedTarball = parseTarballInput(process.argv.slice(2));
const fixtureRepo = "package-smoke/fixture";
const fixtureAuthor = "smoke-author";
let checks = 0;

function executable(name: string): string {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const path = resolve(dir, name);
    try {
      accessSync(path, constants.X_OK);
      if (statSync(path).isFile()) return realpathSync(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EACCES") throw error;
    }
  }
  assert.fail(`${name} must be installed on PATH before package verification`);
}

function run(
  command: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  expected = 0,
): { stdout: string; stderr: string } {
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const label = command.join(" ");
  assert.ifError(result.error);
  assert.equal(result.signal, null, `${label}: killed by ${result.signal}`);
  assert.equal(
    result.status,
    expected,
    `${label}: expected exit ${expected}, got ${result.status}\n${result.stdout}\n${result.stderr}`,
  );
  checks++;
  console.log(`PASS exit ${expected}: ${label}`);
  return { stdout: result.stdout, stderr: result.stderr };
}

const fakeGh = String.raw`#!/usr/bin/env node
const assert = require("node:assert/strict");
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.PACKAGE_TEST_GH_LOG, JSON.stringify(args) + "\n");
if (process.env.PACKAGE_TEST_FAIL === "1") {
  console.error("package smoke: simulated gh failure");
  process.exit(1);
}
assert.deepEqual(args.slice(0, 2), ["api", "graphql"]);
const fields = {};
for (let i = 2; i < args.length; i += 2) {
  assert.ok(args[i] === "-f" || args[i] === "-F");
  const split = args[i + 1].indexOf("=");
  fields[args[i + 1].slice(0, split)] = args[i + 1].slice(split + 1);
}
assert.equal(fields.owner, "package-smoke");
assert.equal(fields.repo, "fixture");
const pageInfo = { hasNextPage: false, endCursor: null };
const author = { login: "smoke-author" };
const createdAt = "2026-01-01T00:00:00Z";
let repository;
if (fields.query.includes("issueOrPullRequest(number:$n)")) {
  assert.ok(fields.n === "1" || fields.n === "2");
  const pr = fields.n === "2";
  repository = {
    issueOrPullRequest: {
      __typename: pr ? "PullRequest" : "Issue",
      title: pr ? "Package smoke fix" : "Package smoke issue",
      state: "OPEN",
      url: "https://github.com/package-smoke/fixture/" + (pr ? "pull/2" : "issues/1"),
      body: pr ? "Fixes #1" : "Related #2",
      author,
      createdAt,
      updatedAt: createdAt,
      reactions: { totalCount: 1 },
      participants: { totalCount: 1 },
      comments: { totalCount: 0, nodes: [] },
      timelineItems: { nodes: [] },
      ...(pr ? {
        isDraft: false,
        reviewDecision: "REVIEW_REQUIRED",
        mergeable: "MERGEABLE",
        additions: 1,
        deletions: 0,
        changedFiles: 1,
        files: { nodes: [{ path: "fixture.js" }] },
        closingIssuesReferences: {
          nodes: [{ number: 1, repository: { owner: { login: "package-smoke" }, name: "fixture" } }],
        },
      } : {}),
    },
  };
} else if (fields.query.includes("pullRequests(first:50,")) {
  assert.equal(fields.after, undefined);
  repository = {
    pullRequests: {
      totalCount: 1,
      pageInfo,
      nodes: [{
        number: 2,
        title: "Package smoke fix",
        url: "https://github.com/package-smoke/fixture/pull/2",
        author,
        headRefOid: "a".repeat(40),
        updatedAt: createdAt,
        isDraft: false,
        reviewDecision: process.env.PACKAGE_TEST_PHASE === "updated" ? "APPROVED" : "REVIEW_REQUIRED",
        mergeable: "MERGEABLE",
        assignees: { nodes: [], pageInfo },
        reviewRequests: { nodes: [], pageInfo },
      }],
    },
  };
} else {
  throw new Error("Unexpected fixture query: " + fields.query);
}
console.log(JSON.stringify({ data: { repository } }));
`;

const guard = `
const assert = require("node:assert/strict");
const { readdirSync } = require("node:fs");
assert.equal(process.release.name, "node", "consumer must run under Node.js");
const bin = process.env.PACKAGE_TEST_BIN;
assert.ok(bin, "consumer requires an isolated tool directory");
assert.deepEqual(readdirSync(bin).sort(), ["dirname", "gh", "node", "package.json", "pnpm", "sed", "uname"]);
process.env.PATH = bin;
require("node:net").Socket.prototype.connect = function () {
  throw new Error("Network forbidden in package smoke consumer");
};
globalThis.fetch = async function () {
  throw new Error("Network forbidden in package smoke consumer");
};
`;

const exportProbe = `
import assert from "node:assert/strict";
const name = ${JSON.stringify(packageName)};
const core = await import(name);
const { httpTransport } = await import(name + "/transport/http");
const { shellTransport } = await import(name + "/transport/shell");
assert.ok(import.meta.resolve(name).endsWith("/dist/index.js"));
assert.equal(typeof core.crawl, "function");
assert.equal(typeof core.parseNodeResponse, "function");
assert.equal(typeof core.collectStatus, "function");
assert.equal(typeof httpTransport, "function");
assert.equal(typeof shellTransport, "function");
const expected = {
  data: { repository: { issueOrPullRequest: {
    __typename: "Issue", title: "HTTP fixture", state: "OPEN", body: "",
  } } },
};
let requests = 0;
globalThis.fetch = async (url, init) => {
  requests++;
  assert.equal(url, "https://api.github.com/graphql");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.authorization, "bearer package-smoke-not-a-token");
  assert.deepEqual(JSON.parse(init.body).variables, { owner: "package-smoke", repo: "fixture", n: 1 });
  return new Response(JSON.stringify(expected), { status: 200 });
};
const http = await core.makeFetchNode(httpTransport({ token: "package-smoke-not-a-token", maxRetries: 0 }))(
  "package-smoke", "fixture", 1, 0,
);
assert.equal(requests, 1);
assert.equal(http.title, "HTTP fixture");
assert.equal(http.fetched, true);
const shell = await core.makeFetchNode(shellTransport())("package-smoke", "fixture", 1, 0);
assert.equal(shell.key, "package-smoke/fixture#1");
assert.equal(shell.title, "Package smoke issue");
assert.equal(shell.fetched, true);
assert.ok(shell.edges.some((edge) => edge.to === "package-smoke/fixture#2"));
console.log("core/http/shell exports passed");
`;

const tools: Record<string, string> = {
  ...Object.fromEntries(["tar", "dirname", "sed", "uname"].map((name) => [name, executable(name)])),
  node: realpathSync(process.execPath),
};
const { packageManager } = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
assert.match(packageManager ?? "", /^pnpm@\d+\.\d+\.\d+/, "packageManager must pin pnpm");
const execPath = process.env.npm_execpath;
assert.ok(execPath && isAbsolute(execPath), "run package verification via pnpm test:package");
const pnpmCli = realpathSync(execPath);
assert.match(pnpmCli, /\.(?:c|m)?js$/, "pnpm must expose its JavaScript CLI entrypoint");
assert.ok(statSync(pnpmCli).isFile(), "pnpm CLI entrypoint must be a file");
accessSync(pnpmCli, constants.R_OK);
const pnpmRoot = resolve(dirname(pnpmCli), "..");
const pnpmManifest = JSON.parse(readFileSync(join(pnpmRoot, "package.json"), "utf8"));
assert.equal(pnpmManifest.name, "pnpm", "CLI entrypoint must belong to the pnpm package");
assert.equal(pnpmManifest.version, packageManager.slice("pnpm@".length).split("+")[0]);
assert.equal(typeof pnpmManifest.bin?.pnpm, "string", "pnpm package must declare its CLI");
assert.equal(realpathSync(resolve(pnpmRoot, pnpmManifest.bin.pnpm)), pnpmCli);
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const owned = mkdtempSync(join(repo, ".package-test-"));
let retainedTarball = suppliedTarball;
try {
  const bin = join(owned, "bin");
  const home = join(owned, "home");
  const consumer = join(owned, "consumer");
  const dlxConsumer = join(owned, "dlx-consumer");
  const artifacts = join(owned, "artifacts");
  const store = join(owned, "pnpm-store");
  const temp = join(owned, "tmp");
  const statusHome = join(owned, "status-home");
  for (const dir of [bin, home, consumer, dlxConsumer, artifacts, store, temp])
    mkdirSync(dir, { recursive: true });
  for (const name of ["node", "dirname", "sed", "uname"]) symlinkSync(tools[name], join(bin, name));
  writeFileSync(
    join(bin, "pnpm"),
    `#!/bin/sh\nexec ${shellQuote(tools.node)} ${shellQuote(pnpmCli)} "$@"\n`,
  );
  chmodSync(join(bin, "pnpm"), 0o755);
  writeFileSync(join(bin, "package.json"), JSON.stringify({ type: "commonjs" }));
  writeFileSync(join(bin, "gh"), fakeGh);
  chmodSync(join(bin, "gh"), 0o755);
  const guardPath = join(owned, "guard.cjs");
  writeFileSync(guardPath, guard);
  for (const dir of [consumer, dlxConsumer]) {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "package-smoke-consumer",
        private: true,
        type: "module",
        packageManager,
      }),
    );
    const prefix = dir === consumer ? "pnpm" : "dlx";
    const settings = {
      storeDir: dir === consumer ? store : join(owned, "dlx-store"),
      cacheDir: join(owned, `${prefix}-cache`),
      stateDir: join(owned, `${prefix}-state`),
      offline: true,
      ignoreScripts: true,
      updateNotifier: false,
      managePackageManagerVersions: false,
      scriptShell: "/bin/sh",
      registry: "http://127.0.0.1:9",
    };
    writeFileSync(
      join(dir, "pnpm-workspace.yaml"),
      `packages: []\n${Object.entries(settings)
        .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
        .join("\n")}\n`,
    );
  }
  const userConfig = join(owned, "pnpm-user.rc");
  const globalConfig = join(owned, "pnpm-global.rc");
  writeFileSync(userConfig, "");
  writeFileSync(globalConfig, "");
  const env: NodeJS.ProcessEnv = {
    PATH: bin,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    PNPM_HOME: join(home, ".local", "share", "pnpm"),
    COREPACK_ENABLE_NETWORK: "0",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    COREPACK_ENABLE_AUTO_PIN: "0",
    GH_CONFIG_DIR: join(home, "gh"),
    ISSUE_GRAPH_HOME: statusHome,
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    CI: "1",
    NO_COLOR: "1",
    NODE_OPTIONS: `--require=${JSON.stringify(guardPath)}`,
    npm_config_userconfig: userConfig,
    npm_config_globalconfig: globalConfig,
    PACKAGE_TEST_BIN: bin,
    PACKAGE_TEST_GH_LOG: join(owned, "gh-calls.jsonl"),
  };
  const node = join(bin, "node");
  const pnpm = join(bin, "pnpm");
  const runtime = run([node, "-p", "process.version"], consumer, env).stdout.trim();
  assert.match(runtime, /^v(?:2[024])\./, `expected Node 20, 22, or 24, got ${runtime}`);
  retainedTarball = selectTarball(suppliedTarball, () => {
    run([pnpm, "pack", "--pack-destination", artifacts], repo, {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    });
    const tarballs = readdirSync(artifacts).filter((name) => name.endsWith(".tgz"));
    assert.equal(tarballs.length, 1, "pnpm must produce exactly one local tarball");
    return join(artifacts, tarballs[0]);
  });
  const { tarball, sha256: digest } = retainedTarball;
  verifyArchive(tarball, sourceManifest, digest);
  const entries = run([tools.tar, "-tzf", tarball], repo, process.env).stdout.trim().split("\n");
  const files = entries.filter((name) => !name.endsWith("/"));
  assert.equal(new Set(files).size, files.length, "archive must not contain duplicate files");
  for (const entry of entries) {
    assert.ok(entry.startsWith("package/"), `unexpected archive root: ${entry}`);
    assert.ok(!entry.split("/").includes(".."), `unsafe archive path: ${entry}`);
  }
  for (const file of files) {
    const name = file.slice("package/".length);
    assert.ok(
      /^(?:package\.json|README\.md|CHANGELOG\.md|LICENSE|SECURITY\.md|CONTRIBUTING\.md)$/.test(
        name,
      ) ||
        /^dist\/.+\.(?:js|d\.ts)$/.test(name) ||
        name === "skills/issue-graph/SKILL.md" ||
        name === "skill-data/core/SKILL.md" ||
        name === "skill-data/core/references/workflows.md",
      `unexpected published file (source, internal docs, or maps): ${name}`,
    );
    assert.ok(
      !/(?:^|\/)(?:__tests__|tests?|src)(?:\/|\.)/i.test(name),
      `test/source file: ${name}`,
    );
    assert.ok(!/\.(?:test|spec)\./i.test(name), `published test: ${name}`);
  }
  for (const name of [
    "package.json",
    "dist/bin.js",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/transports/http.js",
    "dist/transports/http.d.ts",
    "dist/transports/shell.js",
    "dist/transports/shell.d.ts",
    "skills/issue-graph/SKILL.md",
    "dist/skills-cli.js",
    "dist/skills-cli.d.ts",
    "skill-data/core/SKILL.md",
    "skill-data/core/references/workflows.md",
    "LICENSE",
    "README.md",
  ])
    assert.ok(files.includes(`package/${name}`), `missing published file: ${name}`);
  console.log(`PASS published contents: ${files.length} files, no source/tests/internal docs/maps`);

  run(
    [pnpm, "add", "--workspace-root", "--offline", "--ignore-scripts", "--lockfile=false", tarball],
    consumer,
    env,
  );
  const installed = join(consumer, "node_modules", packageName);
  const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  assert.equal(manifest.name, packageName);
  assert.equal(manifest.version, sourceManifest.version);
  assert.equal(manifest.bin["issue-graph"], "./dist/bin.js");
  assert.equal(manifest.main, "./dist/index.js");
  assert.equal(manifest.exports["."].import, "./dist/index.js");
  assert.equal(manifest.exports["./transport/http"].import, "./dist/transports/http.js");
  assert.equal(manifest.exports["./transport/shell"].import, "./dist/transports/shell.js");
  assert.equal(manifest.types, "./dist/index.d.ts");
  assert.equal(manifest.exports["."].types, "./dist/index.d.ts");
  assert.equal(manifest.exports["./transport/http"].types, "./dist/transports/http.d.ts");
  assert.equal(manifest.exports["./transport/shell"].types, "./dist/transports/shell.d.ts");
  assert.equal(
    readFileSync(join(installed, "dist/bin.js"), "utf8").split("\n")[0],
    "#!/usr/bin/env node",
  );
  const cli = join(consumer, "node_modules/.bin/issue-graph");
  accessSync(cli, constants.X_OK);
  accessSync(join(installed, "dist/bin.js"), constants.X_OK);
  const invoke = (args: string[], expected = 0, overrides: NodeJS.ProcessEnv = {}) =>
    run([pnpm, "exec", "issue-graph", ...args], consumer, { ...env, ...overrides }, expected);
  assert.match(invoke(["--help"]).stdout, /usage: issue-graph/);
  assert.match(invoke(["status", "--help"]).stdout, /--save/);
  const schema = JSON.parse(invoke(["schema"]).stdout);
  assert.equal(schema.name, "issue-graph");
  assert.deepEqual(schema.exitCodes, { success: 0, runtimeFailure: 1, usageError: 2 });
  assert.ok(schema.commands.status);
  assert.ok(schema.commands.graph);
  assert.match(invoke([], 2).stderr, /usage: issue-graph/);
  assert.match(invoke(["--not-a-real-option"], 2).stderr, /unknown flag/);
  assert.match(invoke(["status", "--repo", fixtureRepo], 2).stderr, /requires --repo and --author/);
  assert.match(invoke(["skills", "--help"]).stdout, /No network, GitHub authentication/);
  assert.match(invoke(["skills", "list"]).stdout, /core {2}Status-first routing/);
  const catalog = JSON.parse(invoke(["skills", "list", "--json"]).stdout);
  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.success, true);
  assert.deepEqual(
    catalog.data.map((skill: { name: string }) => skill.name),
    ["core"],
  );
  const core = readFileSync(join(installed, "skill-data/core/SKILL.md"), "utf8");
  const referencePath = join(installed, "skill-data/core/references/workflows.md");
  const workflows = readFileSync(referencePath, "utf8");
  assert.equal(core, readFileSync(join(repo, "skill-data/core/SKILL.md"), "utf8"));
  assert.equal(
    workflows,
    readFileSync(join(repo, "skill-data/core/references/workflows.md"), "utf8"),
  );
  const decoy = join(consumer, "skill-data/core");
  mkdirSync(decoy, { recursive: true });
  writeFileSync(join(decoy, "SKILL.md"), "Wrong guide from caller working directory");
  const guide = invoke(["skills", "get", "core"]);
  assert.equal(guide.stdout, core);
  assert.equal(guide.stderr, "");
  const guideJson = JSON.parse(invoke(["skills", "get", "core", "--json"]).stdout);
  assert.deepEqual(guideJson.data, [{ name: "core", content: core }]);
  const fullText = `${core.trimEnd()}\n\n--- references/workflows.md ---\n\n${workflows.trimEnd()}\n`;
  assert.equal(invoke(["skills", "get", "core", "--full"]).stdout, fullText);
  const fullJson = JSON.parse(invoke(["skills", "get", "core", "--full", "--json"]).stdout);
  assert.deepEqual(fullJson.data, [
    {
      name: "core",
      content: core,
      files: [{ path: "references/workflows.md", content: workflows }],
    },
  ]);
  const invalid = invoke(["skills", "get", "missing", "--json"], 2);
  assert.equal(JSON.parse(invalid.stdout).error.code, "USAGE_ERROR");
  assert.equal(invalid.stderr, "");
  assert.match(invoke(["skills", "get", "../core"], 2).stderr, /unknown skill/);
  assert.match(invoke(["skills", "get", "core", "--oops"], 2).stderr, /unknown skills flag/);
  assert.match(invoke(["skills", "get"], 2).stderr, /requires exactly one name/);
  assert.match(invoke(["skills", "list", "--full"], 2).stderr, /list accepts only/);
  for (const missingPath of [referencePath, join(installed, "skill-data/core/SKILL.md")]) {
    renameSync(missingPath, `${missingPath}.unavailable`);
    try {
      const missingJson = invoke(["skills", "get", "core", "--full", "--json"], 1);
      assert.equal(JSON.parse(missingJson.stdout).error.code, "SKILL_READ_FAILED");
      assert.equal(missingJson.stderr, "");
      const missingText = invoke(["skills", "get", "core", "--full"], 1);
      assert.equal(missingText.stdout, "");
      assert.match(missingText.stderr, /Cannot read bundled skill core/);
    } finally {
      renameSync(`${missingPath}.unavailable`, missingPath);
    }
  }
  assert.ok(!existsSync(join(home, ".issue-graph")), "skills must not create graph snapshots");
  assert.ok(!existsSync(statusHome), "skills must not create status snapshots");
  assert.ok(
    !existsSync(env.PACKAGE_TEST_GH_LOG as string),
    "help/schema/skills/usage must not invoke gh",
  );

  const dlx = (args: string[], expected = 0) =>
    run([pnpm, `--package=${tarball}`, "dlx", "issue-graph", ...args], dlxConsumer, env, expected);
  assert.match(dlx(["--help"]).stdout, /usage: issue-graph/);
  assert.deepEqual(JSON.parse(dlx(["schema"]).stdout), schema);
  assert.match(dlx(["--not-a-real-option"], 2).stderr, /unknown flag/);
  assert.equal(dlx(["skills", "get", "core"]).stdout, core);
  assert.deepEqual(JSON.parse(dlx(["skills", "get", "core", "--full", "--json"]).stdout), fullJson);

  const probe = join(consumer, "exports.mjs");
  writeFileSync(probe, exportProbe);
  assert.equal(run([node, probe], consumer, env).stdout.trim(), "core/http/shell exports passed");
  const statusArgs = ["status", "--repo", fixtureRepo, "--author", fixtureAuthor, "--json"];
  const status = JSON.parse(invoke(statusArgs).stdout);
  assert.equal(status.coverageComplete, true);
  assert.equal(status.totals.open.count, 1);
  assert.equal(status.totals.reviewRequired.count, 1);
  assert.equal(status.pullRequests[0].id, `${fixtureRepo}#2`);
  assert.ok(!existsSync(statusHome), "status without --save must not persist a snapshot");
  assert.ok(!existsSync(join(home, ".issue-graph")), "unexpected default-home writes");
  assert.match(invoke([...statusArgs, "--save", "--no-snapshot"], 2).stderr, /conflicts/);
  assert.match(invoke([...statusArgs, "--since", "last"], 1).stderr, /No prior status snapshot/);
  const saved = JSON.parse(invoke([...statusArgs, "--save"]).stdout);
  const baselinePath = resolve(saved.snapshot.path);
  assert.ok(baselinePath.startsWith(`${statusHome}${sep}`), "snapshot escaped owned home");
  const baselineText = readFileSync(baselinePath, "utf8");
  assert.equal(JSON.parse(baselineText).kind, "issue-graph-status-snapshot");
  const updated = { PACKAGE_TEST_PHASE: "updated" };
  const compared = JSON.parse(
    invoke([...statusArgs, "--since", "last", "--save"], 0, updated).stdout,
  );
  assert.equal(compared.history.coverageComplete, true);
  assert.equal(compared.history.totals.approved.delta, 1);
  assert.equal(compared.history.totals.reviewRequired.delta, -1);
  assert.ok(
    compared.history.changes.some((change: { field: string }) => change.field === "reviewState"),
  );
  assert.notEqual(compared.snapshot.path, baselinePath);
  assert.equal(
    readFileSync(baselinePath, "utf8"),
    baselineText,
    "saved snapshots must be immutable",
  );
  const snapshotsBefore = readdirSync(dirname(baselinePath)).sort();
  const explicit = JSON.parse(
    invoke([...statusArgs, "--since", baselinePath, "--no-snapshot"], 0, updated).stdout,
  );
  assert.equal(explicit.history.totals.approved.delta, 1);
  assert.equal(explicit.snapshot, undefined);
  assert.deepEqual(readdirSync(dirname(baselinePath)).sort(), snapshotsBefore);
  assert.match(
    invoke([...statusArgs, "--since", join(owned, "missing.json")], 1).stderr,
    /Cannot read/,
  );
  const failed = { PACKAGE_TEST_FAIL: "1" };
  const incomplete = invoke(statusArgs, 1, failed);
  assert.equal(JSON.parse(incomplete.stdout).coverageComplete, false);
  assert.equal(JSON.parse(incomplete.stdout).totals.open.count, null);
  assert.match(incomplete.stderr, /INCOMPLETE_INVENTORY/);

  const graphArgs = ["1", "--repo", fixtureRepo, "--no-snapshot"];
  const jsonPath = join("output", "json", "nested", "graph.json");
  const htmlPath = join("output", "html", "nested", "graph.html");
  const graphResult = invoke([...graphArgs, "--json", jsonPath, "--html", htmlPath]);
  assert.match(graphResult.stdout, /Package smoke issue/);
  const graph = JSON.parse(readFileSync(join(consumer, jsonPath), "utf8"));
  assert.deepEqual(graph.seeds, [`${fixtureRepo}#1`]);
  assert.equal(graph.nodes.length, 2);
  assert.ok(graph.nodes.every((item: { fetched: boolean }) => item.fetched));
  const pr = graph.nodes.find((item: { kind: string }) => item.kind === "PullRequest");
  assert.deepEqual(pr.pr.files, ["fixture.js"]);
  assert.ok(
    pr.edges.some(
      (edge: { to: string; via: string }) =>
        edge.to === `${fixtureRepo}#1` && edge.via === "closes",
    ),
  );
  const html = readFileSync(join(consumer, htmlPath), "utf8");
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /Package smoke issue/);
  assert.ok(
    !existsSync(join(home, ".issue-graph")),
    "--no-snapshot must prevent graph persistence",
  );
  assert.match(invoke(graphArgs, 1, failed).stderr, /package smoke: simulated gh failure/);
  const blocker = join(consumer, "not-a-directory");
  writeFileSync(blocker, "owned output failure fixture");
  for (const flag of ["--json", "--html"]) {
    const result = invoke([...graphArgs, flag, join(blocker, "nested", "result")], 1);
    assert.match(result.stderr, /ENOTDIR|EEXIST|not a directory/i);
  }
  assert.match(
    invoke([...statusArgs, "--save"], 1, { ISSUE_GRAPH_HOME: join(blocker, "status") }).stderr,
    /ENOTDIR|EEXIST|not a directory/i,
  );
  const calls = readFileSync(env.PACKAGE_TEST_GH_LOG as string, "utf8")
    .trim()
    .split("\n");
  const expectedChecks = suppliedTarball ? 44 : 45;
  assert.equal(
    checks,
    expectedChecks,
    `package verification must exercise all ${expectedChecks} commands`,
  );
  assert.equal(calls.length, 14, "data verification must exercise all 14 owned gh fixture calls");
  console.log(
    `Package smoke passed on ${runtime}: ${checks} commands; ${calls.length} fixture calls`,
  );
} finally {
  const ownedRelative = relative(repo, owned);
  assert.ok(
    !isAbsolute(ownedRelative) &&
      !ownedRelative.includes(sep) &&
      ownedRelative.startsWith(".package-test-"),
  );
  try {
    if (retainedTarball) assertChecksum(retainedTarball.tarball, retainedTarball.sha256);
  } finally {
    rmSync(owned, { recursive: true, force: true });
  }
}
