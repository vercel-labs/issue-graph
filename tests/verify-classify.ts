import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SemanticReport, SemanticReportItem } from "../src/semantic-types.js";

type GatewayCall = {
  valid: boolean;
  attempt: number;
  maxAttempts: number;
  mode: string;
  inputBytes: number;
  questionIds: string[];
  requestId: string | null;
  inputHash: string | null;
  pendingBeforeFetch: boolean;
};

const assertCredentialsAbsent = (value: string) => {
  for (const secret of [
    "SYNTHETIC_SECRET_NOT_OUTPUT",
    "synthetic-test-key",
    "SYNTHETIC_PROVIDER_PROSE_NOT_OUTPUT",
  ]) {
    assert.ok(
      !value.includes(secret),
      "Credentials/provider prose must never persist or be output",
    );
  }
  assert.doesNotMatch(
    value,
    /gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}|\bsk-[A-Za-z0-9_-]{20,}|\bAKIA[A-Z0-9]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  );
};
const assertRedacted = (value: string) => {
  assertCredentialsAbsent(value);
  for (const marker of [
    "SYNTHETIC_BODY_NOT_OUTPUT",
    "Synthetic title, not output",
    "SYNTHETIC_COMMENT_NOT_OUTPUT",
  ]) {
    assert.ok(!value.includes(marker), "Public evidence must not escape immutable evidence files");
  }
};

assert.equal(process.release.name, "node", "smoke must run under Node.js");
const source = fileURLToPath(new URL("../", import.meta.url));
const ttyDemo = process.argv.includes("--tty-demo");
const packagePath = process.argv.slice(2).find((arg) => arg !== "--tty-demo");
const target = realpathSync(packagePath ? resolve(packagePath) : source);
const manifest = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
assert.equal(manifest.name, "issue-graph");
assert.ok(existsSync(join(target, manifest.bin["issue-graph"])));
const owned = mkdtempSync(join(source, ".package-test-classify-"));
let checks = 0;
try {
  const bin = join(owned, "bin");
  const home = join(owned, "home");
  const cwd = join(owned, "consumer");
  for (const directory of [bin, home, cwd]) mkdirSync(directory);
  writeFileSync(join(bin, "package.json"), '{"type":"commonjs"}\n');
  symlinkSync(process.execPath, join(bin, "node"));
  symlinkSync(join(target, manifest.bin["issue-graph"]), join(bin, "issue-graph"));
  const fakeGh = join(bin, "gh");
  writeFileSync(fakeGh, readFileSync(join(source, "tests/fixtures/classify/gh.cjs")));
  chmodSync(fakeGh, 0o755);
  const guard = join(owned, "guard.cjs");
  writeFileSync(
    guard,
    `
require("node:net").Socket.prototype.connect = function () { throw new Error("Network forbidden in classify smoke"); };
globalThis.fetch = async function () { throw new Error("Network forbidden in classify smoke"); };
if (process.env.CLASSIFY_TEST_TTY === "1") Object.defineProperty(process.stdout, "isTTY", { value: true });
`,
  );
  const log = join(owned, "gh.log");
  const gatewayLog = join(owned, "gateway.jsonl");
  const storageLog = join(owned, "storage-violations.jsonl");
  const gatewayPreload = join(owned, "gateway-preload.cjs");
  writeFileSync(
    gatewayPreload,
    readFileSync(join(source, "tests/fixtures/classify/gateway-preload.cjs")),
  );
  const tree = (root: string): Record<string, unknown> => {
    const entries: Record<string, unknown> = {};
    const visit = (relative: string) => {
      const path = join(root, relative);
      const stat = lstatSync(path);
      assert.ok(!stat.isSymbolicLink());
      const text = stat.isFile() ? readFileSync(path, "utf8") : null;
      const evidence = /^issue-graph\/classify\/evidence(?:\/|$)/.test(relative);
      if (evidence) {
        assert.equal(stat.mode & 0o777, stat.isDirectory() ? 0o700 : 0o600);
        assert.equal(stat.uid, process.getuid?.());
        if (stat.isFile()) assert.equal(stat.nlink, 1);
      }
      if (text !== null) {
        assertCredentialsAbsent(text);
        if (
          /^issue-graph\/classify\/evidence\/[a-f0-9]{64}\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.json$/.test(
            relative,
          )
        ) {
          const snapshot = JSON.parse(text);
          assert.equal(snapshot.schemaVersion, 1);
          assert.equal(snapshot.capture.visibility, "PUBLIC");
          assert.match(snapshot.checksum, /^[a-f0-9]{64}$/);
        } else assertRedacted(text);
      }
      entries[relative] = { mode: stat.mode, mtimeMs: stat.mtimeMs, text };
      if (stat.isDirectory()) {
        for (const name of readdirSync(path).sort()) visit(join(relative, name));
      }
    };
    visit("");
    return entries;
  };
  const evidenceOnly = (extra: NodeJS.ProcessEnv) => {
    const entries = tree(extra.HOME as string);
    assert.deepEqual(readdirSync(extra.HOME as string), ["issue-graph"]);
    assert.deepEqual(readdirSync(join(extra.ISSUE_GRAPH_HOME as string, "classify")), ["evidence"]);
    assert.ok(Object.keys(entries).some((path) => /\/evidence\/[^/]+\/current\.json$/.test(path)));
  };
  const gatewayCalls = (): GatewayCall[] => {
    assert.equal(
      existsSync(storageLog),
      false,
      "No-snapshot forbids evidence/cache/receipt I/O; cached forbids writes, keys and network",
    );
    if (!existsSync(gatewayLog)) return [];
    const text = readFileSync(gatewayLog, "utf8");
    assertRedacted(text);
    const calls: GatewayCall[] = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    for (const call of calls) {
      assert.equal(call.valid, true, "Synthetic Gateway contract failed");
      assert.ok(call.attempt >= 1 && call.attempt <= call.maxAttempts);
      if (call.maxAttempts === 1)
        assert.equal(call.attempt, 1, "Default fixture must never retry HTTP");
      else assert.ok(["retry-success", "throttle"].includes(call.mode));
    }
    return calls;
  };
  const env: NodeJS.ProcessEnv = {
    PATH: bin,
    HOME: home,
    XDG_CONFIG_HOME: home,
    GH_CONFIG_DIR: home,
    ISSUE_GRAPH_HOME: join(home, "issue-graph"),
    NODE_OPTIONS: `--require=${JSON.stringify(guard)} --require=${JSON.stringify(gatewayPreload)}`,
    NO_COLOR: "1",
    CLASSIFY_TEST_LOG: log,
    CLASSIFY_TEST_GATEWAY_LOG: gatewayLog,
    CLASSIFY_TEST_STORAGE_LOG: storageLog,
    CLASSIFY_TEST_NOW: "2026-09-22T00:00:00.000Z",
  };
  assert.equal(
    realpathSync(join(bin, "issue-graph")),
    realpathSync(join(target, manifest.bin["issue-graph"])),
  );
  assert.equal(realpathSync(join(bin, "node")), realpathSync(process.execPath));
  assert.deepEqual(readdirSync(bin).sort(), ["gh", "issue-graph", "node", "package.json"]);
  const guardProbeLog = join(owned, "guard-probe.jsonl");
  const guardProbe = spawnSync(
    "node",
    [
      "--input-type=module",
      "-e",
      `
import assert from "node:assert/strict";
import { readFileSync, lstatSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
for (const namespace of ["evidence", "cache", "receipts"]) {
  const path = join(process.env.ISSUE_GRAPH_HOME, "classify", namespace, "probe.json");
  assert.throws(() => readFileSync(path), /Forbidden smoke/);
  await assert.rejects(async () => open(path, "r"), /Forbidden smoke/);
}
assert.throws(() => lstatSync(join(process.env.ISSUE_GRAPH_HOME, "classify", "STOP")), { code: "ENOENT" });
`,
    ],
    {
      cwd,
      env: { ...env, CLASSIFY_TEST_NO_SNAPSHOT: "1", CLASSIFY_TEST_STORAGE_LOG: guardProbeLog },
      encoding: "utf8",
    },
  );
  assert.ifError(guardProbe.error);
  assert.equal(guardProbe.signal, null);
  assert.equal(guardProbe.status, 0, guardProbe.stderr);
  assert.equal(readFileSync(guardProbeLog, "utf8").trim().split("\n").length, 6);
  assert.deepEqual(readdirSync(home), []);
  checks++;
  console.log("PASS exit 0: no-snapshot CJS/ESM evidence/cache/receipt guard, STOP still readable");
  const run = (args: string[], expected = 0, extra: NodeJS.ProcessEnv = {}) => {
    const result = spawnSync("issue-graph", args, {
      cwd,
      env: { ...env, ...extra },
      encoding: "utf8",
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assertRedacted(result.stdout + result.stderr);
    gatewayCalls();
    assert.equal(result.status, expected, `${args.join(" ")}: ${result.stdout}\n${result.stderr}`);
    assert.ok(!(result.stdout + result.stderr).includes("\u001b"));
    if (result.stdout.startsWith("{")) {
      const value = JSON.parse(result.stdout);
      if (value.kind === "classification-report" || value.kind === "classification-preview") {
        assert.deepEqual(Object.keys(value.performance).sort(), [
          "captureMs",
          "evaluationMs",
          "githubCalls",
          "githubRequestMs",
          "totalMs",
        ]);
        for (const metric of Object.values(value.performance))
          assert.ok(typeof metric === "number" && Number.isFinite(metric) && metric >= 0);
        assert.ok(Number.isSafeInteger(value.performance.githubCalls));
      }
    }
    checks++;
    console.log(`PASS exit ${expected}: issue-graph ${args.join(" ")}`);
    return result;
  };
  const help = run(["classify", "--help"]);
  assert.match(help.stdout, /--dry-run/);
  assert.equal(help.stderr, "");
  assert.equal(existsSync(log), false);
  const schema = JSON.parse(run(["schema"]).stdout);
  assert.equal(
    schema.commands.classify.implementation,
    "batched-evidence-and-bounded-scheduling",
    "Compiled package lacks batched evidence/scheduling; rebuild before rerunning this smoke",
  );
  assert.match(help.stdout, /--refresh/);
  assert.equal(schema.commands.classify.cache.enabled, true);
  assert.equal(schema.commands.classify.cache.ttlMs, 86400000);
  assert.ok(schema.commands.classify.flags.includes("--refresh"));
  assert.equal(schema.commands.classify.gatewayCalls, true);
  assert.match(schema.commands.classify.dryRun, /no Gateway key access, inference or local writes/);
  assert.equal(schema.commands.classify.outputKind, "classification-report");
  assert.equal(schema.commands.classify.dryRunOutputKind, "classification-preview");
  assert.equal(schema.commands.classify.maxInputBytes, 24000);
  for (const flag of ["--cached", "--concurrency", "--max-retries", "--min-interval-ms"]) {
    assert.ok(help.stdout.includes(flag));
    assert.ok(schema.commands.classify.flags.includes(flag));
  }
  assert.equal(schema.commands.classify.retries, 0);
  assert.deepEqual(schema.commands.classify.maxRetries, {
    default: 0,
    minimum: 0,
    maximum: 3,
    onlyStatus: 429,
    maxWaitMs: 30000,
  });
  assert.deepEqual(schema.commands.classify.inferenceConcurrency, {
    default: 1,
    minimum: 1,
    maximum: 4,
  });
  assert.deepEqual(schema.commands.classify.minIntervalMs, {
    default: 0,
    minimum: 0,
    maximum: 60000,
  });
  assert.match(schema.commands.classify.noSnapshot, /No evidence\/cache\/receipt I\/O/);
  assert.match(schema.commands.classify.diagnostics, /untrusted/);
  assert.match(schema.commands.classify.diagnostics, /prose is omitted/);
  const guide = JSON.parse(run(["skills", "get", "core", "--full", "--json"]).stdout);
  assert.match(guide.data[0].content, /Semantic suggestions \(V3\)/);
  assert.match(guide.data[0].content, /inference can incur charges/);
  assert.match(guide.data[0].content, /Unknown outcomes block/);
  assert.ok(
    guide.data[0].files.some((file: { content: string }) =>
      file.content.includes("classification-preview"),
    ),
  );
  for (const command of ["status", "reconcile", "plan"]) run([command, "--help"]);
  run(["--help"]);
  const bare = run([], 2);
  assert.equal(bare.stdout, "");
  assert.match(bare.stderr, /usage:/);
  const invalid = run(["classify", "--repo", "sample/public-repo", "--unknown-flag"], 2);
  assert.equal(JSON.parse(invalid.stdout).kind, "classification-error");
  assert.equal(JSON.parse(invalid.stdout).error.code, "invalid-arguments");
  for (const flags of [["--refresh", "true"], ["--refresh=false"], ["--refresh", "--refresh"]]) {
    const invalidRefresh = run(["classify", "--repo", "sample/public-repo", ...flags], 2);
    assert.equal(JSON.parse(invalidRefresh.stdout).error.code, "invalid-arguments");
  }
  assert.equal(existsSync(log), false);
  assert.equal(gatewayCalls().length, 0);

  for (const flags of [
    ["--cached", "--dry-run"],
    ["--cached", "--refresh"],
    ["--cached", "--no-snapshot"],
    ["--cached", "--max-calls", "1"],
    ["--cached", "true"],
    ["--cached=false"],
    ["--cached", "--cached"],
    ["--concurrency", "0"],
    ["--concurrency", "5"],
    ["--max-retries", "4"],
    ["--max-retries", "-1"],
    ["--min-interval-ms", "60001"],
    ["--min-interval-ms", "1.5"],
  ]) {
    assert.equal(
      JSON.parse(run(["classify", "--repo", "sample/public-repo", ...flags], 2).stdout).error.code,
      "invalid-arguments",
    );
  }
  assert.equal(existsSync(log), false);
  assert.equal(gatewayCalls().length, 0);
  const args = ["classify", "--repo", "sample/public-repo", "--dry-run"];
  const good = run(args);
  const report = JSON.parse(good.stdout);
  assert.equal(report.kind, "classification-preview");
  assert.equal(report.coverageComplete, true);
  assert.equal(report.totals.plannedCalls, 1);
  assert.equal(report.execution.gatewayCalls, 0);
  assert.equal(report.execution.localWrites, 0);
  assert.equal(good.stderr, "");
  assert.match(report.items[0].inputHash, /^[a-f0-9]{64}$/);
  assert.equal(report.items[0].reviewRequired, true);
  assert.equal(report.items[0].componentStatus, "unavailable");
  assert.ok(!Object.hasOwn(report.items[0], "probabilities"));
  const noSnapshot = JSON.parse(
    run([...args, "--no-snapshot", "--json"], 0, { CLASSIFY_TEST_NO_SNAPSHOT: "1" }).stdout,
  );
  assert.equal(report.execution.cache, "read-only");
  assert.equal(report.items[0].cacheStatus, "miss");
  assert.equal(report.totals.cacheHits, 0);
  assert.deepEqual(noSnapshot.execution, { ...report.execution, cache: "disabled" });
  assert.equal(noSnapshot.items[0].cacheStatus, "disabled");

  const taxonomyPath = join(cwd, "taxonomy.json");
  writeFileSync(taxonomyPath, readFileSync(join(source, "tests/fixtures/classify/taxonomy.json")));
  const withTaxonomy = JSON.parse(run([...args, "--taxonomy", taxonomyPath]).stdout);
  assert.equal(withTaxonomy.items[0].componentStatus, "available");
  assert.ok(withTaxonomy.items[0].questionIds.includes("component"));
  const deferred = JSON.parse(run([...args, "--max-calls", "0"], 1).stdout);
  assert.equal(deferred.totals.deferred, 1);
  assert.equal(deferred.totals.plannedCalls, 0);
  const bounded = JSON.parse(
    run(
      [
        ...args,
        "--concurrency",
        "4",
        "--max-retries",
        "3",
        "--min-interval-ms",
        "60000",
        "--max-calls",
        "0",
      ],
      1,
    ).stdout,
  );
  assert.equal(bounded.totals.plannedCalls, 0);
  assert.equal(bounded.execution.gatewayCalls, 0);
  assert.equal(bounded.execution.localWrites, 0);
  const partial = JSON.parse(
    run([...args, "--limit", "1"], 1, { CLASSIFY_TEST_CASE: "partial" }).stdout,
  );
  assert.equal(partial.coverageComplete, false);
  assert.equal(partial.coverage.hasNextPage, true);
  assert.equal(partial.items.length, 1);
  const empty = JSON.parse(run(args, 0, { CLASSIFY_TEST_CASE: "empty" }).stdout);
  assert.equal(empty.coverageComplete, true);
  assert.equal(empty.items.length, 0);
  const failure = JSON.parse(run(args, 1, { CLASSIFY_TEST_CASE: "failure" }).stdout);
  assert.equal(failure.kind, "classification-error");
  const callsBeforePrivate = readFileSync(log, "utf8").trim().split("\n").length;
  const privateReport = JSON.parse(run(args, 1, { CLASSIFY_TEST_CASE: "private" }).stdout);
  assert.equal(privateReport.error.code, "repository-not-public");
  assert.equal(readFileSync(log, "utf8").trim().split("\n").length - callsBeforePrivate, 1);
  const demo = JSON.parse(run(args, 1, { CLASSIFY_TEST_CASE: "demo" }).stdout);
  assert.equal(demo.items.length, 3);
  assert.equal(demo.items[0].evidence.commentsCoverage.captured, 101);
  assert.equal(demo.items[0].evidence.commentsCoverage.pages, 2);
  assert.equal(demo.items[2].outcome, "skipped");
  assert.ok(demo.items[2].reasonCodes.includes("state-changed"));
  assert.equal(demo.totals.plannedCalls, 2);
  const markdown = run([...args, "--format", "markdown"]);
  assert.match(markdown.stdout, /# Classification preview:/);
  assert.ok(markdown.stdout.includes("sample/public\\-repo\\#1"));
  assert.ok(markdown.stdout.includes("Review evidence coverage, taxonomy and cache status"));
  assert.ok(!markdown.stdout.includes("%20"));
  const tty = run(args, 0, { CLASSIFY_TEST_TTY: "1" });
  assert.match(tty.stdout, /# Classification preview:/);
  assert.match(tty.stderr, /Captured 1 issues from 1 issue pages/);
  const ttyJson = run([...args, "--json"], 0, { CLASSIFY_TEST_TTY: "1" });
  assert.equal(JSON.parse(ttyJson.stdout).kind, "classification-preview");
  assert.equal(ttyJson.stderr, "");
  const colorEnv = { CLASSIFY_TEST_TTY: "1", CLASSIFY_TEST_FIXED_PERFORMANCE: "1" };
  for (const flags of [[], ["--json"]]) {
    const colorOn = run([...args, ...flags], 0, { ...colorEnv, NO_COLOR: undefined });
    const colorOff = run([...args, ...flags], 0, colorEnv);
    assert.equal(
      colorOn.stdout,
      colorOff.stdout,
      "NO_COLOR must not change any output, including deterministic timing",
    );
    assert.equal(colorOn.stderr, colorOff.stderr);
  }
  assert.deepEqual(readdirSync(home), []);
  assert.equal(gatewayCalls().length, 0);

  const scenario = (name: string, mode = "good", withKey = true): NodeJS.ProcessEnv => {
    const caseHome = join(owned, `home-${name}`);
    mkdirSync(caseHome);
    return {
      HOME: caseHome,
      XDG_CONFIG_HOME: caseHome,
      GH_CONFIG_DIR: caseHome,
      ISSUE_GRAPH_HOME: join(caseHome, "issue-graph"),
      CLASSIFY_TEST_GATEWAY_MODE: mode,
      ...(withKey ? { AI_GATEWAY_API_KEY: "synthetic-test-key" } : {}),
    };
  };
  const paidArgs = ["classify", "--repo", "sample/public-repo", "--json"];
  const paidRun = (
    extra: NodeJS.ProcessEnv,
    flags: string[] = [],
    expected = 0,
    calls = 1,
  ): SemanticReport => {
    const before = gatewayCalls().length;
    const result = run([...paidArgs, ...flags], expected, extra);
    const value: SemanticReport = JSON.parse(result.stdout);
    assert.equal(value.kind, "classification-report");
    assert.equal(value.execution.dryRun, false);
    assert.equal(value.execution.cache, flags.includes("--no-snapshot") ? "disabled" : "enabled");
    assert.equal(value.execution.gatewayCalls, calls);
    assert.equal(gatewayCalls().length - before, calls);
    assert.equal(value.items.length, 1);
    assert.equal(value.items[0].reviewRequired, true);
    if (expected === 0) assert.equal(result.stderr, "");
    const item = value.items[0];
    if (item.provenance) assert.equal(item.provenance.cacheHit, item.cacheStatus === "hit");
    if (calls === 0) {
      assert.equal(item.receipt, null);
      assert.equal(value.execution.receiptRecordsWritten, 0);
      assert.equal(value.execution.cacheEntriesWritten, 0);
      assert.equal(value.totals.evaluated, 0);
      assert.equal(value.totals.reportedCostUsd, 0);
      assert.equal(value.totals.hasUnknownCost, false);
    }
    if (calls) {
      assert.ok(item.receipt);
      assert.equal(item.provenance?.cacheHit ?? false, false);
      assert.equal(value.totals.cacheHits, 0);
      assert.equal(value.totals.cachedHistoricalCostUsd, 0);
      assert.equal(value.totals.hasUnknownHistoricalCost, false);
      const call = gatewayCalls().at(-1);
      assert.ok(call);
      assert.equal(call.inputBytes, value.items[0].inputBytes);
      assert.deepEqual(call.questionIds, [...value.items[0].questionIds].sort());
    }
    return value;
  };
  const receipt = (extra: NodeJS.ProcessEnv, item: SemanticReportItem, durable = true) => {
    assert.ok(item.receipt);
    const { pending, final } = item.receipt;
    assert.ok(final);
    assert.equal(pending.phase, "pending");
    assert.equal(final.phase, "final");
    assert.equal(pending.durable, durable);
    assert.equal(final.durable, durable);
    assert.equal(pending.inputHash, item.inputHash);
    assert.equal(final.inputHash, pending.inputHash);
    assert.equal(final.requestId, pending.requestId);
    assert.equal(final.createdAt, pending.createdAt);
    assert.equal(final.modelRequested, pending.modelRequested);
    assert.equal(final.adapterVersion, pending.adapterVersion);
    assert.ok(Date.parse(final.completedAt) >= Date.parse(pending.createdAt));
    if (item.provenance) {
      assert.equal(final.result.evaluatedAt, item.provenance.evaluatedAt);
      assert.equal(final.result.reportedCostUsd, item.provenance.reportedCostUsd);
      assert.deepEqual(final.result.tokenUsage, item.provenance.tokenUsage);
    }
    if (durable) {
      assert.ok(extra.ISSUE_GRAPH_HOME);
      const directory = join(
        extra.ISSUE_GRAPH_HOME,
        "classify",
        "receipts",
        pending.createdAt.slice(0, 10),
        pending.requestId,
      );
      for (const record of [pending, final]) {
        const text = readFileSync(join(directory, record.phase, "receipt.json"), "utf8");
        assertRedacted(text);
        assert.deepEqual(JSON.parse(text), record);
      }
      const call = gatewayCalls().find((entry) => entry.requestId === pending.requestId);
      assert.ok(call);
      assert.equal(call.pendingBeforeFetch, true);
      assert.equal(call.inputHash, pending.inputHash);
      const lock = join(extra.ISSUE_GRAPH_HOME, "classify", "locks", `${pending.inputHash}.json`);
      assert.equal(existsSync(lock), final.result.outcomeUnknown);
      if (final.result.outcomeUnknown) {
        assert.deepEqual(JSON.parse(readFileSync(lock, "utf8")), pending);
      }
    }
    return { pending, final };
  };

  const cached = (
    extra: NodeJS.ProcessEnv,
    value: SemanticReport,
    original: SemanticReportItem,
  ) => {
    const item = value.items[0];
    assert.ok(original.provenance);
    assert.ok(original.receipt?.final);
    assert.equal(item.receipt, null);
    assert.equal(item.inputHash, original.inputHash);
    assert.equal(item.outcome, original.outcome);
    assert.equal(item.cacheStatus, "hit");
    assert.ok(item.reasonCodes.includes("cache-hit"));
    assert.equal(item.cacheSourceRequestId, original.receipt.pending.requestId);
    assert.equal(item.cacheEvaluatedAt, original.provenance.evaluatedAt);
    assert.deepEqual(item.provenance, { ...original.provenance, cacheHit: true });
    assert.deepEqual(item.answers, original.answers);
    assert.equal(value.totals.cacheHits, 1);
    assert.equal(value.totals.reportedCostUsd, 0);
    assert.equal(value.totals.hasUnknownCost, false);
    assert.equal(value.totals.cachedHistoricalCostUsd, original.provenance.reportedCostUsd ?? 0);
    assert.equal(
      value.totals.hasUnknownHistoricalCost,
      original.provenance.reportedCostUsd === null,
    );
    assert.equal(value.execution.gatewayCalls, 0);
    assert.equal(value.execution.receiptRecordsWritten, 0);
    assert.equal(value.execution.cacheEntriesWritten, 0);
    receipt(extra, original);
  };
  const cacheBucket = (extra: NodeJS.ProcessEnv, item: SemanticReportItem) => {
    assert.ok(extra.ISSUE_GRAPH_HOME);
    assert.ok(item.inputHash);
    return join(extra.ISSUE_GRAPH_HOME, "classify", "cache", item.inputHash);
  };
  const cacheHistory = (extra: NodeJS.ProcessEnv, item: SemanticReportItem) => {
    assert.ok(item.receipt);
    return join(cacheBucket(extra, item), `${item.receipt.pending.requestId}.json`);
  };

  const successEnv = scenario("success");
  const success = paidRun(successEnv);
  assert.equal(success.coverageComplete, true);
  assert.equal(success.execution.receipts, "durable");
  assert.equal(success.execution.receiptRecordsWritten, 2);
  assert.equal(success.execution.cacheEntriesWritten, 1);
  assert.equal(success.items[0].cacheStatus, "miss");
  assert.equal(success.totals.cacheHits, 0);
  assert.equal(success.totals.cachedHistoricalCostUsd, 0);
  assert.equal(success.totals.evaluated, 1);
  assert.equal(success.totals.suggested, 1);
  assert.equal(success.totals.failed, 0);
  assert.equal(success.totals.reportedCostUsd, 0.0125);
  assert.equal(success.totals.hasUnknownCost, false);
  assert.equal(success.items[0].outcome, "suggested");
  assert.equal(success.items[0].impactReportedStatus, "applicable");
  assert.equal(success.items[0].answers?.requestType.type, "choice");
  assert.ok(success.items[0].answers?.requestType.type === "choice");
  assert.equal(success.items[0].answers.requestType.choice, "bug");
  assert.equal(success.items[0].inputBytes, report.items[0].inputBytes);
  assert.equal(success.items[0].inputHash, report.items[0].inputHash);
  assert.equal(success.items[0].provenance?.modelResolved, "typesafe-ai/jev");
  assert.deepEqual(success.items[0].provenance?.tokenUsage, { inputTokens: 120, outputTokens: 40 });
  const firstReceipt = receipt(successEnv, success.items[0]);
  assert.equal(firstReceipt.final.result.status, "succeeded");
  assert.equal(firstReceipt.final.result.outcomeUnknown, false);

  const warmNoKey = { ...successEnv, AI_GATEWAY_API_KEY: undefined };
  const warmTree = tree(successEnv.HOME as string);
  const firstHistory = readFileSync(cacheHistory(successEnv, success.items[0]), "utf8");
  const repeated = paidRun(warmNoKey, [], 0, 0);
  cached(successEnv, repeated, success.items[0]);
  const warmZero = paidRun(warmNoKey, ["--max-calls", "0"], 0, 0);
  cached(successEnv, warmZero, success.items[0]);
  assert.equal(warmZero.totals.deferred, 0);
  const beforeWarmPreview = gatewayCalls().length;
  const warmPreview = JSON.parse(run([...args, "--max-calls", "0"], 0, warmNoKey).stdout);
  assert.deepEqual(warmPreview.execution, {
    dryRun: true,
    gatewayCalls: 0,
    localWrites: 0,
    cache: "read-only",
  });
  assert.equal(warmPreview.totals.plannedCalls, 0);
  assert.equal(warmPreview.totals.cacheHits, 1);
  assert.equal(warmPreview.totals.deferred, 0);
  assert.equal(warmPreview.items[0].plannedCall, false);
  assert.equal(warmPreview.items[0].cacheStatus, "hit");
  assert.equal(warmPreview.items[0].cacheSourceRequestId, firstReceipt.pending.requestId);
  assert.equal(warmPreview.items[0].cacheEvaluatedAt, success.items[0].provenance?.evaluatedAt);
  assert.equal(gatewayCalls().length, beforeWarmPreview);
  assert.deepEqual(tree(successEnv.HOME as string), warmTree);

  const savedEnv = {
    ...warmNoKey,
    CLASSIFY_TEST_CACHED: "1",
    CLASSIFY_TEST_NOW: "2026-09-22T01:00:00.000Z",
  };
  const beforeSavedGh = readFileSync(log, "utf8");
  const beforeSavedGateway = gatewayCalls().length;
  const beforeSavedConsumer = tree(cwd);
  for (const flags of [["--cached"], ["--cached", "--max-calls", "0"]]) {
    const saved = paidRun(savedEnv, flags, 1, 0);
    cached(successEnv, saved, success.items[0]);
    assert.equal(saved.coverageComplete, false);
    assert.ok(saved.items[0].reasonCodes.includes("cached-evidence-not-revalidated"));
    assert.deepEqual(saved.evidenceSource, {
      mode: "cached",
      capturedAt: success.captureWindow.completedAt,
      ageMs: 3600000,
      liveRevalidated: false,
      reusedIssues: 1,
    });
    assert.equal(saved.performance?.githubCalls, 0);
    assert.equal(saved.performance?.githubRequestMs, 0);
  }
  const savedMarkdown = run(["classify", "--repo", "sample/public-repo", "--cached"], 1, {
    ...savedEnv,
    CLASSIFY_TEST_TTY: "1",
  });
  assert.match(savedMarkdown.stdout, /not live revalidated/);
  assert.match(savedMarkdown.stdout, /3600000/);
  assert.match(
    savedMarkdown.stderr,
    /saved evidence, not live revalidated; no network or inference/,
  );
  assert.doesNotMatch(savedMarkdown.stderr, /Captured/);
  const expiredSaved = paidRun(
    { ...savedEnv, CLASSIFY_TEST_NOW: "2026-09-24T00:00:00.000Z" },
    ["--cached"],
    1,
    0,
  );
  assert.equal(expiredSaved.totals.deferred, 1);
  assert.equal(expiredSaved.items[0].cacheStatus, "expired");
  assert.equal(expiredSaved.items[0].answers, null);
  assert.equal(expiredSaved.evidenceSource?.ageMs, 172800000);
  for (const extra of [
    savedEnv,
    { ...scenario("cached-missing", "good", false), CLASSIFY_TEST_CACHED: "1" },
  ]) {
    const missingSnapshot = run([...paidArgs, "--cached", "--limit", "1"], 1, extra);
    assert.equal(JSON.parse(missingSnapshot.stdout).error.code, "evidence-snapshot-missing");
  }
  assert.equal(readFileSync(log, "utf8"), beforeSavedGh);
  assert.equal(gatewayCalls().length, beforeSavedGateway);
  assert.deepEqual(tree(successEnv.HOME as string), warmTree);
  assert.deepEqual(tree(cwd), beforeSavedConsumer);

  const refreshPreview = JSON.parse(run([...args, "--refresh"], 0, warmNoKey).stdout);
  assert.equal(refreshPreview.execution.cache, "read-only");
  assert.equal(refreshPreview.execution.localWrites, 0);
  assert.equal(refreshPreview.execution.gatewayCalls, 0);
  assert.equal(refreshPreview.totals.plannedCalls, 1);
  assert.equal(refreshPreview.totals.cacheHits, 0);
  assert.equal(refreshPreview.items[0].cacheStatus, "refresh");
  assert.equal(gatewayCalls().length, beforeWarmPreview);
  assert.deepEqual(tree(successEnv.HOME as string), warmTree);

  const refreshZero = paidRun(warmNoKey, ["--refresh", "--max-calls", "0"], 1, 0);
  assert.equal(refreshZero.totals.deferred, 1);
  assert.equal(refreshZero.totals.failed, 0);
  assert.equal(refreshZero.totals.cacheHits, 0);
  assert.equal(refreshZero.items[0].outcome, "skipped");
  assert.equal(refreshZero.items[0].cacheStatus, "refresh");
  assert.ok(refreshZero.items[0].reasonCodes.includes("max-calls-reached"));
  assert.deepEqual(tree(successEnv.HOME as string), warmTree);

  const refreshed = paidRun(successEnv, ["--refresh"]);
  assert.equal(refreshed.items[0].inputHash, success.items[0].inputHash);
  assert.equal(refreshed.items[0].cacheStatus, "refresh");
  assert.equal(refreshed.totals.reportedCostUsd, 0.0125);
  assert.equal(refreshed.execution.cacheEntriesWritten, 1);
  const refreshedReceipt = receipt(successEnv, refreshed.items[0]);
  assert.notEqual(refreshedReceipt.pending.requestId, firstReceipt.pending.requestId);
  assert.equal(readFileSync(cacheHistory(successEnv, success.items[0]), "utf8"), firstHistory);
  assert.deepEqual(
    readdirSync(cacheBucket(successEnv, success.items[0])).sort(),
    [
      "current.json",
      `${firstReceipt.pending.requestId}.json`,
      `${refreshedReceipt.pending.requestId}.json`,
    ].sort(),
  );
  assert.equal(
    JSON.parse(
      readFileSync(join(cacheBucket(successEnv, success.items[0]), "current.json"), "utf8"),
    ).requestId,
    refreshedReceipt.pending.requestId,
  );
  const refreshedTree = tree(successEnv.HOME as string);
  const hotRefreshed = paidRun(warmNoKey, [], 0, 0);
  cached(successEnv, hotRefreshed, refreshed.items[0]);
  assert.equal(hotRefreshed.totals.cachedHistoricalCostUsd, 0.0125);
  assert.deepEqual(tree(successEnv.HOME as string), refreshedTree);
  receipt(successEnv, success.items[0]);

  const zeroEnv = scenario("zero", "good", false);
  const zero = paidRun(zeroEnv, ["--max-calls", "0"], 1, 0);
  assert.equal(zero.totals.deferred, 1);
  assert.equal(zero.items[0].outcome, "skipped");
  assert.ok(zero.items[0].reasonCodes.includes("max-calls-reached"));
  assert.equal(zero.items[0].receipt, null);
  assert.equal(zero.execution.receiptRecordsWritten, 0);
  evidenceOnly(zeroEnv);

  const memoryEnv: NodeJS.ProcessEnv = {
    ...scenario("memory"),
    CLASSIFY_TEST_NO_SNAPSHOT: "1",
  };
  const memoryBefore = tree(memoryEnv.HOME as string);
  const consumerBefore = tree(cwd);
  const memory = paidRun(memoryEnv, ["--no-snapshot"]);
  assert.equal(memory.items[0].outcome, "suggested");
  assert.equal(memory.execution.receipts, "memory-only");
  assert.equal(memory.execution.receiptRecordsWritten, 0);
  receipt(memoryEnv, memory.items[0], false);
  assert.equal(gatewayCalls().at(-1)?.pendingBeforeFetch, false);
  assert.equal(gatewayCalls().at(-1)?.requestId, null);
  assert.deepEqual(tree(memoryEnv.HOME as string), memoryBefore);
  assert.deepEqual(tree(cwd), consumerBefore);

  const warmMemoryEnv = { ...successEnv, CLASSIFY_TEST_NO_SNAPSHOT: "1" };
  const warmMemory = paidRun(warmMemoryEnv, ["--no-snapshot"]);
  assert.equal(warmMemory.items[0].cacheStatus, "disabled");
  assert.equal(warmMemory.items[0].outcome, "suggested");
  assert.equal(warmMemory.items[0].cacheSourceRequestId, null);
  assert.equal(warmMemory.execution.cacheEntriesWritten, 0);
  assert.equal(warmMemory.execution.receipts, "memory-only");
  assert.equal(warmMemory.execution.receiptRecordsWritten, 0);
  assert.equal(warmMemory.totals.reportedCostUsd, 0.0125);
  receipt(warmMemoryEnv, warmMemory.items[0], false);
  const beforeMemoryPreview = gatewayCalls().length;
  const warmMemoryPreview = JSON.parse(
    run([...args, "--no-snapshot", "--max-calls", "0"], 1, {
      ...warmMemoryEnv,
      AI_GATEWAY_API_KEY: undefined,
    }).stdout,
  );
  assert.equal(warmMemoryPreview.execution.cache, "disabled");
  assert.equal(warmMemoryPreview.execution.localWrites, 0);
  assert.equal(warmMemoryPreview.execution.gatewayCalls, 0);
  assert.equal(warmMemoryPreview.items[0].cacheStatus, "disabled");
  assert.equal(warmMemoryPreview.totals.cacheHits, 0);
  assert.equal(warmMemoryPreview.totals.plannedCalls, 0);
  assert.equal(warmMemoryPreview.totals.deferred, 1);
  assert.equal(gatewayCalls().length, beforeMemoryPreview);
  assert.deepEqual(tree(successEnv.HOME as string), refreshedTree);
  assert.deepEqual(tree(cwd), consumerBefore);
  cached(successEnv, paidRun(warmNoKey, [], 0, 0), refreshed.items[0]);

  const malformedEnv = scenario("malformed", "malformed");
  const malformed = paidRun(malformedEnv, [], 1);
  assert.equal(malformed.items[0].outcome, "failed");
  assert.equal(malformed.items[0].answers, null);
  assert.equal(malformed.items[0].provenance, null);
  assert.ok(malformed.items[0].reasonCodes.includes("invalid-evaluation"));
  assert.equal(malformed.totals.failed, 1);
  assert.equal(malformed.totals.hasUnknownCost, true);
  assert.equal(receipt(malformedEnv, malformed.items[0]).final.result.status, "failed");

  const missingEnv = scenario("missing-key", "good", false);
  const missing = paidRun(missingEnv, [], 1, 0);
  assert.equal(missing.items[0].outcome, "failed");
  assert.ok(missing.items[0].reasonCodes.includes("gateway-credentials-unavailable"));
  assert.equal(missing.items[0].receipt, null);
  assert.equal(missing.execution.receiptRecordsWritten, 0);
  evidenceOnly(missingEnv);

  const exceptionEnv = scenario("exception", "insufficient");
  const exception = paidRun(exceptionEnv);
  assert.equal(exception.items[0].outcome, "needs-review");
  assert.ok(exception.items[0].reasonCodes.includes("request-type-exception"));
  assert.equal(exception.totals.needsReview, 1);
  assert.equal(exception.totals.failed, 0);
  assert.equal(exception.items[0].impactReportedStatus, "not-applicable");
  assert.ok(exception.items[0].answers);
  assert.equal(Object.hasOwn(exception.items[0].answers, "impactReported"), false);
  assert.equal(receipt(exceptionEnv, exception.items[0]).final.result.status, "succeeded");

  const unknownEnv = scenario("unknown-cost", "unknown-cost");
  const unknown = paidRun(unknownEnv);
  assert.equal(unknown.items[0].outcome, "suggested");
  assert.equal(unknown.items[0].provenance?.reportedCostUsd, null);
  assert.equal(unknown.totals.reportedCostUsd, 0);
  assert.equal(unknown.totals.hasUnknownCost, true);
  assert.equal(receipt(unknownEnv, unknown.items[0]).final.result.reportedCostUsd, null);
  const unknownTree = tree(unknownEnv.HOME as string);
  const unknownHot = paidRun({ ...unknownEnv, AI_GATEWAY_API_KEY: undefined }, [], 0, 0);
  cached(unknownEnv, unknownHot, unknown.items[0]);
  assert.equal(unknownHot.totals.hasUnknownCost, false);
  assert.equal(unknownHot.totals.hasUnknownHistoricalCost, true);
  assert.deepEqual(tree(unknownEnv.HOME as string), unknownTree);

  const corruptEnv = scenario("corruption");
  const beforeCorrupt = paidRun(corruptEnv);
  const corruptReceipt = receipt(corruptEnv, beforeCorrupt.items[0]);
  const corruptPath = cacheHistory(corruptEnv, beforeCorrupt.items[0]);
  const corruptEntry = JSON.parse(readFileSync(corruptPath, "utf8"));
  corruptEntry.checksum = "0".repeat(64);
  writeFileSync(corruptPath, `${JSON.stringify(corruptEntry)}\n`);
  const corruptTree = tree(corruptEnv.HOME as string);
  const corrupt = paidRun(corruptEnv, [], 1, 0);
  assert.equal(corrupt.items[0].cacheStatus, "invalid");
  assert.equal(corrupt.items[0].outcome, "failed");
  assert.ok(corrupt.items[0].reasonCodes.includes("cache-invalid"));
  assert.equal(corrupt.items[0].answers, null);
  assert.equal(corrupt.items[0].provenance, null);
  assert.deepEqual(tree(corruptEnv.HOME as string), corruptTree);
  const beforeCorruptPreview = gatewayCalls().length;
  const corruptPreview = JSON.parse(run(args, 1, corruptEnv).stdout);
  assert.equal(corruptPreview.items[0].cacheStatus, "invalid");
  assert.ok(corruptPreview.items[0].reasonCodes.includes("cache-invalid"));
  assert.equal(corruptPreview.totals.plannedCalls, 0);
  assert.equal(corruptPreview.execution.localWrites, 0);
  assert.equal(gatewayCalls().length, beforeCorruptPreview);
  assert.deepEqual(tree(corruptEnv.HOME as string), corruptTree);
  const recovered = paidRun(corruptEnv, ["--refresh"]);
  assert.equal(recovered.items[0].outcome, "suggested");
  assert.equal(recovered.items[0].cacheStatus, "refresh");
  assert.notEqual(
    receipt(corruptEnv, recovered.items[0]).pending.requestId,
    corruptReceipt.pending.requestId,
  );
  assert.deepEqual(JSON.parse(readFileSync(corruptPath, "utf8")), corruptEntry);
  receipt(corruptEnv, beforeCorrupt.items[0]);
  cached(
    corruptEnv,
    paidRun({ ...corruptEnv, AI_GATEWAY_API_KEY: undefined }, [], 0, 0),
    recovered.items[0],
  );

  for (const fixture of [
    {
      name: "default-throttle",
      mode: "throttle",
      flags: [],
      calls: 1,
      exit: 1,
      refusal: "retries-disabled",
    },
    {
      name: "retry-success",
      mode: "retry-success",
      flags: ["--max-retries", "1", "--max-calls", "2"],
      calls: 2,
      exit: 0,
    },
    {
      name: "retry-budget",
      mode: "throttle",
      flags: ["--max-retries", "3", "--max-calls", "2"],
      calls: 2,
      exit: 1,
    },
    {
      name: "retry-bound",
      mode: "throttle",
      flags: ["--max-retries", "1", "--max-calls", "4"],
      calls: 2,
      exit: 1,
    },
    {
      name: "retry-long-wait",
      mode: "long-wait",
      flags: ["--max-retries", "1", "--max-calls", "2"],
      calls: 1,
      exit: 1,
      refusal: "retry-wait-exceeds-limit",
    },
  ]) {
    const extra: NodeJS.ProcessEnv = {
      ...scenario(fixture.name, fixture.mode),
      CLASSIFY_TEST_MAX_ATTEMPTS: String(fixture.calls),
    };
    const value = paidRun(extra, fixture.flags, fixture.exit, fixture.calls);
    assert.equal(value.execution.receiptRecordsWritten, fixture.calls * 2);
    assert.equal(value.execution.cacheEntriesWritten, fixture.exit === 0 ? 1 : 0);
    assert.equal(value.totals.reportedCostUsd, fixture.exit === 0 ? 0.0125 : 0);
    assert.equal(
      value.totals.hasUnknownCost,
      true,
      "Earlier 429 cost remains unknown after successful retry",
    );
    const attempts = value.items[0].attempts;
    assert.ok(attempts);
    assert.equal(attempts.length, fixture.calls);
    assert.equal(
      new Set(attempts.map((attempt) => attempt.receipt.pending.requestId)).size,
      fixture.calls,
    );
    assert.deepEqual(value.items[0].receipt, attempts.at(-1)?.receipt);
    for (const [index, attempt] of attempts.entries()) {
      assert.equal(attempt.attempted, true);
      const final = attempt.receipt.final;
      assert.ok(final);
      assert.equal(final.result.outcomeUnknown, false);
      assert.equal(final.result.reportedCostUsd, fixture.exit === 0 && index === 1 ? 0.0125 : null);
      const timing = attempt.gatewayTiming;
      assert.ok(timing);
      assert.ok(Number.isFinite(timing.totalMs) && timing.totalMs >= 0);
      const pending = attempt.receipt.pending;
      for (const record of [pending, final]) {
        const text = readFileSync(
          join(
            extra.ISSUE_GRAPH_HOME as string,
            "classify",
            "receipts",
            pending.createdAt.slice(0, 10),
            pending.requestId,
            record.phase,
            "receipt.json",
          ),
          "utf8",
        );
        assertRedacted(text);
        assert.deepEqual(JSON.parse(text), record);
      }
      if (final.result.status === "failed") {
        assert.equal(attempt.providerError?.status, 429);
        const diagnostic = attempt.providerError?.diagnostic;
        assert.ok(diagnostic);
        assert.equal(diagnostic.trust, "untrusted");
        assert.equal(diagnostic.code, "synthetic_throttle");
        assert.equal(diagnostic.type, "rate_limit");
        assert.equal(Object.hasOwn(diagnostic, "message"), false);
        assert.equal(Object.hasOwn(diagnostic, "providerReported"), false);
        assert.ok(diagnostic.requestId?.startsWith("fixture-"));
      }
    }
    if (fixture.refusal)
      assert.equal(value.items[0].providerError?.retryRefusalReason, fixture.refusal);
    tree(extra.HOME as string);
  }
  const diagnosticMarkdown = run(["classify", "--repo", "sample/public-repo"], 1, {
    ...scenario("diagnostic-tty", "throttle"),
    CLASSIFY_TEST_TTY: "1",
  });
  assert.match(diagnosticMarkdown.stdout, /provider diagnostic \(untrusted\)/);
  assert.ok(diagnosticMarkdown.stdout.includes("synthetic\\_throttle"));
  assert.ok(diagnosticMarkdown.stdout.includes("fixture\\-"));

  const transportEnv = scenario("transport", "transport-error");
  const transport = paidRun(transportEnv, [], 1);
  assert.equal(transport.items[0].outcome, "failed");
  assert.equal(transport.items[0].providerError?.code, "gateway-network-error");
  assert.equal(transport.totals.hasUnknownCost, true);
  const transportReceipt = receipt(transportEnv, transport.items[0]);
  assert.equal(transportReceipt.final.result.outcomeUnknown, true);
  assert.equal(transportReceipt.final.result.status, "failed");
  const transportTree = tree(transportEnv.HOME as string);
  for (const flags of [[], ["--refresh"]]) {
    const blocked = paidRun({ ...transportEnv, CLASSIFY_TEST_GATEWAY_MODE: "good" }, flags, 1, 0);
    assert.equal(blocked.items[0].inputHash, transport.items[0].inputHash);
    assert.equal(blocked.items[0].outcome, "failed");
    assert.equal(blocked.items[0].cacheStatus, "blocked");
    assert.ok(blocked.items[0].reasonCodes.includes("in-flight-or-unknown"));
    assert.equal(blocked.items[0].receipt, null);
    assert.equal(blocked.execution.receiptRecordsWritten, 0);
    assert.deepEqual(tree(transportEnv.HOME as string), transportTree);
    receipt(transportEnv, transport.items[0]);
  }
  const pendingEnv = scenario("pending-only", "transport-error");
  const pendingReport = paidRun(pendingEnv, [], 1);
  const pendingReceipt = receipt(pendingEnv, pendingReport.items[0]);
  rmSync(
    join(
      pendingEnv.ISSUE_GRAPH_HOME as string,
      "classify",
      "receipts",
      pendingReceipt.pending.createdAt.slice(0, 10),
      pendingReceipt.pending.requestId,
      "final",
    ),
    { recursive: true },
  );
  const pendingTree = tree(pendingEnv.HOME as string);
  for (const flags of [[], ["--refresh"]]) {
    const blocked = paidRun({ ...pendingEnv, CLASSIFY_TEST_GATEWAY_MODE: "good" }, flags, 1, 0);
    assert.equal(blocked.items[0].cacheStatus, "blocked");
    assert.equal(blocked.items[0].outcome, "failed");
    assert.ok(blocked.items[0].reasonCodes.includes("in-flight-or-unknown"));
    assert.deepEqual(tree(pendingEnv.HOME as string), pendingTree);
  }

  const boundaryEnv = scenario("byte-cap");
  const boundaryPath = join(cwd, "byte-cap-taxonomy.json");
  const boundaryTaxonomy = {
    schemaVersion: 1,
    repo: "sample/public-repo",
    version: "byte-cap-1",
    components: Array.from({ length: 12 }, (_, index) => ({
      id: `component-${index}`,
      description: "x",
    })),
  };
  writeFileSync(boundaryPath, JSON.stringify(boundaryTaxonomy));
  const beforeBoundary = gatewayCalls().length;
  const baseline = JSON.parse(run([...args, "--taxonomy", boundaryPath]).stdout);
  let remaining = 24000 - baseline.items[0].inputBytes;
  assert.ok(Number.isInteger(remaining) && remaining > 0);
  for (const component of boundaryTaxonomy.components) {
    const pairs = Math.min(1998, Math.floor(remaining / 2));
    component.description += "é".repeat(pairs);
    remaining -= pairs * 2;
    if (remaining === 1) {
      component.description += "x";
      remaining--;
    }
  }
  assert.equal(remaining, 0);
  writeFileSync(boundaryPath, JSON.stringify(boundaryTaxonomy));
  const boundaryPreview = JSON.parse(run([...args, "--taxonomy", boundaryPath]).stdout);
  assert.equal(boundaryPreview.items[0].inputBytes, 24000);
  assert.equal(gatewayCalls().length, beforeBoundary);
  const boundary = paidRun(boundaryEnv, ["--taxonomy", boundaryPath]);
  assert.equal(boundary.items[0].inputBytes, 24000);
  assert.equal(boundary.items[0].inputHash, boundaryPreview.items[0].inputHash);
  assert.equal(boundary.items[0].outcome, "suggested");
  assert.equal(boundary.totals.oversized, 0);
  assert.equal(boundary.totals.deferred, 0);
  assert.equal(gatewayCalls().at(-1)?.inputBytes, 24000);
  receipt(boundaryEnv, boundary.items[0]);
  const spare = boundaryTaxonomy.components.find(
    (component) => component.description.length < 2000,
  );
  assert.ok(spare);
  spare.description += "x";
  writeFileSync(boundaryPath, JSON.stringify(boundaryTaxonomy));
  const beforeOversized = gatewayCalls().length;
  const oversizedPreview = JSON.parse(run([...args, "--taxonomy", boundaryPath]).stdout);
  assert.equal(oversizedPreview.coverageComplete, true);
  assert.equal(oversizedPreview.items[0].inputBytes, 24001);
  assert.equal(oversizedPreview.items[0].outcome, "needs-review");
  assert.ok(oversizedPreview.items[0].reasonCodes.includes("input-too-large"));
  assert.equal(oversizedPreview.totals.oversized, 1);
  assert.equal(oversizedPreview.totals.deferred, 0);
  assert.equal(oversizedPreview.totals.plannedCalls, 0);
  assert.equal(oversizedPreview.execution.gatewayCalls, 0);
  assert.equal(oversizedPreview.execution.localWrites, 0);
  assert.deepEqual(readdirSync(home), []);
  for (const noSnapshot of [false, true]) {
    const oversizedEnv: NodeJS.ProcessEnv = {
      ...scenario(noSnapshot ? "over-byte-cap-memory" : "over-byte-cap", "good", false),
      ...(noSnapshot ? { CLASSIFY_TEST_NO_SNAPSHOT: "1" } : {}),
    };
    const oversized = paidRun(
      oversizedEnv,
      ["--taxonomy", boundaryPath, ...(noSnapshot ? ["--no-snapshot"] : [])],
      1,
      0,
    );
    assert.equal(oversized.items[0].inputBytes, 24001);
    assert.equal(oversized.items[0].outcome, "needs-review");
    assert.ok(oversized.items[0].reasonCodes.includes("input-too-large"));
    assert.equal(oversized.totals.oversized, 1);
    assert.equal(oversized.totals.deferred, 1);
    assert.equal(oversized.totals.needsReview, 1);
    assert.equal(oversized.totals.failed, 0);
    assert.equal(oversized.items[0].answers, null);
    assert.equal(oversized.items[0].provenance, null);
    assert.equal(oversized.items[0].receipt, null);
    if (noSnapshot) assert.deepEqual(readdirSync(oversizedEnv.HOME as string), []);
    else evidenceOnly(oversizedEnv);
  }
  assert.equal(gatewayCalls().length, beforeOversized);

  const reportTtyEnv: NodeJS.ProcessEnv = { ...scenario("report-tty"), CLASSIFY_TEST_TTY: "1" };
  const beforeReportTty = gatewayCalls().length;
  const reportTty = run(["classify", "--repo", "sample/public-repo"], 0, reportTtyEnv);
  assert.match(reportTty.stdout, /# Classification suggestions:/);
  assert.match(reportTty.stdout, /Human review required/);
  assert.match(reportTty.stderr, /Captured 1 issues from 1 issue pages/);
  assert.equal(gatewayCalls().length - beforeReportTty, 1);
  assert.match(reportTty.stdout, /Reported cost known subtotal: USD 0\.0125; unknown cost: no/);
  assert.match(reportTty.stdout, /Cached historical cost \(not current spend\): USD 0;/);
  const reportTtyTree = tree(reportTtyEnv.HOME as string);
  const hotReportTty = run(["classify", "--repo", "sample/public-repo", "--max-calls", "0"], 0, {
    ...reportTtyEnv,
    AI_GATEWAY_API_KEY: undefined,
  });
  assert.match(hotReportTty.stdout, /Gateway attempts: 0\/0; evaluated 0;/);
  assert.match(hotReportTty.stdout, /Reported cost known subtotal: USD 0; unknown cost: no/);
  assert.match(hotReportTty.stdout, /Cached historical cost \(not current spend\): USD 0\.0125;/);
  assert.match(hotReportTty.stdout, /Cache: enabled; hits 1; entries written 0;/);
  assert.equal(gatewayCalls().length - beforeReportTty, 1);
  assert.deepEqual(tree(reportTtyEnv.HOME as string), reportTtyTree);
  paidRun({ ...scenario("report-tty-json"), CLASSIFY_TEST_TTY: "1" });

  const coreUrl = pathToFileURL(join(target, "dist/index.js")).href;
  const beforeCore = gatewayCalls().length;
  const coreProbe = spawnSync(
    "node",
    [
      "--input-type=module",
      "-e",
      `
import assert from "node:assert/strict";
const core = await import(${JSON.stringify(coreUrl)});
for (const name of ["collectSemanticEvidence", "buildClassificationPreview", "buildEvaluationInput", "fingerprintInput", "validateTaxonomy", "renderClassificationPreview", "buildEvaluationRequest", "fingerprintEvaluation", "validateEvaluation", "decideSuggestion", "renderClassificationReport", "crawl", "collectStatus"]) assert.equal(typeof core[name], "function", name);
for (const name of ["runSemanticCli", "runSemanticPreview", "runSemanticEvaluation", "createSemanticCacheStore", "createSemanticReceiptStore", "evaluateWithJev"]) assert.equal(core[name], undefined, name);
`,
    ],
    { cwd, env, encoding: "utf8" },
  );
  assert.ifError(coreProbe.error);
  assertRedacted(coreProbe.stdout + coreProbe.stderr);
  assert.equal(coreProbe.status, 0, coreProbe.stderr);
  assert.equal(gatewayCalls().length, beforeCore);
  assert.deepEqual(readdirSync(home), []);
  checks++;
  console.log("PASS exit 0: Node core exports from packaged dist");
  if (ttyDemo) {
    assert.equal(process.stdout.isTTY, true, "--tty-demo requires a real terminal");
    const demoResult = spawnSync("issue-graph", args, {
      cwd,
      env: { ...env, CLASSIFY_TEST_CASE: "demo" },
      stdio: "inherit",
    });
    assert.ifError(demoResult.error);
    assert.equal(demoResult.status, 1);
    checks++;
    console.log("PASS exit 1: real TTY fixture preview with closure exclusion");
    const ttyReportEnv = scenario("real-tty");
    const before = gatewayCalls().length;
    const reportResult = spawnSync("issue-graph", ["classify", "--repo", "sample/public-repo"], {
      cwd,
      env: { ...env, ...ttyReportEnv },
      stdio: "inherit",
    });
    assert.ifError(reportResult.error);
    assert.equal(reportResult.signal, null);
    assert.equal(reportResult.status, 0);
    assert.equal(gatewayCalls().length - before, 1);
    checks++;
    console.log("PASS exit 0: real TTY cold synthetic Gateway review-required report");
    const beforeHot = gatewayCalls().length;
    const ttyTree = tree(ttyReportEnv.HOME as string);
    const hotResult = spawnSync(
      "issue-graph",
      ["classify", "--repo", "sample/public-repo", "--max-calls", "0"],
      {
        cwd,
        env: { ...env, ...ttyReportEnv, AI_GATEWAY_API_KEY: undefined },
        stdio: "inherit",
      },
    );
    assert.ifError(hotResult.error);
    assert.equal(hotResult.signal, null);
    assert.equal(hotResult.status, 0);
    assert.equal(gatewayCalls().length, beforeHot);
    assert.deepEqual(tree(ttyReportEnv.HOME as string), ttyTree);
    checks++;
    console.log("PASS exit 0: real TTY hot report, no key or HTTP, historical cost only");
    const hotJson = paidRun(
      { ...ttyReportEnv, AI_GATEWAY_API_KEY: undefined },
      ["--max-calls", "0"],
      0,
      0,
    );
    assert.equal(hotJson.totals.cacheHits, 1);
    assert.equal(hotJson.totals.cachedHistoricalCostUsd, 0.0125);
    assert.equal(hotJson.totals.hasUnknownHistoricalCost, false);
  }
  for (const name of readdirSync(owned).filter(
    (name) => name === "home" || name.startsWith("home-"),
  )) {
    tree(join(owned, name));
  }
  assertRedacted(readFileSync(log, "utf8"));
  console.log(
    `PASS: ${checks} classify/legacy/package checks on ${process.version}; offline, foreign cwd, isolated PATH/home, no Bun in consumer PATH`,
  );
} finally {
  rmSync(owned, { recursive: true, force: true });
}
