const assert = require("node:assert/strict");
const { appendFileSync, readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const active = process.env.CLASSIFY_TEST_ACTIVE === "1";
const root = join(process.env.ISSUE_GRAPH_HOME, "classify");
const forbidden = () => {
  appendFileSync(process.env.CLASSIFY_TEST_VIOLATIONS, "forbidden network/auth/subprocess\n");
  throw new Error("Forbidden smoke I/O");
};
require("node:net").Socket.prototype.connect = forbidden;
require("node:tls").connect = forbidden;
require("node:dgram").Socket.prototype.send = forbidden;
process.env = new Proxy(process.env, {
  get(target, key) {
    if (key === "AI_GATEWAY_API_KEY" && !active) forbidden();
    return Reflect.get(target, key);
  },
});
const child = require("node:child_process");
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  const original = child[name];
  child[name] = function (command, args, ...rest) {
    if (process.env.CLASSIFY_TEST_GH !== "1" || command !== "gh") forbidden();
    if (args?.[0] !== "api" || args?.[1] !== "graphql") forbidden();
    return Reflect.apply(original, this, [command, args, ...rest]);
  };
}
require("node:module").syncBuiltinESMExports();
let attempts = 0;
globalThis.fetch = async (url, options) => {
  if (!active || url !== "https://ai-gateway.vercel.sh/v1/evaluate") forbidden();
  assert.equal(++attempts, 1);
  assert.equal(options.method, "POST");
  assert.equal(options.redirect, "error");
  assert.equal(new Headers(options.headers).get("authorization"), "Bearer synthetic-test-key");
  const request = JSON.parse(options.body);
  assert.equal(request.model, "typesafe-ai/jev");
  assert.deepEqual(request.providerOptions, { gateway: { only: ["typesafe-ai"] } });
  const locks = readdirSync(join(root, "locks"));
  assert.equal(locks.length, 1);
  const lock = JSON.parse(readFileSync(join(root, "locks", locks[0]), "utf8"));
  const directory = join(root, "receipts", lock.createdAt.slice(0, 10), lock.requestId);
  const path = join(directory, "pending/receipt.json");
  const pending = JSON.parse(await require("node:fs/promises").readFile(path, "utf8"));
  assert.deepEqual(pending, lock);
  assert.equal(pending.phase, "pending");
  assert.equal(pending.durable, true);
  appendFileSync(process.env.CLASSIFY_TEST_GATEWAY_LOG, `${JSON.stringify(pending)}\n`);
  if (process.env.CLASSIFY_TEST_GATEWAY_MODE === "transport-error")
    throw new Error("SYNTHETIC_SECRET_NOT_OUTPUT");
  const answers = Object.fromEntries(
    Object.entries(request.questions).map(([id, question]) => {
      if (question.type === "boolean") return [id, { type: "boolean", probability: 0.9 }];
      assert.ok(["choice", "score"].includes(question.type));
      const keys = Object.keys(question.criteria);
      const choice = id === "requestType" ? "bug" : keys[0];
      assert.ok(keys.includes(choice));
      const probabilities = Object.fromEntries(keys.map((key) => [key, key === choice ? 1 : 0]));
      if (question.type === "score")
        return [id, { type: "score", probabilities, score: Number(choice) }];
      return [id, { type: "choice", probabilities, choice }];
    }),
  );
  return Response.json({
    model: request.model,
    answers,
    usage: { inputTokens: 120, outputTokens: 40 },
    providerMetadata: { gateway: { cost: "0.0125" } },
  });
};
