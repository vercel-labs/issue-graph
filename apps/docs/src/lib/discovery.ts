import { markdownPath } from "./docs-paths";
import { geistdocsSource } from "./geistdocs/source";
import { canonicalUrl, packageReleasePending, siteDescription, siteName } from "./site";

export function documentationPages() {
  return geistdocsSource.source.getPages("en");
}

export function releaseNotice(): string {
  return packageReleasePending
    ? "The npm release is pending. Installation instructions for a published package are not yet available."
    : "Install from npm with npm install -g issue-graph@latest, or run npx issue-graph@latest --help. Requires Node.js 20+ and GitHub CLI authentication for GitHub queries.";
}

export function llmsIndex(): string {
  return [
    `# ${siteName}`,
    "",
    `> ${siteDescription}`,
    "",
    releaseNotice(),
    "",
    "issue-graph reads GitHub data. It does not close issues, merge pull requests, or establish code correctness or merge readiness. Snapshots can write local files.",
    "",
    "## Documentation",
    "",
    ...documentationPages().map(
      (page) =>
        `- [${page.data.title}](${canonicalUrl(page.url)}): ${page.data.description ?? "Documentation"}`,
    ),
    "",
    "## Agent resources",
    "",
    `- [Release-compatible agent setup](${canonicalUrl("/docs/agents.md")})`,
    `- [Markdown sitemap](${canonicalUrl("/sitemap.md")})`,
    `- [XML sitemap](${canonicalUrl("/sitemap.xml")})`,
    "",
    "Request a page with Accept: text/markdown or append .md to a documentation URL. WebMCP is available in supporting browsers; ordinary navigation and search do not require it.",
    "",
  ].join("\n");
}

export function sitemapMarkdown(): string {
  return [
    `# ${siteName} sitemap`,
    "",
    `- [Home](${canonicalUrl("/")}): [Markdown](${canonicalUrl("/index.md")})`,
    ...documentationPages().map(
      (page) =>
        `- [${page.data.title}](${canonicalUrl(page.url)}): ${page.data.description ?? ""} [Markdown](${canonicalUrl(markdownPath(page.url))})`,
    ),
    `- [Release-compatible agent setup](${canonicalUrl("/docs/agents.md")})`,
    "",
  ].join("\n");
}
