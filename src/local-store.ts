import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

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

/**
 * Refuse a published tree when any directory between `root` and `file` is a symlink, belongs to
 * another account, or is writable by group or others. Owners of such a directory could swap files
 * after they are written.
 */
export function assertPrivateDirs(root: string, file: string): void {
  const uid = process.getuid?.();
  if (uid === undefined) return;
  let dir = fs.realpathSync(root);
  const top = fs.statSync(dir);
  if ((top.uid !== uid && top.uid !== 0) || ((top.mode & 0o022) !== 0 && (top.mode & 0o1000) === 0))
    throw new Error(`refusing to publish into a directory other accounts can modify: ${dir}`);
  for (const part of relative(resolve(root), dirname(resolve(file)))
    .split(sep)
    .filter(Boolean)) {
    dir = join(dir, part);
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o022) !== 0)
      throw new Error(`refusing to publish through a shared or linked directory: ${dir}`);
  }
}
