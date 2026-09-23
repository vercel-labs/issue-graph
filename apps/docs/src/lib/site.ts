export const siteName = "issue-graph";
export const siteUrl = "https://issue-graph.dev";
export const repositoryUrl = "https://github.com/vercel-labs/issue-graph";
export const siteDescription =
  "Find related issues, competing changes, and unresolved follow-ups before you start work. A CLI for maintainers and coding agents.";
export const repositoryIsPublic = false;
export const plannedInstallCommand = "npm install -g issue-graph@latest";
export const agentSetupPrompt = "npx skills@latest add vercel-labs/issue-graph";
export const exampleCommand =
  "issue-graph 1113 --repo vercel-labs/agent-browser --depth 1 --max-nodes 12 --no-snapshot";
export const isPreview = process.env.VERCEL_ENV === "preview";

export function canonicalUrl(pathname = "/") {
  return new URL(pathname, siteUrl).toString();
}
