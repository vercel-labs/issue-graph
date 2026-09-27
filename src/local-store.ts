import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
