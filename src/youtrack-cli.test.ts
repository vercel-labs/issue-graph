import { expect, test } from "vitest";
import { BASE, fakeYouTrack } from "../tests/youtrack-fixtures.js";
import type { YouTrackReader } from "./youtrack.js";
import { runYouTrack, type YouTrackIO } from "./youtrack-cli.js";

const issues = {
  "ABC-1": {
    links: [{ type: "Depend" as const, direction: "OUTWARD" as const, targets: ["ABC-2"] }],
  },
  "ABC-2": {},
};

function fixture(bases: Array<string | undefined> = []): (base?: string) => YouTrackReader {
  return (base) => {
    bases.push(base);
    return fakeYouTrack(issues, { baseUrl: base });
  };
}

async function invoke(
  args: string[],
  factory = fixture(),
  extra: Partial<YouTrackIO> = {},
  defaultUrl?: string,
) {
  let stdout = "";
  let stderr = "";
  const code = await runYouTrack(
    args,
    factory,
    {
      stdout: (value) => {
        stdout += value;
      },
      stderr: (value) => {
        stderr += value;
      },
      ...extra,
    },
    defaultUrl,
  );
  return { code, stdout, stderr };
}

test("help and invalid arguments never create a reader", async () => {
  const unused = () => {
    throw new Error("Must not read YouTrack");
  };
  const help = await invoke(["--help"], unused);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("YOUTRACK_TOKEN");
  for (const args of [
    [],
    ["--typo"],
    ["ABC-1", "ABC-2"],
    ["UTF", "--url", BASE],
    ["ABC-1"],
    ["ABC-1", "--url"],
    ["ABC-1", "--url", "--json"],
    ["ABC-1", "--url", "acme.youtrack.cloud"],
    ["ABC-1", "--url", "https://u:p@acme.youtrack.cloud"],
    ["ABC-1", "--url", `${BASE}/?q=1`],
    [`${BASE}/issue/ABC-1`, "--url", "https://other.youtrack.cloud"],
    ["ABC-1", "--url", "http://acme.youtrack.cloud"],
    ["ABC-1", "--url", BASE, "--depth", "9"],
    ["ABC-1", "--url", BASE, "--concurrency", "17"],
    ["ABC-1", "--url", BASE, "--html"],
    ["ABC-1", "--url", BASE, "--clusters", "themes.json"],
    ["ABC-1", "--url", BASE, "--cluster", "--json"],
  ])
    expect((await invoke(args, unused)).code, args.join(" ")).toBe(2);
});

test("the configured base is --url, else YOUTRACK_URL, and an issue URL must match it", async () => {
  const bases: Array<string | undefined> = [];
  const factory = fixture(bases);
  await invoke(
    ["ABC-1", "--url", `${BASE}/`, "--depth", "0"],
    factory,
    {},
    "https://default.example",
  );
  await invoke(["ABC-1", "--depth", "0"], factory, {}, "https://default.example/youtrack/");
  await invoke([`${BASE}/issue/ABC-1`, "--depth", "0"], factory, {}, `${BASE}/`);
  await invoke(
    [`${BASE}/issue/ABC-1/slug`, "--url", BASE, "--depth", "0"],
    factory,
    {},
    "https://default.example",
  );
  expect(bases).toEqual([BASE, "https://default.example/youtrack", BASE, BASE]);
});

test("an issue URL never chooses the host the token is sent to", async () => {
  const unused = () => {
    throw new Error("Must not create a reader");
  };
  const stray = "http://127.0.0.1:47123/issue/ABC-1";
  const mismatch = await invoke([stray, "--depth", "0"], unused, {}, BASE);
  expect(mismatch.code).toBe(2);
  expect(mismatch.stderr).toContain("does not match YOUTRACK_URL");
  const flag = await invoke([stray, "--url", BASE], unused);
  expect(flag.code).toBe(2);
  expect(flag.stderr).toContain("does not match --url");
  const bare = await invoke([`${BASE}/issue/ABC-1`], unused);
  expect(bare.code).toBe(2);
  expect(bare.stderr).toContain("--url or YOUTRACK_URL");
  const none = await invoke(["ABC-1"], unused);
  expect(none.code).toBe(2);
  expect(none.stderr).toContain("YOUTRACK_URL");
  const clear = await invoke(["ABC-1", "--url", "http://acme.youtrack.cloud"], unused);
  expect(clear.code).toBe(2);
  expect(clear.stderr).toContain("https");
});

test("JSON output carries the report and partial coverage exits 1", async () => {
  const result = await invoke(["ABC-1", "--url", BASE, "--json"], fixture());
  expect(result.code).toBe(0);
  const report = JSON.parse(result.stdout);
  expect(report).toMatchObject({
    source: "youtrack",
    authority: "acme.youtrack.cloud",
    readSource: "fixture",
  });
  const partial = await invoke(["ABC-1", "--url", BASE, "--json"], (base) =>
    fakeYouTrack({ "ABC-1": issues["ABC-1"] }, { baseUrl: base }),
  );
  expect(partial.code).toBe(1);
  expect(JSON.parse(partial.stdout).coverage.failed).toEqual([
    "youtrack:acme.youtrack.cloud:ABC-2",
  ]);
});

test("Markdown is the default and depth 0 reads only the seed", async () => {
  const result = await invoke([`${BASE}/issue/ABC-1`, "--url", BASE, "--depth", "0"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("# YouTrack graph · acme.youtrack.cloud");
  expect(result.stdout).toContain("Depth boundary: 1 nodes not expanded.");
});

test("a failed seed read prints the reason and exits 1", async () => {
  const result = await invoke(["ABC-9", "--url", BASE]);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("NOT_FOUND");
});

test("--html and --open hand the report to the dashboard and save unless --no-save", async () => {
  const calls: Array<{ path?: string; open: boolean; save: boolean }> = [];
  const dashboard: YouTrackIO["dashboard"] = async (_report, options) => {
    calls.push(options);
  };
  expect(
    (await invoke(["ABC-1", "--url", BASE, "--depth", "0"], fixture(), { dashboard })).code,
  ).toBe(0);
  expect(calls).toEqual([]);
  await invoke(["ABC-1", "--url", BASE, "--depth", "0", "--html", "out.html"], fixture(), {
    dashboard,
  });
  await invoke(["ABC-1", "--url", BASE, "--depth", "0", "--open", "--no-save"], fixture(), {
    dashboard,
  });
  expect(calls).toEqual([
    { path: "out.html", open: false, save: true, clusters: undefined },
    { path: undefined, open: true, save: false, clusters: undefined },
  ]);
});

test("--cluster prints a clustering task after the report", async () => {
  const result = await invoke(["ABC-1", "--url", BASE, "--depth", "0", "--cluster"]);
  expect(result.stdout).toContain("Propose thematic clusters for acme.youtrack.cloud / ABC.");
});
