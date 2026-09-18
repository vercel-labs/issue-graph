import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { normalizeStatusScope, type StatusReport } from "./status.js";
import type { StatusSnapshot } from "./status-history-types.js";
import { parseStatusSnapshot } from "./status-snapshot.js";

function scopeKey(scope: StatusReport["scope"]): string {
  const normalized = normalizeStatusScope(scope.repos, scope.authors);
  return JSON.stringify({
    repos: normalized.repos.map((repo) => repo.toLowerCase()),
    authors: normalized.authors.map((author) => author.toLowerCase()),
  });
}

export function statusHistoryDir(
  scope: StatusReport["scope"],
  home = process.env.ISSUE_GRAPH_HOME || join(homedir(), ".issue-graph"),
): string {
  const hash = createHash("sha256").update(scopeKey(scope)).digest("hex");
  return join(resolve(home), "status", hash);
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

function contextual(action: string, file: string, cause: unknown): Error {
  return new Error(
    `${action} status snapshot ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
    { cause },
  );
}

export function readStatusSnapshot(file: string): StatusSnapshot {
  let fd: number | undefined;
  try {
    if (!lstatSync(file).isFile())
      throw new Error("expected a regular file, not a symlink or directory");
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) throw new Error("expected a regular file");
    return parseStatusSnapshot(JSON.parse(readFileSync(fd, "utf8")));
  } catch (cause) {
    throw contextual("Cannot read", file, cause);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function latestStatusSnapshot(
  scope: StatusReport["scope"],
  home?: string,
): { snapshot: StatusSnapshot; path: string } | null {
  const dir = statusHistoryDir(scope, home);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) return null;
    throw contextual("Cannot list", dir, cause);
  }
  const latest = names
    .filter((name) => /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-.+\.json$/.test(name))
    .sort()
    .at(-1);
  if (!latest) return null;
  const path = join(dir, latest);
  const snapshot = readStatusSnapshot(path);
  if (scopeKey(snapshot.scope) !== scopeKey(scope))
    throw contextual("Cannot load", path, new Error("snapshot scope mismatch"));
  return { snapshot, path };
}

function privateDirectory(dir: string, tightenExisting = false): void {
  const created = mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(`Not a regular directory: ${dir}`);
  if (created !== undefined || tightenExisting) chmodSync(dir, 0o700);
}

export function writeStatusSnapshot(snapshot: StatusSnapshot, home?: string): string {
  const validated = parseStatusSnapshot(snapshot);
  const dir = statusHistoryDir(validated.scope, home);
  const timestamp = new Date(validated.generatedAt).toISOString().replace(/[:.]/g, "-");
  const contents = `${JSON.stringify(validated, null, 2)}\n`;
  try {
    privateDirectory(dirname(dirname(dir)));
    privateDirectory(dirname(dir), true);
    privateDirectory(dir, true);
    for (let attempt = 0; attempt < 8; attempt++) {
      const id = randomUUID();
      const file = join(dir, `${timestamp}-${id}.json`);
      const temp = join(dir, `.${id}.tmp`);
      let fd: number | undefined;
      let owned = false;
      try {
        fd = openSync(
          temp,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        owned = true;
        fchmodSync(fd, 0o600);
        writeFileSync(fd, contents, "utf8");
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        linkSync(temp, file);
        return file;
      } catch (cause) {
        if (!hasCode(cause, "EEXIST")) throw cause;
      } finally {
        try {
          if (fd !== undefined) closeSync(fd);
        } finally {
          if (owned) unlinkSync(temp);
        }
      }
    }
    throw new Error("could not allocate a unique snapshot filename");
  } catch (cause) {
    throw contextual("Cannot write", dir, cause);
  }
}
