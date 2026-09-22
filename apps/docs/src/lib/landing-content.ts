export const landingTitle = "Find related work before you start";
export const landingLastModified = "2026-09-22";
export const landingDescription =
  "The fix might already be in another pull request. Trace the issues, competing changes, and follow-ups around your next task, without opening another dozen tabs.";

export const workflows = [
  {
    number: "01",
    title: "See what is connected",
    description:
      "Start with an issue or PR. Follow references across repositories and find the work you should read first.",
    command: "issue-graph 1113 --repo vercel-labs/agent-browser --depth 1",
    href: "/docs/graph",
    link: "Trace a graph",
  },
  {
    number: "02",
    title: "Know what needs attention",
    description:
      "Get PR status by author and project, with the underlying evidence and explicit gaps in coverage.",
    command: "issue-graph status --repo vercel-labs/portless --author Railly",
    href: "/docs/status",
    link: "Inspect PR status",
  },
  {
    number: "03",
    title: "Give the backlog a next step",
    description:
      "Reconcile open work, even without labels. Get a review queue, not a bot that closes things for you.",
    command: "issue-graph plan --repo vercel-labs/portless",
    href: "/docs/backlog",
    link: "Reconcile a backlog",
  },
] as const;
