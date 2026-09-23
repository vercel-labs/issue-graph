export const landingTitle = "Find related work before you start";
export const landingLastModified = "2026-09-23";
export const landingDescription =
  "Trace linked issues and pull requests. Find existing fixes and open follow-ups in your terminal.";

export const workflows = [
  {
    number: "01",
    title: "Trace related work",
    description:
      "Start with an issue or PR to find linked fixes, competing changes, and open follow-ups.",
    command: "issue-graph 1113 --repo vercel-labs/agent-browser --depth 1",
    href: "/docs/graph",
    link: "Trace a graph",
  },
  {
    number: "02",
    title: "Check PR status",
    description:
      "Count open PRs by author and repository. See which need review, have approval, or have conflicts.",
    command: "issue-graph status --repo vercel-labs/portless --author Railly",
    href: "/docs/status",
    link: "Inspect PR status",
  },
  {
    number: "03",
    title: "Review your backlog",
    description:
      "Find issues linked to merged fixes and PRs ready for review. Get a suggested next action.",
    command: "issue-graph plan --repo vercel-labs/portless",
    href: "/docs/backlog",
    link: "Reconcile a backlog",
  },
] as const;
