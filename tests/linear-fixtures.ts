import type { LinearGraphOptions } from "../src/linear.js";
import { LINEAR_CONNECTIONS, type LinearReader } from "../src/linear-queries.js";

export const organization = "11111111-1111-4111-8111-111111111111";
export const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
export const key = (number: number) => `linear:${organization}:issue:${id(number)}`;
export const workspace = { id: organization, urlKey: "fixture", name: "Fixture" };
export const options: LinearGraphOptions = {
  maxDepth: 1,
  maxNodes: 80,
  maxPages: 5,
  hubThreshold: 12,
  concurrency: 4,
  generatedAt: "2026-09-26T00:00:00.000Z",
};

export function reference(number: number) {
  return {
    id: id(number),
    identifier: `ENG-${number}`,
    url: `https://linear.app/fixture/issue/ENG-${number}/example`,
    team: { organization: { id: organization } },
  };
}

export function page(nodes: unknown[] = [], cursor: string | null = null) {
  return { nodes, pageInfo: { hasNextPage: cursor !== null, endCursor: cursor } };
}

export function issue(number: number) {
  return {
    ...reference(number),
    title: `Issue ${number}`,
    updatedAt: "2026-09-25T00:00:00.000Z",
    archivedAt: null as string | null,
    state: { name: "In review", type: "started" },
    parent: null as ReturnType<typeof reference> | null,
    ...Object.fromEntries(LINEAR_CONNECTIONS.map((name) => [name, page()])),
  } as ReturnType<typeof reference> & {
    title: string;
    updatedAt: string;
    archivedAt: string | null;
    state: { name: string; type: string };
    parent: ReturnType<typeof reference> | null;
    relations: ReturnType<typeof page>;
    inverseRelations: ReturnType<typeof page>;
    children: ReturnType<typeof page>;
    attachments: ReturnType<typeof page>;
  };
}

export function relation(from: number, to: number, type = "blocks") {
  return {
    id: `${from}-${to}-${type}`,
    type,
    archivedAt: null as string | null,
    issue: reference(from),
    relatedIssue: reference(to),
  };
}

export function fixtureReader(issues: ReturnType<typeof issue>[] = [issue(1)]): LinearReader {
  return {
    async workspace() {
      return { organization: workspace };
    },
    async issue(locator) {
      const found = issues.find((item) => item.id === locator || item.identifier === locator);
      if (!found) throw new Error("Fixture issue unavailable");
      return { issue: structuredClone(found) };
    },
  };
}
