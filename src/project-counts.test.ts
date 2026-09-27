import { expect, test, vi } from "vitest";
import { repositoryOpenCount } from "./github.js";

const githubResponse = (issues = 301, pullRequests = 47) => ({
  data: {
    repository: {
      nameWithOwner: "Example/Repo",
      issues: { totalCount: issues },
      pullRequests: { totalCount: pullRequests },
    },
  },
});

test("reads GitHub's entire repository counts, including both issues and PRs", async () => {
  const transport = { graphql: vi.fn(async () => githubResponse()) };
  expect(await repositoryOpenCount(transport, "example", "repo")).toMatchObject({
    value: 348,
    issues: 301,
    pullRequests: 47,
    complete: true,
  });
  expect(transport.graphql.mock.calls[0]).toEqual([
    expect.stringContaining("issues(states:OPEN){totalCount}"),
    { owner: "example", repo: "repo" },
  ]);
  expect(
    await repositoryOpenCount({ graphql: async () => githubResponse(0, 0) }, "example", "repo"),
  ).toMatchObject({ value: 0, complete: true });
});

test.each([
  {},
  { ...githubResponse(), errors: [{ message: "partial" }] },
  { data: { repository: { ...githubResponse().data.repository, nameWithOwner: "other/repo" } } },
  githubResponse(-1),
  githubResponse(1.5),
  githubResponse(Number.MAX_SAFE_INTEGER, 1),
])("rejects an unavailable or unreliable GitHub total: %j", async (response) => {
  await expect(
    repositoryOpenCount({ graphql: async () => response }, "example", "repo"),
  ).rejects.toThrow();
});
