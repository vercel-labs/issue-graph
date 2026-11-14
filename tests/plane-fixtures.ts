import type { PlaneGraphOptions } from "../src/plane.js";
import { type PlanePage, PlaneReadError, type PlaneReader } from "../src/plane-queries.js";

export const workspace = "fixture";
export const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
export const pid = (number: number) =>
  `11111111-1111-4111-8111-${String(number).padStart(12, "0")}`;
export const key = (number: number) => `plane:${workspace}:issue:${id(number)}`;
export const engine = {
  id: pid(1),
  identifier: "ENG",
  name: "Engine",
  archived_at: null,
  intake_view: true,
};
export const ops = {
  id: pid(2),
  identifier: "OPS",
  name: "Ops",
  archived_at: null,
  intake_view: false,
};

export const options: PlaneGraphOptions = {
  maxDepth: 1,
  maxNodes: 80,
  maxPages: 5,
  hubThreshold: 12,
  concurrency: 2,
  generatedAt: "2026-11-08T00:00:00.000Z",
};

export interface FixtureItem {
  id: string;
  name: string;
  identifier: string;
  sequence_id: number;
  project_id: string;
  parent_id: string | null;
  archived_at: string | null;
  updated_at: string;
  description_html: string;
  state: { id: string; name: string; group: string };
}

export function item(
  number: number,
  overrides: Partial<FixtureItem> & { project?: typeof engine } = {},
): FixtureItem {
  const { project = engine, ...rest } = overrides;
  return {
    id: id(number),
    name: `Item ${number}`,
    identifier: `${project.identifier}-${number}`,
    sequence_id: number,
    project_id: project.id,
    parent_id: null,
    archived_at: null,
    updated_at: "2026-11-01T00:00:00.000Z",
    description_html: `<p>Body &amp; detail ${number}</p>`,
    state: { id: pid(90), name: "In Progress", group: "started" },
    ...rest,
  };
}

export interface Fixture {
  items: FixtureItem[];
  relations?: Record<string, Record<string, unknown[]>>;
  links?: Record<string, unknown[]>;
  projects?: Array<typeof engine>;
  /** Intake requests by project id, as `{ status, issue_detail }`. */
  intake?: Record<string, unknown[]>;
  /** Page size for workspace and project lists. */
  pageSize?: number;
}

function paged(values: unknown[], size: number, next?: string): PlanePage {
  const offset = next ? Number(new URLSearchParams(next).get("offset")) : 0;
  const end = offset + size;
  return {
    items: values.slice(offset, end),
    ...(end < values.length && { next: `offset=${end}` }),
    total: values.length,
  };
}

export function fixtureReader(fixture: Fixture): PlaneReader & { calls: string[] } {
  const calls: string[] = [];
  const size = fixture.pageSize ?? 100;
  const find = (match: (item: FixtureItem) => boolean) => fixture.items.find(match);
  return {
    calls,
    label: "fixture",
    workspace,
    webUrl: "https://app.plane.so",
    async projects() {
      calls.push("projects");
      return { items: fixture.projects ?? [engine, ops] };
    },
    async workItems(next) {
      calls.push(`workItems ${next ?? ""}`.trim());
      return paged(fixture.items, size, next);
    },
    async workItemByIdentifier(identifier) {
      calls.push(`identifier ${identifier}`);
      const found = find((item) => item.identifier === identifier);
      if (!found) throw new PlaneReadError("NOT_FOUND");
      return found;
    },
    async workItem(projectId, itemId) {
      calls.push(`item ${projectId} ${itemId}`);
      const found = find((item) => item.id === itemId && item.project_id === projectId);
      if (!found) throw new PlaneReadError("NOT_FOUND");
      return found;
    },
    async relations(_projectId, itemId) {
      calls.push(`relations ${itemId}`);
      return fixture.relations?.[itemId] ?? { blocking: [], blocked_by: [] };
    },
    async links(_projectId, itemId) {
      calls.push(`links ${itemId}`);
      return { items: fixture.links?.[itemId] ?? [] };
    },
    async children(parentId, next) {
      calls.push(`children ${parentId}`);
      return paged(
        fixture.items.filter((item) => item.parent_id === parentId),
        size,
        next,
      );
    },
    async intake(projectId, next) {
      calls.push(`intake ${projectId}`);
      return paged(fixture.intake?.[projectId] ?? [], size, next);
    },
    async projectWorkItems(projectId, next) {
      calls.push(`projectWorkItems ${projectId}`);
      return paged(
        fixture.items.filter((item) => item.project_id === projectId),
        size,
        next,
      );
    },
  };
}
