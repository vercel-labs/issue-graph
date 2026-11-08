/** One page of a Plane list endpoint. `next` is an opaque token for the following page. */
export interface PlanePage {
  items: unknown[];
  next?: string;
  /** Total matching rows, when the endpoint reports it. */
  total?: number;
}

/**
 * Read-only access to one Plane workspace. Implementations return raw API payloads;
 * `plane.ts` validates and normalizes them.
 */
export interface PlaneReader {
  /** How the data was read, recorded as the report's source. */
  label?: string;
  /** Workspace slug every read is scoped to. */
  workspace: string;
  /** Web app origin used for item and project links, such as `https://app.plane.so`. */
  webUrl: string;
  projects(next?: string): Promise<PlanePage>;
  /** A work item by its `PROJ-123` key, with its state expanded. */
  workItemByIdentifier(identifier: string): Promise<unknown>;
  /** A work item by project and UUID, with its state expanded. */
  workItem(projectId: string, id: string): Promise<unknown>;
  /** Relation lists keyed by Plane relation type. */
  relations(projectId: string, id: string): Promise<unknown>;
  links(projectId: string, id: string, next?: string): Promise<PlanePage>;
  /** Work items across the workspace, with their state expanded. */
  workItems(next?: string): Promise<PlanePage>;
  /** Direct children of a work item, with their state expanded. */
  children(parentId: string, next?: string): Promise<PlanePage>;
  /** Work items in a project, with their state expanded. */
  projectWorkItems(projectId: string, next?: string): Promise<PlanePage>;
  /** Number of open (triage, backlog, unstarted, started) work items in a project. */
  countOpen?(projectId: string): Promise<number | undefined>;
}

export class PlaneReadError extends Error {
  constructor(readonly code: string) {
    super(`Plane read failed (${code})`);
    this.name = "PlaneReadError";
  }
}

/** Plane relation types, in the shape the relations endpoint returns them. */
export const PLANE_RELATION_TYPES = [
  "blocking",
  "blocked_by",
  "duplicate",
  "relates_to",
  "start_before",
  "start_after",
  "finish_before",
  "finish_after",
] as const;

export type PlaneRelationType = (typeof PLANE_RELATION_TYPES)[number];

export const PLANE_OPEN_STATE_GROUPS = ["triage", "backlog", "unstarted", "started"] as const;
