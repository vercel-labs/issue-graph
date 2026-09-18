import {
  buildStatusReport,
  normalizeStatusScope,
  STATUS_METRICS,
  type StatusCounts,
  type StatusPullRequest,
  type StatusReport,
} from "./status.js";
import type {
  StatusChangeField,
  StatusChangeValue,
  StatusDeparture,
  StatusHistory,
  StatusMetricDeltas,
  StatusSnapshot,
} from "./status-history-types.js";
import type { GhTransport } from "./transport.js";

const fields: StatusChangeField[] = [
  "assignees",
  "headSha",
  "isDraft",
  "mergeability",
  "requestedReviewers",
  "reviewState",
];
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const key = (value: string) => value.toLowerCase();
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function timestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) return null;
  const [, year, month, day, hour, minute, second, zone] = parts;
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== `${year}-${month}-${day}` ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))
  )
    return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

function validate(previous: StatusSnapshot, current: StatusReport): void {
  const scopeKey = (scope: StatusReport["scope"]) => {
    const normalized = normalizeStatusScope(scope.repos, scope.authors);
    return JSON.stringify({
      repos: normalized.repos.map(key),
      authors: normalized.authors.map(key),
    });
  };
  if (scopeKey(previous.scope) !== scopeKey(current.scope))
    throw new Error(
      "Status history scope mismatch: repositories and authors must match the baseline.",
    );
  const beforeStart = timestamp(previous.startedAt);
  const beforeEnd = timestamp(previous.generatedAt);
  const afterStart = timestamp(current.startedAt);
  const afterEnd = timestamp(current.generatedAt);
  if (beforeStart === null || beforeEnd === null || afterStart === null || afterEnd === null)
    throw new Error("Status history requires valid capture timestamps.");
  if (beforeStart > beforeEnd || afterStart > afterEnd)
    throw new Error("Status history capture timestamps are reversed.");
  if (beforeEnd > afterStart)
    throw new Error(
      "Status history baseline is newer than current.startedAt; query windows must not overlap.",
    );
}

function report(source: StatusSnapshot | StatusReport): StatusReport {
  return buildStatusReport(source.pullRequests, source.coverage, {
    ...source.scope,
    startedAt: source.startedAt,
    generatedAt: source.generatedAt,
  });
}

function value(pr: StatusPullRequest, field: StatusChangeField): StatusChangeValue | null {
  const observed = pr[field];
  if (observed === null || observed === undefined) return null;
  if (field === "reviewState" && observed === "unknown") return null;
  if (field === "mergeability" && observed === "UNKNOWN") return null;
  if (field === "headSha" && observed === "") return null;
  return Array.isArray(observed) ? [...new Set(observed.map(key))].sort(compare) : observed;
}

function metricDeltas(before: StatusCounts, after: StatusCounts): StatusMetricDeltas {
  const known = (counts: StatusCounts, metric: (typeof STATUS_METRICS)[number]) => {
    if (
      ["reviewRequired", "changesRequested", "approved", "notRequired"].includes(metric) &&
      counts.reviewUnknown.prIds.length > 0
    )
      return null;
    return counts[metric].count;
  };
  return Object.fromEntries(
    STATUS_METRICS.map((metric) => {
      const a = known(before, metric);
      const b = known(after, metric);
      return [metric, { before: a, after: b, delta: a === null || b === null ? null : b - a }];
    }),
  ) as StatusMetricDeltas;
}

function unverified(pr: StatusPullRequest, checkedAt: string, reason: string): StatusDeparture {
  return {
    id: pr.id,
    repo: pr.repo,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author,
    state: "UNVERIFIED",
    checkedAt,
    closedAt: null,
    mergedAt: null,
    reason,
  };
}

function terminalReason(
  pr: StatusPullRequest,
  evidence: Record<string, unknown>,
  checkedAt: string,
): string | null {
  if (
    typeof evidence.repo !== "string" ||
    key(evidence.repo) !== key(pr.repo) ||
    !Number.isSafeInteger(evidence.number) ||
    evidence.number !== pr.number
  )
    return "Terminal lookup returned an unexpected PR identity.";
  if (
    typeof evidence.url !== "string" ||
    /[\s\\]/.test(evidence.url) ||
    [...evidence.url].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    return "Terminal lookup returned an invalid HTTPS URL.";
  try {
    const url = new URL(evidence.url);
    if (
      url.protocol !== "https:" ||
      !evidence.url.startsWith("https://") ||
      !url.hostname ||
      url.origin !== new URL(pr.url).origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      key(url.pathname) !== `/${key(pr.repo)}/pull/${pr.number}`
    )
      return "Terminal lookup returned an invalid HTTPS URL or URL identity.";
  } catch {
    return "Terminal lookup returned an invalid HTTPS URL.";
  }
  if (evidence.state === "OPEN")
    return "PR is still OPEN; its absence from the current scope is uncertain.";
  if (evidence.state !== "MERGED" && evidence.state !== "CLOSED")
    return "Terminal lookup returned an invalid or unknown PR state.";
  const checked = timestamp(checkedAt);
  const closed = timestamp(evidence.closedAt);
  const merged = timestamp(evidence.mergedAt);
  if (
    checked === null ||
    closed === null ||
    closed > checked ||
    (evidence.state === "MERGED" && (merged === null || merged > checked || merged > closed)) ||
    (evidence.state === "CLOSED" && evidence.mergedAt !== null)
  )
    return "Terminal lookup returned invalid or inconsistent terminal timestamps.";
  return null;
}

export function compareStatusSnapshots(
  previous: StatusSnapshot,
  current: StatusReport,
  departures: StatusDeparture[],
  comparedAt: string,
): StatusHistory {
  validate(previous, current);
  const comparisonTime = timestamp(comparedAt);
  if (comparisonTime === null || comparisonTime < Date.parse(current.generatedAt))
    throw new Error(
      "Status history requires a valid comparedAt timestamp at or after the current capture.",
    );
  const before = report(previous);
  const after = report(current);
  const prior = new Map(before.pullRequests.map((pr) => [pr.id, pr]));
  const present = new Set(after.pullRequests.map((pr) => pr.id));
  const priorCoverage = new Map(before.coverage.map((item) => [key(item.repo), item.complete]));
  const history: StatusHistory = {
    schemaVersion: 1,
    previousGeneratedAt: previous.generatedAt,
    currentGeneratedAt: current.generatedAt,
    comparedAt,
    previousProvenance: { ...previous.provenance, sources: [...previous.provenance.sources] },
    coverageComplete: before.coverageComplete && after.coverageComplete && current.coverageComplete,
    totals: metricDeltas(before.totals, after.totals),
    rows: [],
    changes: [],
    added: [],
    departures: [],
    uncertain: [],
  };
  const beforeRows = new Map(
    before.rows.map((row) => [`${key(row.repo)}:${key(row.author)}`, row]),
  );
  history.rows = after.rows.map((row) => {
    const priorRow = beforeRows.get(`${key(row.repo)}:${key(row.author)}`);
    if (!priorRow) throw new Error("Status history row scope mismatch.");
    return {
      repo: row.repo,
      author: row.author,
      counts: metricDeltas(priorRow.counts, row.counts),
    };
  });
  for (const pr of after.pullRequests) {
    const old = prior.get(pr.id);
    if (!old) {
      if (priorCoverage.get(key(pr.repo))) history.added.push(pr);
      else
        history.uncertain.push({
          id: pr.id,
          reason:
            "Membership is uncertain: baseline repository inventory was incomplete; cannot claim newly in scope.",
        });
      for (const field of fields) {
        if (value(pr, field) === null)
          history.uncertain.push({
            id: pr.id,
            reason: `${field} observation is unknown for a newly observed PR.`,
          });
      }
      continue;
    }
    for (const field of fields) {
      const a = value(old, field);
      const b = value(pr, field);
      if (a === null || b === null) {
        history.uncertain.push({
          id: pr.id,
          reason: `${field} comparison is uncertain: ${a === null && b === null ? "both observations are" : a === null ? "baseline observation is" : "current observation is"} unknown.`,
        });
      } else if (JSON.stringify(a) !== JSON.stringify(b)) {
        history.changes.push({
          id: pr.id,
          repo: pr.repo,
          number: pr.number,
          title: pr.title,
          url: pr.url,
          author: pr.author,
          field,
          before: a,
          after: b,
        });
      }
    }
  }
  for (const pr of before.pullRequests) {
    if (present.has(pr.id)) continue;
    const candidates = departures.filter((item) => key(item.id) === pr.id);
    const candidate = candidates.length === 1 ? candidates[0] : null;
    let departure: StatusDeparture;
    if (!candidate) {
      departure = unverified(
        pr,
        comparedAt,
        candidates.length
          ? "Conflicting terminal observations; membership is uncertain."
          : "Missing from current inventory; terminal state has not been verified.",
      );
    } else if (candidate.state === "UNVERIFIED") {
      departure = unverified(
        pr,
        candidate.checkedAt,
        candidate.reason || "Terminal state could not be verified; membership is uncertain.",
      );
    } else {
      const reason =
        terminalReason(pr, { ...candidate }, candidate.checkedAt) ??
        (Date.parse(candidate.checkedAt) < Date.parse(current.startedAt) ||
        Date.parse(candidate.checkedAt) > comparisonTime
          ? "Terminal observation is outside the current capture and comparison window; membership is uncertain."
          : null) ??
        (Date.parse(
          (candidate.state === "MERGED" ? candidate.mergedAt : candidate.closedAt) ?? "",
        ) < Date.parse(previous.startedAt)
          ? "Terminal timestamp predates the baseline's open observation; transition is uncertain."
          : null);
      departure = reason
        ? unverified(pr, candidate.checkedAt, reason)
        : {
            ...candidate,
            id: pr.id,
            repo: pr.repo,
            number: pr.number,
            title: pr.title,
            author: pr.author,
          };
    }
    history.departures.push(departure);
    if (departure.state === "UNVERIFIED")
      history.uncertain.push({ id: pr.id, reason: `Membership is uncertain: ${departure.reason}` });
  }
  history.changes.sort((a, b) => compare(a.id, b.id) || compare(a.field, b.field));
  history.added.sort((a, b) => compare(a.id, b.id));
  history.departures.sort((a, b) => compare(a.id, b.id));
  history.uncertain.sort((a, b) => compare(a.id, b.id) || compare(a.reason, b.reason));
  history.coverageComplete &&=
    history.uncertain.length === 0 &&
    STATUS_METRICS.every((metric) => history.totals[metric].delta !== null) &&
    ["reviewUnknown", "mergeUnknown"].every((metric) => {
      const delta = history.totals[metric as (typeof STATUS_METRICS)[number]];
      return delta.before === 0 && delta.after === 0;
    });
  return history;
}

const TERMINAL_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){state url number mergedAt closedAt repository{nameWithOwner}}
  }
}`;

export async function inspectStatusHistory(
  transport: GhTransport,
  previous: StatusSnapshot,
  current: StatusReport,
  options: { concurrency?: number; now?: () => string } = {},
): Promise<StatusHistory> {
  validate(previous, current);
  const concurrency = options.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32)
    throw new Error("concurrency must be an integer from 1 to 32");
  const now = options.now ?? (() => new Date().toISOString());
  const present = new Set(report(current).pullRequests.map((pr) => pr.id));
  const missing = report(previous).pullRequests.filter((pr) => !present.has(pr.id));
  const departures: StatusDeparture[] = [];
  let index = 0;
  async function inspect(pr: StatusPullRequest): Promise<StatusDeparture> {
    const [owner, repo] = pr.repo.split("/");
    let raw: unknown;
    try {
      raw = await transport.graphql(TERMINAL_QUERY, { owner, repo, number: pr.number });
    } catch (error) {
      return unverified(
        pr,
        now(),
        `Terminal lookup failed: ${error instanceof Error ? error.message : "request failed"}`,
      );
    }
    const checkedAt = now();
    const envelope = object(raw);
    if (
      !envelope ||
      (envelope.errors !== undefined &&
        envelope.errors !== null &&
        (!Array.isArray(envelope.errors) || envelope.errors.length > 0))
    )
      return unverified(
        pr,
        checkedAt,
        "Terminal lookup returned GraphQL errors or a malformed response.",
      );
    const node = object(object(object(envelope.data)?.repository)?.pullRequest);
    if (!node)
      return unverified(
        pr,
        checkedAt,
        "Terminal lookup returned no accessible PR; membership is uncertain.",
      );
    const evidence = { ...node, repo: object(node.repository)?.nameWithOwner };
    const reason = terminalReason(pr, evidence, checkedAt);
    if (reason) return unverified(pr, checkedAt, reason);
    return {
      ...unverified(pr, checkedAt, ""),
      state: node.state as "MERGED" | "CLOSED",
      url: node.url as string,
      closedAt: node.closedAt as string,
      mergedAt: node.mergedAt as string | null,
      reason: null,
    };
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, missing.length) }, async () => {
      while (index < missing.length) {
        const pr = missing[index++];
        departures.push(await inspect(pr));
      }
    }),
  );
  return compareStatusSnapshots(previous, current, departures, now());
}
