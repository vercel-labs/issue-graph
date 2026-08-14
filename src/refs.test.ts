import { describe, expect, test } from "bun:test";
import { extractClosingRefs, extractRefs, isNoiseUrl, parseSeed } from "./refs.js";

describe("parseSeed", () => {
  test("parses a pull URL", () => {
    expect(parseSeed("https://github.com/vercel-labs/portless/pull/352")).toEqual({
      owner: "vercel-labs",
      repo: "portless",
      number: 352,
    });
  });

  test("parses an issue URL", () => {
    expect(parseSeed("https://github.com/o/r/issues/7")).toEqual({
      owner: "o",
      repo: "r",
      number: 7,
    });
  });

  test("parses a bare number with --repo", () => {
    expect(parseSeed("352", "vercel-labs/portless")).toEqual({
      owner: "vercel-labs",
      repo: "portless",
      number: 352,
    });
  });

  test("strips a leading #", () => {
    expect(parseSeed("#42", "o/r").number).toBe(42);
  });

  test("throws on a bare number without --repo", () => {
    expect(() => parseSeed("352")).toThrow(/--repo/);
  });

  test("throws on garbage", () => {
    expect(() => parseSeed("not-a-seed", "o/r")).toThrow(/Cannot parse/);
  });
});

describe("isNoiseUrl", () => {
  test.each([
    "http://127.0.0.1:4000",
    "https://myapp.localhost",
    "https://machine.tailnet.ts.net:8443",
    "https://example.com/x",
    "https://admin.example.com",
    "https://a.com",
    "https://httpbin.org/get",
    "https://vercel.com/x/status/ready.svg",
  ])("treats %s as noise", (u) => {
    expect(isNoiseUrl(u)).toBe(true);
  });

  test.each([
    "https://nodejs.org/api/dns.html",
    "https://cursor.com",
    "https://tailscale.com/kb/funnel",
    "https://project.vercel.app",
    "https://vercel.com/docs",
  ])("keeps %s", (u) => {
    expect(isNoiseUrl(u)).toBe(false);
  });
});

describe("extractRefs", () => {
  test("finds local, cross-repo, and URL refs", () => {
    const { refs } = extractRefs(
      "fixes #12, see owner/repo#34 and https://github.com/a/b/pull/56",
      "me",
      "proj",
    );
    expect(refs).toContain("me/proj#12");
    expect(refs).toContain("owner/repo#34");
    expect(refs).toContain("a/b#56");
  });

  test("collects traceable external links, drops noise", () => {
    const { external } = extractRefs(
      "docs https://nodejs.org/x and http://127.0.0.1:3000",
      "o",
      "r",
    );
    expect(external).toEqual(["https://nodejs.org/x"]);
  });

  test("empty text yields nothing", () => {
    expect(extractRefs("", "o", "r")).toEqual({ refs: [], external: [] });
  });
});

describe("extractClosingRefs", () => {
  test("captures local, cross-repo, and URL closing keywords", () => {
    const refs = extractClosingRefs(
      "This fixes #346, closes owner/repo#12, and resolves https://github.com/a/b/issues/9",
      "me",
      "proj",
    );
    expect(refs).toContain("me/proj#346");
    expect(refs).toContain("owner/repo#12");
    expect(refs).toContain("a/b#9");
  });

  test("ignores a bare mention with no closing keyword", () => {
    expect(extractClosingRefs("see #346 and related work in #12", "me", "proj")).toEqual([]);
  });

  test("matches keyword variants (fix/fixed/close/resolved)", () => {
    expect(extractClosingRefs("fixed #1", "o", "r")).toEqual(["o/r#1"]);
    expect(extractClosingRefs("Closes: #2", "o", "r")).toEqual(["o/r#2"]);
    expect(extractClosingRefs("resolved #3", "o", "r")).toEqual(["o/r#3"]);
  });

  test("empty text yields nothing", () => {
    expect(extractClosingRefs("", "o", "r")).toEqual([]);
  });
});
