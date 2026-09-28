import { describe, expect, test, vi } from "vitest";
import { parseModel } from "./model-validation.js";
import { collectYouTrack } from "./youtrack.js";

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const activity = (
  $type: string,
  timestamp: number,
  added: unknown[] = [],
  removed: unknown[] = [],
) => ({ $type, timestamp, added, removed });
const activityPage = (activities: unknown[], hasAfter = false, afterCursor?: string) =>
  response({ activities, hasAfter, afterCursor });

const project = { id: "project-1", name: "Engineering", shortName: "ENG" };

function issue(id: string, idReadable: string, resolved: number | null, projectShortName = "ENG") {
  return {
    id,
    idReadable,
    summary: `Issue ${idReadable}`,
    resolved,
    project: { shortName: projectShortName },
    customFields: [{ name: "State", value: { name: resolved === null ? "Open" : "Fixed" } }],
  };
}

function fetcherFor(
  handler: (url: URL, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(new URL(String(input)), init),
  ) as typeof fetch;
}

describe("collectYouTrack", () => {
  test("reads connection settings from the documented environment variables", async () => {
    const previousUrl = process.env.YOUTRACK_URL;
    const previousToken = process.env.YOUTRACK_TOKEN;
    process.env.YOUTRACK_URL = "https://tracker.example";
    process.env.YOUTRACK_TOKEN = "secret";
    const fetcher = fetcherFor((url, init) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer secret");
      if (url.pathname.endsWith("/api/admin/projects")) return response([project]);
      if (url.pathname.endsWith("/api/admin/projects/project-1/issues")) return response([]);
      throw new Error(`Unexpected request: ${url.pathname}`);
    });

    try {
      const model = await collectYouTrack("ENG", { fetcher });
      expect(model.repo).toBe("youtrack:tracker.example/ENG");
    } finally {
      if (previousUrl === undefined) delete process.env.YOUTRACK_URL;
      else process.env.YOUTRACK_URL = previousUrl;
      if (previousToken === undefined) delete process.env.YOUTRACK_TOKEN;
      else process.env.YOUTRACK_TOKEN = previousToken;
    }
  });

  test("captures one resolved issue and its direct links without listing the project", async () => {
    const root = {
      ...issue("internal-14006", "ENG-14006", 1710000000000),
      links: [
        {
          id: "relates",
          direction: "BOTH",
          linkType: {
            id: "relates",
            name: "relates to",
            sourceToTarget: "relates to",
            targetToSource: "relates to",
            directed: false,
          },
          issues: [issue("internal-2032", "ENG-2032", null)],
        },
      ],
    };
    const fetcher = fetcherFor((url) => {
      if (url.pathname.endsWith("/api/admin/projects")) return response([project]);
      if (url.pathname.endsWith("/api/issues/ENG-14006")) return response(root);
      if (url.pathname.endsWith("/api/issues/internal-14006/activitiesPage"))
        return activityPage([]);
      if (url.pathname.includes("/api/admin/projects/project-1/issues"))
        throw new Error("issue capture must not list the entire project");
      throw new Error(`Unexpected request: ${url.pathname}`);
    });

    const model = await collectYouTrack("ENG", {
      baseUrl: "https://tracker.example",
      token: "secret",
      issueId: "ENG-14006",
      fetcher,
    });

    const byId = new Map(Object.values(model.nodes).map((node) => [node.identifier, node]));
    const target = byId.get("ENG-14006");
    const related = byId.get("ENG-2032");
    expect(model.seeds).toEqual([target?.key]);
    expect(target).toMatchObject({
      state: "CLOSED",
      seed: true,
      url: expect.stringContaining("/ENG-14006"),
    });
    expect(related).toMatchObject({ seed: false, read: { fetched: false } });
    expect(target?.out).toEqual([
      expect.objectContaining({ to: related?.key, via: "relates to", undirected: true }),
    ]);
    expect(model.repo).toBe("youtrack:tracker.example/ENG");
    expect(model.id).toBe("youtrack:tracker.example/ENG/ENG-14006");
    expect(model.label).toContain("ENG-14006");
    expect(model.url).toContain("/ENG-14006");
    expect(model.coverage?.complete).toBe(true);
    expect(parseModel(model)).toEqual(model);
  });

  test("reads PR state and commits from paginated activity history across subtasks", async () => {
    const subtask = {
      id: "subtask",
      name: "Subtask",
      sourceToTarget: "parent for",
      targetToSource: "subtask of",
      directed: true,
    };
    const relates = {
      id: "relates",
      name: "Relates",
      sourceToTarget: "relates to",
      targetToSource: "relates to",
      directed: false,
    };
    const root = {
      ...issue("root", "ENG-1", null),
      description: "Implementation: https://github.com/acme/app/pull/44",
      links: [
        {
          id: "sub",
          direction: "OUTWARD",
          linkType: subtask,
          issues: [issue("child", "ENG-2", null)],
        },
        {
          id: "rel",
          direction: "BOTH",
          linkType: relates,
          issues: [issue("context", "OPS-9", null, "OPS")],
        },
      ],
    };
    const child = {
      ...issue("child", "ENG-2", null),
      links: [
        {
          id: "sub",
          direction: "OUTWARD",
          linkType: subtask,
          issues: [issue("grandchild", "OPS-3", null, "OPS")],
        },
      ],
    };
    const grandchild = {
      ...issue("grandchild", "OPS-3", null, "OPS"),
      links: [
        {
          id: "sub",
          direction: "OUTWARD",
          linkType: subtask,
          issues: [issue("root", "ENG-1", null)],
        },
      ],
    };
    const pullRequestChange = (state: string) => ({
      pullRequest: {
        idExternal: "44",
        title: "Add collaborative editing",
        url: "https://github.com/acme/app/pull/44",
      },
      state: { id: state },
    });
    const rootPageCursors: Array<string | null> = [];
    const fetcher = fetcherFor((url) => {
      if (url.pathname.endsWith("/api/admin/projects")) return response([project]);
      if (url.pathname.endsWith("/api/issues/ENG-1")) return response(root);
      if (url.pathname.endsWith("/api/issues/child")) return response(child);
      if (url.pathname.endsWith("/api/issues/grandchild")) return response(grandchild);
      if (url.pathname.endsWith("/api/issues/root/activitiesPage")) {
        expect(url.searchParams.get("categories")).toBe(
          "VcsChangeCategory,PullRequestChangeCategory",
        );
        expect(url.searchParams.get("reverse")).toBe("false");
        rootPageCursors.push(url.searchParams.get("cursor"));
        if (!url.searchParams.has("cursor"))
          return activityPage(
            [
              activity("PullRequestChangeActivityItem", 1000, [pullRequestChange("OPEN")]),
              activity("VcsChangeActivityItem", 1100, [
                {
                  urls: [
                    "https://github.com/acme/app/commit/0123456789abcdef0123456789abcdef01234567",
                    "https://build.example/log/12",
                  ],
                },
              ]),
            ],
            true,
            "root-after-1",
          );
        expect(url.searchParams.get("cursor")).toBe("root-after-1");
        return activityPage([
          activity(
            "PullRequestChangeActivityItem",
            3000,
            [pullRequestChange("MERGED")],
            [pullRequestChange("OPEN")],
          ),
          activity("VcsChangeActivityItem", 3100, [
            {
              urls: ["https://github.com/acme/app/commit/abcdef0123456789abcdef0123456789abcdef01"],
            },
          ]),
        ]);
      }
      if (url.pathname.endsWith("/api/issues/child/activitiesPage"))
        return activityPage([
          activity("PullRequestChangeActivityItem", 2000, [pullRequestChange("OPEN")]),
        ]);
      if (url.pathname.endsWith("/api/issues/grandchild/activitiesPage")) return activityPage([]);
      throw new Error(`Unexpected request: ${url.pathname}`);
    });

    const model = await collectYouTrack("ENG", {
      baseUrl: "https://tracker.example",
      token: "secret",
      issueId: "ENG-1",
      maxDepth: 2,
      fetcher,
    });
    const byId = new Map(Object.values(model.nodes).map((node) => [node.identifier, node]));
    const rootNode = byId.get("ENG-1");
    const childNode = byId.get("ENG-2");
    const grandchildNode = byId.get("OPS-3");
    const contextNode = byId.get("OPS-9");
    const pullRequest = Object.values(model.nodes).find((node) => node.kind === "PullRequest");

    expect(rootNode).toMatchObject({ seed: true, depth: 0 });
    expect(childNode).toMatchObject({ seed: false, depth: 1 });
    expect(childNode?.read).toBeUndefined();
    expect(grandchildNode).toMatchObject({ repo: "youtrack:tracker.example/OPS", depth: 2 });
    expect(grandchildNode?.read).toBeUndefined();
    expect(contextNode).toMatchObject({ read: { fetched: false } });
    expect(pullRequest).toMatchObject({
      repo: "acme/app",
      kind: "PullRequest",
      identifier: "acme/app#44",
      state: "MERGED",
    });
    expect(rootNode?.out).toContainEqual(expect.objectContaining({ to: pullRequest?.key }));
    expect(childNode?.out).toContainEqual(expect.objectContaining({ to: pullRequest?.key }));
    expect(rootNode?.external).toEqual([
      "https://github.com/acme/app/commit/0123456789abcdef0123456789abcdef01234567",
      "https://github.com/acme/app/commit/abcdef0123456789abcdef0123456789abcdef01",
    ]);
    expect(rootPageCursors).toEqual([null, "root-after-1"]);
    expect(Object.values(model.nodes).filter((node) => node.kind === "PullRequest")).toHaveLength(
      1,
    );
    expect(model.stats.openPRs).toBe(0);
    expect(model.repo).toBe("youtrack:tracker.example/ENG");
    expect(model.id).toBe("youtrack:tracker.example/ENG/ENG-1");
    expect(model.coverage?.complete).toBe(true);
    expect(parseModel(model)).toEqual(model);
  });

  test("recursively fetches epic-for children through the requested depth", async () => {
    const epic = {
      id: "epic",
      name: "Epic",
      sourceToTarget: "epic for",
      targetToSource: "epic of",
      directed: true,
    };
    const root = {
      ...issue("root", "ENG-1", null),
      links: [
        {
          id: "epic-root",
          direction: "OUTWARD",
          linkType: epic,
          issues: [issue("child", "ENG-2", null)],
        },
      ],
    };
    const child = {
      ...issue("child", "ENG-2", null),
      links: [
        {
          id: "epic-child",
          direction: "OUTWARD",
          linkType: epic,
          issues: [issue("grandchild", "ENG-3", null)],
        },
      ],
    };
    const grandchild = { ...issue("grandchild", "ENG-3", null), links: [] };
    const issueReads: string[] = [];
    const fetcher = fetcherFor((url) => {
      if (url.pathname.endsWith("/api/admin/projects")) return response([project]);
      if (url.pathname.endsWith("/api/issues/ENG-1")) {
        issueReads.push(url.pathname);
        return response(root);
      }
      if (url.pathname.endsWith("/api/issues/child")) {
        issueReads.push(url.pathname);
        return response(child);
      }
      if (url.pathname.endsWith("/api/issues/grandchild")) {
        issueReads.push(url.pathname);
        return response(grandchild);
      }
      if (url.pathname.includes("/api/issues/") && url.pathname.endsWith("/activitiesPage"))
        return activityPage([]);
      issueReads.push(url.pathname);
      throw new Error(`Unexpected request: ${url.pathname}`);
    });

    const model = await collectYouTrack("ENG", {
      baseUrl: "https://tracker.example",
      token: "secret",
      issueId: "ENG-1",
      maxDepth: 2,
      fetcher,
    });
    const byId = new Map(Object.values(model.nodes).map((node) => [node.identifier, node]));

    expect(byId.get("ENG-1")).toMatchObject({ seed: true, depth: 0 });
    expect(byId.get("ENG-2")).toMatchObject({ seed: false, depth: 1 });
    expect(byId.get("ENG-3")).toMatchObject({ seed: false, depth: 2 });
    expect(byId.get("ENG-3")?.read).toBeUndefined();
    expect(issueReads).toEqual([
      "/api/issues/ENG-1",
      "/api/issues/child",
      "/api/issues/grandchild",
    ]);
  });

  test.each([
    "missing continuation cursor",
    "repeated continuation cursor",
  ])("marks activity history partial for a %s and skips malformed GitHub URLs", async (cursorCase) => {
    const malformedActivity = [
      activity("PullRequestChangeActivityItem", 1000, [
        {
          pullRequest: { url: "https://github.example/acme/app/pull/44" },
          state: { id: "OPEN" },
        },
      ]),
      activity("VcsChangeActivityItem", 1100, [
        { urls: ["https://github.com/acme/app/commit/not-a-sha"] },
      ]),
    ];
    const fetcher = fetcherFor((url) => {
      if (url.pathname.endsWith("/api/admin/projects")) return response([project]);
      if (url.pathname.endsWith("/api/issues/ENG-1"))
        return response({ ...issue("root", "ENG-1", null), links: [] });
      if (url.pathname.endsWith("/api/issues/root/activitiesPage")) {
        if (!url.searchParams.has("cursor"))
          return activityPage(
            malformedActivity,
            true,
            cursorCase === "repeated continuation cursor" ? "repeat" : undefined,
          );
        return activityPage(
          malformedActivity,
          true,
          cursorCase === "repeated continuation cursor" ? "repeat" : undefined,
        );
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });

    const model = await collectYouTrack("ENG", {
      baseUrl: "https://tracker.example",
      token: "secret",
      issueId: "ENG-1",
      fetcher,
    });

    expect(Object.values(model.nodes).filter((node) => node.kind === "PullRequest")).toHaveLength(
      0,
    );
    expect(
      Object.values(model.nodes).find((node) => node.identifier === "ENG-1")?.external,
    ).toEqual([]);
    expect(model.coverage?.complete).toBe(false);
    expect(model.coverage?.warnings?.join(" ")).toContain(
      cursorCase === "missing continuation cursor"
        ? "no continuation cursor"
        : "repeated its cursor",
    );
  });

  test("reports node-budget truncation and missing activity visibility", async () => {
    const subtask = {
      id: "subtask",
      name: "Subtask",
      sourceToTarget: "parent for",
      targetToSource: "subtask of",
      directed: true,
    };
    const root = {
      ...issue("root", "ENG-1", null),
      links: [
        {
          id: "sub",
          direction: "OUTWARD",
          linkType: subtask,
          issues: [issue("child", "ENG-2", null), issue("omitted", "ENG-3", null)],
        },
      ],
    };
    const fetcher = fetcherFor((url) => {
      if (url.pathname.endsWith("/api/admin/projects")) return response([project]);
      if (url.pathname.endsWith("/api/issues/ENG-1")) return response(root);
      if (url.pathname.endsWith("/api/issues/child"))
        return response({ ...issue("child", "ENG-2", null), links: [] });
      if (url.pathname.endsWith("/api/issues/root/activitiesPage")) return activityPage([]);
      if (url.pathname.endsWith("/api/issues/child/activitiesPage")) return response({}, 403);
      throw new Error(`Unexpected request: ${url.pathname}`);
    });

    const model = await collectYouTrack("ENG", {
      baseUrl: "https://tracker.example",
      token: "secret",
      issueId: "ENG-1",
      maxNodes: 2,
      fetcher,
    });

    expect(Object.keys(model.nodes)).toHaveLength(2);
    expect(model.coverage?.complete).toBe(false);
    expect(model.coverage?.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("node limit was reached"),
        expect.stringContaining("activity visibility access"),
      ]),
    );
  });

  test("enforces the node budget when adding project-link context", async () => {
    const root = {
      ...issue("root", "ENG-1", null),
      links: [],
    };
    const link = {
      id: "relates",
      direction: "BOTH",
      linkType: {
        id: "relates",
        name: "relates to",
        sourceToTarget: "relates to",
        targetToSource: "relates to",
        directed: false,
      },
    };
    const fetcher = fetcherFor((url) => {
      if (url.pathname.endsWith("/api/admin/projects")) return response([project]);
      if (url.pathname.endsWith("/api/admin/projects/project-1/issues"))
        return response(url.searchParams.get("$skip") === "1" ? [] : [root]);
      if (url.pathname.endsWith("/api/issues/root/links")) return response([link]);
      if (url.pathname.endsWith("/api/issues/root/links/relates/issues"))
        return response([issue("child", "ENG-2", null)]);
      throw new Error(`Unexpected request: ${url.pathname}`);
    });

    const model = await collectYouTrack("ENG", {
      baseUrl: "https://tracker.example",
      token: "secret",
      maxNodes: 1,
      fetcher,
    });

    expect(Object.keys(model.nodes)).toHaveLength(1);
    expect(model.coverage).toMatchObject({
      complete: false,
      warnings: [expect.stringContaining("1 linked issues were omitted")],
    });
  });

  test("matches the exact project and paginates issues with bearer auth and a base path", async () => {
    const issues = Array.from({ length: 101 }, (_, index) =>
      issue(`internal-${index}`, `ENG-${index + 1}`, null),
    );
    const pages: number[] = [];
    const fetcher = fetcherFor((url, init) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer secret");
      expect(url.pathname.startsWith("/youtrack/api/")).toBe(true);
      if (url.pathname.endsWith("/api/admin/projects"))
        return response([{ id: "old", name: "Old", shortName: "ENG-ARCHIVE" }, project]);
      if (url.pathname.endsWith("/api/admin/projects/project-1/issues")) {
        const skip = Number(url.searchParams.get("$skip"));
        pages.push(skip);
        expect(url.searchParams.get("query")).toBe("#Unresolved");
        return response(skip === 0 ? issues.slice(0, 100) : [issues[99], ...issues.slice(100)]);
      }
      if (/\/api\/issues\/[^/]+\/links$/.test(url.pathname)) return response([]);
      throw new Error(`Unexpected request: ${url.pathname}`);
    });

    const model = await collectYouTrack("ENG", {
      baseUrl: "https://tracker.example/youtrack/",
      token: "secret",
      maxNodes: 200,
      fetcher,
    });

    expect(pages).toEqual([0, 100]);
    expect(model.provider.id).toBe("youtrack");
    expect(model.repo).toBe("youtrack:tracker.example/youtrack/ENG");
    expect(Object.keys(model.nodes)).toHaveLength(101);
    expect(model.coverage?.complete).toBe(true);
    expect(parseModel(model)).toEqual(model);
  });

  test("preserves directed and symmetric link labels and cross-project targets", async () => {
    const issues = [
      issue("1", "ENG-1", null),
      issue("2", "ENG-2", 1234),
      issue("3", "ENG-3", null),
    ];
    const dependency = {
      id: "depends",
      name: "depends on",
      sourceToTarget: "depends on",
      targetToSource: "is required for",
      directed: true,
    };
    const related = {
      id: "relates",
      name: "relates to",
      sourceToTarget: "relates to",
      targetToSource: "relates to",
      directed: false,
    };
    const externalLink = {
      id: "external",
      name: "blocks",
      sourceToTarget: "blocks",
      targetToSource: "is blocked by",
      directed: true,
    };
    const fetcher = fetcherFor((url) => {
      if (url.pathname.endsWith("/api/admin/projects")) return response([project]);
      if (url.pathname.endsWith("/api/admin/projects/project-1/issues")) return response(issues);
      const linkList = url.pathname.match(/\/api\/issues\/([^/]+)\/links$/);
      if (linkList) {
        if (linkList[1] === "1")
          return response([
            { id: "depends", direction: "OUTWARD", linkType: dependency },
            { id: "relates", direction: "BOTH", linkType: related },
          ]);
        if (linkList[1] === "2")
          return response([{ id: "depends", direction: "INWARD", linkType: dependency }]);
        return response([
          { id: "relates", direction: "BOTH", linkType: related },
          { id: "external", direction: "OUTWARD", linkType: externalLink },
        ]);
      }
      const linked = url.pathname.match(/\/api\/issues\/([^/]+)\/links\/([^/]+)\/issues$/);
      if (linked) {
        if (linked[2] === "depends") return response([issues[linked[1] === "1" ? 1 : 0]]);
        if (linked[2] === "relates") return response([issues[linked[1] === "1" ? 2 : 0]]);
        if (linked[2] === "external")
          return response([
            {
              id: "external-7",
              idReadable: "OPS-7",
              summary: "External issue",
              resolved: null,
              project: { shortName: "OPS" },
            },
          ]);
        return response([issues[0]]);
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });

    const model = await collectYouTrack("ENG", {
      baseUrl: "https://tracker.example",
      token: "secret",
      state: "all",
      fetcher,
    });
    const byId = new Map(Object.values(model.nodes).map((node) => [node.identifier, node]));
    const node = (id: string) => {
      const found = byId.get(id);
      if (!found) throw new Error(`Test issue ${id} is missing`);
      return found;
    };
    const first = node("ENG-1");
    const second = node("ENG-2");
    const third = node("ENG-3");
    const external = node("OPS-7");

    expect(first.stateLabel).toBe("Open");
    expect(second.state).toBe("CLOSED");
    expect(first.out.filter((edge) => edge.to === second.key)).toEqual([
      expect.objectContaining({ via: "depends on" }),
    ]);
    expect(first.out.filter((edge) => edge.to === third.key)).toEqual([
      expect.objectContaining({ via: "relates to", undirected: true }),
    ]);
    expect(external.repo).toBe("youtrack:tracker.example/OPS");
    expect(external.read?.fetched).toBe(false);
    expect(Object.values(model.nodes).some((node) => node.heat)).toBe(false);
    expect(model.coverage?.complete).toBe(true);
  });

  test.each([401, 403, 502])("fails clearly when project lookup returns %i", async (status) => {
    const fetcher = fetcherFor(() => response({}, status));
    await expect(
      collectYouTrack("ENG", {
        baseUrl: "https://tracker.example",
        token: "secret",
        fetcher,
      }),
    ).rejects.toThrow(`YouTrack API request failed (${status})`);
  });

  test("rejects a malformed issue collection instead of showing an empty project", async () => {
    const fetcher = fetcherFor((url) =>
      url.pathname.endsWith("/api/admin/projects") ? response([project]) : response({ issues: [] }),
    );
    await expect(
      collectYouTrack("ENG", {
        baseUrl: "https://tracker.example",
        token: "secret",
        fetcher,
      }),
    ).rejects.toThrow("invalid collection");
  });

  test("returns explicit partial coverage when link reads fail", async () => {
    const fetcher = fetcherFor((url) => {
      if (url.pathname.endsWith("/api/admin/projects")) return response([project]);
      if (url.pathname.endsWith("/api/admin/projects/project-1/issues"))
        return response([issue("1", "ENG-1", null)]);
      return response({}, 503);
    });
    const model = await collectYouTrack("ENG", {
      baseUrl: "https://tracker.example",
      token: "secret",
      fetcher,
    });
    expect(model.coverage?.complete).toBe(false);
    expect(model.coverage?.warnings?.[0]).toMatch(/Link data could not be read/);
  });
});
