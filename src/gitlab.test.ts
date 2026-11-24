import { describe, expect, test } from "vitest";
import {
  buildGitLabGraph,
  GitLabReadError,
  type GitLabReader,
  gitlabNodeKey,
  parseGitLabHost,
  parseGitLabLocator,
  parseGitLabUrl,
  renderGitLab,
  resolveGitLabReference,
} from "./gitlab.js";

const HOST = "gitlab.example.com";
const options = { maxDepth: 1, maxNodes: 80, hubThreshold: 12, concurrency: 2 };
const API = "acme/platform/api";
const WEB = "acme/platform/web";

type Kind = "issue" | "merge_request";

function url(path: string, kind: Kind, iid: number, host = HOST): string {
  return `https://${host}/${path}/-/${kind === "issue" ? "work_items" : "merge_requests"}/${iid}`;
}

function item(path: string, kind: Kind, iid: number, extra: Record<string, unknown> = {}) {
  return {
    id: iid * 10,
    iid,
    title: `${path} ${kind} ${iid}`,
    state: "opened",
    web_url: url(path, kind, iid),
    updated_at: "2026-01-01T00:00:00Z",
    ...extra,
  };
}

const note = (id: number, body: string, system = true) => ({ id, body, system });

/** A fake REST API: `routes` maps a request path without its query to a JSON body. */
function reader(routes: Record<string, unknown>, requests: string[] = []): GitLabReader {
  return {
    label: "fixture",
    async get(path) {
      requests.push(path);
      const [route, query] = path.split("?");
      const value = routes[route];
      if (value === undefined) {
        if (/\/(links|closed_by|closes_issues|notes)$/.test(route)) return [];
        throw new GitLabReadError("NOT_FOUND");
      }
      if (Array.isArray(value) && query) {
        const page = Number(new URLSearchParams(query).get("page"));
        return value.slice((page - 1) * 100, page * 100);
      }
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

const base = (path: string, kind: Kind, iid: number) =>
  `projects/${encodeURIComponent(path)}/${kind === "issue" ? "issues" : "merge_requests"}/${iid}`;
const key = (path: string, kind: Kind, iid: number) => gitlabNodeKey(HOST, { path, kind, iid });

describe("GitLab host", () => {
  test("normalizes bare hosts and origins the same way", () => {
    expect(parseGitLabHost("GitLab.com:443")).toBe("gitlab.com");
    expect(parseGitLabHost("https://gitlab.com:443")).toBe("gitlab.com");
    expect(parseGitLabHost("gitlab.example.com:8443")).toBe("gitlab.example.com:8443");
    expect(parseGitLabHost("https://gitlab.example.com:8443/")).toBe("gitlab.example.com:8443");
  });

  test("rejects invalid ports and non-host input", () => {
    for (const bad of [
      "gitlab.example.com:99999",
      "gitlab.example.com:0",
      "gitlab.example.com:",
      "gitlab.example.com:80a",
      "gitlab.example.com/path",
      "gitlab.example.com//x",
      "user@gitlab.example.com",
      "--hostname=evil",
    ])
      expect(() => parseGitLabHost(bad), bad).toThrow(/Invalid GitLab host/);
  });
});

describe("GitLab locators", () => {
  test("parse issue, work item, incident, and MR URLs in nested groups", () => {
    expect(parseGitLabUrl(`https://${HOST}/${API}/-/issues/7`)).toEqual({
      host: HOST,
      path: API,
      kind: "issue",
      iid: 7,
    });
    expect(parseGitLabUrl(`https://${HOST}/${API}/-/work_items/7#note_1`)?.kind).toBe("issue");
    expect(parseGitLabUrl(`https://${HOST}/${API}/-/issues/incident/7`)?.iid).toBe(7);
    expect(parseGitLabUrl(`https://${HOST}:8443/${API}/-/merge_requests/7/diffs`)).toEqual({
      host: `${HOST}:8443`,
      path: API,
      kind: "merge_request",
      iid: 7,
    });
    expect(parseGitLabUrl(`https://${HOST}/groups/acme/-/work_items/3`)).toEqual({
      host: HOST,
      path: "acme",
      kind: "issue",
      iid: 3,
      group: true,
    });
    for (const rejected of [
      `http://${HOST}/${API}/-/issues/7`,
      `https://user:pass@${HOST}/${API}/-/issues/7`,
      `https://${HOST}/acme/-/issues/7`,
      `https://${HOST}/${API}/-/epics/7`,
    ])
      expect(parseGitLabUrl(rejected)).toBeUndefined();
  });

  test("parse full references and reject group URLs as seeds", () => {
    expect(parseGitLabLocator(`${API}#12`)).toEqual({ path: API, kind: "issue", iid: 12 });
    expect(parseGitLabLocator(`${API}!12`)).toEqual({ path: API, kind: "merge_request", iid: 12 });
    for (const rejected of [
      "#12",
      "api#12",
      `${API}#0`,
      `https://${HOST}/groups/acme/-/work_items/3`,
    ])
      expect(() => parseGitLabLocator(rejected)).toThrow(/Expected a GitLab/);
  });

  test("resolve system note references relative to the noted item's project", () => {
    expect(resolveGitLabReference("#4", API)).toEqual({ path: API, kind: "issue", iid: 4 });
    expect(resolveGitLabReference("web!5", API)).toEqual({
      path: WEB,
      kind: "merge_request",
      iid: 5,
    });
    expect(resolveGitLabReference("other/group/repo#6", API)?.path).toBe("other/group/repo");
  });

  test("keys keep issues and MRs with the same number apart and ignore path case", () => {
    expect(key(API, "issue", 1)).not.toBe(key(API, "merge_request", 1));
    expect(gitlabNodeKey(HOST, { path: "Acme/Platform/API", kind: "issue", iid: 1 })).toBe(
      key(API, "issue", 1),
    );
  });
});

describe("buildGitLabGraph", () => {
  test("reads links, closing MRs, and mentions, keeping #1 and !1 separate", async () => {
    const routes = {
      [base(API, "issue", 1)]: item(API, "issue", 1),
      [`${base(API, "issue", 1)}/links`]: [
        { ...item(API, "issue", 2), link_type: "blocks", issue_link_id: 31 },
        { ...item(WEB, "issue", 3), link_type: "relates_to", issue_link_id: 32 },
        {
          ...item("acme", "issue", 9),
          web_url: `https://${HOST}/groups/acme/-/work_items/9`,
          link_type: "is_blocked_by",
          issue_link_id: 33,
        },
      ],
      [`${base(API, "issue", 1)}/closed_by`]: [item(API, "merge_request", 1)],
      [`${base(API, "issue", 1)}/notes`]: [
        note(41, "mentioned in merge request web!8"),
        note(42, "mentioned in commit 0123abc"),
        note(44, "mentioned in epic acme/platform#6"),
        note(43, "mentioned in merge request !99", false),
      ],
      [base(API, "merge_request", 1)]: item(API, "merge_request", 1, { state: "merged" }),
      [`${base(API, "merge_request", 1)}/closes_issues`]: [
        item(API, "issue", 1),
        { id: "EXT-1", title: "External tracker issue" },
      ],
      [base(API, "issue", 2)]: item(API, "issue", 2),
      [`${base(API, "issue", 2)}/links`]: [
        { ...item(API, "issue", 1), link_type: "is_blocked_by", issue_link_id: 31 },
      ],
      [base(WEB, "issue", 3)]: item(WEB, "issue", 3),
      [`${base(WEB, "issue", 3)}/links`]: [
        { ...item(API, "issue", 1), link_type: "relates_to", issue_link_id: 32 },
        { ...item(WEB, "issue", 4), link_type: "relates_to", issue_link_id: 34 },
      ],
      [base(WEB, "merge_request", 8)]: item(WEB, "merge_request", 8, { draft: true }),
    };
    const requests: string[] = [];
    const report = await buildGitLabGraph(reader(routes, requests), url(API, "issue", 1), options);
    expect(report.host).toBe(HOST);
    expect(report.seeds).toEqual([key(API, "issue", 1)]);
    expect(report.nodes.map((node) => node.identifier).sort()).toEqual([
      `${API}!1`,
      `${API}#1`,
      `${API}#2`,
      `${WEB}!8`,
      `${WEB}#3`,
    ]);
    const seed = report.nodes.find((node) => node.key === key(API, "issue", 1));
    expect(
      seed?.edges.map((edge) => [edge.nativeRelation, edge.direction, edge.to]).sort(),
    ).toEqual(
      [
        ["blocks", "outgoing", key(API, "issue", 2)],
        ["closes", "incoming", key(API, "merge_request", 1)],
        [
          "blocks",
          "incoming",
          gitlabNodeKey(HOST, { path: "acme", kind: "issue", iid: 9, group: true }),
        ],
        ["mentions", "incoming", key(WEB, "merge_request", 8)],
        ["relates_to", "undirected", key(WEB, "issue", 3)],
      ].sort(),
    );
    const mr = report.nodes.find((node) => node.key === key(API, "merge_request", 1));
    expect(mr?.kind).toBe("pull-request");
    expect(mr?.edges[0].evidence).toEqual(
      seed?.edges.find((edge) => edge.nativeRelation === "closes")?.evidence,
    );
    expect(report.nodes.find((node) => node.identifier === `${WEB}!8`)?.draft).toBe(true);
    // Other projects are read one hop: web#4 is known but never requested.
    expect(requests.some((path) => path.startsWith(base(WEB, "issue", 4)))).toBe(false);
    expect(report.coverage.depthBoundaries).toContain(key(WEB, "issue", 3));
    // Group work items are listed but never read.
    expect(requests.some((path) => path.includes("acme/-/") || path.startsWith("groups/"))).toBe(
      false,
    );
    expect(report.coverage.groupWorkItems).toHaveLength(1);
    expect(report.coverageComplete).toBe(true);
    expect(requests.every((path) => path.startsWith("projects/"))).toBe(true);
    const markdown = renderGitLab(report);
    expect(markdown).toContain(`← closes: ${API}!1`);
    expect(markdown).toContain("Group work items: 1 linked, not read.");
  });

  test("takes the host from the seed's web_url when the seed is a reference", async () => {
    const report = await buildGitLabGraph(
      reader({ [base(API, "merge_request", 5)]: item(API, "merge_request", 5) }),
      `${API}!5`,
      options,
    );
    expect(report.host).toBe(HOST);
    expect(report.seeds).toEqual([key(API, "merge_request", 5)]);
  });

  test("rejects a seed on another host and a payload for another item", async () => {
    const routes = { [base(API, "issue", 1)]: item(API, "issue", 1) };
    await expect(
      buildGitLabGraph(reader(routes), `${API}#1`, { ...options, host: "gitlab.com" }),
    ).rejects.toMatchObject({ code: "HOST_MISMATCH" });
    await expect(
      buildGitLabGraph(
        reader({ [base(API, "issue", 1)]: item(API, "issue", 2) }),
        `${API}#1`,
        options,
      ),
    ).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
    await expect(
      buildGitLabGraph(reader(routes), url(API, "issue", 1), { ...options, host: "gitlab.com" }),
    ).rejects.toThrow(/disagree/);
  });

  test("marks failed and page-capped listings partial and unreadable targets failed", async () => {
    const notes = Array.from({ length: 1000 }, (_, index) => note(index + 1, "changed the title"));
    const report = await buildGitLabGraph(
      reader({
        [base(API, "issue", 1)]: item(API, "issue", 1),
        [`${base(API, "issue", 1)}/links`]: new GitLabReadError("UNAUTHORIZED"),
        [`${base(API, "issue", 1)}/notes`]: [...notes, note(2000, "mentioned in issue #404")],
      }),
      `${API}#1`,
      options,
    );
    const seed = report.nodes[0];
    expect(seed.coverage).toEqual([
      { source: "issue links", pages: 1, complete: false, reason: "read-failed" },
      { source: "system notes", pages: 10, complete: false, reason: "page-limit" },
    ]);
    expect(report.coverage.partial).toEqual([seed.key]);
    expect(report.coverageComplete).toBe(false);
  });

  test("a listing that ends exactly at the page cap is complete", async () => {
    const notes = Array.from({ length: 1000 }, (_, index) => note(index + 1, "changed the title"));
    const requests: string[] = [];
    const report = await buildGitLabGraph(
      reader(
        {
          [base(API, "issue", 1)]: item(API, "issue", 1),
          [`${base(API, "issue", 1)}/notes`]: notes,
        },
        requests,
      ),
      `${API}#1`,
      options,
    );
    expect(report.nodes[0].coverage).toEqual([]);
    expect(report.coverageComplete).toBe(true);
    expect(requests.some((request) => request.includes("notes?per_page=100&page=11"))).toBe(true);
  });

  test("sends no reads after the first rate limit and marks the unread items failed", async () => {
    const requests: string[] = [];
    const links = [2, 3, 4].map((iid) => ({ ...item(API, "issue", iid), link_type: "relates_to" }));
    const report = await buildGitLabGraph(
      reader(
        {
          [base(API, "issue", 1)]: item(API, "issue", 1),
          [`${base(API, "issue", 1)}/links`]: links,
          [base(API, "issue", 2)]: new GitLabReadError("RATE_LIMITED"),
          [base(API, "issue", 3)]: item(API, "issue", 3),
          [base(API, "issue", 4)]: item(API, "issue", 4),
        },
        requests,
      ),
      `${API}#1`,
      { ...options, concurrency: 1 },
    );
    expect(requests.filter((request) => request.startsWith(base(API, "issue", 3)))).toEqual([]);
    expect(requests.filter((request) => request.startsWith(base(API, "issue", 4)))).toEqual([]);
    expect(report.nodes.filter((node) => !node.fetched).map((node) => node.error)).toEqual([
      "RATE_LIMITED",
      "RATE_LIMITED",
      "RATE_LIMITED",
    ]);
    expect(report.coverageComplete).toBe(false);
  });

  test("keeps an unreadable linked item as an unavailable node", async () => {
    const report = await buildGitLabGraph(
      reader({
        [base(API, "issue", 1)]: item(API, "issue", 1),
        [`${base(API, "issue", 1)}/notes`]: [note(1, "mentioned in issue #2")],
      }),
      `${API}#1`,
      options,
    );
    const missing = report.nodes.find((node) => node.key === key(API, "issue", 2));
    expect(missing).toMatchObject({ fetched: false, error: "NOT_FOUND", title: "Unavailable" });
    expect(report.coverage.failed).toEqual([key(API, "issue", 2)]);
    expect(report.coverageComplete).toBe(false);
  });
});
