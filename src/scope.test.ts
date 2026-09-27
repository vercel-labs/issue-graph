import { describe, expect, test } from "vitest";
import { inferRepo, parseScope, repoFromRemote } from "./scope.js";

describe("parseScope", () => {
  test("reads repositories, with or without a provider", () => {
    expect(parseScope("vercel-labs/emulate")).toEqual({
      kind: "repo",
      provider: "github",
      repo: "vercel-labs/emulate",
    });
    expect(parseScope("github:vercel-labs/emulate")).toEqual({
      kind: "repo",
      provider: "github",
      repo: "vercel-labs/emulate",
    });
  });

  test("reads items as numbers, refs, and URLs", () => {
    expect(parseScope("123")).toEqual({
      kind: "item",
      provider: "github",
      repo: undefined,
      number: 123,
    });
    expect(parseScope("#123")).toMatchObject({ kind: "item", number: 123 });
    expect(parseScope("o/r#7")).toMatchObject({ kind: "item", repo: "o/r", number: 7 });
    expect(parseScope("https://github.com/o/r/pull/9")).toMatchObject({
      kind: "item",
      repo: "o/r",
      number: 9,
    });
  });

  test("names unsupported providers instead of guessing", () => {
    expect(() => parseScope("linear:ENG")).toThrow(/provider 'linear' is not supported yet/);
    expect(() => parseScope("not a scope")).toThrow(/cannot read/);
  });
});

test("a repository whose name ends in a digit stays a repository", () => {
  expect(parseScope("vercel-labs/v0")).toEqual({
    kind: "repo",
    provider: "github",
    repo: "vercel-labs/v0",
  });
  expect(parseScope("acme/web2")).toMatchObject({ kind: "repo", repo: "acme/web2" });
  expect(parseScope("github:acme/web2")).toMatchObject({ kind: "repo", repo: "acme/web2" });
  expect(parseScope("acme/web2#5")).toMatchObject({ kind: "item", repo: "acme/web2", number: 5 });
});

describe("inferRepo", () => {
  test("reads https and ssh remotes, preferring origin", () => {
    expect(repoFromRemote("git@github.com:vercel-labs/emulate.git")).toBe("vercel-labs/emulate");
    expect(repoFromRemote("https://github.com/vercel-labs/emulate")).toBe("vercel-labs/emulate");
    const git = (args: string[]) =>
      args[0] === "remote" && args.length === 1 ? "labs\norigin\n" : "git@github.com:o/r.git\n";
    expect(inferRepo(git)).toBe("o/r");
  });

  test("is undefined outside a GitHub repository", () => {
    expect(repoFromRemote("https://gitlab.com/o/r.git")).toBeUndefined();
    expect(
      inferRepo(() => {
        throw new Error("not a repo");
      }),
    ).toBeUndefined();
  });
});
