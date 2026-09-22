import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { docsSlugs, markdownPath } from "../src/lib/docs-paths";
import { canonicalUrl, repositoryUrl } from "../src/lib/site";
import { testUrl } from "./test-url";

const origin = testUrl();
const preview = process.env.DOCS_TEST_PREVIEW === "1";
const browser = {
  accept: "text/html",
  "user-agent": "Mozilla/5.0",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
};
let checks = 0;

async function request(path: string, headers: Record<string, string> = browser) {
  const response = await fetch(new URL(path, origin), { headers, redirect: "manual" });
  const body = await response.text();
  if (preview) assert.match(response.headers.get("x-robots-tag") ?? "", /noindex/, path);
  return { response, body };
}

function isolated(response: Response) {
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  const vary = new Set(
    (response.headers.get("vary") ?? "")
      .toLowerCase()
      .split(",")
      .map((header) => header.trim()),
  );
  for (const header of ["accept", "user-agent", "rsc", "next-router-prefetch"])
    assert.ok(vary.has(header), `Missing Vary: ${header} (${response.url})`);
}

function htmlAttribute(html: string, tag: string, key: string, value: string, attribute: string) {
  const element = [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, "g"))].find(([item]) =>
    item.includes(`${key}="${value}"`),
  )?.[0];
  return element?.match(new RegExp(`${attribute}="([^"]*)"`))?.[1];
}

const titles = new Set<string>();
for (const path of ["/", ...docsSlugs.map((slug) => (slug ? `/docs/${slug}` : "/docs"))]) {
  const html = await request(path);
  assert.equal(html.response.status, 200, path);
  assert.match(html.response.headers.get("content-type") ?? "", /text\/html/, path);
  assert.equal((html.body.match(/<h1(?:\s|>)/g) ?? []).length, 1, `One H1: ${path}`);
  assert.equal((html.body.match(/<main(?:\s|>)/g) ?? []).length, 1, `One main: ${path}`);
  assert.ok(html.body.includes('id="main-content"'), `Skip target: ${path}`);
  const title = html.body.match(/<title>([^<]+)<\/title>/)?.[1];
  assert.ok(title, `Title: ${path}`);
  assert.ok(!titles.has(title), `Unique title: ${path}`);
  titles.add(title);
  const canonical = htmlAttribute(html.body, "link", "rel", "canonical", "href");
  const ogUrl = htmlAttribute(html.body, "meta", "property", "og:url", "content");
  assert.ok(canonical, `Canonical URL: ${path}`);
  assert.ok(ogUrl, `OG URL: ${path}`);
  assert.equal(new URL(canonical).href, new URL(canonicalUrl(path)).href, `Canonical URL: ${path}`);
  assert.equal(new URL(ogUrl).href, new URL(canonicalUrl(path)).href, `OG URL: ${path}`);
  const image = htmlAttribute(html.body, "meta", "property", "og:image", "content");
  assert.ok(image, `OG image metadata: ${path}`);
  assert.ok(image.startsWith(canonicalUrl("/og")), `OG: ${path}`);
  const imageResponse = await fetch(new URL(new URL(image).pathname, origin), {
    headers: { accept: "image/*" },
    redirect: "manual",
  });
  assert.equal(imageResponse.status, 200, `OG image: ${path}`);
  assert.match(imageResponse.headers.get("content-type") ?? "", /^image\//);
  assert.ok((await imageResponse.arrayBuffer()).byteLength > 0);
  assert.ok(
    htmlAttribute(html.body, "meta", "name", "description", "content"),
    `Description: ${path}`,
  );
  if (preview)
    assert.match(htmlAttribute(html.body, "meta", "name", "robots", "content") ?? "", /noindex/);
  const header = html.body.match(/<header\b[^>]*>[\s\S]*?<\/header>/)?.[0];
  assert.ok(header, `Navbar: ${path}`);
  assert.equal(
    htmlAttribute(header, "a", "aria-label", "Vercel Labs", "href"),
    "https://vercel.com/labs",
    `Native Labs branding: ${path}`,
  );
  assert.ok(!header.includes('aria-label="Vercel Open Source"'), `No OSS brand: ${path}`);
  assert.equal(
    htmlAttribute(header, "a", "aria-label", "GitHub repository", "href"),
    repositoryUrl,
    `Navbar GitHub destination: ${path}`,
  );
  assert.equal(
    htmlAttribute(header, "a", "aria-label", "GitHub repository", "target"),
    "_blank",
    `Navbar GitHub opens separately: ${path}`,
  );
  assert.match(
    htmlAttribute(header, "a", "aria-label", "GitHub repository", "rel") ?? "",
    /\bnoopener\b/,
    `Navbar GitHub opener isolation: ${path}`,
  );
  assert.ok(
    !html.body.includes(`href="${repositoryUrl}/edit/`),
    `Source editing remains disabled: ${path}`,
  );
  isolated(html.response);

  const markdown = await request(path, {
    accept: "text/markdown",
    "user-agent": "docs-route-test",
  });
  const sibling = await request(markdownPath(path));
  for (const result of [markdown, sibling]) {
    assert.equal(result.response.status, 200, `Markdown: ${path}`);
    assert.match(result.response.headers.get("content-type") ?? "", /text\/markdown/);
    assert.equal(result.response.headers.get("link"), `<${canonicalUrl(path)}>; rel="canonical"`);
    assert.ok(
      result.body.includes(`canonical_url: ${JSON.stringify(canonicalUrl(path))}`) ||
        result.body.includes(`canonical_url: ${canonicalUrl(path)}`),
    );
    assert.equal((result.body.match(/^# /gm) ?? []).length, 1, `Markdown H1: ${path}`);
    assert.ok(!result.body.includes("<!DOCTYPE html>"));
    isolated(result.response);
  }
  assert.equal(markdown.body, sibling.body, `Matching representations: ${path}`);
  const after = await request(path);
  assert.match(after.response.headers.get("content-type") ?? "", /text\/html/);
  checks += 5;
}

for (const path of [
  "/docs/not-a-real-page",
  "/docs/not-a-real-page.md",
  "/api/docs-md/not-a-real-page",
  "/docs/%252e%252e/secret.md",
  "/docs/graph%2Fsecurity.md",
]) {
  for (const headers of [browser, { accept: "text/markdown", "user-agent": "ClaudeBot/1.0" }]) {
    const result = await request(path, headers);
    assert.equal(result.response.status, 404, `True 404: ${path}`);
    if (result.response.headers.get("content-type")?.includes("text/markdown")) {
      assert.ok(
        !result.response.headers.has("link"),
        `Missing pages must not declare a canonical: ${path}`,
      );
      assert.match(result.body, /not found/i);
    }
    checks++;
  }
}

for (const agent of ["Slackbot-LinkExpanding 1.0", "Discordbot/2.0", "Twitterbot/1.0"]) {
  const result = await request("/docs/graph", { accept: "*/*", "user-agent": agent });
  assert.match(result.response.headers.get("content-type") ?? "", /text\/html/, agent);
  checks++;
}
const agent = await request("/docs/graph", { accept: "*/*", "user-agent": "ClaudeBot/1.0" });
assert.match(agent.response.headers.get("content-type") ?? "", /text\/markdown/);
const htmlPreference = await request("/docs/graph", {
  accept: "text/html, text/markdown;q=0.2",
  "user-agent": "ClaudeBot/1.0",
});
assert.match(htmlPreference.response.headers.get("content-type") ?? "", /text\/html/);

const flightHeaders = {
  accept: "text/markdown",
  rsc: "1",
  "user-agent": "ClaudeBot/1.0",
};
let flight = await request("/docs/graph", flightHeaders);
if (flight.response.status === 307) {
  const location = flight.response.headers.get("location");
  assert.ok(location, "RSC cache-key redirect location");
  const destination = new URL(location, origin);
  assert.equal(destination.origin, origin.origin, "Same-origin RSC redirect");
  assert.equal(destination.pathname, "/docs/graph", "Same-page RSC redirect");
  assert.ok(destination.searchParams.has("_rsc"), "RSC redirect supplies its cache key");
  assert.equal(destination.hash, "");
  isolated(flight.response);
  flight = await request(`${destination.pathname}${destination.search}`, flightHeaders);
  checks++;
}
assert.equal(flight.response.status, 200);
assert.match(flight.response.headers.get("content-type") ?? "", /text\/x-component/);
isolated(flight.response);
for (const signal of ["purpose", "sec-purpose"]) {
  const prefetch = await request("/docs/graph", {
    accept: "text/markdown",
    [signal]: "prefetch",
    "user-agent": "ClaudeBot/1.0",
  });
  assert.match(prefetch.response.headers.get("content-type") ?? "", /text\/html/);
  isolated(prefetch.response);
}
const flightQuery = await request("/docs/graph?_rsc=route-test", {
  accept: "text/markdown",
  "user-agent": "ClaudeBot/1.0",
});
assert.match(flightQuery.response.headers.get("content-type") ?? "", /text\/html/);
isolated(flightQuery.response);
checks += 6;

const search = await request("/api/search?query=graph&locale=en", { accept: "application/json" });
assert.equal(search.response.status, 200);
assert.match(search.response.headers.get("content-type") ?? "", /application\/json/);
const results = JSON.parse(search.body);
assert.ok(Array.isArray(results) && results.length > 0, "Native search results");
assert.ok(results.some((result: { url?: string }) => result.url?.startsWith("/docs")));
const llms = await request("/llms.txt");
assert.equal(llms.response.status, 200);
assert.match(llms.body, /npm install -g issue-graph@latest/);
assert.match(llms.body, /npx issue-graph@latest --help/);
assert.doesNotMatch(llms.body, /release is pending/i);
for (const slug of docsSlugs)
  assert.ok(llms.body.includes(canonicalUrl(slug ? `/docs/${slug}` : "/docs")));
const sitemap = await request("/sitemap.xml");
assert.equal(sitemap.response.status, 200);
if (!preview)
  for (const slug of docsSlugs)
    assert.ok(sitemap.body.includes(canonicalUrl(slug ? `/docs/${slug}` : "/docs")));
const sitemapMd = await request("/sitemap.md");
assert.equal(sitemapMd.response.status, 200);
assert.match(sitemapMd.response.headers.get("content-type") ?? "", /text\/markdown/);
const robots = await request("/robots.txt");
assert.equal(robots.response.status, 200);
assert.ok(
  preview
    ? /Disallow: \/\s*$/.test(robots.body.trim())
    : robots.body.includes(canonicalUrl("/sitemap.xml")),
);
const skill = await request("/skill.md");
assert.equal(skill.response.status, 200);
assert.equal(
  skill.body,
  await readFile(new URL("../../../skills/issue-graph/SKILL.md", import.meta.url), "utf8"),
);
assert.match(skill.response.headers.get("content-type") ?? "", /text\/markdown/);
const docsIndex = await request("/docs/index.md");
assert.equal(docsIndex.response.status, 200);
assert.equal(docsIndex.response.headers.get("link"), `<${canonicalUrl("/docs")}>; rel="canonical"`);
checks += 7;
const skillIndex = await request("/.well-known/skills/index.json", { accept: "application/json" });
assert.equal(skillIndex.response.status, 200);
assert.match(skillIndex.response.headers.get("content-type") ?? "", /application\/json/);
const skillListing = JSON.parse(skillIndex.body);
assert.deepEqual(
  skillListing.skills.map((item: { name: string }) => item.name),
  ["issue-graph"],
);
assert.deepEqual(skillListing.skills[0].files, ["SKILL.md"]);
const publicSkill = await request("/.well-known/skills/issue-graph/SKILL.md", {
  accept: "text/markdown",
});
assert.equal(publicSkill.response.status, 200);
assert.match(publicSkill.body, /^---\nname: issue-graph\n/);
assert.equal(publicSkill.body, skill.body);
assert.match(publicSkill.body, /issue-graph skills get core/);
checks += 2;
console.log(
  `PASS: ${checks} route checks against ${origin.origin}${preview ? " (preview noindex)" : ""}`,
);
