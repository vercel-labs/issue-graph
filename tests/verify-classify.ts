import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SemanticReportItem } from "../src/semantic-types.js";

assert.equal(process.release.name, "node");
const source = fileURLToPath(new URL("../", import.meta.url));
const installed = process.argv.slice(2).find((arg) => arg !== "--tty-demo");
const target = fs.realpathSync(installed ? resolve(installed) : source);
const json = (path: string) => JSON.parse(fs.readFileSync(path, "utf8"));
const manifest = json(join(target, "package.json"));
assert.equal(manifest.name, "issue-graph");
const owned = fs.mkdtempSync(join(source, ".package-test-classify-"));
let checks = 0;
try {
  const [bin, home, cwd] = ["bin", "home", "consumer"].map((name) => join(owned, name));
  for (const path of [bin, home, cwd]) fs.mkdirSync(path);
  fs.writeFileSync(join(bin, "package.json"), '{"type":"commonjs"}\n');
  fs.symlinkSync(process.execPath, join(bin, "node"));
  fs.symlinkSync(join(target, manifest.bin["issue-graph"]), join(bin, "issue-graph"));
  const fixtures = join(source, "tests/fixtures/classify");
  fs.writeFileSync(join(bin, "gh"), fs.readFileSync(join(fixtures, "gh.cjs")));
  fs.chmodSync(join(bin, "gh"), 0o755);
  const gh = join(owned, "gh.log"),
    gateway = join(owned, "gateway.jsonl");
  const violations = join(owned, "violations.log");
  const text = (path: string) => (fs.existsSync(path) ? fs.readFileSync(path, "utf8") : "");
  const calls = () =>
    text(gateway)
      .match(/[^\n]+/g)
      ?.map((line) => JSON.parse(line)) ?? [];
  const tree = (root: string): unknown =>
    fs
      .readdirSync(root)
      .sort()
      .map((name) => {
        const path = join(root, name),
          stat = fs.lstatSync(path);
        assert.equal(stat.isSymbolicLink(), false);
        return [name, stat.mode, stat.mtimeMs, stat.isDirectory() ? tree(path) : text(path)];
      });
  const env: NodeJS.ProcessEnv = {
    PATH: bin,
    HOME: home,
    XDG_CONFIG_HOME: home,
    GH_CONFIG_DIR: home,
    ISSUE_GRAPH_HOME: join(home, "issue-graph"),
    NO_COLOR: "1",
    NODE_OPTIONS: `--require=${JSON.stringify(join(fixtures, "gateway-preload.cjs"))}`,
    CLASSIFY_TEST_LOG: gh,
    CLASSIFY_TEST_GATEWAY_LOG: gateway,
    CLASSIFY_TEST_VIOLATIONS: violations,
  };
  const run = (args: string[], expected = 0, extra: NodeJS.ProcessEnv = {}) => {
    const result = spawnSync("issue-graph", args, {
      cwd,
      env: { ...env, ...extra },
      encoding: "utf8",
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(text(violations), "");
    assert.equal(result.status, expected, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /synthetic-test-key|SYNTHETIC_(SECRET|BODY)_NOT_OUTPUT/,
    );
    checks++;
    console.log(`PASS exit ${expected}: issue-graph ${args.join(" ")}`);
    return result;
  };
  const args = ["classify", "--repo", "sample/public-repo", "--json"];
  const classify = (flags: string[], expected = 0, extra: NodeJS.ProcessEnv = {}) =>
    JSON.parse(run([...args, ...flags], expected, { CLASSIFY_TEST_GH: "1", ...extra }).stdout);
  const receipt = (item: SemanticReportItem, unknown = false) => {
    assert.ok(item.receipt?.final);
    const { pending, final } = item.receipt;
    const root = join(env.ISSUE_GRAPH_HOME as string, "classify");
    const directory = join(root, "receipts", pending.createdAt.slice(0, 10), pending.requestId);
    assert.deepEqual(json(join(directory, "pending/receipt.json")), pending);
    assert.deepEqual(json(join(directory, "final/receipt.json")), final);
    assert.deepEqual(calls().at(-1), pending);
    assert.equal(final.requestId, pending.requestId);
    assert.equal(final.inputHash, item.inputHash);
    assert.equal(final.durable, true);
    assert.equal(final.result.outcomeUnknown, unknown);
    assert.equal(fs.existsSync(join(root, "locks", `${item.inputHash}.json`)), unknown);
  };
  assert.match(run(["classify", "--help"]).stdout, /--dry-run/);
  const schema = JSON.parse(run(["schema"]).stdout).commands.classify;
  assert.equal(schema.outputKind, "classification-report");
  assert.ok(schema.flags.includes("--cached"));
  const guide = JSON.parse(run(["skills", "get", "core", "--full", "--json"]).stdout);
  assert.match(guide.data[0].content, /incur charges/);
  assert.match(guide.data[0].content, /unknown-outcome locks/);
  assert.match(run(["status", "--help"]).stdout, /usage:/);
  assert.match(run([], 2).stderr, /usage:/);
  const invalid = JSON.parse(run([...args, "--unknown-flag"], 2).stdout);
  assert.equal(invalid.error.code, "invalid-arguments");
  assert.equal(text(gh), "");
  const snapshot = () => [tree(home), tree(cwd)];
  const pristine = snapshot();
  const preview = classify(["--dry-run"]);
  assert.equal(preview.kind, "classification-preview");
  assert.equal(preview.coverageComplete, true);
  assert.equal(preview.totals.plannedCalls, 1);
  assert.equal(preview.execution.localWrites, 0);
  const privateReport = classify(["--dry-run"], 1, { CLASSIFY_TEST_CASE: "private" });
  assert.equal(privateReport.error.code, "repository-not-public");
  const partial = classify(["--dry-run", "--limit", "1"], 1, { CLASSIFY_TEST_CASE: "partial" });
  assert.equal(partial.coverageComplete, false);
  assert.deepEqual(snapshot(), pristine);
  assert.equal(calls().length, 0);
  const active = { CLASSIFY_TEST_ACTIVE: "1", AI_GATEWAY_API_KEY: "synthetic-test-key" };
  const cold = classify([], 0, active);
  assert.equal(cold.kind, "classification-report");
  assert.equal(cold.coverageComplete, true);
  assert.equal(cold.items[0].outcome, "suggested");
  assert.equal(cold.items[0].reviewRequired, true);
  assert.equal(cold.execution.gatewayCalls, 1);
  assert.equal(calls().length, 1);
  receipt(cold.items[0]);
  const warmTree = snapshot(),
    ghBeforeWarm = text(gh);
  const warm = classify(["--max-calls", "0"]);
  assert.equal(warm.items[0].cacheStatus, "hit");
  assert.equal(warm.items[0].cacheSourceRequestId, cold.items[0].receipt.pending.requestId);
  assert.deepEqual(warm.items[0].answers, cold.items[0].answers);
  assert.equal(warm.execution.gatewayCalls, 0);
  assert.notEqual(text(gh), ghBeforeWarm);
  assert.deepEqual(snapshot(), warmTree);
  const ghBeforeCached = text(gh);
  const cached = classify(["--cached"], 1, { CLASSIFY_TEST_GH: "0" });
  assert.equal(cached.items[0].cacheStatus, "hit");
  assert.equal(cached.coverageComplete, false);
  assert.equal(cached.evidenceSource.liveRevalidated, false);
  assert.ok(cached.items[0].reasonCodes.includes("cached-evidence-not-revalidated"));
  assert.equal(text(gh), ghBeforeCached);
  assert.equal(calls().length, 1);
  assert.deepEqual(snapshot(), warmTree);
  const unknown = classify(["--refresh"], 1, {
    ...active,
    CLASSIFY_TEST_GATEWAY_MODE: "transport-error",
  });
  assert.equal(unknown.items[0].providerError.code, "gateway-network-error");
  assert.equal(calls().length, 2);
  receipt(unknown.items[0], true);
  const unknownTree = snapshot();
  const blocked = classify(["--refresh"], 1);
  assert.equal(blocked.items[0].cacheStatus, "blocked");
  assert.ok(blocked.items[0].reasonCodes.includes("in-flight-or-unknown"));
  assert.equal(blocked.execution.gatewayCalls, 0);
  assert.equal(calls().length, 2);
  assert.deepEqual(snapshot(), unknownTree);
  console.log(`PASS: ${checks} classify/legacy/package checks`);
} finally {
  fs.rmSync(owned, { recursive: true, force: true });
}
