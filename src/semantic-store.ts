import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  fingerprintEvaluation,
  SEMANTIC_CACHE_TTL_MS,
  validateEvaluation,
} from "./semantic-evaluation.js";
import {
  type SemanticCacheContext,
  type SemanticCacheEntry,
  type SemanticCacheLookup,
  type SemanticCacheStore,
  SemanticError,
  type SemanticEvaluation,
  type SemanticFinalReceipt,
  type SemanticPendingReceipt,
  type SemanticReceiptResult,
  type SemanticReceiptStore,
} from "./semantic-types.js";

const MAX_METADATA_BYTES = 8192;
const HINT =
  "Inspect classify receipts and locks manually before taking action. Do not rerun a paid request.";
const PENDING_KEYS = [
  "schemaVersion",
  "requestId",
  "inputHash",
  "modelRequested",
  "adapterVersion",
  "createdAt",
  "phase",
  "durable",
];

function fail(code: "receipt-invalid" | "receipt-write-failed" | "in-flight-or-unknown"): never {
  throw new SemanticError(code, "Durable receipt operation blocked.", HINT);
}

function fsCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("receipt-invalid");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail("receipt-invalid");
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor)) fail("receipt-invalid");
  }
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (
    Reflect.ownKeys(value).length !== allowed.length ||
    allowed.some((key) => !Object.hasOwn(value, key))
  ) {
    fail("receipt-invalid");
  }
}

function timestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    fail("receipt-invalid");
  return value;
}

function inputFields(value: Record<string, unknown>) {
  const { inputHash, modelRequested, adapterVersion } = value;
  if (
    typeof inputHash !== "string" ||
    !/^[a-fA-F0-9]{64}$/.test(inputHash) ||
    modelRequested !== "typesafe-ai/jev" ||
    typeof adapterVersion !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(adapterVersion)
  )
    fail("receipt-invalid");
  return { inputHash: inputHash.toLowerCase(), modelRequested, adapterVersion };
}

function pendingValue(value: unknown): SemanticPendingReceipt {
  const record = object(value);
  keys(record, PENDING_KEYS);
  const input = inputFields(record);
  if (
    record.schemaVersion !== 1 ||
    record.phase !== "pending" ||
    record.durable !== true ||
    record.inputHash !== input.inputHash ||
    typeof record.requestId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.requestId)
  )
    fail("receipt-invalid");
  return {
    schemaVersion: 1,
    requestId: record.requestId,
    ...input,
    createdAt: timestamp(record.createdAt),
    phase: "pending",
    durable: true,
  };
}

function boundedNumber(value: unknown, integer: boolean): number | null {
  if (value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER ||
    (integer && !Number.isSafeInteger(value))
  )
    fail("receipt-invalid");
  return value;
}

function resultValue(value: unknown): SemanticReceiptResult {
  const record = object(value);
  const usage = object(record.tokenUsage);
  if (
    typeof record.status !== "string" ||
    !["succeeded", "failed", "not-sent"].includes(record.status) ||
    typeof record.outcomeUnknown !== "boolean" ||
    (record.errorCode !== null &&
      (typeof record.errorCode !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(record.errorCode)))
  )
    fail("receipt-invalid");
  return {
    status: record.status as SemanticReceiptResult["status"],
    evaluatedAt: record.evaluatedAt === null ? null : timestamp(record.evaluatedAt),
    tokenUsage: {
      inputTokens: boundedNumber(usage.inputTokens, true),
      outputTokens: boundedNumber(usage.outputTokens, true),
    },
    reportedCostUsd: boundedNumber(record.reportedCostUsd, false),
    errorCode: record.errorCode as string | null,
    outcomeUnknown: record.outcomeUnknown,
  };
}

function safeStat(stat: Stats, directory: boolean): void {
  if (
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (stat.mode & 0o7777) !== (directory ? 0o700 : 0o600) ||
    (process.getuid && stat.uid !== process.getuid()) ||
    (!directory && stat.nlink !== 1)
  )
    fail("receipt-invalid");
}

async function maybeStat(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (fsCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function directory(path: string, create: boolean): Promise<void> {
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (fsCode(error) !== "EEXIST") throw error;
    }
  }
  safeStat(await lstat(path), true);
}

async function homeDirectory(path: string, create: boolean): Promise<string> {
  const parent = dirname(path);
  if (parent === path) fail("receipt-invalid");
  if (!(await maybeStat(parent))) {
    if (!create) fail("receipt-invalid");
    await homeDirectory(parent, true);
  }
  const canonical = join(await realpath(parent), basename(path));
  await directory(canonical, create);
  if (create) await syncDirectory(dirname(canonical));
  return canonical;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "ENOSYS"].includes(fsCode(error) ?? "")) throw error;
  } finally {
    await handle.close();
  }
}

async function exclusiveFile(path: string, value: unknown): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    safeStat(await handle.stat(), false);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function absent(path: string): Promise<void> {
  if (await maybeStat(path)) fail("receipt-invalid");
}

async function publish(path: string, value: unknown): Promise<void> {
  await absent(path);
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  await mkdir(temporary, { mode: 0o700 });
  await directory(temporary, false);
  await exclusiveFile(join(temporary, "receipt.json"), value);
  await syncDirectory(temporary);
  await absent(path);
  try {
    await rename(temporary, path);
  } catch (error) {
    if (["EEXIST", "ENOTEMPTY"].includes(fsCode(error) ?? "")) fail("receipt-invalid");
    throw error;
  }
  await syncDirectory(dirname(path));
}

async function readMetadata(path: string, limit = MAX_METADATA_BYTES): Promise<unknown> {
  const before = await lstat(path);
  safeStat(before, false);
  if (before.size < 2 || before.size > limit) fail("receipt-invalid");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    safeStat(stat, false);
    if (stat.ino !== before.ino || stat.dev !== before.dev || stat.size !== before.size)
      fail("receipt-invalid");
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, size);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
    }
    const after = await handle.stat();
    if (
      size !== stat.size ||
      size > limit ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    ) {
      fail("receipt-invalid");
    }
    try {
      return JSON.parse(buffer.subarray(0, size).toString("utf8"));
    } catch {
      fail("receipt-invalid");
    }
  } finally {
    await handle.close();
  }
}

async function samePending(path: string, pending: SemanticPendingReceipt): Promise<void> {
  const stored = pendingValue(await readMetadata(path));
  if (JSON.stringify(stored) !== JSON.stringify(pending)) fail("receipt-invalid");
}

async function redacted<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SemanticError) throw error;
    fail(
      ["ENOENT", "ELOOP", "ENOTDIR", "EISDIR"].includes(fsCode(error) ?? "")
        ? "receipt-invalid"
        : "receipt-write-failed",
    );
  }
}

export function createSemanticReceiptStore(options?: {
  home?: string;
  now?: () => string;
}): SemanticReceiptStore {
  let home: string | undefined;

  function clock(): string {
    return timestamp(options?.now ? options.now() : new Date().toISOString());
  }

  function paths(pending: SemanticPendingReceipt) {
    if (!home) fail("receipt-invalid");
    const root = join(home, "classify");
    const locks = join(root, "locks");
    const receipts = join(root, "receipts");
    const day = join(receipts, pending.createdAt.slice(0, 10));
    const request = join(day, pending.requestId);
    return { root, locks, receipts, day, request, lock: join(locks, `${pending.inputHash}.json`) };
  }

  async function tree(pending: SemanticPendingReceipt, create: boolean) {
    if (!home) fail("receipt-invalid");
    home = await homeDirectory(home, create);
    const location = paths(pending);
    for (const path of [location.root, location.locks, location.receipts, location.day]) {
      await directory(path, create);
      if (create) await syncDirectory(dirname(path));
    }
    return location;
  }

  return {
    begin(input) {
      return redacted(async () => {
        const record = object(input);
        keys(record, ["inputHash", "modelRequested", "adapterVersion"]);
        const fields = inputFields(record);
        const pending: SemanticPendingReceipt = {
          schemaVersion: 1,
          requestId: randomUUID(),
          ...fields,
          createdAt: clock(),
          phase: "pending",
          durable: true,
        };
        if (!home) {
          const configured =
            options?.home ?? process.env.ISSUE_GRAPH_HOME ?? join(homedir(), ".issue-graph");
          if (
            typeof configured !== "string" ||
            !configured ||
            configured.length > 4096 ||
            configured.includes("\0")
          )
            fail("receipt-invalid");
          home = resolve(configured);
        }
        const location = await tree(pending, true);
        try {
          await exclusiveFile(location.lock, pending);
        } catch (error) {
          if (fsCode(error) === "EEXIST") fail("in-flight-or-unknown");
          throw error;
        }
        await syncDirectory(location.locks);
        await mkdir(location.request, { mode: 0o700 });
        await directory(location.request, false);
        await syncDirectory(location.day);
        await publish(join(location.request, "pending"), pending);
        return pending;
      });
    },
    finish(pendingInput, resultInput) {
      return redacted(async () => {
        const pending = pendingValue(pendingInput);
        const result = resultValue(resultInput);
        const completedAt = clock();
        if (completedAt < pending.createdAt) fail("receipt-invalid");
        const final: SemanticFinalReceipt = { ...pending, phase: "final", completedAt, result };
        const location = await tree(pending, false);
        await directory(location.request, false);
        const pendingDirectory = join(location.request, "pending");
        const finalDirectory = join(location.request, "final");
        const pendingPath = join(pendingDirectory, "receipt.json");
        const finalPath = join(finalDirectory, "receipt.json");
        const claimPath = join(location.request, "finalizing.json");
        await directory(pendingDirectory, false);
        await samePending(location.lock, pending);
        await samePending(pendingPath, pending);
        await absent(finalDirectory);
        try {
          await exclusiveFile(claimPath, pending);
        } catch (error) {
          if (fsCode(error) === "EEXIST") fail("in-flight-or-unknown");
          throw error;
        }
        await syncDirectory(location.request);
        await tree(pending, false);
        await directory(location.request, false);
        await directory(pendingDirectory, false);
        await samePending(location.lock, pending);
        await samePending(pendingPath, pending);
        await publish(finalDirectory, final);
        await tree(pending, false);
        await directory(location.request, false);
        await directory(pendingDirectory, false);
        await directory(finalDirectory, false);
        await samePending(location.lock, pending);
        await samePending(pendingPath, pending);
        await samePending(claimPath, pending);
        const storedFinal = object(await readMetadata(finalPath));
        keys(storedFinal, [...PENDING_KEYS, "completedAt", "result"]);
        if (JSON.stringify(storedFinal) !== JSON.stringify(final)) fail("receipt-invalid");
        if (!result.outcomeUnknown) await unlink(location.lock);
        return final;
      });
    },
  };
}

const MAX_CACHE_BYTES = 128 * 1024;
const CACHE_MESSAGE = "Semantic cache operation blocked.";
const CACHE_HINT =
  "Inspect classify cache, receipts and locks manually before taking action. Do not rerun a paid request.";
const CACHE_VERSION = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const CACHE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CACHE_HASH = /^[a-f0-9]{64}$/;
const CACHE_KEYS = [
  "schemaVersion",
  "inputHash",
  "requestId",
  "adapterVersion",
  "cacheEpoch",
  "createdAt",
  "modelRequested",
  "evaluatedAt",
  "expiresAt",
  "response",
  "checksum",
];

function cacheFail(code: "cache-invalid" | "in-flight-or-unknown" = "cache-invalid"): never {
  throw new SemanticError(code, CACHE_MESSAGE, CACHE_HINT);
}

async function cacheRedacted<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    cacheFail(
      error instanceof SemanticError && error.code === "in-flight-or-unknown"
        ? "in-flight-or-unknown"
        : "cache-invalid",
    );
  }
}

function cacheSnapshot<T>(input: T): T {
  let remaining = 100_000;
  function visit(value: unknown, depth: number): unknown {
    if (--remaining < 0 || depth > 32) cacheFail();
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (value.length > 4 * 1024 * 1024) cacheFail();
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (Array.isArray(value)) {
      if (value.length > 100_000 || Reflect.ownKeys(value).length !== value.length + 1) cacheFail();
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) cacheFail();
        return visit(descriptor.value, depth + 1);
      });
    }
    const record = object(value);
    if (Reflect.ownKeys(record).length !== Object.keys(record).length) cacheFail();
    return Object.fromEntries(
      Object.entries(record).map(([key, child]) => [key, visit(child, depth + 1)]),
    );
  }
  const copy = visit(input, 0) as T;
  if (Buffer.byteLength(JSON.stringify(copy)) > 4 * 1024 * 1024) cacheFail();
  return copy;
}

async function cacheContext(input: SemanticCacheContext): Promise<SemanticCacheContext> {
  const context = cacheSnapshot(input);
  keys(object(context), ["inputHash", "request", "taxonomy", "adapterVersion", "cacheEpoch"]);
  if (
    typeof context.inputHash !== "string" ||
    !CACHE_HASH.test(context.inputHash) ||
    typeof context.adapterVersion !== "string" ||
    !CACHE_VERSION.test(context.adapterVersion) ||
    typeof context.cacheEpoch !== "string" ||
    !CACHE_VERSION.test(context.cacheEpoch)
  )
    cacheFail();
  const request = object(context.request);
  keys(request, ["model", "state", "questions", "providerOptions"]);
  const provider = object(request.providerOptions);
  keys(provider, ["gateway"]);
  keys(object(provider.gateway), ["only"]);
  keys(object(request.state), ["issue"]);
  const issue = object(context.request.state.issue);
  keys(issue, [
    "key",
    "id",
    "url",
    "state",
    "title",
    "body",
    "updatedAt",
    "comments",
    "commentsCoverage",
  ]);
  if (
    !["key", "id", "url", "title", "body", "updatedAt"].every(
      (key) => typeof issue[key] === "string",
    ) ||
    !["OPEN", "CLOSED"].includes(String(issue.state)) ||
    !Array.isArray(issue.comments)
  )
    cacheFail();
  for (const comment of issue.comments) {
    const record = object(comment);
    keys(record, ["id", "url", "author", "updatedAt", "body"]);
    if (
      !["id", "url", "updatedAt", "body"].every((key) => typeof record[key] === "string") ||
      (record.author !== null && typeof record.author !== "string")
    )
      cacheFail();
  }
  const coverage = object(issue.commentsCoverage);
  keys(coverage, ["captured", "total", "hasNextPage", "complete"]);
  if (
    boundedNumber(coverage.captured, true) === null ||
    (coverage.hasNextPage !== null && typeof coverage.hasNextPage !== "boolean") ||
    typeof coverage.complete !== "boolean"
  )
    cacheFail();
  boundedNumber(coverage.total, true);
  if (context.taxonomy !== null) {
    const taxonomy = object(context.taxonomy);
    keys(taxonomy, ["schemaVersion", "repo", "version", "components"]);
    if (
      taxonomy.schemaVersion !== 1 ||
      typeof taxonomy.repo !== "string" ||
      typeof taxonomy.version !== "string" ||
      !CACHE_VERSION.test(taxonomy.version) ||
      !Array.isArray(taxonomy.components)
    )
      cacheFail();
    for (const component of taxonomy.components) {
      const record = object(component);
      keys(record, [
        "id",
        "description",
        ...(Object.hasOwn(record, "examples") ? ["examples"] : []),
      ]);
      if (
        typeof record.id !== "string" ||
        typeof record.description !== "string" ||
        (Object.hasOwn(record, "examples") &&
          (!Array.isArray(record.examples) ||
            !record.examples.every((item) => typeof item === "string")))
      )
        cacheFail();
    }
  }
  const answers = Object.fromEntries(
    Object.entries(object(request.questions)).map(([id, inputQuestion]) => {
      if (!id || id.length > 128) cacheFail();
      const question = object(inputQuestion);
      keys(question, [
        "type",
        "instructions",
        ...(question.type === "boolean" ? [] : ["criteria"]),
      ]);
      if (question.type === "boolean") return [id, { type: "boolean", probability: 0 }];
      const options =
        question.type === "score"
          ? Array.isArray(question.criteria)
            ? question.criteria.map((_, index) => String(index))
            : []
          : Object.keys(object(question.criteria));
      if (!options.length || options.some((key) => !key || key.length > 128)) cacheFail();
      return [
        id,
        {
          type: question.type,
          ...(question.type === "score" ? { score: 0 } : { choice: options[0] }),
          probabilities: Object.fromEntries(
            options.map((key, index) => [key, index === 0 ? 1 : 0]),
          ),
        },
      ];
    }),
  );
  validateEvaluation(context.request, { answers });
  if (
    context.inputHash !==
    (await fingerprintEvaluation(
      context.request,
      context.taxonomy,
      context.adapterVersion,
      context.cacheEpoch,
    ))
  )
    cacheFail();
  return context;
}

function cacheResponse(evaluation: SemanticEvaluation): Record<string, unknown> {
  const value = cacheSnapshot(evaluation);
  const answers = Object.fromEntries(
    Object.entries(object(value.answers)).map(([id, input]) => {
      const answer = object(input);
      const confidence =
        answer.providerConfidence === null ? {} : { confidence: answer.providerConfidence };
      if (answer.type === "boolean")
        return [id, { type: answer.type, probability: answer.probability, ...confidence }];
      if (answer.type !== "choice" && answer.type !== "score") cacheFail();
      return [
        id,
        {
          type: answer.type,
          probabilities: { ...object(answer.probabilities) },
          ...(answer.type === "choice" ? { choice: answer.choice } : { score: answer.score }),
          ...confidence,
        },
      ];
    }),
  );
  const usage = object(value.tokenUsage);
  return {
    ...(value.modelResolved === null ? {} : { model: value.modelResolved }),
    answers,
    usage: {
      inputTokens: boundedNumber(usage.inputTokens, true),
      outputTokens: boundedNumber(usage.outputTokens, true),
    },
    ...(value.reportedCostUsd === null
      ? {}
      : {
          providerMetadata: { gateway: { cost: boundedNumber(value.reportedCostUsd, false) } },
        }),
  };
}

function cachedEvaluation(context: SemanticCacheContext, input: unknown): SemanticEvaluation {
  const response = object(input);
  keys(response, [
    "answers",
    "usage",
    ...(Object.hasOwn(response, "model") ? ["model"] : []),
    ...(Object.hasOwn(response, "providerMetadata") ? ["providerMetadata"] : []),
  ]);
  const usage = object(response.usage);
  keys(usage, ["inputTokens", "outputTokens"]);
  boundedNumber(usage.inputTokens, true);
  boundedNumber(usage.outputTokens, true);
  if (Object.hasOwn(response, "providerMetadata")) {
    const metadata = object(response.providerMetadata);
    keys(metadata, ["gateway"]);
    const gateway = object(metadata.gateway);
    keys(gateway, ["cost"]);
    if (boundedNumber(gateway.cost, false) === null) cacheFail();
  }
  return validateEvaluation(context.request, response);
}

function cacheChecksum(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function cacheDirectory(path: string): Promise<boolean> {
  const stat = await maybeStat(path);
  if (!stat) return false;
  safeStat(stat, true);
  return true;
}

async function cacheReceipt(root: string, pending: SemanticPendingReceipt): Promise<string> {
  const receipts = join(root, "receipts");
  const day = join(receipts, pending.createdAt.slice(0, 10));
  const request = join(day, pending.requestId);
  for (const path of [receipts, day, request, join(request, "pending")])
    await directory(path, false);
  await samePending(join(request, "pending", "receipt.json"), pending);
  return request;
}

function cachePendingMatches(context: SemanticCacheContext, pending: SemanticPendingReceipt): void {
  if (
    pending.inputHash !== context.inputHash ||
    pending.adapterVersion !== context.adapterVersion ||
    pending.modelRequested !== context.request.model
  )
    cacheFail();
}

async function cacheLock(
  root: string,
  context: SemanticCacheContext,
  ownedRequestId?: string,
): Promise<SemanticPendingReceipt | null> {
  const locks = join(root, "locks");
  if (!(await cacheDirectory(locks))) {
    if (ownedRequestId) cacheFail("in-flight-or-unknown");
    return null;
  }
  const lock = join(locks, `${context.inputHash}.json`);
  if (!(await maybeStat(lock))) {
    if (ownedRequestId) cacheFail("in-flight-or-unknown");
    return null;
  }
  let pending: SemanticPendingReceipt;
  try {
    pending = pendingValue(await readMetadata(lock));
  } catch (error) {
    if (fsCode(error) === "ENOENT" && !ownedRequestId) return null;
    throw error;
  }
  cachePendingMatches(context, pending);
  if (!ownedRequestId || pending.requestId !== ownedRequestId) cacheFail("in-flight-or-unknown");
  const request = await cacheReceipt(root, pending);
  if (
    (await maybeStat(join(request, "final"))) ||
    (await maybeStat(join(request, "finalizing.json")))
  )
    cacheFail("in-flight-or-unknown");
  await samePending(lock, pending);
  return pending;
}

async function cacheFinal(
  root: string,
  pending: SemanticPendingReceipt,
  entry: SemanticCacheEntry,
): Promise<void> {
  const request = await cacheReceipt(root, pending);
  const finalDirectory = join(request, "final");
  await directory(finalDirectory, false);
  const final = object(await readMetadata(join(finalDirectory, "receipt.json")));
  keys(final, [...PENDING_KEYS, "completedAt", "result"]);
  const { completedAt, result: rawResult, ...storedPending } = final;
  if (storedPending.phase !== "final") cacheFail();
  const validatedPending = pendingValue({ ...storedPending, phase: "pending" });
  if (JSON.stringify(validatedPending) !== JSON.stringify(pending)) cacheFail();
  if (timestamp(completedAt) < pending.createdAt || timestamp(completedAt) < entry.evaluatedAt)
    cacheFail();
  const result = object(rawResult);
  keys(result, [
    "status",
    "evaluatedAt",
    "tokenUsage",
    "reportedCostUsd",
    "errorCode",
    "outcomeUnknown",
  ]);
  keys(object(result.tokenUsage), ["inputTokens", "outputTokens"]);
  const checked = resultValue(result);
  if (
    checked.status !== "succeeded" ||
    checked.outcomeUnknown ||
    checked.errorCode !== null ||
    checked.evaluatedAt !== entry.evaluatedAt ||
    checked.tokenUsage.inputTokens !== entry.evaluation.tokenUsage.inputTokens ||
    checked.tokenUsage.outputTokens !== entry.evaluation.tokenUsage.outputTokens ||
    checked.reportedCostUsd !== entry.evaluation.reportedCostUsd
  )
    cacheFail();
}

export function createSemanticCacheStore(options?: {
  home?: string;
  now?: () => string;
}): SemanticCacheStore {
  let home: string | undefined;

  function clock(): string {
    return timestamp(options?.now ? options.now() : new Date().toISOString());
  }

  async function root(): Promise<string | null> {
    if (!home) {
      const configured =
        options?.home ?? process.env.ISSUE_GRAPH_HOME ?? join(homedir(), ".issue-graph");
      if (
        typeof configured !== "string" ||
        !configured ||
        configured.length > 4096 ||
        configured.includes("\0")
      )
        cacheFail();
      home = resolve(configured);
    }
    if (!(await cacheDirectory(home))) return null;
    home = await homeDirectory(home, false);
    const path = join(home, "classify");
    return (await cacheDirectory(path)) ? path : null;
  }

  async function recheck(
    context: SemanticCacheContext,
    expectedRoot: string | null,
    ownedRequestId?: string,
  ): Promise<SemanticPendingReceipt | null> {
    const currentRoot = await root();
    const pending = currentRoot ? await cacheLock(currentRoot, context, ownedRequestId) : null;
    if (!currentRoot && ownedRequestId) cacheFail("in-flight-or-unknown");
    if (currentRoot !== expectedRoot) cacheFail();
    return pending;
  }

  return {
    read(input, readOptions) {
      return cacheRedacted(async () => {
        const context = await cacheContext(input);
        const record = object(readOptions ?? {});
        if (
          Reflect.ownKeys(record).some(
            (key) => typeof key !== "string" || !["refresh", "ownedRequestId"].includes(key),
          ) ||
          (record.refresh !== undefined && typeof record.refresh !== "boolean") ||
          (record.ownedRequestId !== undefined &&
            (typeof record.ownedRequestId !== "string" || !CACHE_UUID.test(record.ownedRequestId)))
        )
          cacheFail();
        const settings = {
          refresh: record.refresh === true,
          ownedRequestId: record.ownedRequestId as string | undefined,
        };
        const now = clock();
        const location = await root();
        let result: SemanticCacheLookup = { status: settings.refresh ? "refresh" : "miss" };
        if (location) {
          await cacheLock(location, context, settings.ownedRequestId);
          const cache = join(location, "cache");
          const bucket = join(cache, context.inputHash);
          if ((await cacheDirectory(cache)) && (await cacheDirectory(bucket))) {
            const pointerPath = join(bucket, "current.json");
            const pointerStat = await maybeStat(pointerPath);
            if (pointerStat) safeStat(pointerStat, false);
            if (!settings.refresh && pointerStat) {
              const pointer = object(await readMetadata(pointerPath));
              keys(pointer, ["schemaVersion", "inputHash", "requestId"]);
              if (
                pointer.schemaVersion !== 1 ||
                pointer.inputHash !== context.inputHash ||
                typeof pointer.requestId !== "string" ||
                !CACHE_UUID.test(pointer.requestId)
              )
                cacheFail();
              if (pointer.requestId === settings.ownedRequestId) cacheFail("in-flight-or-unknown");
              const disk = object(
                await readMetadata(join(bucket, `${pointer.requestId}.json`), MAX_CACHE_BYTES),
              );
              keys(disk, CACHE_KEYS);
              const { checksum, ...payload } = disk;
              if (
                typeof checksum !== "string" ||
                !CACHE_HASH.test(checksum) ||
                checksum !== cacheChecksum(payload)
              )
                cacheFail();
              if (
                disk.schemaVersion !== 1 ||
                disk.inputHash !== context.inputHash ||
                disk.requestId !== pointer.requestId ||
                disk.adapterVersion !== context.adapterVersion ||
                disk.cacheEpoch !== context.cacheEpoch ||
                disk.modelRequested !== context.request.model
              )
                cacheFail();
              const evaluatedAt = timestamp(disk.evaluatedAt);
              const expiresAt = timestamp(disk.expiresAt);
              if (
                evaluatedAt > now ||
                Date.parse(expiresAt) !== Date.parse(evaluatedAt) + SEMANTIC_CACHE_TTL_MS
              )
                cacheFail();
              const pending = pendingValue({
                schemaVersion: 1,
                requestId: disk.requestId,
                inputHash: disk.inputHash,
                adapterVersion: disk.adapterVersion,
                modelRequested: disk.modelRequested,
                createdAt: disk.createdAt,
                phase: "pending",
                durable: true,
              });
              if (pending.createdAt > evaluatedAt) cacheFail();
              const entry: SemanticCacheEntry = {
                schemaVersion: 1,
                inputHash: context.inputHash,
                requestId: pointer.requestId,
                adapterVersion: context.adapterVersion,
                cacheEpoch: context.cacheEpoch,
                evaluatedAt,
                expiresAt,
                evaluation: cachedEvaluation(context, disk.response),
              };
              await cacheFinal(location, pending, entry);
              result = now >= expiresAt ? { status: "expired" } : { status: "hit", entry };
            }
          }
        }
        await recheck(context, location, settings.ownedRequestId);
        return result;
      });
    },
    write(input, inputValue, inputPending) {
      return cacheRedacted(async () => {
        const context = await cacheContext(input);
        const value = cacheSnapshot(inputValue);
        keys(object(value), ["evaluation", "evaluatedAt"]);
        const pending = pendingValue(cacheSnapshot(inputPending));
        cachePendingMatches(context, pending);
        const evaluatedAt = timestamp(value.evaluatedAt);
        if (evaluatedAt > clock() || evaluatedAt < pending.createdAt) cacheFail();
        const response = cacheResponse(value.evaluation);
        cachedEvaluation(context, response);
        const payload = {
          schemaVersion: 1,
          inputHash: context.inputHash,
          requestId: pending.requestId,
          adapterVersion: context.adapterVersion,
          cacheEpoch: context.cacheEpoch,
          createdAt: pending.createdAt,
          modelRequested: pending.modelRequested,
          evaluatedAt,
          expiresAt: timestamp(
            new Date(Date.parse(evaluatedAt) + SEMANTIC_CACHE_TTL_MS).toISOString(),
          ),
          response,
        };
        const disk = { ...payload, checksum: cacheChecksum(payload) };
        if (Buffer.byteLength(`${JSON.stringify(disk)}\n`) > MAX_CACHE_BYTES) cacheFail();
        const location = await root();
        if (!location) cacheFail();
        async function owned(): Promise<void> {
          const stored = await recheck(context, location, pending.requestId);
          if (JSON.stringify(stored) !== JSON.stringify(pending)) cacheFail();
        }
        await owned();
        const cache = join(location, "cache");
        const bucket = join(cache, context.inputHash);
        for (const path of [cache, bucket]) {
          await directory(path, true);
          await syncDirectory(dirname(path));
        }
        const entryPath = join(bucket, `${pending.requestId}.json`);
        const pointerPath = join(bucket, "current.json");
        async function pointerSafe(): Promise<void> {
          await directory(cache, false);
          await directory(bucket, false);
          const stat = await maybeStat(pointerPath);
          if (stat) safeStat(stat, false);
        }
        await pointerSafe();
        await absent(entryPath);
        const temporary = join(bucket, `.${randomUUID()}.tmp`);
        await exclusiveFile(temporary, disk);
        await owned();
        await pointerSafe();
        await link(temporary, entryPath);
        await unlink(temporary);
        await syncDirectory(bucket);
        const pointerTemporary = join(bucket, `.${randomUUID()}.tmp`);
        await exclusiveFile(pointerTemporary, {
          schemaVersion: 1,
          inputHash: context.inputHash,
          requestId: pending.requestId,
        });
        await owned();
        await pointerSafe();
        await rename(pointerTemporary, pointerPath);
        await syncDirectory(bucket);
        await owned();
      });
    },
  };
}
