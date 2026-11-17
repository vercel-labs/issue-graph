import { expect, test } from "vitest";
import { JiraReadError, type JiraReader } from "./jira.js";
import { runJira } from "./jira-cli.js";

const root = {
  apiVersion: "v2",
  data: [
    {
      key: "ABC-1",
      url: "https://acme.atlassian.net/browse/ABC-1",
      summary: "Root",
      status: { name: "To Do", statusCategory: { key: "new" } },
      project: { key: "ABC" },
      issuetype: { name: "Task", hierarchyLevel: 0 },
      issuelinks: [{ id: "1", type: { name: "Blocks" }, outwardIssue: { key: "ABC-2" } }],
      subtasks: [],
      remoteLinks: [],
    },
  ],
};

function fixture(sites: Array<string | undefined> = []): (site?: string) => JiraReader {
  return (site) => {
    sites.push(site);
    return {
      label: "twg",
      async issue(key) {
        if (key === "ABC-1") return root;
        throw new JiraReadError("NOT_FOUND");
      },
    };
  };
}

async function invoke(args: string[], factory = fixture()) {
  let stdout = "";
  let stderr = "";
  const code = await runJira(args, factory, {
    stdout: (value) => {
      stdout += value;
    },
    stderr: (value) => {
      stderr += value;
    },
  });
  return { code, stdout, stderr };
}

test("help and invalid arguments never start twg", async () => {
  const unused = () => {
    throw new Error("Must not start twg");
  };
  const help = await invoke(["--help"], unused);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("twg jira workitem get");
  for (const args of [
    [],
    ["--typo"],
    ["ABC-1", "ABC-2"],
    ["UTF"],
    ["ABC-1", "--depth", "9"],
    ["ABC-1", "--max-nodes", "0"],
    ["ABC-1", "--concurrency", "1.5"],
    ["ABC-1", "--site"],
    ["ABC-1", "--site", "--json"],
    ["https://acme.atlassian.net/browse/ABC-1", "--site", "other.atlassian.net"],
    ["https://acme.atlassian.net/browse/ABC-1", "--site", "other"],
    ["https://[::1]/browse/ABC-1"],
  ])
    expect((await invoke(args, unused)).code, args.join(" ")).toBe(2);
});

test("JSON output carries the report and partial coverage exits 1", async () => {
  const sites: Array<string | undefined> = [];
  const result = await invoke(["abc-1", "--site", "Acme.atlassian.net", "--json"], fixture(sites));
  expect(result.code).toBe(1);
  expect(sites).toEqual(["acme.atlassian.net"]);
  const report = JSON.parse(result.stdout);
  expect(report).toMatchObject({ source: "jira", site: "acme.atlassian.net", readSource: "twg" });
  expect(report.coverage.failed).toEqual(["jira:acme.atlassian.net:ABC-2"]);
  expect(report.coverage.partial).toEqual([]);
});

test("depth 0 reads only the seed and exits 0; Markdown is the default", async () => {
  const result = await invoke(["https://acme.atlassian.net/browse/ABC-1", "--depth", "0"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("# Jira graph · acme.atlassian.net");
  expect(result.stdout).toContain("Depth boundary: 1 nodes not expanded.");
});

test("a browse URL with a site prefix reads through that prefix", async () => {
  const sites: Array<string | undefined> = [];
  const result = await invoke(
    ["https://acme.atlassian.net/browse/ABC-1", "--site", "acme", "--depth", "0"],
    fixture(sites),
  );
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  expect(sites).toEqual(["acme"]);
  expect(result.stdout).toContain("# Jira graph · acme.atlassian.net");
});

test("help explains when child issues are not read", async () => {
  const help = (await invoke(["--help"])).stdout.replace(/\s+/g, " ");
  expect(help).toContain("missing or null");
});

test("a failed seed read prints the reason and exits 1", async () => {
  const result = await invoke(["ABC-9", "--site", "acme"]);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("NOT_FOUND");
});
