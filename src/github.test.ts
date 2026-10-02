import { describe, expect, test } from "vitest";
import {
  labelSeeds,
  makeFetchNode,
  NODE_QUERY,
  openBacklogSeeds,
  parseNodeResponse,
  type RawNodeItem,
} from "./github.js";
import type { GhTransport } from "./transport.js";

const ISSUE: RawNodeItem = {
  __typename: "Issue",
  title: "Crash on resize",
  state: "OPEN",
  url: "https://github.com/o/r/issues/1",
  body: "same as #2 and see https://example.dev/x",
  author: { login: "alice" },
  createdAt: "2026-01-01T00:00:00Z",
  reactions: { totalCount: 7 },
  participants: { totalCount: 3 },
  comments: { totalCount: 4, nodes: [{ body: "dup of #3", author: { login: "bob" } }] },
  timelineItems: {
    nodes: [
      {
        createdAt: "2026-01-02T00:00:00Z",
        actor: { login: "carol" },
        source: { number: 9, repository: { owner: { login: "o" }, name: "r" } },
      },
    ],
  },
};

/** A transport that answers with whatever envelope the test hands it. */
function fakeTransport(envelope: unknown, hits: number[] = []): GhTransport {
  return {
    async graphql() {
      return envelope;
    },
    async search() {
      return hits.map((number) => ({ owner: "o", repo: "r", number }));
    },
  };
}

describe("parseNodeResponse", () => {
  test("extracts heat, text edges, and structural edges with attribution", () => {
    const node = parseNodeResponse(ISSUE, "o", "r", 1, 0);
    expect(node.fetched).toBe(true);
    expect(node.kind).toBe("Issue");
    expect(node.author).toBe("alice");
    expect(node.heat).toEqual({
      createdAt: "2026-01-01T00:00:00Z",
      comments: 4,
      participants: 3,
      reactions: 7,
    });

    const byTarget = new Map(node.edges.map((e) => [e.to, e]));
    expect(byTarget.get("o/r#2")?.via).toBe("text");
    expect(byTarget.get("o/r#2")?.by).toBe("alice");
    expect(byTarget.get("o/r#3")?.by).toBe("bob"); // from the comment, not the body
    expect(byTarget.get("o/r#9")?.via).toBe("cross-ref");
    expect(byTarget.get("o/r#9")?.by).toBe("carol");
    expect(node.externalLinks).toContain("https://example.dev/x");
  });

  test("a PR records its files and its claimed closes", () => {
    const node = parseNodeResponse(
      {
        __typename: "PullRequest",
        title: "fixes #42",
        state: "OPEN",
        body: "",
        createdAt: "2026-01-01T00:00:00Z",
        mergedAt: null,
        files: { nodes: [{ path: "src/a.ts" }, { path: "src/b.ts" }] },
        changedFiles: 2,
      },
      "o",
      "r",
      50,
      0,
    );
    expect(node.pr?.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(node.pr?.mergedAt).toBe("");
    expect(node.claimsClose).toEqual(["o/r#42"]);
  });

  test("a PR records only the files its base must already have", () => {
    const node = parseNodeResponse(
      {
        __typename: "PullRequest",
        title: "t",
        state: "OPEN",
        files: {
          nodes: [
            { path: "src/edited.ts", changeType: "MODIFIED" },
            { path: "src/removed.ts", changeType: "DELETED" },
            { path: "src/new.ts", changeType: "ADDED" },
            { path: "src/moved.ts", changeType: "RENAMED" },
            { path: "src/unknown.ts" },
          ],
        },
      },
      "o",
      "r",
      51,
      0,
    );
    expect(node.pr?.baseFiles).toEqual(["src/edited.ts", "src/removed.ts"]);
    expect(node.pr?.files).toHaveLength(5);
  });

  test("a missing item is NOT_FOUND, not a silently empty node", () => {
    const node = parseNodeResponse(undefined, "o", "r", 1, 0);
    expect(node.state).toBe("NOT_FOUND");
    expect(node.fetched).toBe(false);
  });
});

describe("sub-issues", () => {
  const ref = (number: number, owner = "o", name = "r") => ({
    number,
    repository: { owner: { login: owner }, name },
  });

  test("a sub-issue points at its parent, even with no mention in the text", () => {
    const node = parseNodeResponse(
      { __typename: "Issue", title: "child", state: "OPEN", body: "", parent: ref(7848) },
      "o",
      "r",
      8343,
      0,
    );
    expect(node.edges).toEqual([{ to: "o/r#7848", via: "sub-issue" }]);
    expect(node.subIssues).toBeUndefined();
  });

  test("a parent lists its sub-issues for the crawl without claiming edges to them", () => {
    const node = parseNodeResponse(
      {
        __typename: "Issue",
        title: "parent",
        state: "OPEN",
        body: "",
        parent: null,
        subIssues: { nodes: [ref(2), ref(3), ref(2), ref(1), ref(4, "other", "x")] },
      },
      "o",
      "r",
      1,
      0,
    );
    expect(node.subIssues).toEqual(["o/r#2", "o/r#3", "other/x#4"]);
    expect(node.edges).toEqual([]);
  });

  test("the sub-issue link wins over a text mention or cross-reference of the same parent", () => {
    const node = parseNodeResponse(
      {
        __typename: "Issue",
        title: "child",
        state: "OPEN",
        body: "part of #7848",
        author: { login: "alice" },
        parent: ref(7848),
        timelineItems: { nodes: [{ actor: { login: "bob" }, source: ref(7848) }] },
      },
      "o",
      "r",
      8343,
      0,
    );
    expect(node.edges).toEqual([{ to: "o/r#7848", via: "sub-issue" }]);
  });

  test("a cross-repo parent keeps its own repository in the key", () => {
    const node = parseNodeResponse(
      { __typename: "Issue", title: "child", state: "OPEN", parent: ref(5, "other", "x") },
      "o",
      "r",
      8,
      0,
    );
    expect(node.edges).toEqual([{ to: "other/x#5", via: "sub-issue" }]);
  });

  test("a parent with more sub-issues than the page records the total", () => {
    const parse = (totalCount: number) =>
      parseNodeResponse(
        {
          __typename: "Issue",
          title: "epic",
          state: "OPEN",
          subIssues: { totalCount, nodes: [ref(2), ref(3)] },
        },
        "o",
        "r",
        1,
        0,
      );
    expect(parse(75).subIssueTotal).toBe(75);
    expect(parse(2).subIssueTotal).toBeUndefined();
  });

  test("the node query asks for the parent and a bounded page of sub-issues", () => {
    expect(NODE_QUERY).toContain("parent{ number repository{owner{login} name} }");
    expect(NODE_QUERY).toContain("subIssues(first:50){ totalCount");
  });
});

describe("makeFetchNode", () => {
  test("parses a well-formed envelope", async () => {
    const fetch = makeFetchNode(
      fakeTransport({ data: { repository: { issueOrPullRequest: ISSUE } } }),
    );
    const node = await fetch("o", "r", 1, 0);
    expect(node.title).toBe("Crash on resize");
    expect(node.depth).toBe(0);
  });

  test("a per-node GraphQL error degrades to FETCH_ERROR", async () => {
    const fetch = makeFetchNode(fakeTransport({ errors: [{ message: "Could not resolve" }] }));
    const node = await fetch("o", "r", 1, 0);
    expect(node.state).toBe("FETCH_ERROR");
    expect(node.fetched).toBe(false);
  });

  test("a transport failure propagates instead of becoming an empty node", async () => {
    const boom: GhTransport = {
      async graphql() {
        throw new Error("rate limited");
      },
      async search() {
        return [];
      },
    };
    await expect(makeFetchNode(boom)("o", "r", 1, 0)).rejects.toThrow("rate limited");
  });
});

describe("labelSeeds", () => {
  test("returns the issue numbers the search matched", async () => {
    expect(await labelSeeds(fakeTransport(null, [4, 8, 15]), "o/r", "bug")).toEqual([4, 8, 15]);
  });
});

describe("openBacklogSeeds", () => {
  test("returns every open issue or PR number matched by search", async () => {
    expect(await openBacklogSeeds(fakeTransport(null, [3, 5, 8]), "o/r")).toEqual([3, 5, 8]);
  });
});
