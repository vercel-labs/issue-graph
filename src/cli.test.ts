import { describe, expect, test } from "bun:test";
import { parseArgs, UsageError } from "./cli.js";

describe("parseArgs", () => {
  test("parses a seed with repo and depth", () => {
    const a = parseArgs(["352", "--repo", "o/r", "--depth", "3"]);
    expect(a.seed).toBe("352");
    expect(a.repo).toBe("o/r");
    expect(a.depth).toBe(3);
  });

  test("boolean flags are not swallowed as the seed", () => {
    const a = parseArgs(["352", "--repo", "o/r", "--no-snapshot", "--cluster"]);
    expect(a.seed).toBe("352");
    expect(a.noSnapshot).toBe(true);
    expect(a.cluster).toBe(true);
  });

  test("--cluster-run implies --cluster and captures the agent", () => {
    const a = parseArgs(["1", "--repo", "o/r", "--cluster-run", "claude"]);
    expect(a.cluster).toBe(true);
    expect(a.clusterRun).toBe("claude");
  });

  test("--seeds and --label are captured", () => {
    expect(parseArgs(["--seeds", "1,2,3", "--repo", "o/r"]).seedsCsv).toBe("1,2,3");
    expect(parseArgs(["--label", "bug", "--repo", "o/r"]).label).toBe("bug");
  });

  test("parses reconcile and its output format", () => {
    const a = parseArgs(["reconcile", "--repo", "o/r", "--format", "json"]);
    expect(a.command).toBe("reconcile");
    expect(a.repo).toBe("o/r");
    expect(a.seed).toBe("");
    expect(a.format).toBe("json");
  });

  test("parses schema without treating it as a seed", () => {
    const a = parseArgs(["schema"]);
    expect(a.command).toBe("schema");
    expect(a.seed).toBe("");
  });

  test("rejects an unknown reconcile format", () => {
    expect(() => parseArgs(["reconcile", "--format", "xml"])).toThrow(UsageError);
  });

  // `--help` used to fall through to the seed and die in parseSeed with
  // "Cannot parse seed: --help", which is a poor first impression.
  test("--help and -h ask for usage instead of becoming the seed", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["--help"]).seed).toBe("");
  });

  test("an unknown flag is an error, not a seed", () => {
    expect(() => parseArgs(["--hlep"])).toThrow(UsageError);
    expect(() => parseArgs(["352", "--repo", "o/r", "--depht", "2"])).toThrow(UsageError);
  });
});
