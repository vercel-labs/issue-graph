import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

export function buildDashboard() {
  const app = join(root, "apps/dashboard");
  const hash = createHash("sha256");
  const add = (path: string) => {
    for (const entry of readdirSync(join(root, path), { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const name = `${path}/${entry.name}`;
      if (entry.isDirectory()) add(name);
      else hash.update(name).update(readFileSync(join(root, name)));
    }
  };
  add("apps/dashboard/src");
  for (const path of [
    "apps/dashboard/package.json",
    "apps/dashboard/next.config.mjs",
    "apps/dashboard/tsconfig.json",
    "pnpm-lock.yaml",
    "scripts/build-dashboard.ts",
    "src/dashboard-query.ts",
    "src/dashboard-filters.ts",
    "src/dashboard-client.ts",
    "src/dashboard-view.js",
    "src/dashboard-style.ts",
    "src/scoring.ts",
    "src/model-validation.ts",
  ])
    hash.update(path).update(readFileSync(join(root, path)));
  const fingerprint = hash.digest("hex"),
    stamp = join(app, "out/.source-hash");
  if (
    existsSync(stamp) &&
    readFileSync(stamp, "utf8") === fingerprint &&
    existsSync(join(app, "out/index.html"))
  )
    return;
  const result = spawnSync(
    process.execPath,
    [join(app, "node_modules/next/dist/bin/next"), "build", "--webpack"],
    {
      cwd: app,
      stdio: "inherit",
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, "Next.js dashboard build failed");
  writeFileSync(
    join(app, "out/font-LICENSE.txt"),
    readFileSync(join(app, "node_modules/geist/LICENSE.txt")),
  );
  writeFileSync(stamp, fingerprint);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) buildDashboard();
