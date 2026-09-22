import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { GET } from "../src/app/og/[[...slug]]/route";
import { docsSlugs } from "../src/lib/docs-paths";
import { landingTitle } from "../src/lib/landing-content";

const { getPage, renderOgImage } = vi.hoisted(() => ({
  getPage: vi.fn<(...args: unknown[]) => { data: { title?: string } } | undefined>(),
  renderOgImage: vi.fn<(title: string) => Promise<Response>>(),
}));

vi.mock("@/lib/geistdocs/source", () => ({
  geistdocsSource: { source: { getPage } },
}));
vi.mock("@/lib/og-image", () => ({ renderOgImage }));

const pages = docsSlugs.map((slug) => {
  const source = readFileSync(
    new URL(`../content/docs/${slug || "index"}.mdx`, import.meta.url),
    "utf8",
  );
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  const title = frontmatter?.[1]?.match(/^title:\s*(.+)$/m)?.[1];
  return { slug, title };
});

function request(slug?: string[]) {
  return GET(new Request(`https://issue-graph.dev/og${slug?.length ? `/${slug.join("/")}` : ""}`), {
    params: Promise.resolve(slug === undefined ? {} : { slug }),
  });
}

beforeEach(() => {
  getPage.mockReset();
  renderOgImage.mockReset();
  renderOgImage.mockImplementation(async () => new Response("rendered og"));
});

describe("OG route title selection", () => {
  test.each([undefined, []])("renders the canonical landing sentence for slug %j", async (slug) => {
    const response = await request(slug);
    expect(getPage).not.toHaveBeenCalled();
    expect(renderOgImage).toHaveBeenCalledExactlyOnceWith("Find related work\nbefore you start");
    const title = renderOgImage.mock.calls[0]?.[0] ?? "";
    expect(title.replace(/\s+/g, " ").trim()).toBe(landingTitle);
    expect(title.split("\n")).toHaveLength(2);
    expect(response).toBe(await renderOgImage.mock.results[0]?.value);
  });

  test.each(pages)("uses the real frontmatter title for /og/docs/$slug", async ({
    slug,
    title,
  }) => {
    expect(title).toBeTruthy();
    getPage.mockReturnValue({ data: { title } });
    const response = await request(["docs", ...(slug ? [slug] : [])]);
    expect(getPage).toHaveBeenCalledExactlyOnceWith(slug ? [slug] : [], "en");
    expect(renderOgImage).toHaveBeenCalledExactlyOnceWith(title);
    expect(response).toBe(await renderOgImage.mock.results[0]?.value);
  });

  test("uses the documentation fallback only when a resolved page has no title", async () => {
    getPage.mockReturnValue({ data: {} });
    const response = await request(["docs"]);
    expect(getPage).toHaveBeenCalledExactlyOnceWith([], "en");
    expect(renderOgImage).toHaveBeenCalledExactlyOnceWith("Documentation");
    expect(response).toBe(await renderOgImage.mock.results[0]?.value);
  });

  test("returns 404 without rendering for an unknown docs page", async () => {
    const response = await request(["docs", "not-a-real-page"]);
    expect(getPage).toHaveBeenCalledExactlyOnceWith(["not-a-real-page"], "en");
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
    expect(renderOgImage).not.toHaveBeenCalled();
  });

  test("does not resolve or render an unknown top-level route", async () => {
    const response = await request(["not-a-real-page"]);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
    expect(getPage).not.toHaveBeenCalled();
    expect(renderOgImage).not.toHaveBeenCalled();
  });
});
