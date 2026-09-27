export const landingTitle = "Find related work before you start";
export const landingLastModified = "2026-09-27";
export const landingDescription =
  "Map related issues and pull requests. Prioritize your backlog, then open the exact view in your browser.";

export const workflows = [
  {
    number: "01",
    title: "Map your backlog",
    description:
      "Capture open issues, PRs, and their references. Explore linked work or ask your agent to group it by root cause.",
    command: "issue-graph open vercel-labs/portless --budget 80 --no-open",
    href: "/docs/dashboard#capture-a-repository",
    link: "Capture a backlog",
  },
  {
    number: "02",
    title: "Choose what to inspect next",
    description:
      "Filter by kind, state, cluster, or Heat. Rank open work with weights you control. Heat measures discussion, not severity.",
    command:
      "issue-graph query github:vercel-labs/portless --kind Issue --heat-top 25 --view rank --json --no-open",
    href: "/docs/dashboard#prioritize-with-filters",
    link: "Filter and rank",
  },
  {
    number: "03",
    title: "Open the exact view",
    description:
      "Keep the CLI and dashboard on the same filters and weights. Explore in the browser or replay a saved query.",
    command:
      "issue-graph query github:vercel-labs/portless --kind Issue --heat-top 25 --view rank --open",
    href: "/docs/dashboard#open-the-exact-result",
    link: "Use the dashboard",
  },
] as const;
