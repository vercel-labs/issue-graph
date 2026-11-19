import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  dashboardDir,
  readDashboardModel,
  readDashboardModels,
  removeDashboardRun,
  writeDashboardModel,
} from "./snapshot.js";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ig-store-"));
  vi.stubEnv("ISSUE_GRAPH_HOME", home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

test("ids that reduce to the same file name keep separate saved runs", () => {
  const a = "gitlab:h:project:foo/bar_baz";
  const b = "gitlab:h:project:foo_bar/baz";
  const fileA = writeDashboardModel(a, { id: a, n: 1 });
  const fileB = writeDashboardModel(b, { id: b, n: 2 });
  expect(path.basename(fileA)).toBe("gitlab_h_project_foo_bar_baz.json");
  expect(fileB).not.toBe(fileA);
  expect(readDashboardModel(a)).toEqual({ id: a, n: 1 });
  expect(readDashboardModel(b)).toEqual({ id: b, n: 2 });
  expect(writeDashboardModel(b, { id: b, n: 3 })).toBe(fileB);
  expect(readDashboardModels()).toHaveLength(2);
  expect(removeDashboardRun(b)).toBe(true);
  expect(readDashboardModel(b)).toBeUndefined();
  expect(readDashboardModel(a)).toEqual({ id: a, n: 1 });
});

test("a run in the hashed file keeps it after the readable file is removed", () => {
  const a = "gitlab:h:project:foo/bar_baz";
  const b = "gitlab:h:project:foo_bar/baz";
  writeDashboardModel(a, { id: a });
  const fileB = writeDashboardModel(b, { id: b, n: 1 });
  expect(removeDashboardRun(a)).toBe(true);
  expect(writeDashboardModel(b, { id: b, n: 2 })).toBe(fileB);
  expect(readDashboardModels()).toEqual([{ id: b, n: 2 }]);
});

test("a run without an id keeps answering after it lands in the hashed file", () => {
  const repo = "acme/api";
  const other = "acme:api";
  writeDashboardModel(other, { id: other, n: 1 });
  const file = writeDashboardModel(repo, { repo, n: 2 });
  expect(path.basename(file)).not.toBe("acme_api.json");
  expect(readDashboardModel(repo)).toEqual({ repo, n: 2 });
  expect(writeDashboardModel(repo, { repo, n: 3 })).toBe(file);
  expect(removeDashboardRun(repo)).toBe(true);
  expect(readDashboardModel(other)).toEqual({ id: other, n: 1 });
});

test("a model saved without an id keeps its readable file name", () => {
  fs.mkdirSync(dashboardDir(), { recursive: true });
  const legacy = path.join(dashboardDir(), "acme_api.json");
  fs.writeFileSync(legacy, JSON.stringify({ repo: "acme/api" }));
  expect(readDashboardModel("acme/api")).toEqual({ repo: "acme/api" });
  expect(writeDashboardModel("acme/api", { repo: "acme/api", n: 2 })).toBe(legacy);
  expect(removeDashboardRun("acme/api")).toBe(true);
  expect(removeDashboardRun("acme/api")).toBe(false);
});
