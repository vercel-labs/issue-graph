import { readdir, readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { docsSlugs } from "../src/lib/docs-paths";

const contentRoot = new URL("../content/docs/", import.meta.url);
const appRoot = new URL("../", import.meta.url);
const read = (path: string) => readFile(new URL(path, appRoot), "utf8");

function withoutCodeFences(body: string): string {
  return body.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, "");
}

describe("documentation content contract", () => {
  test("matches the navigation inventory and has one runtime-owned title", async () => {
    const files = (await readdir(contentRoot)).filter((name) => name.endsWith(".mdx")).sort();
    expect(files).toEqual(docsSlugs.map((slug) => `${slug || "index"}.mdx`).sort());
    const meta = JSON.parse(await read("content/docs/meta.json"));
    expect(meta.pages).toEqual(docsSlugs.map((slug) => slug || "index"));
    const titles = new Set<string>();
    const descriptions = new Set<string>();
    const pages = new Set<string>([
      "/",
      "/skill.md",
      "/llms.txt",
      "/sitemap.md",
      ...docsSlugs.map((slug) => (slug ? `/docs/${slug}` : "/docs")),
    ]);
    for (const file of files) {
      const raw = await readFile(new URL(file, contentRoot), "utf8");
      const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
      expect(frontmatter).not.toBeNull();
      const title = frontmatter?.[1]?.match(/^title:\s*(.+)$/m)?.[1];
      const description = frontmatter?.[1]?.match(/^description:\s*(.+)$/m)?.[1];
      expect(title?.length).toBeGreaterThan(2);
      expect(description?.length).toBeGreaterThan(20);
      expect(titles.has(title ?? "")).toBe(false);
      expect(descriptions.has(description ?? "")).toBe(false);
      titles.add(title ?? "");
      descriptions.add(description ?? "");
      const body = withoutCodeFences(raw.slice(frontmatter?.[0].length ?? 0));
      expect(body).not.toMatch(/^#\s/m);
      expect(body).not.toMatch(/<h1[\s>]/i);
      for (const match of body.matchAll(/\]\((\/[^)\s]*)\)/g)) {
        const pathname = match[1]?.split(/[?#]/)[0] ?? "";
        expect(pages.has(pathname)).toBe(true);
      }
    }
  });

  test("names the docs entry Overview", async () => {
    const intro = await read("content/docs/index.mdx");
    expect(intro).toMatch(/^title: Overview$/m);
  });

  test("documents published npm-first installation and preserves access boundaries", async () => {
    const [intro, start, library, reference, security] = await Promise.all([
      read("content/docs/index.mdx"),
      read("content/docs/get-started.mdx"),
      read("content/docs/library.mdx"),
      read("content/docs/reference.mdx"),
      read("content/docs/security.mdx"),
    ]);
    for (const page of [intro, start]) {
      expect(page).toContain("npx issue-graph@latest --help");
      expect(page).toContain("npm install --global issue-graph@latest");
      expect(page).toContain("https://www.npmjs.com/package/issue-graph)");
    }
    expect(start).toContain("npm install --global issue-graph@latest");
    expect(start.indexOf("## Install from npm")).toBeLessThan(
      start.indexOf("## Optional source development"),
    );
    expect(library).toContain("npm install issue-graph@latest");
    expect(library).toContain('from "issue-graph"');
    expect(library).toContain('from "issue-graph/transport/http"');
    expect(library).toContain('from "issue-graph/transport/shell"');
    expect(library).not.toContain("file:../issue-graph");
    expect(reference).toContain("npx issue-graph@latest");
    expect(start).toContain("supported by your installed release");
    expect(security).toContain("INTERNAL");
    expect(security.toLowerCase()).toContain("snapshot");
    const files = (await readdir(contentRoot)).filter((name) => name.endsWith(".mdx"));
    for (const file of files) {
      const page = await readFile(new URL(file, contentRoot), "utf8");
      expect(page).not.toMatch(
        /publication is (?:still )?pending|still pending publication|functional unscoped release is pending|no working public npm CLI|supported installation is from source|public npm placeholder/i,
      );
    }
  });

  test("uses latest for install and try commands without version-specific npm links", async () => {
    const files = (await readdir(contentRoot)).filter((name) => name.endsWith(".mdx"));
    const pages = await Promise.all([
      ...files.map((file) => readFile(new URL(file, contentRoot), "utf8")),
      read("../../README.md"),
      read("../../CONTRIBUTING.md"),
    ]);
    for (const page of pages) {
      for (const command of page.matchAll(
        /\b(?:npx\s+|npm\s+install\s+(?:(?:--global|-g)\s+)?)(issue-graph|skills)(@[^\s`]+)?/g,
      )) {
        expect(command[2]).toBe("@latest");
      }
      expect(page).not.toContain("https://www.npmjs.com/package/issue-graph/v/");
      expect(page).not.toMatch(
        /examples pin 0\.2\.0|version 0\.2\.0 for reproducible installation/,
      );
    }
  });

  test("keeps demo documentation aligned with the bounded captured fixture", async () => {
    const example = JSON.parse(await read("src/lib/example-graph.json"));
    const pages = await Promise.all([
      read("content/docs/index.mdx"),
      read("content/docs/get-started.mdx"),
      read("content/docs/graph.mdx"),
      read("../../README.md"),
    ]);
    for (const page of pages) {
      expect(page).toContain(example.command);
      expect(page).not.toContain("issue-graph 427");
    }
    for (const page of pages.slice(1)) {
      expect(page).toContain(example.capturedAt.slice(0, 10));
      for (const node of example.nodes) expect(page).toContain(`#${node.number}`);
    }
    expect(pages[0]).toContain("[Get started](/docs/get-started)");
    const start = pages[1] ?? "";
    for (const node of example.nodes) {
      const row = start.split("\n").find((line) => line.includes(`](${node.url}) |`));
      expect(row).toContain(`| ${node.state} |`);
    }
    expect(start).toContain("[Graph](/docs/graph)");
    expect(pages[2]).toContain(`${example.coverage.beyondDepthReferences} references`);
    expect(pages[2]).toContain(`${example.coverage.omittedEdges} edges`);
    expect(pages[3]).toContain("[Capture details](https://issue-graph.dev/docs/graph)");
  });

  test("root guidance separates published installation from future release authorization", async () => {
    const [readme, contributing] = await Promise.all([
      read("../../README.md"),
      read("../../CONTRIBUTING.md"),
    ]);
    for (const page of [readme, contributing]) {
      expect(page).toContain("npm install --global issue-graph@latest");
      expect(page).toContain("npm install issue-graph@latest");
      expect(page).toContain("npx issue-graph@latest --help");
      expect(page).toContain("INTERNAL");
      expect(page).not.toMatch(/publication is (?:still )?pending|pending publication/i);
    }
    expect(contributing).not.toMatch(/expected_version=\d+\.\d+\.\d+/);
    expect(contributing).toContain('expected_version="$EXPECTED_VERSION"');
    expect(contributing).toContain("Release environment approval");
  });

  test("uses canonical skill discovery and CLI-bundled guidance without release stories", async () => {
    const [agents, readme] = await Promise.all([
      read("content/docs/agents.mdx"),
      read("../../README.md"),
    ]);
    const readmeAgents = readme.match(/^## Agents and integrations\n([\s\S]*?)(?=^## )/m)?.[1];
    expect(readmeAgents).toBeDefined();
    for (const page of [agents, readmeAgents ?? ""]) {
      expect(page).not.toMatch(/\b\d+\.\d+\.\d+(?:-[\w.-]+)?\b/);
      expect(page).not.toMatch(/outdated|source-only|newer source stub|not available in npm/i);
      expect(page).not.toMatch(/do not (?:install|pair).*stub|npm root --global|cp -R/i);
      expect(page).toContain("npm install --global issue-graph@latest");
      expect(page).toContain("npx skills@latest add vercel-labs/issue-graph");
      expect(page).toContain("npx skills@latest add https://issue-graph.dev");
      expect(page).toContain("same canonical");
      expect(page).toContain("/skill.md");
      expect(page).toContain("issue-graph skills get core\n");
      expect(page).toContain("issue-graph skills get core --full\n");
      expect(page).toContain("issue-graph skills list");
      expect(page).toContain("authorized setup correction");
    }
    for (const heading of [
      "## Load the command guidance",
      "## Choose a command",
      "## Report findings",
      "## Optional root-cause clustering",
    ]) {
      expect(agents).toContain(heading);
    }
  });

  test("enables the native GitHub navbar link without changing source access", async () => {
    const [config, site] = await Promise.all([
      read("src/lib/geistdocs/config.tsx"),
      read("src/lib/site.ts"),
    ]);
    expect(config).toContain("navbarGithub: { enabled: true }");
    expect(config).toContain('owner: "vercel-labs"');
    expect(config).toContain('repo: "issue-graph"');
    expect(config).not.toContain("...(repositoryIsPublic");
    expect(config).toContain("editSource: repositoryIsPublic");
    expect(site).toContain("repositoryIsPublic = false");
  });

  test("pins the public runtime and uses no initializer or private provider", async () => {
    const pkg = JSON.parse(await read("package.json"));
    expect(pkg.name).toBe("@issue-graph/docs");
    expect(pkg.private).toBe(true);
    for (const [name, version] of Object.entries({
      "@vercel/geistdocs": "2.4.1",
      "@vercel/agent-readability": "0.7.0",
      next: "16.3.5",
      react: "19.3.0",
      "react-dom": "19.3.0",
      geist: "1.7.2",
      "fumadocs-core": "16.2.2",
      "fumadocs-mdx": "14.0.4",
    }))
      expect(pkg.dependencies[name]).toBe(version);
    expect(pkg.devDependencies.tailwindcss).toBe("4.3.3");
    expect(JSON.stringify(pkg)).not.toMatch(/eslint|geistdocs init|@vercel\/geist(?=")/);
    expect(pkg.scripts.test).toMatch(/^vitest run(?:\s|$)/);
    expect(pkg.scripts["test:routes"]).toBe("tsx scripts/test-routes.ts");
    expect(pkg.scripts["test:ci"]).toBe("tsx scripts/verify-site.ts");
    expect(pkg.scripts.audit).toBe("tsx scripts/audit.ts");
    const config = await read("src/lib/geistdocs/config.tsx");
    expect(config).toContain("webmcp: { enabled: true }");
    expect(config).toContain("ai: { enabled: false }");
    expect(config).toContain("editSource: repositoryIsPublic");
    const layout = await read("src/app/layout.tsx");
    expect(layout).toContain("@vercel/geistdocs/navbar");
    expect(layout).toContain("@vercel/geistdocs/footer");
    expect(layout).toContain('href="#main-content"');
    expect(layout).not.toMatch(/<main[\s>]/);
    const skillRoute = await read("src/app/skill.md/route.ts");
    expect(skillRoute).toContain("../../skills/issue-graph/SKILL.md");
    expect(skillRoute).not.toContain("params");
  });
});
