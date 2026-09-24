import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import robots from "../src/app/robots";
import {
  docsPath,
  docsSlugs,
  isFlightRequest,
  isSafePathSegments,
  markdownPath,
} from "../src/lib/docs-paths";
import { applyDocsResponseHeaders } from "../src/lib/docs-response-headers";
import { pageMetadata } from "../src/lib/page-metadata";
import { canonicalUrl, isPreview, siteName, siteUrl } from "../src/lib/site";
import { textResponse } from "../src/lib/text-response";

test("regenerates MDX after Next typegen before running TypeScript", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(pkg.scripts.typecheck.split("&&").map((command: string) => command.trim())).toEqual([
    "next typegen",
    "fumadocs-mdx",
    "tsc --noEmit",
  ]);
});

describe("route boundaries", () => {
  test("preserves a separate landing page and docs root", () => {
    expect(docsPath()).toBe("/docs");
    expect(docsPath(["graph"])).toBe("/docs/graph");
    expect(markdownPath("/")).toBe("/index.md");
    expect(markdownPath("/docs")).toBe("/docs.md");
    expect(markdownPath("/docs/graph")).toBe("/docs/graph.md");
  });

  test("rejects traversal, encoded paths, separators and control bytes", () => {
    for (const segment of [
      "",
      ".",
      "..",
      "../security",
      "graph/status",
      "graph\\status",
      "%2e%2e",
      "%252e%252e",
      "graph\u0000",
      "graph.mdx",
      "Graph",
    ]) {
      expect(isSafePathSegments([segment])).toBe(false);
    }
    expect(isSafePathSegments([])).toBe(true);
    expect(isSafePathSegments(["get-started"])).toBe(true);
    expect(isSafePathSegments(Array(17).fill("graph"))).toBe(false);
  });

  test("keeps every RSC and prefetch signal out of markdown negotiation", () => {
    for (const name of [
      "rsc",
      "next-router-state-tree",
      "next-router-prefetch",
      "next-router-segment-prefetch",
    ]) {
      expect(isFlightRequest(new Headers({ [name]: "1" }))).toBe(true);
    }
    expect(isFlightRequest(new Headers({ purpose: "prefetch" }))).toBe(true);
    expect(isFlightRequest(new Headers({ "sec-purpose": "prefetch;prerender" }))).toBe(true);
    expect(isFlightRequest(new Headers({ accept: "text/html" }))).toBe(false);
  });
});

describe("metadata and response isolation", () => {
  test("previews disallow crawlers while production advertises its sitemap", () => {
    expect(robots()).toEqual(
      isPreview
        ? { rules: { userAgent: "*", disallow: "/" } }
        : {
            rules: { userAgent: "*", allow: "/", disallow: "/api/" },
            sitemap: canonicalUrl("/sitemap.xml"),
          },
    );
  });

  test("gives every docs page unique, consistent canonical, OG and Twitter metadata", () => {
    const titles = new Set<string>();
    const descriptions = new Set<string>();
    const images = new Set<string>();
    for (const slug of docsSlugs) {
      const pathname = slug ? `/docs/${slug}` : "/docs";
      const source = readFileSync(
        new URL(`../content/docs/${slug || "index"}.mdx`, import.meta.url),
        "utf8",
      );
      const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
      const title = frontmatter?.[1]?.match(/^title:\s*(.+)$/m)?.[1] ?? "";
      const description = frontmatter?.[1]?.match(/^description:\s*(.+)$/m)?.[1] ?? "";
      expect(title).not.toBe("");
      expect(description).not.toBe("");
      const fullTitle = `${siteName} | ${title}`;
      const image = `${siteUrl}/og${pathname}`;
      const metadata = pageMetadata(pathname, title, description);
      expect(metadata.title).toEqual({ absolute: fullTitle });
      expect(metadata.description).toBe(description);
      expect(metadata.alternates?.canonical).toBe(canonicalUrl(pathname));
      expect(metadata.alternates?.types?.["text/markdown"]).toBe(canonicalUrl(`${pathname}.md`));
      expect(metadata.openGraph).toMatchObject({
        url: canonicalUrl(pathname),
        title: fullTitle,
        description,
        images: [{ url: image, width: 1200, height: 630, alt: title }],
      });
      expect(metadata.twitter).toEqual({
        card: "summary_large_image",
        title: fullTitle,
        description,
        images: [image],
      });
      expect(metadata.robots).toEqual({ index: !isPreview, follow: !isPreview });
      expect(titles.has(fullTitle)).toBe(false);
      expect(descriptions.has(description)).toBe(false);
      expect(images.has(image)).toBe(false);
      titles.add(fullTitle);
      descriptions.add(description);
      images.add(image);
    }
  });

  test("merges Vary without dropping Next.js headers or duplicating tokens", () => {
    const headers = new Headers({
      Vary: "Accept-Encoding, RSC, accept",
      "Cache-Control": "public, max-age=600",
    });
    applyDocsResponseHeaders(headers);
    applyDocsResponseHeaders(headers);
    const vary = headers.get("Vary")?.toLowerCase().split(/,\s*/) ?? [];
    expect(new Set(vary).size).toBe(vary.length);
    for (const value of [
      "accept-encoding",
      "accept",
      "rsc",
      "next-router-state-tree",
      "next-router-prefetch",
      "user-agent",
      "signature-agent",
    ])
      expect(vary).toContain(value);
    expect(headers.get("Cache-Control")).toBe("private, no-store");
    expect(headers.get("CDN-Cache-Control")).toBe("no-store");
    expect(headers.get("Vercel-CDN-Cache-Control")).toBe("no-store");
  });

  test("canonical links are only emitted for resolved pages", async () => {
    const found = textResponse("# Graph\n", "/docs/graph");
    expect(found.status).toBe(200);
    expect(found.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(found.headers.get("Link")).toBe(`<${siteUrl}/docs/graph>; rel="canonical"`);
    expect(await found.text()).toBe("# Graph\n");
    const missing = textResponse("# Page not found\n", null, "text/markdown; charset=utf-8", 404);
    expect(missing.status).toBe(404);
    expect(missing.headers.has("Link")).toBe(false);
    expect(missing.headers.get("X-Robots-Tag")).toContain("noindex");
  });
});
