import { describe, expect, test } from "vitest";
import { fixtureReader, item, key } from "../tests/plane-fixtures.js";
import { runPlane } from "./plane-cli.js";

function io(defaultWorkspace?: string) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: (value: string) => void out.push(value),
      stderr: (value: string) => void err.push(value),
      defaultWorkspace,
    },
  };
}

describe("issue-graph plane", () => {
  test("prints help without building a reader", async () => {
    const run = io();
    const code = await runPlane(
      ["--help"],
      () => {
        throw new Error("no reader");
      },
      run.io,
    );
    expect(code).toBe(0);
    expect(run.out.join("")).toContain("PLANE_API_KEY");
  });

  test.each([
    [["ENG-1"], "Specify --workspace"],
    [["ENG-1", "--project", "ENG"], "Choose a work item"],
    [["https://app.plane.so/a/browse/ENG-1/", "--workspace", "b"], "disagree"],
    [["--project", "bad id!"], "--project requires"],
    [["ENG-1", "--depth", "9"], "--depth must be"],
    [["ENG-1", "--cluster", "--json"], "--cluster cannot"],
    [["nope"], "Expected a Plane"],
  ])("rejects %j with exit 2", async (argv, message) => {
    const run = io();
    const code = await runPlane(argv, () => fixtureReader({ items: [] }), run.io);
    expect(code).toBe(2);
    expect(run.err.join("")).toContain(message);
  });

  test("takes the workspace from the URL and prints the graph", async () => {
    const run = io();
    let requested: string | undefined;
    const code = await runPlane(
      ["https://app.plane.so/fixture/browse/ENG-1/", "--json"],
      (workspace) => {
        requested = workspace;
        return fixtureReader({ items: [item(1)] });
      },
      run.io,
    );
    expect(requested).toBe("fixture");
    expect(code).toBe(0);
    const report = JSON.parse(run.out.join(""));
    expect(report.source).toBe("plane");
    expect(report.seeds).toEqual([key(1)]);
    expect(report.readSource).toBe("fixture");
  });

  test("uses the default workspace and hands the report to the dashboard", async () => {
    const run = io("fixture");
    const opened: unknown[] = [];
    const code = await runPlane(
      ["--project", "ENG", "--open"],
      () => fixtureReader({ items: [item(1)] }),
      {
        ...run.io,
        dashboard: async (report, options) => void opened.push([report.source, options.open]),
      },
    );
    expect(code).toBe(0);
    expect(opened).toEqual([["plane", true]]);
    expect(run.out.join("")).toContain("# Plane graph · fixture / Engine");
  });
});
