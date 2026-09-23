import {
  type SemanticCapture,
  type SemanticComment,
  type SemanticCoverage,
  SemanticError,
  type SemanticEvidence,
} from "./semantic-types.js";
import type { GhTransport } from "./transport.js";

const ISSUE_BATCH_SIZE = 20;
const INITIAL_COMMENTS = 10;
const COMMENT_PAGE_SIZE = 100;
const BODY_CONTINUATION_BATCH_SIZE = Math.floor(
  (ISSUE_BATCH_SIZE * INITIAL_COMMENTS) / COMMENT_PAGE_SIZE,
);
const MAX_COMMENTS = 300;
const MAX_COMMENT_PAGES = 1 + Math.ceil((MAX_COMMENTS - INITIAL_COMMENTS) / COMMENT_PAGE_SIZE);
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const REPOSITORY_FIELDS = "nameWithOwner visibility isPrivate";
const REPOSITORY_QUERY = `query SemanticRepository($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    ${REPOSITORY_FIELDS}
    issues(states: OPEN) { totalCount }
  }
}`;

function issueFields(bodies: boolean, first: string, after?: string): string {
  return `__typename id number state title updatedAt ${bodies ? "body" : ""}
    comments(first: ${first}${after ? `, after: ${after}` : ""}) {
      totalCount pageInfo { hasNextPage endCursor }
      nodes { __typename id url updatedAt author { login } ${bodies ? "body" : ""} }
    }`;
}

function issuesQuery(bodies: boolean): string {
  return `query SemanticIssues($owner: String!, $repo: String!, $after: String) {
    repository(owner: $owner, name: $repo) {
      ${REPOSITORY_FIELDS}
      issues(states: OPEN, first: ${ISSUE_BATCH_SIZE}, after: $after, orderBy: {field: CREATED_AT, direction: ASC}) {
        totalCount pageInfo { hasNextPage endCursor }
        nodes { ${issueFields(bodies, String(INITIAL_COMMENTS))} }
      }
    }
  }`;
}

type ObjectValue = Record<string, unknown>;
type Variables = Record<string, string | number>;
type IssueMetadata = {
  __typename: "Issue";
  id: string;
  number: number;
  state: "OPEN" | "CLOSED";
  updatedAt: string;
};
type Page = {
  nodes: unknown[];
  total: number;
  hasNextPage: boolean;
  cursor: string | null;
};

function object(value: unknown): value is ObjectValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function timestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function error(code: string): SemanticError {
  if (code === "invalid-capture-options")
    return new SemanticError(
      code,
      "Expected owner/repo and an integer limit from 1 to 500.",
      "Check the repository and capture limit.",
      2,
    );
  return new SemanticError(
    code,
    "GitHub semantic evidence could not be verified.",
    "Check repository access and retry the capture.",
  );
}

function reason(coverage: { reasonCodes: string[] }, code: string): void {
  if (!coverage.reasonCodes.includes(code)) coverage.reasonCodes.push(code);
}

function coverage(): SemanticCoverage {
  return {
    captured: 0,
    total: null,
    hasNextPage: null,
    pages: 0,
    complete: false,
    reasonCodes: [],
  };
}

function finish(value: SemanticCoverage): void {
  value.complete =
    value.reasonCodes.length === 0 && value.hasNextPage === false && value.total === value.captured;
}

async function repository(
  transport: GhTransport,
  query: string,
  variables: Variables,
): Promise<ObjectValue> {
  let response: unknown;
  try {
    response = await transport.graphql(query, variables);
  } catch {
    throw error("github-read-failed");
  }
  if (!object(response)) throw error("malformed-response");
  if (object(response.data)) {
    const repo = response.data.repository;
    if (!object(repo) || repo.visibility !== "PUBLIC" || repo.isPrivate !== false) {
      throw error("repository-not-public");
    }
  }
  if (new TextEncoder().encode(JSON.stringify(response)).byteLength > MAX_RESPONSE_BYTES)
    throw error("github-response-too-large");
  if (response.errors !== undefined && response.errors !== null) {
    if (!Array.isArray(response.errors)) throw error("malformed-response");
    if (response.errors.length > 0) throw error("github-graphql-error");
  }
  if (!object(response.data)) throw error("malformed-response");
  const repo = response.data.repository;
  if (!object(repo) || repo.visibility !== "PUBLIC" || repo.isPrivate !== false) {
    throw error("repository-not-public");
  }
  if (
    typeof repo.nameWithOwner !== "string" ||
    repo.nameWithOwner.toLowerCase() !== `${variables.owner}/${variables.repo}`.toLowerCase()
  )
    throw error("repository-identity-unverified");
  return repo;
}

function census(repo: ObjectValue): number {
  if (!object(repo.issues) || !count(repo.issues.totalCount)) throw error("malformed-response");
  return repo.issues.totalCount;
}

function page(value: unknown, maximum: number): Page {
  if (
    !object(value) ||
    !count(value.totalCount) ||
    !Array.isArray(value.nodes) ||
    value.nodes.length > maximum ||
    !object(value.pageInfo) ||
    typeof value.pageInfo.hasNextPage !== "boolean" ||
    !(value.pageInfo.endCursor === null || nonempty(value.pageInfo.endCursor)) ||
    (value.pageInfo.hasNextPage &&
      (!nonempty(value.pageInfo.endCursor) || value.nodes.length === 0)) ||
    value.nodes.length > value.totalCount
  ) {
    throw error("malformed-page");
  }
  return {
    nodes: value.nodes,
    total: value.totalCount,
    hasNextPage: value.pageInfo.hasNextPage,
    cursor: value.pageInfo.endCursor,
  };
}

function metadata(value: unknown): value is IssueMetadata & ObjectValue {
  return (
    object(value) &&
    value.__typename === "Issue" &&
    nonempty(value.id) &&
    count(value.number) &&
    value.number > 0 &&
    (value.state === "OPEN" || value.state === "CLOSED") &&
    timestamp(value.updatedAt)
  );
}

function failItem(item: SemanticEvidence, code: string): void {
  item.status = "failed";
  reason(item, code);
}

function recheck(item: SemanticEvidence, value: unknown): boolean {
  if (!metadata(value) || value.id !== item.id || value.number !== item.number) {
    failItem(item, "issue-identity-unverified");
    return false;
  }
  if (value.state === "CLOSED") {
    item.state = "CLOSED";
    item.status = "excluded";
    reason(item, "state-changed");
  }
  if (value.updatedAt !== item.updatedAt) {
    item.status = "excluded";
    reason(item, "needs-refresh");
  }
  return item.status === "ready";
}

type Validation = "current" | "state-changed" | "needs-refresh";

function repoVariables(repo: string): Variables {
  if (
    typeof repo !== "string" ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/.test(repo) ||
    [".", ".."].includes(repo.split("/")[1] ?? "")
  )
    throw error("invalid-capture-options");
  const [owner, name] = repo.split("/");
  return { owner, repo: name };
}

function identity(value: unknown, repo: string): value is SemanticEvidence {
  return (
    object(value) &&
    nonempty(value.id) &&
    count(value.number) &&
    value.number > 0 &&
    value.key === `${repo}#${value.number}` &&
    value.url === `https://github.com/${repo}/issues/${value.number}`
  );
}

function reusable(value: unknown, repo: string): value is SemanticEvidence {
  if (
    !identity(value, repo) ||
    value.status !== "ready" ||
    value.state !== "OPEN" ||
    typeof value.title !== "string" ||
    typeof value.body !== "string" ||
    !timestamp(value.updatedAt) ||
    !Array.isArray(value.reasonCodes) ||
    value.reasonCodes.length !== 0 ||
    !object(value.captureWindow) ||
    !timestamp(value.captureWindow.startedAt) ||
    !timestamp(value.captureWindow.completedAt) ||
    Date.parse(value.captureWindow.startedAt) > Date.parse(value.captureWindow.completedAt) ||
    !Array.isArray(value.comments) ||
    value.comments.length > MAX_COMMENTS
  )
    return false;
  const c = value.commentsCoverage;
  if (
    !object(c) ||
    c.complete !== true ||
    c.hasNextPage !== false ||
    c.total !== value.comments.length ||
    c.captured !== value.comments.length ||
    !count(c.pages) ||
    c.pages < 1 ||
    c.pages > MAX_COMMENT_PAGES ||
    !Array.isArray(c.reasonCodes) ||
    c.reasonCodes.length !== 0
  )
    return false;
  const ids = new Set<string>();
  const urls = new Set<string>();
  for (const raw of value.comments) {
    if (!object(raw)) return false;
    const parsed = comment(
      {
        ...raw,
        __typename: "IssueComment",
        author: raw.author === null ? null : { login: raw.author },
      },
      value.url,
    );
    if (!parsed || ids.has(parsed.id) || urls.has(parsed.url)) return false;
    ids.add(parsed.id);
    urls.add(parsed.url);
  }
  return true;
}

function compare(previous: SemanticEvidence, current: SemanticEvidence): Validation {
  if (current.state !== "OPEN") return "state-changed";
  if (
    current.status !== "ready" ||
    current.updatedAt !== previous.updatedAt ||
    current.title !== previous.title ||
    current.id !== previous.id ||
    current.commentsCoverage.total !== previous.commentsCoverage.total ||
    current.commentsCoverage.hasNextPage !== previous.commentsCoverage.hasNextPage ||
    current.commentsCoverage.complete !== previous.commentsCoverage.complete ||
    current.comments.length !== previous.comments.length ||
    current.comments.some((c, index) => {
      const old = previous.comments[index];
      return (
        !old ||
        c.id !== old.id ||
        c.updatedAt !== old.updatedAt ||
        c.url !== old.url ||
        c.author !== old.author
      );
    })
  )
    return "needs-refresh";
  return "current";
}

function failureCode(cause: unknown): string {
  if (cause instanceof SemanticError) {
    if (cause.code === "repository-not-public") throw cause;
    return cause.code;
  }
  return "github-read-failed";
}

function observePage(value: SemanticCoverage, next: Page, cursors: Set<string>): boolean {
  if (value.total !== null && value.total !== next.total) reason(value, "total-count-drift");
  value.total = next.total;
  value.hasNextPage = next.hasNextPage;
  if (next.cursor !== null) {
    if (cursors.has(next.cursor)) {
      reason(value, "repeated-cursor");
      return false;
    }
    cursors.add(next.cursor);
  }
  return true;
}

function reconcileCount(value: SemanticCoverage, seen: number): void {
  if (
    value.total !== null &&
    (seen > value.total ||
      (value.hasNextPage === false && seen !== value.total) ||
      (value.hasNextPage === true && seen >= value.total))
  ) {
    reason(value, "total-count-drift");
  }
}

function comment(value: unknown, issueUrl: string): SemanticComment | null {
  if (
    !object(value) ||
    value.__typename !== "IssueComment" ||
    !nonempty(value.id) ||
    typeof value.body !== "string" ||
    !timestamp(value.updatedAt) ||
    typeof value.url !== "string" ||
    value.url.slice(0, issueUrl.length).toLowerCase() !== issueUrl.toLowerCase() ||
    !value.url.slice(issueUrl.length).startsWith("#issuecomment-") ||
    !/^[1-9]\d*$/.test(value.url.slice(`${issueUrl}#issuecomment-`.length)) ||
    !(value.author === null || (object(value.author) && nonempty(value.author.login)))
  ) {
    return null;
  }
  return {
    id: value.id,
    url: `${issueUrl}${value.url.slice(issueUrl.length)}`,
    body: value.body,
    updatedAt: value.updatedAt,
    author: value.author === null ? null : (value.author.login as string),
  };
}

type Row = {
  item: SemanticEvidence;
  ids: Set<string>;
  urls: Set<string>;
  cursors: Set<string>;
  after: string | null;
  received: number;
  pending: boolean;
};

function row(item: SemanticEvidence): Row {
  return {
    item,
    ids: new Set(),
    urls: new Set(),
    cursors: new Set(),
    after: null,
    received: 0,
    pending: true,
  };
}

function blank(
  repo: string,
  raw: IssueMetadata & ObjectValue,
  startedAt: string,
): SemanticEvidence {
  return {
    key: `${repo}#${raw.number}`,
    id: raw.id,
    url: `https://github.com/${repo}/issues/${raw.number}`,
    number: raw.number,
    state: raw.state,
    title: raw.title as string,
    body: typeof raw.body === "string" ? raw.body : "",
    updatedAt: raw.updatedAt,
    comments: [],
    commentsCoverage: coverage(),
    captureWindow: { startedAt, completedAt: startedAt },
    status: raw.state === "OPEN" ? "ready" : "excluded",
    reasonCodes: raw.state === "OPEN" ? [] : ["state-changed"],
  };
}

function consume(
  target: Row,
  raw: unknown,
  maximum: number,
  bodies: boolean,
  initial = false,
): void {
  const { item } = target;
  const value = item.commentsCoverage;
  target.pending = false;
  try {
    if (!metadata(raw) || raw.id !== item.id || raw.number !== item.number)
      throw error("issue-identity-unverified");
    if (typeof raw.title !== "string" || (bodies && typeof raw.body !== "string"))
      throw error("malformed-issue");
    if (initial) {
      item.state = raw.state;
      item.updatedAt = raw.updatedAt;
      item.title = raw.title;
      item.body = bodies ? (raw.body as string) : "";
      item.status = raw.state === "OPEN" ? "ready" : "excluded";
      item.reasonCodes = raw.state === "OPEN" ? [] : ["state-changed"];
    } else if (!recheck(item, raw) || raw.title !== item.title) {
      if (raw.title !== item.title) {
        item.status = "excluded";
        reason(item, "needs-refresh");
      }
      reason(value, "issue-unavailable");
      return;
    }
    if (bodies && value.pages === 0) item.body = raw.body as string;
    value.pages++;
    const next = page(raw.comments, maximum);
    const advances = observePage(value, next, target.cursors);
    target.received += next.nodes.length;
    for (const rawComment of next.nodes) {
      const parsed = comment(
        bodies || !object(rawComment) ? rawComment : { ...rawComment, body: "" },
        item.url,
      );
      if (!parsed) {
        reason(value, "malformed-comment");
        failItem(item, "malformed-comment");
        continue;
      }
      if (target.ids.has(parsed.id) || target.urls.has(parsed.url)) {
        reason(value, "duplicate-comment");
        continue;
      }
      target.ids.add(parsed.id);
      target.urls.add(parsed.url);
      item.comments.push(parsed);
    }
    value.captured = item.comments.length;
    reconcileCount(value, value.captured);
    target.after = next.cursor;
    if ((target.received === MAX_COMMENTS || value.pages === MAX_COMMENT_PAGES) && next.hasNextPage)
      reason(value, "comments-page-limit");
    target.pending =
      advances && value.reasonCodes.length === 0 && next.hasNextPage && item.status === "ready";
  } catch (cause) {
    const code = failureCode(cause);
    failItem(item, code);
    reason(value, code);
    value.hasNextPage = null;
  }
  finish(value);
}

async function batches(
  transport: GhTransport,
  variables: Variables,
  rows: Row[],
  bodies: boolean,
  initial: boolean,
): Promise<void> {
  let pending = rows.filter((r) => r.pending);
  while (pending.length > 0) {
    const batchSize =
      bodies && pending.some((r) => r.item.commentsCoverage.pages > 0)
        ? BODY_CONTINUATION_BATCH_SIZE
        : ISSUE_BATCH_SIZE;
    for (let offset = 0; offset < pending.length; offset += batchSize) {
      const batch = pending.slice(offset, offset + batchSize);
      const vars = { ...variables };
      const declarations = ["$owner: String!", "$repo: String!"];
      const fields = batch.map((r, index) => {
        declarations.push(
          `$number${index}: Int!`,
          `$first${index}: Int!`,
          `$after${index}: String`,
        );
        vars[`number${index}`] = r.item.number;
        vars[`first${index}`] =
          r.item.commentsCoverage.pages === 0
            ? INITIAL_COMMENTS
            : Math.min(COMMENT_PAGE_SIZE, MAX_COMMENTS - r.received);
        if (r.after !== null) vars[`after${index}`] = r.after;
        return `i${index}: issue(number: $number${index}) { ${issueFields(bodies, `$first${index}`, `$after${index}`)} }`;
      });
      const query = `query Semantic${bodies ? "Bodies" : "Versions"}(${declarations.join(", ")}) {
        repository(owner: $owner, name: $repo) { ${REPOSITORY_FIELDS} ${fields.join("\n")} }
      }`;
      try {
        const result = await repository(transport, query, vars);
        batch.forEach((r, index) => {
          consume(
            r,
            result[`i${index}`],
            Number(vars[`first${index}`]),
            bodies,
            initial && r.item.commentsCoverage.pages === 0,
          );
        });
      } catch (cause) {
        const code = failureCode(cause);
        for (const r of batch) {
          failItem(r.item, code);
          reason(r.item.commentsCoverage, code);
          r.item.commentsCoverage.hasNextPage = null;
          r.item.commentsCoverage.complete = false;
          r.pending = false;
        }
      }
    }
    pending = rows.filter((r) => r.pending);
  }
}

async function versions(
  transport: GhTransport,
  repo: string,
  evidences: SemanticEvidence[],
): Promise<SemanticEvidence[]> {
  const variables = repoVariables(repo);
  const ids = new Set<string>();
  const numbers = new Set<number>();
  const rows = evidences.map((item) => {
    if (!identity(item, repo) || ids.has(item.id) || numbers.has(item.number))
      throw error("issue-identity-unverified");
    ids.add(item.id);
    numbers.add(item.number);
    return row(
      blank(
        repo,
        {
          __typename: "Issue",
          id: item.id,
          number: item.number,
          state: "OPEN",
          title: "",
          updatedAt: item.updatedAt,
        },
        "",
      ),
    );
  });
  await batches(transport, variables, rows, false, true);
  return rows.map((r) => r.item);
}

export async function revalidateSemanticEvidenceBatch(
  transport: GhTransport,
  repo: string,
  evidences: SemanticEvidence[],
): Promise<Map<string, Validation>> {
  const current = await versions(transport, repo, evidences);
  const result = new Map<string, Validation>();
  current.forEach((item, index) => {
    const invalid = item.commentsCoverage.reasonCodes.find(
      (code) => code !== "comments-page-limit" && code !== "issue-unavailable",
    );
    if (item.status === "failed" || invalid)
      throw error(item.reasonCodes[0] ?? invalid ?? "malformed-response");
    const old = evidences[index];
    result.set(
      old.key,
      item.state !== "OPEN"
        ? "state-changed"
        : reusable(old, repo)
          ? compare(old, item)
          : "needs-refresh",
    );
  });
  return result;
}

export async function revalidateSemanticEvidence(
  transport: GhTransport,
  repo: string,
  evidence: SemanticEvidence,
): Promise<Validation> {
  const result = await revalidateSemanticEvidenceBatch(transport, repo, [evidence]);
  return result.get(evidence.key) as Validation;
}

function previousItems(
  capture: SemanticCapture | undefined,
  repo: string,
): Map<string, SemanticEvidence> {
  const result = new Map<string, SemanticEvidence>();
  if (
    !object(capture) ||
    capture.repo !== repo ||
    capture.visibility !== "PUBLIC" ||
    !Array.isArray(capture.items) ||
    capture.items.length > 500 ||
    !object(capture.coverage) ||
    capture.coverage.captured !== capture.items.length ||
    !object(capture.captureWindow) ||
    !timestamp(capture.captureWindow.startedAt) ||
    !timestamp(capture.captureWindow.completedAt) ||
    Date.parse(capture.captureWindow.startedAt) > Date.parse(capture.captureWindow.completedAt)
  )
    return result;
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const item of capture.items) {
    if (!identity(item, repo) || ids.has(item.id) || keys.has(item.key)) return new Map();
    ids.add(item.id);
    keys.add(item.key);
    if (reusable(item, repo)) result.set(item.key, item);
  }
  return result;
}

export async function collectSemanticEvidence(
  transport: GhTransport,
  options: {
    repo: string;
    limit: number;
    now?: () => string;
    onProgress?: (event: { captured: number; pages: number }) => void;
    previousCapture?: SemanticCapture;
    onEvidenceReuse?: (key: string) => void;
  },
): Promise<SemanticCapture> {
  const { repo, limit } = options;
  const variables = repoVariables(repo);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw error("invalid-capture-options");
  const now = options.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const previous = previousItems(options.previousCapture, repo);
  const bodies = previous.size === 0;
  const initialTotal = census(await repository(transport, REPOSITORY_QUERY, variables));
  const value = coverage();
  value.total = initialTotal;
  const rows: Row[] = [];
  const ids = new Set<string>();
  const numbers = new Set<number>();
  const cursors = new Set<string>();
  let after: string | null = null;
  let scanned = 0;
  while (rows.length < limit) {
    value.pages++;
    try {
      const result = await repository(transport, issuesQuery(bodies), {
        ...variables,
        ...(after === null ? {} : { after }),
      });
      const next = page(result.issues, ISSUE_BATCH_SIZE);
      const advances = observePage(value, next, cursors);
      scanned += next.nodes.length;
      reconcileCount(value, scanned);
      for (const raw of next.nodes) {
        if (
          !metadata(raw) ||
          typeof raw.title !== "string" ||
          (bodies && typeof raw.body !== "string")
        ) {
          reason(value, "malformed-issue");
          continue;
        }
        if (ids.has(raw.id) || numbers.has(raw.number)) {
          reason(value, "duplicate-issue");
          continue;
        }
        ids.add(raw.id);
        numbers.add(raw.number);
        if (rows.length >= limit) continue;
        const r = row(blank(repo, raw, startedAt));
        consume(r, raw, INITIAL_COMMENTS, bodies, true);
        rows.push(r);
      }
      value.captured = rows.length;
      if (rows.length === limit && (next.hasNextPage || scanned > rows.length)) {
        value.hasNextPage = true;
        reason(value, "issue-limit");
      }
      after = next.cursor;
      if (!advances || value.reasonCodes.length > 0 || !next.hasNextPage) break;
    } catch (cause) {
      reason(value, failureCode(cause));
      value.hasNextPage = null;
      break;
    } finally {
      options.onProgress?.({ captured: rows.length, pages: value.pages });
    }
  }
  const beforeComments = census(await repository(transport, REPOSITORY_QUERY, variables));
  if (beforeComments !== value.total) reason(value, "total-count-drift");
  value.total = beforeComments;
  await batches(transport, variables, rows, bodies, false);
  const reused = new Set<string>();
  if (!bodies) {
    const refresh: Row[] = [];
    for (const r of rows) {
      const old = previous.get(r.item.key);
      if (old && r.item.commentsCoverage.complete && compare(old, r.item) === "current") {
        r.item.body = old.body;
        r.item.comments = r.item.comments.map((c, index) => ({
          ...c,
          body: old.comments[index].body,
        }));
        reused.add(r.item.key);
      } else if (r.item.status === "ready") {
        const invalid = r.item.commentsCoverage.reasonCodes.find(
          (code) => code !== "comments-page-limit",
        );
        if (invalid) {
          failItem(r.item, invalid);
          continue;
        }
        r.item.comments = [];
        r.item.commentsCoverage = coverage();
        const fresh = row(r.item);
        refresh.push(fresh);
      }
    }
    await batches(transport, variables, refresh, true, false);
  }
  const items = rows.map((r) => r.item);
  const checks = items.filter((item) => item.status === "ready");
  const finalVersions = await versions(transport, repo, checks);
  finalVersions.forEach((current, index) => {
    const item = checks[index];
    if (current.status === "failed") failItem(item, current.reasonCodes[0] ?? "malformed-response");
    else {
      const result = compare(item, current);
      if (result !== "current") {
        item.status = "excluded";
        if (result === "state-changed") item.state = "CLOSED";
        reason(item, result);
      }
    }
  });
  const finalTotal = census(await repository(transport, REPOSITORY_QUERY, variables));
  if (finalTotal !== value.total) reason(value, "total-count-drift");
  value.total = finalTotal;
  for (const item of items) {
    item.captureWindow.completedAt = now();
    if (item.status !== "ready") reason(value, "issues-unavailable");
    if (!item.commentsCoverage.complete) reason(value, "comments-incomplete");
    if (item.status === "ready" && item.commentsCoverage.complete && reused.has(item.key))
      options.onEvidenceReuse?.(item.key);
  }
  reconcileCount(value, items.length);
  finish(value);
  return {
    repo,
    visibility: "PUBLIC",
    captureWindow: { startedAt, completedAt: now() },
    coverage: value,
    items,
  };
}
