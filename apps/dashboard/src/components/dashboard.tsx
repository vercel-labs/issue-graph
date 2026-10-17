"use client";

import { type DashboardDocument, mountDashboard } from "@core/dashboard-client";
import { dashboardQuery } from "@core/dashboard-query";
import { parseModel } from "@core/model-validation";
import { scoring } from "@core/scoring";
import { useEffect, useRef, useState } from "react";

function parseDocument(raw: unknown): DashboardDocument {
  if (!raw || typeof raw !== "object") throw new Error("Expected a captured project.");
  const value = raw as Partial<DashboardDocument> & { schemaVersion?: number; model?: unknown };
  const projects = (
    Array.isArray(raw)
      ? raw
      : value.projects || [value.schemaVersion === 1 && value.model ? value.model : raw]
  ).map(parseModel);
  if (!projects.length) throw new Error("This capture contains no projects.");
  const ids = projects.map(dashboardQuery.identity);
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate project identities.");
  const defaults = Object.fromEntries(
    projects.map((model) => [
      dashboardQuery.identity(model),
      {
        ...scoring.defaults,
        ...scoring.validate(value.defaults?.[dashboardQuery.identity(model)] ?? {}),
      },
    ]),
  );
  return { projects, defaults };
}

export function Dashboard() {
  const root = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<DashboardDocument | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const load = () => {
      const raw = document.getElementById("issue-graph-data")?.textContent;
      if (raw) {
        try {
          setData(parseDocument(JSON.parse(raw)));
        } catch (error) {
          setError(error instanceof Error ? error.message : String(error));
        }
      }
      setReady(true);
    };
    if (document.readyState === "loading")
      document.addEventListener("DOMContentLoaded", load, { once: true });
    else load();
    return () => document.removeEventListener("DOMContentLoaded", load);
  }, []);
  useEffect(() => {
    if (!data || !root.current) return;
    try {
      return mountDashboard(root.current, data);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }, [data]);
  const selected =
    data?.projects.find(
      (model) =>
        dashboardQuery.identity(model) === new URL(location.href).searchParams.get("project") ||
        (model.id || model.repo) === new URL(location.href).searchParams.get("project"),
    ) ?? data?.projects[0];
  return (
    <>
      <title>{selected ? `issue-graph · ${selected.label || selected.repo}` : "issue-graph"}</title>
      <div id="app" ref={root} />
      {ready && !data && (
        <main className="empty">
          <h1>issue-graph</h1>
          <label>
            Open a captured project
            <input
              type="file"
              accept=".json,application/json"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                try {
                  setData(parseDocument(JSON.parse(await file.text())));
                  setError("");
                } catch (error) {
                  setError(error instanceof Error ? error.message : String(error));
                }
              }}
            />
          </label>
        </main>
      )}
      {error && <p role="alert">{error}</p>}
    </>
  );
}
