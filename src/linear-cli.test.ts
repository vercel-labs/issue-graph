import { expect, test } from "vitest";
import { fixtureReader, issue, page } from "../tests/linear-fixtures.js";
import { runLinear } from "./linear-cli.js";
import type { LinearReader } from "./linear-queries.js";

async function invoke(args: string[], factory = (): LinearReader => fixtureReader()) {
  let stdout = "";
  let stderr = "";
  const code = await runLinear(args, factory, {
    stdout: (value) => {
      stdout += value;
    },
    stderr: (value) => {
      stderr += value;
    },
  });
  return { code, stdout, stderr };
}

test("Linear help and invalid arguments never initialize authentication", async () => {
  const unused = () => {
    throw new Error("Must not initialize");
  };
  expect((await invoke(["--help"], unused)).code).toBe(0);
  for (const args of [
    [],
    ["--typo"],
    ["ENG-1", "ENG-2"],
    ["ENG-1", "--depth", "-1"],
    ["ENG-1", "--max-pages", "1.5"],
    ["ENG-1", "--workspace"],
    ["ENG-1", "--html"],
    ["ENG-1", "--html", "--open"],
    ["--project"],
    ["--project", "ENG-1"],
    ["ENG-1", "--project", "00000000-0000-4000-8000-000000000001"],
    ["https://linear.app/fixture/issue/ENG-1/x", "--workspace", "another"],
  ])
    expect((await invoke(args, unused)).code).toBe(2);
});

test("HTML and open are explicit, preserve JSON stdout and respect no-snapshot", async () => {
  const calls: unknown[] = [];
  let stdout = "";
  const io = {
    stdout: (value: string) => {
      stdout += value;
    },
    stderr: () => {},
    dashboard: async (report: unknown, settings: unknown) => {
      calls.push({ report, settings });
    },
  };
  expect(await runLinear(["ENG-1", "--json"], () => fixtureReader(), io)).toBe(0);
  expect(calls).toEqual([]);
  stdout = "";
  expect(
    await runLinear(
      ["ENG-1", "--html", "nested/linear.html", "--open", "--no-snapshot", "--json"],
      () => fixtureReader(),
      io,
    ),
  ).toBe(0);
  expect(calls).toMatchObject([
    {
      settings: { path: "nested/linear.html", open: true, save: false },
      report: { source: "linear" },
    },
  ]);
  expect(JSON.parse(stdout).source).toBe("linear");
});

test("partial HTML is still emitted with exit1 and output failures do not report success", async () => {
  const root = issue(1);
  root.children = page([], "more");
  let rendered = false;
  let stdout = "";
  let stderr = "";
  const io = {
    stdout: (value: string) => {
      stdout += value;
    },
    stderr: (value: string) => {
      stderr += value;
    },
    dashboard: async (report: { coverageComplete: boolean }) => {
      rendered = !report.coverageComplete;
    },
  };
  expect(
    await runLinear(["ENG-1", "--open", "--max-pages", "1"], () => fixtureReader([root]), io),
  ).toBe(1);
  expect(rendered).toBe(true);
  stdout = "";
  io.dashboard = async () => {
    throw new Error("Output unavailable");
  };
  expect(
    await runLinear(["ENG-1", "--html", "linear.html", "--json"], () => fixtureReader(), io),
  ).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toBe("Output unavailable\n");
});

test("complete JSON is machine-readable and partial pagination exits1", async () => {
  const complete = await invoke(["ENG-1", "--json"]);
  expect(complete.code).toBe(0);
  expect(complete.stderr).toBe("");
  expect(JSON.parse(complete.stdout)).toMatchObject({ source: "linear", coverageComplete: true });
  const root = issue(1);
  root.attachments = page([], "more");
  const partial = await invoke(["ENG-1", "--json", "--max-pages", "1"], () =>
    fixtureReader([root]),
  );
  expect(partial.code).toBe(1);
  expect(JSON.parse(partial.stdout).coverageComplete).toBe(false);
});

test("runtime failure is distinct from usage and Markdown states the scope", async () => {
  const result = await invoke(["ENG-1"], () => {
    throw new Error("Missing local credential");
  });
  expect(result).toEqual({ code: 1, stdout: "", stderr: "Missing local credential\n" });
  expect((await invoke(["ENG-1"])).stdout).toContain("Text mentions are not collected");
});
