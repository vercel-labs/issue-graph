export const XREF_SCHEMA = {
  name: "xref",
  schemaVersion: 1,
  crawl: {
    maxNodes: { default: 80, minimum: 1, maximum: 1000 },
    concurrency: { default: 4, minimum: 1, maximum: 32 },
    searchPageSize: 100,
    searchResultLimit: 1000,
  },
  exitCodes: {
    success: 0,
    runtimeFailure: 1,
    usageError: 2,
  },
  commands: {
    graph: {
      githubMutations: false,
      localWrites: [
        "~/.xref snapshots unless --no-snapshot is set",
        "explicit --json and --html output paths",
      ],
      formats: ["markdown"],
      description: "Crawl and render the reference graph around explicit seeds.",
    },
    reconcile: {
      githubMutations: false,
      localWrites: ["~/.xref snapshots unless --no-snapshot is set"],
      outputSchemaVersion: 1,
      formats: ["json", "markdown"],
      description:
        "Inventory an open repository backlog and derive verification actions plus repository-level deltas.",
    },
    plan: {
      githubMutations: false,
      localWrites: [],
      outputSchemaVersion: 1,
      formats: ["json", "markdown"],
      description:
        "Turn a live repository reconciliation into a deterministic execution, investigation, and blocked queue.",
    },
    schema: {
      githubMutations: false,
      localWrites: [],
      formats: ["json"],
      description: "Print the stable agent-facing command contract.",
    },
  },
} as const;
