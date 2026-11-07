import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export const stateHome = () =>
  resolve(process.env.ISSUE_GRAPH_HOME || join(homedir(), ".issue-graph"));
export const contentId = (text: string | Uint8Array) =>
  createHash("sha256").update(text).digest("hex");
export const hasCode = (error: unknown, code: string) =>
  error !== null && typeof error === "object" && "code" in error && error.code === code;

export function readLocal(file: string): string {
  return readLocalBytes(file).toString("utf8");
}

export function readLocalBytes(file: string): Buffer {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`expected a regular file: ${file}`);
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function publishLocal(file: string, text: string | Uint8Array, replace = false): void {
  fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = join(dirname(file), `.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, text, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (replace) fs.renameSync(temp, file);
    else {
      try {
        fs.linkSync(temp, file);
      } catch (error) {
        if (!hasCode(error, "EEXIST") || !readLocalBytes(file).equals(Buffer.from(text)))
          throw error;
      }
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temp, { force: true });
  }
}

/** A path inside a fresh mode-0700 directory, so exported HTML and its sibling assets share no ancestor another account can write. */
export function privateExportPath(name: string): string {
  return join(fs.mkdtempSync(join(tmpdir(), "issue-graph-")), name);
}

const othersCanWrite = (mode: number) => (mode & 0o022) !== 0;

/** Refuse `root` when it or any ancestor is foreign, or writable by others without the sticky bit. Returns its real path. */
export function assertPrivateRoot(root: string): string {
  const uid = process.getuid?.();
  const real = fs.realpathSync(root);
  if (uid === undefined) return real;
  for (let dir = real; ; dir = dirname(dir)) {
    const stat = fs.statSync(dir);
    if (
      (stat.uid !== uid && stat.uid !== 0) ||
      (othersCanWrite(stat.mode) && !(stat.mode & 0o1000))
    )
      throw new Error(`refusing to publish under a directory other accounts can modify: ${dir}`);
    if (dirname(dir) === dir) break;
  }
  return real;
}

/**
 * Refuse a published file that another account could replace or edit: any ancestor of `root` that
 * is not owned by this account or root, or is writable by others without the sticky bit; any
 * directory between `root` and `file` that is a symlink, foreign, or writable by others; or the
 * file itself when it is not a private regular file.
 */
export function assertPrivatePath(root: string, file: string): void {
  const uid = process.getuid?.();
  if (uid === undefined) return;
  const real = assertPrivateRoot(root);
  let dir = real;
  for (const part of relative(resolve(root), dirname(resolve(file)))
    .split(sep)
    .filter(Boolean)) {
    dir = join(dir, part);
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.uid !== uid || othersCanWrite(stat.mode))
      throw new Error(`refusing to publish through a shared or linked directory: ${dir}`);
  }
  const stat = fs.lstatSync(join(dir, basename(file)));
  if (!stat.isFile() || stat.uid !== uid || othersCanWrite(stat.mode))
    throw new Error(`refusing a published file other accounts can modify: ${file}`);
}
