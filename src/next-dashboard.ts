import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model } from "./html.js";
import { contentId, publishLocal, readLocal, readLocalBytes } from "./local-store.js";
import { parseModel } from "./model-validation.js";
import type { Weights } from "./scoring.js";

export function prepareDashboard(models: Model[], weights: Record<string, Weights> = {}) {
  if (!models.length) throw new Error("dashboard needs at least one model");
  const packaged = fileURLToPath(new URL("./dashboard/", import.meta.url));
  const root = existsSync(join(packaged, "index.html"))
    ? packaged
    : fileURLToPath(new URL("../apps/dashboard/out/", import.meta.url));
  if (!existsSync(join(root, "index.html")))
    throw new Error("Next.js dashboard build is missing. Run the package build before opening it.");
  const assets: Record<string, Buffer> = {};
  const visit = (path: string) => {
    for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
      const name = `${path}/${entry.name}`;
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile()) assets[name] = readLocalBytes(join(root, name));
      else throw new Error(`unexpected dashboard asset: ${name}`);
    }
  };
  visit("_next");
  assets["font-LICENSE.txt"] = readLocalBytes(join(root, "font-LICENSE.txt"));
  const manifest = Object.fromEntries(
    Object.keys(assets)
      .sort()
      .map((name) => [name, contentId(assets[name])]),
  );
  const data = JSON.stringify({ projects: models.map(parseModel), defaults: weights }).replace(
    /</g,
    "\\u003c",
  );
  const template = readLocal(join(root, "index.html"));
  if (!template.includes("</body>")) throw new Error("invalid Next.js dashboard template");
  const html = template.replace(
    "</body>",
    () => `<script id="issue-graph-data" type="application/json">${data}</script></body>`,
  );
  return { html, assets, manifest };
}

export function publishDashboardAssets(dir: string, assets: Record<string, Buffer>) {
  for (const [name, bytes] of Object.entries(assets)) publishLocal(join(dir, name), bytes);
}

export function verifyDashboardAssets(dir: string, manifest: Record<string, string>) {
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    !Object.keys(manifest).length
  )
    throw new Error("missing dashboard assets");
  for (const [name, hash] of Object.entries(manifest)) {
    if (
      (name !== "font-LICENSE.txt" && !/^_next\/[a-zA-Z0-9_./()[\]-]+$/.test(name)) ||
      name.split("/").includes("..") ||
      contentId(readLocalBytes(join(dir, name))) !== hash
    )
      throw new Error("saved dashboard asset has changed");
  }
}

export function writeNextDashboard(
  file: string,
  models: Model[],
  weights: Record<string, Weights> = {},
) {
  const artifact = prepareDashboard(models, weights);
  publishDashboardAssets(dirname(file), artifact.assets);
  publishLocal(file, artifact.html, true);
}
