import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, parse, resolve, sep } from "node:path";
import {
  type SemanticCapture,
  type SemanticCoverage,
  SemanticError,
  type SemanticEvidence,
  type SemanticWindow,
} from "./semantic-types.js";

export interface SemanticEvidenceStore {
  read(repo: string, limit: number): Promise<SemanticCapture | null>;
  write(repo: string, limit: number, capture: SemanticCapture): Promise<void>;
}

const MAX_BYTES = 16 * 1024 * 1024;
const UUID_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
const HASH = /^[0-9a-f]{64}$/;
const SECRET =
  /(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}|\bsk-[A-Za-z0-9_-]{20,}|\bAKIA[A-Z0-9]{16}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/;

type Scope = { repo: string; limit: number };
type Snapshot = Scope & {
  schemaVersion: 1;
  savedAt: string;
  capture: SemanticCapture;
  checksum: string;
};

function fail(code = "evidence-invalid"): never {
  throw new SemanticError(
    code,
    "Private semantic evidence operation blocked.",
    "Inspect classify/evidence permissions and data. Saved evidence is not live verification.",
  );
}

function fsCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

async function guarded<T>(write: boolean, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SemanticError) throw error;
    fail(
      write && !["ENOENT", "ELOOP", "ENOTDIR", "EISDIR"].includes(fsCode(error) ?? "")
        ? "evidence-write-failed"
        : "evidence-invalid",
    );
  }
}

function record(value: unknown, fields: string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail();
  if (Reflect.ownKeys(value).length !== fields.length) fail();
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail();
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail();
  if (value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) fail();
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail();
  }
  return value;
}

function text(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_BYTES) fail();
  if (Buffer.from(value, "utf8").toString("utf8") !== value || SECRET.test(value)) fail();
  return value;
}

function identity(value: unknown): string {
  const result = text(value);
  if (!/^[\x21-\x7e]{1,1024}$/.test(result)) fail();
  return result;
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail();
  return value;
}

function timestamp(value: unknown): string {
  const result = text(value);
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(result);
  if (!match || !Number.isFinite(Date.parse(result))) fail();
  const canonical = `${match[1]}.${(match[2] ?? "").padEnd(3, "0").slice(0, 3)}Z`;
  if (new Date(result).toISOString() !== canonical) fail();
  return result;
}

function windowValue(value: unknown): SemanticWindow {
  const raw = record(value, ["startedAt", "completedAt"]);
  const startedAt = timestamp(raw.startedAt);
  const completedAt = timestamp(raw.completedAt);
  if (Date.parse(startedAt) > Date.parse(completedAt)) fail();
  return { startedAt, completedAt };
}

function reasons(value: unknown): string[] {
  const result = array(value, 100).map((entry) => {
    const code = text(entry);
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(code)) fail();
    return code;
  });
  if (new Set(result).size !== result.length) fail();
  return result;
}

function coverageValue(value: unknown, length: number): SemanticCoverage {
  const raw = record(value, [
    "captured",
    "total",
    "hasNextPage",
    "pages",
    "complete",
    "reasonCodes",
  ]);
  const captured = count(raw.captured);
  const total = raw.total === null ? null : count(raw.total);
  const pages = count(raw.pages);
  const reasonCodes = reasons(raw.reasonCodes);
  if (
    captured !== length ||
    (pages === 0 && captured !== 0) ||
    !(raw.hasNextPage === null || typeof raw.hasNextPage === "boolean") ||
    typeof raw.complete !== "boolean"
  )
    fail();
  if (
    raw.complete &&
    (total !== captured || raw.hasNextPage !== false || reasonCodes.length !== 0 || pages === 0)
  )
    fail();
  return {
    captured,
    total,
    pages,
    hasNextPage: raw.hasNextPage,
    complete: raw.complete,
    reasonCodes,
  };
}

function scopeValue(repo: unknown, limit: unknown): Scope {
  if (
    typeof repo !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/.test(repo) ||
    repo.length > 240 ||
    [".", ".."].includes(repo.split("/")[1]) ||
    typeof limit !== "number" ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 500
  )
    fail();
  return { repo: repo.toLowerCase(), limit };
}

function captureValue(value: unknown, scope: Scope): SemanticCapture {
  const raw = record(value, ["repo", "visibility", "captureWindow", "coverage", "items"]);
  const repo = text(raw.repo);
  if (scopeValue(repo, scope.limit).repo !== scope.repo || raw.visibility !== "PUBLIC") fail();
  const captureWindow = windowValue(raw.captureWindow);
  const ids = new Set<string>();
  const numbers = new Set<number>();
  const commentIds = new Set<string>();
  const commentUrls = new Set<string>();
  const items = array(raw.items, scope.limit).map<SemanticEvidence>((entry) => {
    const item = record(entry, [
      "key",
      "id",
      "url",
      "number",
      "state",
      "title",
      "body",
      "updatedAt",
      "comments",
      "commentsCoverage",
      "captureWindow",
      "status",
      "reasonCodes",
    ]);
    const id = identity(item.id);
    const number = count(item.number);
    const key = text(item.key) as SemanticEvidence["key"];
    const url = text(item.url);
    const normalizedUrl = `https://github.com/${scope.repo}/issues/${number}`;
    if (
      number === 0 ||
      ids.has(id) ||
      numbers.has(number) ||
      key.toLowerCase() !== `${scope.repo}#${number}` ||
      url.toLowerCase() !== normalizedUrl ||
      (item.state !== "OPEN" && item.state !== "CLOSED") ||
      (item.status !== "ready" && item.status !== "excluded" && item.status !== "failed")
    )
      fail();
    ids.add(id);
    numbers.add(number);
    const itemWindow = windowValue(item.captureWindow);
    const updatedAt = timestamp(item.updatedAt);
    if (
      Date.parse(itemWindow.startedAt) < Date.parse(captureWindow.startedAt) ||
      Date.parse(itemWindow.completedAt) > Date.parse(captureWindow.completedAt) ||
      Date.parse(updatedAt) > Date.parse(itemWindow.completedAt)
    )
      fail();
    const comments = array(item.comments, 300).map((entry) => {
      const comment = record(entry, ["id", "url", "author", "updatedAt", "body"]);
      const id = identity(comment.id);
      const commentUrl = text(comment.url);
      const normalizedCommentUrl = commentUrl.toLowerCase();
      if (
        !normalizedCommentUrl.startsWith(`${normalizedUrl}#issuecomment-`) ||
        !/^[1-9]\d*$/.test(normalizedCommentUrl.slice(`${normalizedUrl}#issuecomment-`.length)) ||
        commentIds.has(id) ||
        commentUrls.has(normalizedCommentUrl)
      )
        fail();
      commentIds.add(id);
      commentUrls.add(normalizedCommentUrl);
      const author = comment.author === null ? null : identity(comment.author);
      const updatedAt = timestamp(comment.updatedAt);
      if (Date.parse(updatedAt) > Date.parse(itemWindow.completedAt)) fail();
      return { id, url: commentUrl, author, updatedAt, body: text(comment.body) };
    });
    return {
      key,
      id,
      url,
      number,
      state: item.state,
      title: text(item.title),
      body: text(item.body),
      updatedAt,
      comments,
      commentsCoverage: coverageValue(item.commentsCoverage, comments.length),
      captureWindow: itemWindow,
      status: item.status,
      reasonCodes: reasons(item.reasonCodes),
    };
  });
  return {
    repo,
    visibility: "PUBLIC",
    captureWindow,
    coverage: coverageValue(raw.coverage, items.length),
    items,
  };
}

function eligible(capture: SemanticCapture, limit: number): boolean {
  const coverage = capture.coverage;
  const bounded =
    !coverage.complete &&
    coverage.captured === limit &&
    coverage.total !== null &&
    coverage.total > limit &&
    coverage.hasNextPage === true &&
    coverage.reasonCodes.length === 1 &&
    coverage.reasonCodes[0] === "issue-limit";
  return (
    (coverage.complete || bounded) &&
    capture.items.every(
      (item) =>
        item.state === "OPEN" &&
        item.status === "ready" &&
        item.reasonCodes.length === 0 &&
        item.commentsCoverage.complete,
    )
  );
}

function semanticValue(capture: SemanticCapture): string {
  const coverage = ({ pages: _pages, ...value }: SemanticCoverage) => value;
  return JSON.stringify({
    repo: capture.repo,
    visibility: capture.visibility,
    coverage: coverage(capture.coverage),
    items: capture.items.map(({ captureWindow: _window, commentsCoverage, ...item }) => ({
      ...item,
      commentsCoverage: coverage(commentsCoverage),
    })),
  });
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function bytes(value: unknown, maximum = MAX_BYTES): string {
  const result = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(result, "utf8") > maximum) fail();
  return result;
}

function safeStat(stat: Stats, directory: boolean): void {
  if (
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (stat.mode & 0o7777) !== (directory ? 0o700 : 0o600) ||
    (process.getuid && stat.uid !== process.getuid()) ||
    (!directory && stat.nlink !== 1)
  )
    fail();
}

async function maybeStat(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (fsCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function syncDirectory(path: string, privateDirectory = true): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory()) fail();
    if (privateDirectory) safeStat(stat, true);
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "ENOSYS"].includes(fsCode(error) ?? "")) throw error;
  } finally {
    await handle.close();
  }
}

async function tree(home: string, scope: Scope, create: boolean): Promise<string | null> {
  const root = parse(home).root;
  let path = root;
  for (const part of home.slice(root.length).split(sep).filter(Boolean)) {
    const parent = path;
    path = join(path, part);
    let stat = await maybeStat(path);
    let created = false;
    if (!stat) {
      if (!create) return null;
      try {
        await mkdir(path, { mode: 0o700 });
        created = true;
      } catch (error) {
        if (fsCode(error) !== "EEXIST") throw error;
      }
      stat = await lstat(path);
      safeStat(stat, true);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
    if (path === home || created) safeStat(stat, true);
    if (created) await syncDirectory(parent, false);
  }
  if (home === root) fail();
  for (const part of ["classify", "evidence", digest(scope)]) {
    const parent = path;
    path = join(path, part);
    if (create) {
      try {
        await mkdir(path, { mode: 0o700 });
        await syncDirectory(parent);
      } catch (error) {
        if (fsCode(error) !== "EEXIST") throw error;
      }
    }
    const stat = await maybeStat(path);
    if (!stat) return null;
    safeStat(stat, true);
  }
  return path;
}

class PointerReplaced extends Error {}

function detachedPointer(stat: Stats): boolean {
  return (
    stat.isFile() &&
    (stat.mode & 0o7777) === 0o600 &&
    (!process.getuid || stat.uid === process.getuid()) &&
    stat.nlink === 0
  );
}

async function checkReadFile(
  path: string,
  before: Stats,
  observed: Stats,
  replaceable: boolean,
): Promise<void> {
  if (replaceable && detachedPointer(observed)) {
    if (
      observed.mode !== before.mode ||
      observed.uid !== before.uid ||
      observed.dev !== before.dev ||
      (observed.ino === before.ino &&
        (observed.size !== before.size || observed.mtimeMs !== before.mtimeMs))
    )
      fail();
    const replacement = await lstat(path);
    if (!detachedPointer(replacement)) safeStat(replacement, false);
    if (replacement.dev !== observed.dev || replacement.ino === observed.ino) fail();
    throw new PointerReplaced();
  }
  safeStat(observed, false);
  if (observed.dev !== before.dev) fail();
  if (observed.ino !== before.ino) {
    if (replaceable) throw new PointerReplaced();
    fail();
  }
}

async function readJson(path: string, maximum = MAX_BYTES, replaceable = false): Promise<unknown> {
  const before = await lstat(path);
  if (before.size < 2 || before.size > maximum) fail();
  await checkReadFile(path, before, before, replaceable);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    await checkReadFile(path, before, stat, replaceable);
    if (stat.size !== before.size) fail();
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const next = await handle.read(buffer, size, buffer.length - size, size);
      if (next.bytesRead === 0) break;
      size += next.bytesRead;
    }
    const after = await handle.stat();
    await checkReadFile(path, stat, after, replaceable);
    if (
      size !== stat.size ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    )
      fail();
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size)));
    } catch {
      fail();
    }
  } finally {
    await handle.close();
  }
}

async function readPointer(path: string): Promise<unknown> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await readJson(path, 4096, true);
    } catch (error) {
      if (!(error instanceof PointerReplaced)) throw error;
    }
  }
  fail("evidence-store-busy");
}

async function current(path: string, scope: Scope): Promise<Snapshot | null> {
  const pointerPath = join(path, "current.json");
  if (!(await maybeStat(pointerPath))) return null;
  const pointer = record(await readPointer(pointerPath), [
    "schemaVersion",
    "repo",
    "limit",
    "snapshot",
    "checksum",
  ]);
  if (
    pointer.schemaVersion !== 1 ||
    pointer.repo !== scope.repo ||
    pointer.limit !== scope.limit ||
    typeof pointer.snapshot !== "string" ||
    !UUID_FILE.test(pointer.snapshot) ||
    typeof pointer.checksum !== "string" ||
    !HASH.test(pointer.checksum)
  )
    fail();
  const raw = record(await readJson(join(path, pointer.snapshot)), [
    "schemaVersion",
    "repo",
    "limit",
    "savedAt",
    "capture",
    "checksum",
  ]);
  if (
    raw.schemaVersion !== 1 ||
    raw.repo !== scope.repo ||
    raw.limit !== scope.limit ||
    typeof raw.checksum !== "string" ||
    !HASH.test(raw.checksum) ||
    raw.checksum !== pointer.checksum
  )
    fail();
  const capture = captureValue(raw.capture, scope);
  const savedAt = timestamp(raw.savedAt);
  if (
    !eligible(capture, scope.limit) ||
    Date.parse(savedAt) < Date.parse(capture.captureWindow.completedAt)
  )
    fail();
  const payload = { schemaVersion: 1 as const, ...scope, savedAt, capture };
  if (digest(payload) !== raw.checksum) fail();
  return { ...payload, checksum: raw.checksum };
}

async function exclusiveFile(path: string, content: string, owned: Set<string>): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  owned.add(path);
  try {
    safeStat(await handle.stat(), false);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    safeStat(await handle.stat(), false);
  } finally {
    await handle.close();
  }
}

async function removeTemporary(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (fsCode(error) !== "ENOENT") throw error;
  }
}

export function createSemanticEvidenceStore(options?: {
  home?: string;
  now?: () => string;
}): SemanticEvidenceStore {
  let home: string | undefined;
  function location(): string {
    if (home === undefined) {
      const configured =
        options?.home ?? process.env.ISSUE_GRAPH_HOME ?? join(homedir(), ".issue-graph");
      if (
        typeof configured !== "string" ||
        configured.length === 0 ||
        configured.length > 4096 ||
        configured.includes("\0")
      )
        fail();
      home = resolve(configured);
    }
    return home;
  }
  return {
    read(repo, limit) {
      return guarded(false, async () => {
        const scope = scopeValue(repo, limit);
        const path = await tree(location(), scope, false);
        return path === null ? null : ((await current(path, scope))?.capture ?? null);
      });
    },
    write(repo, limit, input) {
      return guarded(true, async () => {
        const scope = scopeValue(repo, limit);
        const capture = captureValue(input, scope);
        if (!eligible(capture, limit)) return;
        bytes(capture);
        const existingPath = await tree(location(), scope, false);
        const previous = existingPath === null ? null : await current(existingPath, scope);
        const semantic = semanticValue(capture);
        if (previous && semanticValue(previous.capture) === semantic) return;
        const payload = {
          schemaVersion: 1 as const,
          ...scope,
          savedAt: timestamp(options?.now ? options.now() : new Date().toISOString()),
          capture,
        };
        if (Date.parse(payload.savedAt) < Date.parse(capture.captureWindow.completedAt)) fail();
        const snapshot = { ...payload, checksum: digest(payload) };
        const content = bytes(snapshot);
        const path = await tree(location(), scope, true);
        if (path === null) fail();
        const lock = join(path, ".writing");
        try {
          await mkdir(lock, { mode: 0o700 });
        } catch (error) {
          if (fsCode(error) === "EEXIST") {
            const existing = await maybeStat(lock);
            if (existing) safeStat(existing, true);
            fail("evidence-store-busy");
          }
          throw error;
        }
        const temporary = join(path, `.${randomUUID()}.pointer.tmp`);
        const staged = join(path, `.${randomUUID()}.capture.tmp`);
        const owned = new Set<string>();
        try {
          safeStat(await lstat(lock), true);
          const latest = await current(path, scope);
          if (latest && semanticValue(latest.capture) === semantic) return;
          const filename = `${randomUUID()}.json`;
          const destination = join(path, filename);
          await exclusiveFile(staged, content, owned);
          if (bytes(await readJson(staged)) !== content) fail();
          await link(staged, destination);
          await unlink(staged);
          if (bytes(await readJson(destination)) !== content) fail();
          await syncDirectory(path);
          const pointer = {
            schemaVersion: 1,
            ...scope,
            snapshot: filename,
            checksum: snapshot.checksum,
          };
          const pointerContent = bytes(pointer, 4096);
          await exclusiveFile(temporary, pointerContent, owned);
          if (bytes(await readJson(temporary, 4096), 4096) !== pointerContent) fail();
          await tree(location(), scope, false);
          await current(path, scope);
          await rename(temporary, join(path, "current.json"));
          await syncDirectory(path);
        } finally {
          try {
            for (const path of owned) await removeTemporary(path);
          } finally {
            await rmdir(lock);
          }
        }
      });
    },
  };
}
