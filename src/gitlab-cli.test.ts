import { expect, test } from "vitest";
import { GitLabReadError, type GitLabReader } from "./gitlab.js";
import { type GitLabIO, runGitLab } from "./gitlab-cli.js";

const ROOT = "projects/acme%2Fplatform%2Fapi/issues/1";
const URL = "https://gitlab.example.com/acme/platform/api/-/work_items/1";

function fixture(hosts: Array<string | undefined> = []): (host?: string) => GitLabReader {
  return (host) => {
    hosts.push(host);
    return {
      label: "glab",
      async get(path) {
        if (path === ROOT) return { id: 1, iid: 1, title: "Root", state: "opened", web_url: URL };
        if (path.startsWith(`${ROOT}/`)) return [];
        throw new GitLabReadError("NOT_FOUND");
      },
    };
  };
}

async function invoke(args: string[], factory = fixture(), extra: Partial<GitLabIO> = {}) {
  let stdout = "";
  let stderr = "";
  const code = await runGitLab(args, factory, {
    stdout: (value) => {
      stdout += value;
    },
    stderr: (value) => {
      stderr += value;
    },
    ...extra,
  });
  return { code, stdout, stderr };
}

test("help and invalid arguments never start glab", async () => {
  const hosts: Array<string | undefined> = [];
  expect((await invoke(["--help"], fixture(hosts))).stdout).toContain("glab api --method GET");
  for (const args of [
    [],
    ["acme/api#1", "acme/api#2"],
    ["acme/api#1", "--host", "--json"],
    ["acme/api#1", "--depth", "9"],
    ["acme/api#1", "--write"],
    ["#1"],
    [URL, "--host", "gitlab.com"],
    ["acme/api#1", "--cluster", "--json"],
    ["acme/api#1", "--clusters", "themes.json"],
  ])
    expect((await invoke(args, fixture(hosts))).code).toBe(2);
  expect(hosts).toEqual([]);
});

test("passes the URL's host to the reader and prints JSON", async () => {
  const hosts: Array<string | undefined> = [];
  const result = await invoke([URL, "--json"], fixture(hosts));
  expect(result.code).toBe(0);
  expect(hosts).toEqual(["gitlab.example.com"]);
  const report = JSON.parse(result.stdout);
  expect(report.host).toBe("gitlab.example.com");
  expect(report.nodes[0].identifier).toBe("acme/platform/api#1");
});

test("a reference without --host leaves the host to glab", async () => {
  const hosts: Array<string | undefined> = [];
  const result = await invoke(["acme/platform/api#1"], fixture(hosts));
  expect(result.code).toBe(0);
  expect(hosts).toEqual([undefined]);
  expect(result.stdout).toContain("# GitLab graph · gitlab.example.com");
});

test("an unreadable seed exits 1 with the code on stderr", async () => {
  const result = await invoke(["acme/platform/api!9"]);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("NOT_FOUND");
});

test("--open hands the report to the dashboard writer", async () => {
  const calls: unknown[] = [];
  const result = await invoke([URL, "--open", "--no-save"], fixture(), {
    dashboard: async (_report, options) => {
      calls.push(options);
    },
  });
  expect(result.code).toBe(0);
  expect(calls).toEqual([{ path: undefined, open: true, save: false, clusters: undefined }]);
});
