import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { glabGitLabReader } from "./glab.js";

const dir = mkdtempSync(join(tmpdir(), "issue-graph-glab-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const VERSION = `if [ "$1" = version ]; then echo 'glab 1.126.0 (abc1234)'; exit 0; fi`;

function stub(name: string, body: string, version = VERSION): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${version}\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("glabGitLabReader", () => {
  test("runs one GET through glab api with the host and no shell", async () => {
    const log = join(dir, "args.txt");
    const binary = stub(
      "glab-ok",
      `for a in "$@"; do printf '%s\\n' "$a"; done > '${log}'\necho '{"iid":1}'`,
    );
    const reader = glabGitLabReader({ binary, host: "gitlab.example.com" });
    expect(reader.label).toBe("glab");
    const path = "projects/acme%2Fapi/issues/1/notes?per_page=100&page=2";
    expect(await reader.get(path)).toEqual({ iid: 1 });
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
      "api",
      "--method",
      "GET",
      "--hostname",
      "gitlab.example.com",
      path,
    ]);
  });

  test("passes glab the hostname without a port", async () => {
    const log = join(dir, "port.txt");
    const binary = stub("glab-port", `printf '%s ' "$@" > '${log}'\necho '{}'`);
    await glabGitLabReader({ binary, host: "gitlab.example.com:8443" }).get(
      "projects/acme%2Fapi/issues/1",
    );
    expect(readFileSync(log, "utf8")).toContain("--hostname gitlab.example.com projects/");
  });

  test("omits --hostname to use glab's default host", async () => {
    const log = join(dir, "default.txt");
    const binary = stub("glab-default", `printf '%s ' "$@" > '${log}'\necho '[]'`);
    await glabGitLabReader({ binary }).get("projects/acme%2Fapi/merge_requests/1");
    expect(readFileSync(log, "utf8")).not.toContain("--hostname");
  });

  test("rejects paths outside the read routes and hosts that could become flags", async () => {
    const binary = stub("glab-never", "exit 99");
    const reader = glabGitLabReader({ binary });
    for (const path of [
      "projects/acme%2Fapi/issues/1/notes?body=x&per_page=1;rm",
      "projects/acme/api/issues/1",
      "user",
      "--method=POST projects/acme%2Fapi/issues/1",
    ])
      await expect(reader.get(path)).rejects.toMatchObject({ code: "INVALID_PATH" });
    expect(() => glabGitLabReader({ host: "--hostname=evil" })).toThrow(/Invalid GitLab host/);
  });

  test("maps HTTP failures, a missing binary, and non-JSON output to codes", async () => {
    const notFound = stub(
      "glab-404",
      `echo '{"message":"404 Project Not Found"}'\necho 'glab: 404 Project Not Found (HTTP 404)' >&2\nexit 1`,
    );
    await expect(
      glabGitLabReader({ binary: notFound }).get("projects/acme%2Fapi/issues/1"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const unauthorized = stub("glab-401", `echo 'glab: 401 Unauthorized (HTTP 401)' >&2\nexit 1`);
    await expect(
      glabGitLabReader({ binary: unauthorized }).get("projects/acme%2Fapi/issues/1/links"),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const limited = stub(
      "glab-429",
      `printf 'glab: HTTP 429\\nglab: rate limited, retry after 30s\\n' >&2\nexit 1`,
    );
    await expect(
      glabGitLabReader({ binary: limited }).get("projects/acme%2Fapi/issues/1"),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    const proxied = stub(
      "glab-proxied",
      `echo 'glab: upstream returned HTTP 429' >&2\necho 'glab: 404 Project Not Found (HTTP 404)' >&2\nexit 1`,
    );
    await expect(
      glabGitLabReader({ binary: proxied }).get("projects/acme%2Fapi/issues/1"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      glabGitLabReader({ binary: join(dir, "missing") }).get("projects/acme%2Fapi/issues/1"),
    ).rejects.toMatchObject({ code: "GLAB_NOT_FOUND" });
    const text = stub("glab-text", "echo 'not json'");
    await expect(
      glabGitLabReader({ binary: text }).get("projects/acme%2Fapi/issues/1"),
    ).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
  });

  test("fails closed before any read when glab is older than 1.126 or its version is unreadable", async () => {
    const read = "projects/acme%2Fapi/issues/1";
    const log = join(dir, "old.txt");
    for (const [name, output, code] of [
      ["glab-old", "glab 1.125.9 (abc)", "GLAB_TOO_OLD"],
      ["glab-v0", "glab version 0.9.0 (2020-01-01)", "GLAB_TOO_OLD"],
      ["glab-weird", "something else", "GLAB_VERSION_UNKNOWN"],
    ] as const) {
      const binary = stub(
        name,
        `echo read >> '${log}'\necho '{}'`,
        `if [ "$1" = version ]; then echo '${output}'; exit 0; fi`,
      );
      await expect(
        glabGitLabReader({ binary, host: "evil.example" }).get(read),
      ).rejects.toMatchObject({ code });
    }
    expect(() => readFileSync(log, "utf8")).toThrow();
    const newer = stub(
      "glab-new",
      "echo '{}'",
      `if [ "$1" = version ]; then echo 'glab 2.0.0 (abc)'; exit 0; fi`,
    );
    expect(await glabGitLabReader({ binary: newer }).get(read)).toEqual({});
  });
});

test("reads aliased work-item queries through glab and handles schema errors", async () => {
  const log = join(dir, "graphql-input.json");
  const binary = stub(
    "glab-graphql",
    `cat > '${log}'
    printf '%s\n' '{"errors":[{"message":"Field is not available","extensions":{"code":"undefinedField"}}]}'
    exit 1`,
  );
  const reader = glabGitLabReader({ binary, host: "gitlab.example.com" });
  const items = Array.from({ length: 21 }, (_, index) => ({
    kind: "issue" as const,
    path: "acme/api",
    iid: index + 1,
  }));
  await expect(reader.getIssues?.(items)).resolves.toEqual({ supported: false, issues: new Map() });
  const { query, variables } = JSON.parse(readFileSync(log, "utf8"));
  expect(query.match(/: workItemsByReference/g)).toHaveLength(3);
  expect(query).toContain("closingMergeRequests");
  expect(query).not.toContain("relatedMergeRequests");
  expect([variables.refs0.length, variables.refs1.length, variables.refs2.length]).toEqual([
    10, 10, 1,
  ]);
  expect(variables.refs2).toEqual(["acme/api#21"]);
});

test("reads the GraphQL HTTP status when stderr has no status", async () => {
  const binary = stub(
    "glab-graphql-throttle",
    `cat >/dev/null
    printf 'HTTP/2.0 429 Too Many Requests\\nContent-Type: application/json\\r\\n\\r\\n{"errors":[{"message":"Rate limit exceeded"}]}'
    echo 'glab: Rate limit exceeded' >&2
    exit 1`,
  );
  const reader = glabGitLabReader({ binary });
  await expect(
    reader.getIssues?.([{ kind: "issue", path: "acme/api", iid: 1 }]),
  ).rejects.toMatchObject({
    code: "RATE_LIMITED",
  });
});

test("keeps issue details and unaffected relations after a GraphQL field error", async () => {
  const reference = "acme/api#1";
  const data = {
    batch0: {
      nodes: [
        {
          reference,
          title: "Issue 1",
          state: "OPEN",
          webUrl: "https://gitlab.example.com/acme/api/-/work_items/1",
          features: {
            development: {
              closingMergeRequests: {
                nodes: [{ mergeRequest: null }],
                pageInfo: { hasNextPage: false },
              },
            },
            linkedItems: { linkedItems: { nodes: [], pageInfo: { hasNextPage: false } } },
          },
        },
      ],
    },
  };
  const json = JSON.stringify({
    data,
    errors: [
      {
        message: "Internal error",
        path: [
          "batch0",
          "nodes",
          0,
          "features",
          "development",
          "closingMergeRequests",
          "nodes",
          0,
          "mergeRequest",
        ],
      },
    ],
  });
  const binary = stub(
    "glab-graphql-partial",
    `cat >/dev/null
    printf '%s\\n' '${json}'
    exit 1`,
  );
  const reader = glabGitLabReader({ binary });
  const result = await reader.getIssues?.([{ kind: "issue", path: "acme/api", iid: 1 }]);
  expect(result?.issues.get(reference)).toMatchObject({
    body: { title: "Issue 1", state: "opened" },
    links: [],
    closing: [],
    closingIncomplete: "read-failed",
  });
});
