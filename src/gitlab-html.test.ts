import { expect, test } from "vitest";
import { buildGitLabGraph, type GitLabReader, gitlabNodeKey } from "./gitlab.js";
import { gitlabDashboardModel } from "./gitlab-html.js";
import { parseModel } from "./model-validation.js";

const HOST = "gitlab.example.com";
const API = "acme/platform/api";
const issueUrl = `https://${HOST}/${API}/-/work_items/1`;
const mrUrl = `https://${HOST}/${API}/-/merge_requests/1`;
const blockerUrl = `https://${HOST}/${API}/-/work_items/2`;

const reader: GitLabReader = {
  async get(path) {
    const root = `projects/${encodeURIComponent(API)}`;
    if (path === `${root}/issues/1`)
      return { id: 1, iid: 1, title: "Bug", state: "opened", web_url: issueUrl };
    if (path === `${root}/merge_requests/1`)
      return { id: 2, iid: 1, title: "Fix", state: "merged", web_url: mrUrl };
    if (path.startsWith(`${root}/issues/1/closed_by`)) return [{ web_url: mrUrl }];
    if (path.startsWith(`${root}/merge_requests/1/closes_issues`)) return [{ web_url: issueUrl }];
    if (path.startsWith(`${root}/issues/1/links`))
      return [{ web_url: blockerUrl, link_type: "is_blocked_by", issue_link_id: 5 }];
    if (path === `${root}/issues/2`)
      return { id: 3, iid: 2, title: "Cause", state: "opened", web_url: blockerUrl };
    if (path.startsWith(`${root}/issues/2/links`))
      return [{ web_url: issueUrl, link_type: "blocks", issue_link_id: 5 }];
    if (path.startsWith(`${root}/issues/1/notes`))
      return [{ id: 7, system: true, body: "mentioned in merge request !1" }];
    return [];
  },
};

test("the dashboard model passes validation and shows each link once", async () => {
  const report = await buildGitLabGraph(reader, issueUrl, {
    maxDepth: 1,
    maxNodes: 80,
    hubThreshold: 12,
  });
  const model = parseModel(JSON.parse(JSON.stringify(gitlabDashboardModel(report))));
  expect(model.id).toBe(`gitlab:${HOST}:project:${API}`);
  expect(model.provider.id).toBe("gitlab");
  const issue = model.nodes[gitlabNodeKey(HOST, { path: API, kind: "issue", iid: 1 })];
  const mr = model.nodes[gitlabNodeKey(HOST, { path: API, kind: "merge_request", iid: 1 })];
  expect(issue.kind).toBe("Issue");
  expect(mr).toMatchObject({ kind: "PullRequest", state: "MERGED" });
  // Closing and blocking links read from both ends collapse to one; closes is labeled as on GitHub.
  expect(mr.out.filter((edge) => edge.via === "closes")).toHaveLength(1);
  expect(issue.in.map((edge) => edge.via).sort()).toEqual(["blocked by", "closes", "mentioned by"]);
});
