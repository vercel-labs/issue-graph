import { expect, test } from "vitest";
import { fixtureReader, issue, key, options, page, relation } from "../tests/linear-fixtures.js";
import { buildLinearGraph, renderLinear } from "./linear.js";
import { runLinear } from "./linear-cli.js";
import { githubTarget, resolveGithubAttachments } from "./linear-github.js";
import { linearDashboardModel } from "./linear-html.js";

function attachment(id: string, url: string, title = id) {
  return { id, title, url, archivedAt: null };
}

function github(items: Record<string, unknown>, calls: string[] = []) {
  return {
    async graphql(_query: string, variables: Record<string, string | number> = {}) {
      const id = `${variables.owner}/${variables.repo}#${variables.n}`;
      calls.push(id);
      const found = items[id];
      if (found instanceof Error) throw found;
      return {
        data: {
          repository: {
            nameWithOwner: `${variables.owner}/${variables.repo}`,
            issueOrPullRequest: found ?? null,
          },
        },
      };
    },
  };
}

function blockedGraph() {
  const blocked = issue(1);
  blocked.inverseRelations = page([relation(2, 1)]);
  const blocker = issue(2);
  blocker.relations = page([relation(2, 1)]);
  blocker.attachments = page([
    attachment("pr", "https://github.com/o/r/pull/20"),
    attachment("dup", "https://github.com/o/r/pull/20/files"),
    attachment("doc", "https://example.com/spec"),
  ]);
  return fixtureReader([blocked, blocker]);
}

test("parses GitHub issue and pull request URLs and ignores everything else", () => {
  expect(githubTarget("https://github.com/o/r/pull/20")).toEqual({ repo: "o/r", number: 20 });
  expect(githubTarget("https://github.com/o/r/issues/7#issuecomment-1")).toEqual({
    repo: "o/r",
    number: 7,
  });
  for (const url of [
    "http://github.com/o/r/pull/20",
    "https://github.com/o/r/commit/abc",
    "https://github.com/o/r/pull/0",
    "https://github.com.evil.dev/o/r/pull/1",
    "https://example.com/o/r/pull/1",
    "not a url",
  ])
    expect(githubTarget(url)).toBeUndefined();
});

test("a blocked issue shows the state of the blocker's linked pull request", async () => {
  const calls: string[] = [];
  const report = await resolveGithubAttachments(
    await buildLinearGraph(blockedGraph(), "ENG-1", options),
    github(
      {
        "o/r#20": {
          __typename: "PullRequest",
          number: 20,
          title: "Fix",
          state: "OPEN",
          isDraft: true,
        },
      },
      calls,
    ),
  );
  expect(calls).toEqual(["o/r#20"]);
  expect(report.coverageComplete).toBe(true);
  expect(report.scope.externalLinks).toBe("github-resolved");
  const blocker = report.nodes.find((node) => node.key === key(2));
  expect(blocker?.externalLinks.find((link) => link.evidence.id === "pr")?.github).toMatchObject({
    repo: "o/r",
    number: 20,
    kind: "pull-request",
    state: "OPEN",
    draft: true,
  });
  expect(blocker?.externalLinks.find((link) => link.evidence.id === "doc")?.github).toBeUndefined();
  expect(blocker?.coverage.at(-1)).toEqual({
    source: "github attachments",
    pages: 2,
    complete: true,
  });
  const markdown = renderLinear(report);
  expect(markdown).toContain("- ← blocks: ENG-2 · o/r#20 PR open, draft");
  expect(markdown).toContain("GitHub issue and pull request attachments are read one hop");
  const model = linearDashboardModel(report);
  expect(
    model.nodes[key(2)].attachments?.find((link) => link.evidence.id === "pr")?.github?.state,
  ).toBe("OPEN");
});

test("an unreadable target is visible and makes the capture partial", async () => {
  const report = await resolveGithubAttachments(
    await buildLinearGraph(blockedGraph(), "ENG-1", options),
    github({ "o/r#20": new Error("rate limited") }),
  );
  expect(report.coverageComplete).toBe(false);
  expect(report.coverage.partial).toContain(key(2));
  const blocker = report.nodes.find((node) => node.key === key(2));
  expect(blocker?.externalLinks.find((link) => link.evidence.id === "pr")?.github).toMatchObject({
    error: "READ_FAILED",
  });
  expect(blocker?.coverage.at(-1)).toMatchObject({ complete: false, reason: "read-failed" });
  expect(renderLinear(report)).toContain("o/r#20 unavailable");
});

test("a response for a different item is not trusted", async () => {
  const report = await resolveGithubAttachments(
    await buildLinearGraph(blockedGraph(), "ENG-1", options),
    github({
      "o/r#20": { __typename: "PullRequest", number: 21, title: "Other", state: "MERGED" },
    }),
  );
  expect(
    report.nodes
      .find((node) => node.key === key(2))
      ?.externalLinks.find((link) => link.evidence.id === "pr")?.github?.error,
  ).toBe("NOT_FOUND");
});

test("GitHub is read only with --github", async () => {
  const calls: string[] = [];
  const io = {
    stdout: () => {},
    stderr: () => {},
    github: () =>
      github(
        { "o/r#20": { __typename: "PullRequest", number: 20, title: "Fix", state: "MERGED" } },
        calls,
      ),
  };
  expect(await runLinear(["ENG-1", "--json"], () => blockedGraph(), io)).toBe(0);
  expect(calls).toEqual([]);
  let stdout = "";
  expect(
    await runLinear(["ENG-1", "--json", "--github"], () => blockedGraph(), {
      ...io,
      stdout: (value: string) => {
        stdout += value;
      },
    }),
  ).toBe(0);
  expect(calls).toEqual(["o/r#20"]);
  expect(JSON.parse(stdout).scope.externalLinks).toBe("github-resolved");
});
