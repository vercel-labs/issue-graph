import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type DashboardQuery, dashboardQuery } from "./dashboard-query.js";
import type { Model } from "./html.js";
import { contentId, publishLocal, readLocal, stateHome } from "./local-store.js";
import { parseModel } from "./model-validation.js";
import {
  prepareDashboard,
  publishDashboardAssets,
  verifyDashboardAssets,
} from "./next-dashboard.js";

export { parseModel } from "./model-validation.js";

interface Capture {
  schemaVersion: 1;
  model: Model;
}

export function saveCapture(model: Model): string {
  const text = JSON.stringify({ schemaVersion: 1, model: parseModel(model) });
  const id = contentId(text);
  publishLocal(join(stateHome(), "captures", `${id}.json`), text);
  return id;
}

export function readCapture(id: string): Model {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("invalid capture ID");
  const text = readLocal(join(stateHome(), "captures", `${id}.json`));
  if (contentId(text) !== id) throw new Error(`corrupt capture: ${id}`);
  const capture = JSON.parse(text) as Capture;
  if (capture.schemaVersion !== 1) throw new Error("unsupported capture schemaVersion");
  return parseModel(capture.model);
}

export function saveQuery(model: Model, captureId: string, query: DashboardQuery) {
  const { html, assets, manifest } = prepareDashboard([model], {
    [dashboardQuery.identity(model)]: query.weights,
  });
  const rendererId = contentId(html);
  const receipt = {
    schemaVersion: 1,
    scoringVersion: 1,
    captureId,
    rendererId,
    assets: manifest,
    provider: model.provider.id,
    scope: dashboardQuery.scope(model),
    query,
  };
  const text = JSON.stringify(receipt, null, 2);
  const id = contentId(text);
  const dir = join(stateHome(), "history", id);
  const file = join(dir, "view.html");
  publishDashboardAssets(dir, assets);
  publishLocal(file, html);
  const viewUrl = dashboardQuery.url(pathToFileURL(file).href, model, query);
  publishLocal(join(dir, "query.json"), JSON.stringify({ ...receipt, viewUrl }, null, 2));
  return { id, viewUrl };
}

export function readQuery(id: string) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("invalid history ID");
  const dir = join(stateHome(), "history", id);
  const { viewUrl, ...receipt } = JSON.parse(readLocal(join(dir, "query.json")));
  if (
    contentId(JSON.stringify(receipt, null, 2)) !== id ||
    receipt.schemaVersion !== 1 ||
    receipt.scoringVersion !== 1
  )
    throw new Error("corrupt or unsupported query history");
  const model = readCapture(receipt.captureId);
  if (contentId(readLocal(join(dir, "view.html"))) !== receipt.rendererId)
    throw new Error("saved view has changed");
  verifyDashboardAssets(dir, receipt.assets);
  const query = dashboardQuery.normalize(model, receipt.query);
  const expectedUrl = dashboardQuery.url(pathToFileURL(join(dir, "view.html")).href, model, query);
  if (viewUrl !== expectedUrl) throw new Error("saved view URL has changed");
  return { model, query, captureId: receipt.captureId as string, id, viewUrl: expectedUrl };
}
