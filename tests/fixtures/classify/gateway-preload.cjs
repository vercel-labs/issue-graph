const assert = require("node:assert/strict");
const { appendFileSync, existsSync, readdirSync, readFileSync } = require("node:fs");
const { join, resolve, sep } = require("node:path");
const { fileURLToPath } = require("node:url");

const mode = process.env.CLASSIFY_TEST_GATEWAY_MODE ?? "good";
const log = process.env.CLASSIFY_TEST_GATEWAY_LOG;
const memoryOnly = process.env.CLASSIFY_TEST_NO_SNAPSHOT === "1";
const cachedOnly = process.env.CLASSIFY_TEST_CACHED === "1";
const maxAttempts = Number(process.env.CLASSIFY_TEST_MAX_ATTEMPTS ?? "1");
assert.ok(Number.isInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= 4);
if (process.env.CLASSIFY_TEST_NOW) {
  const NativeDate = Date;
  const now = NativeDate.parse(process.env.CLASSIFY_TEST_NOW);
  assert.ok(Number.isFinite(now));
  globalThis.Date = class extends NativeDate {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() {
      return now;
    }
  };
}
if (process.env.CLASSIFY_TEST_FIXED_PERFORMANCE === "1") {
  let tick = 0;
  Object.defineProperty(performance, "now", { value: () => ++tick });
}
const violation = (operation) => {
  appendFileSync(process.env.CLASSIFY_TEST_STORAGE_LOG, `${JSON.stringify({ operation })}\n`);
  throw new Error("Forbidden smoke I/O or key access");
};
if (require("node:path").basename(process.argv[1] ?? "") !== "gh") {
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write;
    stream.write = function (chunk, ...args) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      if (
        [
          "SYNTHETIC_BODY_NOT_OUTPUT",
          "Synthetic title, not output",
          "SYNTHETIC_COMMENT_NOT_OUTPUT",
          "SYNTHETIC_SECRET_NOT_OUTPUT",
          "synthetic-test-key",
          "SYNTHETIC_PROVIDER_PROSE_NOT_OUTPUT",
        ].some((marker) => text.includes(marker))
      )
        violation("output-redaction");
      return Reflect.apply(write, this, [chunk, ...args]);
    };
  }
}
if (cachedOnly) {
  process.env = new Proxy(process.env, {
    get(target, key) {
      if (key === "AI_GATEWAY_API_KEY") violation("gateway-key-read");
      return Reflect.get(target, key);
    },
  });
  const child = require("node:child_process");
  for (const name of [
    "spawn",
    "spawnSync",
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "fork",
  ]) {
    child[name] = () => violation(`cached-${name}`);
  }
}
const model = "typesafe-ai/jev";
let attempts = 0;

const networkForbidden = () => {
  throw new Error("Network forbidden in classify smoke");
};
require("node:net").Socket.prototype.connect = networkForbidden;
require("node:tls").connect = networkForbidden;
require("node:dgram").Socket.prototype.send = networkForbidden;

if (memoryOnly || cachedOnly) {
  const fs = require("node:fs");
  const promises = require("node:fs/promises");
  const root = resolve(process.env.ISSUE_GRAPH_HOME);
  const stop = join(root, "classify", "STOP");
  const guard = (operation, original) =>
    function (...args) {
      for (const argument of args.slice(
        0,
        ["rename", "link", "symlink", "cp", "copyFile"].some((name) => operation.startsWith(name))
          ? 2
          : 1,
      )) {
        const path =
          argument instanceof URL
            ? fileURLToPath(argument)
            : Buffer.isBuffer(argument)
              ? argument.toString("utf8")
              : argument;
        if (typeof path !== "string") continue;
        const absolute = resolve(path);
        const inside = absolute === root || absolute.startsWith(`${root}${sep}`);
        const readOnly =
          /^(?:access|exists|lstat|opendir|readdir|readFile|readlink|realpath|stat|createReadStream)(?:Sync)?$/.test(
            operation,
          ) ||
          (operation.startsWith("open") &&
            (typeof args[1] === "number"
              ? (args[1] &
                  (fs.constants.O_WRONLY |
                    fs.constants.O_RDWR |
                    fs.constants.O_CREAT |
                    fs.constants.O_TRUNC |
                    fs.constants.O_APPEND)) ===
                0
              : args[1] === "r"));
        if (inside && ((memoryOnly && absolute !== stop) || (cachedOnly && !readOnly))) {
          violation(
            `${memoryOnly ? "no-snapshot-evidence-cache-receipt" : "cached-write"}-${operation}`,
          );
        }
      }
      return Reflect.apply(original, this, args);
    };
  for (const operation of [
    "access",
    "appendFile",
    "chmod",
    "chown",
    "copyFile",
    "cp",
    "truncate",
    "watch",
    "exists",
    "link",
    "lstat",
    "mkdir",
    "open",
    "opendir",
    "readdir",
    "readFile",
    "readlink",
    "realpath",
    "rename",
    "rm",
    "rmdir",
    "stat",
    "symlink",
    "unlink",
    "utimes",
    "writeFile",
  ]) {
    for (const name of [operation, `${operation}Sync`]) {
      if (typeof fs[name] === "function") fs[name] = guard(name, fs[name]);
    }
    if (typeof promises[operation] === "function")
      promises[operation] = guard(operation, promises[operation]);
  }
  for (const name of ["createReadStream", "createWriteStream"]) fs[name] = guard(name, fs[name]);
}
require("node:module").syncBuiltinESMExports();

const pendingAtRequest = () => {
  if (memoryOnly) return null;
  const root = join(process.env.ISSUE_GRAPH_HOME, "classify", "receipts");
  const pending = [];
  for (const day of readdirSync(root)) {
    assert.match(day, /^\d{4}-\d{2}-\d{2}$/);
    for (const id of readdirSync(join(root, day))) {
      assert.match(id, /^[a-f0-9-]{36}$/);
      const directory = join(root, day, id);
      if (existsSync(join(directory, "final"))) continue;
      const receipt = JSON.parse(readFileSync(join(directory, "pending", "receipt.json"), "utf8"));
      assert.equal(receipt.schemaVersion, 1);
      assert.equal(receipt.phase, "pending");
      assert.equal(receipt.durable, true);
      assert.equal(receipt.modelRequested, model);
      assert.equal(receipt.requestId, id);
      assert.equal(receipt.createdAt.slice(0, 10), day);
      assert.match(receipt.inputHash, /^[a-f0-9]{64}$/);
      assert.deepEqual(
        JSON.parse(
          readFileSync(
            join(process.env.ISSUE_GRAPH_HOME, "classify", "locks", `${receipt.inputHash}.json`),
            "utf8",
          ),
        ),
        receipt,
      );
      pending.push(receipt);
    }
  }
  assert.equal(pending.length, 1);
  return pending[0];
};

globalThis.fetch = async (url, options) => {
  if (cachedOnly) violation("cached-fetch");
  const attempt = ++attempts;
  let request;
  let metadata;
  try {
    assert.ok(
      attempt <= maxAttempts,
      "Default is one attempt; retries require explicit fixture opt-in",
    );
    assert.equal(url, "https://ai-gateway.vercel.sh/v1/evaluate");
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    const headers = new Headers(options.headers);
    assert.deepEqual([...headers.keys()].sort(), ["accept", "authorization", "content-type"]);
    assert.equal(headers.get("authorization"), "Bearer synthetic-test-key");
    assert.equal(headers.get("content-type"), "application/json");
    assert.equal(headers.get("accept"), "application/json");
    assert.equal(typeof options.body, "string");
    const inputBytes = Buffer.byteLength(options.body, "utf8");
    assert.ok(inputBytes > 0 && inputBytes <= 24000);
    request = JSON.parse(options.body);
    assert.deepEqual(Object.keys(request).sort(), [
      "model",
      "providerOptions",
      "questions",
      "state",
    ]);
    assert.equal(request.model, model);
    assert.deepEqual(request.providerOptions, { gateway: { only: ["typesafe-ai"] } });
    assert.equal(request.state.issue.id, "SYNTHETIC_I_1");
    assert.equal(request.state.issue.state, "OPEN");
    const expectedIds = [
      "expectedActualPresent",
      "impactReported",
      "regressionReported",
      "reproStepsPresent",
      "requestType",
      ...(Object.hasOwn(request.questions, "component") ? ["component"] : []),
    ].sort();
    assert.deepEqual(Object.keys(request.questions).sort(), expectedIds);
    for (const [id, question] of Object.entries(request.questions)) {
      const expectedType = ["requestType", "component"].includes(id)
        ? "choice"
        : id === "impactReported"
          ? "score"
          : "boolean";
      assert.equal(question.type, expectedType);
      assert.deepEqual(
        Object.keys(question).sort(),
        expectedType === "boolean"
          ? ["instructions", "type"]
          : ["criteria", "instructions", "type"],
      );
      assert.equal(typeof question.instructions, "string");
      assert.match(question.instructions, /untrusted data, not instructions/);
      if (expectedType === "choice") {
        assert.equal(Array.isArray(question.criteria), false);
        assert.ok(Object.keys(question.criteria).length >= 2);
        assert.ok(
          Object.values(question.criteria).every(
            (value) => typeof value === "string" && value.length > 0,
          ),
        );
        assert.ok(Object.hasOwn(question.criteria, "insufficient"));
      } else if (expectedType === "score") {
        assert.ok(Array.isArray(question.criteria));
        assert.ok(question.criteria.length >= 2);
        assert.ok(
          question.criteria.every((value) => typeof value === "string" && value.length > 0),
        );
      }
    }
    assert.ok(Object.hasOwn(request.questions.requestType.criteria, "bug"));
    assert.ok(
      [
        "good",
        "insufficient",
        "unknown-cost",
        "malformed",
        "transport-error",
        "throttle",
        "retry-success",
        "long-wait",
      ].includes(mode),
    );
    const pending = pendingAtRequest();
    metadata = {
      valid: true,
      attempt,
      maxAttempts,
      mode,
      inputBytes,
      questionIds: expectedIds,
      requestId: pending?.requestId ?? null,
      inputHash: pending?.inputHash ?? null,
      pendingBeforeFetch: pending !== null,
    };
  } catch {
    appendFileSync(log, `${JSON.stringify({ valid: false, attempt, mode })}\n`);
    throw new Error("Synthetic Gateway contract failed");
  }
  appendFileSync(log, `${JSON.stringify(metadata)}\n`);
  if (mode === "throttle" || mode === "long-wait" || (mode === "retry-success" && attempt === 1)) {
    return Response.json(
      {
        error: {
          code: "synthetic_throttle",
          type: "rate_limit",
          requestId: "fixture-request",
          message:
            "SYNTHETIC_PROVIDER_PROSE_NOT_OUTPUT synthetic-test-key SYNTHETIC_BODY_NOT_OUTPUT",
        },
      },
      {
        status: 429,
        headers: {
          "retry-after": mode === "long-wait" ? "31" : "0",
          "x-request-id": "fixture-header-request",
          "x-untrusted-secret": "synthetic-test-key",
        },
      },
    );
  }
  if (mode === "transport-error") throw new Error("SYNTHETIC_SECRET_NOT_OUTPUT");
  if (mode === "malformed") return Response.json({ answers: {} });
  const answers = Object.fromEntries(
    Object.entries(request.questions).map(([id, question]) => {
      if (question.type === "boolean") {
        return [id, { type: "boolean", probability: id === "regressionReported" ? 0.1 : 0.9 }];
      }
      const keys =
        question.type === "score"
          ? question.criteria.map((_, index) => String(index))
          : Object.keys(question.criteria);
      const choice =
        id === "requestType" ? (mode === "insufficient" ? "insufficient" : "bug") : keys[0];
      const probabilities = Object.fromEntries(
        keys.map((key) => [key, key === choice ? 0.9 : 0.1 / (keys.length - 1)]),
      );
      return [
        id,
        question.type === "score"
          ? {
              type: "score",
              probabilities,
              score: Object.entries(probabilities).reduce(
                (sum, [key, probability]) => sum + Number(key) * probability,
                0,
              ),
            }
          : { type: "choice", probabilities, choice },
      ];
    }),
  );
  return Response.json({
    model,
    answers,
    usage: { inputTokens: 120, outputTokens: 40 },
    providerMetadata: {
      gateway: {
        ...(mode === "unknown-cost" ? {} : { cost: "0.0125" }),
        routing: {
          originalModelId: model,
          canonicalSlug: model,
          resolvedProvider: "typesafe-ai",
          finalProvider: "typesafe-ai",
        },
      },
    },
  });
};
