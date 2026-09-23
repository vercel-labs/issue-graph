import { defineConfig } from "@vercel/geistdocs/config";
import { repositoryIsPublic, siteName, siteUrl } from "@/lib/site";

export const config = defineConfig({
  title: siteName,
  siteUrl,
  defaultLanguage: "en",
  logo: <span className="font-medium tracking-tight">{siteName}</span>,
  logoHref: "/",
  navbarVariant: "oss",
  navbarBrand: "labs",
  navbarActiveProduct: siteName,
  navbarGithub: { enabled: true },
  github: {
    owner: "vercel-labs",
    repo: "issue-graph",
    branch: "main",
    editPath: "apps/docs/content/docs",
  },
  content: [{ id: "docs", label: "Documentation", dir: "content/docs", route: "/docs" }],
  nav: [
    { label: "Docs", href: "/docs" },
    { label: "npm", href: "https://www.npmjs.com/package/issue-graph", external: true },
  ],
  ai: { enabled: false },
  feedback: { enabled: false },
  language: { enabled: false },
  search: { enabled: true },
  pageActions: { askAI: false, openInChat: false, editSource: repositoryIsPublic },
  webmcp: { enabled: true },
});
