import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDashboard } from "./build-dashboard.js";

assert.equal(process.release.name, "node", "build requires Node.js");
const root = fileURLToPath(new URL("../", import.meta.url));
buildDashboard();
rmSync(join(root, "dist"), { recursive: true, force: true });
const build = spawnSync(
  process.execPath,
  [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"],
  { cwd: root, stdio: "inherit" },
);
assert.ifError(build.error);
assert.equal(build.signal, null, `TypeScript build killed by ${build.signal}`);
if (build.status !== 0) process.exit(build.status ?? 1);
chmodSync(join(root, "dist/bin.js"), 0o755);
mkdirSync(join(root, "dist/dashboard"), { recursive: true });
for (const name of ["index.html", "_next", "font-LICENSE.txt"])
  cpSync(join(root, "apps/dashboard/out", name), join(root, "dist/dashboard", name), {
    recursive: true,
  });
