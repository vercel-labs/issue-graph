import { readFile } from "node:fs/promises";
import { ImageResponse } from "next/og";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { landingTitle } from "../src/lib/landing-content";
import { OgImage, renderOgImage } from "../src/lib/og-image";
import { siteName } from "../src/lib/site";

function styles(value: string) {
  return Object.fromEntries(value.split(";").map((declaration) => declaration.split(":")));
}

describe("OG image composition", () => {
  test("uses a black canvas with only the white Vercel mark, gray slash and pixel brand", () => {
    const markup = renderToStaticMarkup(createElement(OgImage, { title: "Overview" }));
    const divs = [...markup.matchAll(/<div style="([^"]+)">/g)];
    expect(divs).toHaveLength(3);
    expect(styles(divs[0]?.[1] ?? "")).toMatchObject({
      width: "100%",
      height: "100%",
      display: "flex",
      "flex-direction": "column",
      "background-color": "#000000",
      padding: "60px 80px",
    });
    expect(styles(divs[1]?.[1] ?? "")).toMatchObject({
      display: "flex",
      "align-items": "center",
      gap: "16px",
    });
    const header = markup.match(/<div style="[^"]+">(<svg[\s\S]*?)<\/div>/)?.[1] ?? "";
    expect(header).toContain(
      '<svg width="36" height="36" viewBox="0 0 16 16" fill="#ffffff" role="img" aria-label="Vercel">',
    );
    const mark = header.match(/<svg\b[^>]*>([\s\S]*?)<\/svg>/)?.[1] ?? "";
    expect(mark).not.toMatch(/<(?:title|desc|text)\b/);
    expect(mark.replace(/<[^>]*>/g, "").trim()).toBe("");
    expect(header).toContain('d="M8 1L16 15H0L8 1Z"');
    const labels = [...header.matchAll(/<span style="([^"]+)">([^<]+)<\/span>/g)];
    expect(labels.map((label) => label[2])).toEqual(["/", siteName]);
    expect(styles(labels[0]?.[1] ?? "")).toMatchObject({
      "font-family": "Geist",
      "font-size": "36px",
      "font-weight": "400",
      color: "#666666",
    });
    expect(styles(labels[1]?.[1] ?? "")).toMatchObject({
      "font-family": "GeistPixelSquare",
      "font-size": "36px",
      "font-weight": "400",
      color: "#ffffff",
    });
    expect(markup.match(/<svg\b/g)).toHaveLength(1);
    expect(markup.match(/<path\b/g)).toHaveLength(1);
    expect(markup.match(/<span\b/g)).toHaveLength(3);
    expect([...markup.matchAll(/>([^<>]+)</g)].map((match) => match[1])).toEqual([
      "/",
      siteName,
      "Overview",
    ]);
    expect(markup).not.toMatch(
      /<footer\b|<img\b|<circle\b|<line\b|<polyline\b|linear-gradient|#0070f3|#3291ff|blue/i,
    );
    expect(
      new Set(
        [...markup.matchAll(/(?:background-color|color):([^;"<]+)/g)].map((match) => match[1]),
      ),
    ).toEqual(new Set(["#000000", "#ffffff", "#666666"]));
  });

  test.each([
    landingTitle.replace(" before ", "\nbefore "),
    "Command reference",
  ])("centers each title line in the remaining body: %s", (title) => {
    const markup = renderToStaticMarkup(createElement(OgImage, { title }));
    const body = markup.match(/<\/div><div style="([^"]+)">([\s\S]*?)<\/div><\/div>$/);
    expect(body).not.toBeNull();
    expect(styles(body?.[1] ?? "")).toMatchObject({
      display: "flex",
      flex: "1",
      "flex-direction": "column",
      "align-items": "center",
      "justify-content": "center",
    });
    const lines = [...(body?.[2] ?? "").matchAll(/<span style="([^"]+)">([^<]+)<\/span>/g)];
    expect(lines.map((line) => line[2])).toEqual(title.split("\n"));
    expect(lines.map((line) => line[2]).join(" ")).toBe(title.replace(/\s+/g, " "));
    for (const line of lines) {
      expect(styles(line[1] ?? "")).toMatchObject({
        "font-family": "Geist",
        "font-size": "72px",
        "font-weight": "400",
        color: "#ffffff",
        "letter-spacing": "-0.02em",
        "text-align": "center",
        "line-height": "1.2",
        "max-width": "100%",
      });
    }
  });
});

describe("OG image runtime", () => {
  test.each([
    "home",
    "index",
    "graph",
  ])("renders a real 1200x630 PNG with local fonts for %s", async (page) => {
    let title = landingTitle.replace(" before ", "\nbefore ");
    if (page !== "home") {
      const source = await readFile(
        new URL(`../content/docs/${page}.mdx`, import.meta.url),
        "utf8",
      );
      const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
      const docsTitle = frontmatter?.[1]?.match(/^title:\s*(.+)$/m)?.[1];
      expect(docsTitle).toBeTruthy();
      title = docsTitle ?? "";
    }
    const response = await renderOgImage(title);
    expect(response).toBeInstanceOf(ImageResponse);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    const png = Buffer.from(await response.arrayBuffer());
    expect(png.byteLength).toBeGreaterThan(33);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(png.readUInt32BE(8)).toBe(13);
    expect(png.toString("ascii", 12, 16)).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
    expect(png.subarray(-12)).toEqual(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]));
  }, 15_000);

  test("ships the local TrueType fonts with their license and provenance", async () => {
    for (const name of ["Geist-Regular.ttf", "GeistPixel-Square.ttf"]) {
      const font = await readFile(new URL(`../public/og-fonts/${name}`, import.meta.url));
      expect(font.readUInt32BE(0)).toBe(0x00010000);
    }
    const license = await readFile(new URL("../public/og-fonts/OFL.txt", import.meta.url), "utf8");
    expect(license).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/i);
    const readme = await readFile(new URL("../public/og-fonts/README.md", import.meta.url), "utf8");
    expect(readme).toContain("Geist Regular");
    expect(readme).toContain("Geist Pixel Square");
    expect(readme).toContain("OFL.txt");
  });
});
