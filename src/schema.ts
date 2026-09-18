export const ISSUE_GRAPH_SCHEMA = {
  name: "issue-graph",
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
        "~/.issue-graph snapshots unless --no-snapshot is set",
        "explicit --json and --html output paths",
      ],
      formats: ["markdown"],
      description: "Crawl and render the reference graph around explicit seeds.",
    },
    reconcile: {
      githubMutations: false,
      localWrites: ["~/.issue-graph snapshots unless --no-snapshot is set"],
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
    status: {
      githubMutations: false,
      localWrites: [
        "immutable snapshots under ISSUE_GRAPH_HOME/status (default ~/.issue-graph/status) only with --save",
      ],
      history: {
        snapshotSchemaVersion: 1,
        comparisonSchemaVersion: 1,
        save: "--save opts into an immutable capture; default remains no writes",
        since:
          "--since last|PATH compares before saving; identical repository/author scope required",
        noSnapshot: "--no-snapshot forbids writes and conflicts with --save",
        jsonFields: ["history (with --since)", "snapshot (with --save)"],
        terminalVerification:
          "Missing PRs are queried explicitly; inaccessible or still-open PRs remain UNVERIFIED",
      },
      outputSchemaVersion: 1,
      formats: ["table", "markdown", "json"],
      views: ["authors", "projects", "prs"],
      defaultView: "authors",
      defaultFormat: { tty: "table", pipe: "json" },
      required: ["--repo owner/repo (repeatable)", "--author login[,login] (repeatable)"],
      pageSize: 50,
      maxPages: { default: 100, minimum: 1, maximum: 1000 },
      concurrency: { default: 4, minimum: 1, maximum: 32 },
      exitCodes: { complete: 0, incompleteOrFailure: 1, usageError: 2 },
      countShape: { count: "number | null", prIds: "string[]", unknownIds: "string[]" },
      reviewStates: ["required", "changes-requested", "approved", "not-required", "unknown"],
      jsonFlag: "--json emits the report on stdout; unlike graph --json PATH, takes no path",
      description:
        "Inventory explicit repositories and authors, with count provenance and incomplete coverage. Drafts, conflicts and assignment are independent of review state. No graph crawl; snapshots and comparison are opt-in.",
    },
    schema: {
      githubMutations: false,
      localWrites: [],
      formats: ["json"],
      description: "Print the stable agent-facing command contract.",
    },
  },
} as const;
