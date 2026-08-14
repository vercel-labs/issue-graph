export const XREF_SCHEMA = {
  name: "xref",
  schemaVersion: 1,
  exitCodes: {
    success: 0,
    runtimeFailure: 1,
    usageError: 2,
  },
  commands: {
    graph: {
      mutates: false,
      formats: ["markdown"],
      description: "Crawl and render the reference graph around explicit seeds.",
    },
    reconcile: {
      mutates: false,
      outputSchemaVersion: 1,
      formats: ["json", "markdown"],
      description: "Inventory an open repository backlog and derive verification actions.",
    },
    schema: {
      mutates: false,
      formats: ["json"],
      description: "Print the stable agent-facing command contract.",
    },
  },
} as const;
