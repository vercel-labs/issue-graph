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
    classify: {
      implementation: "batched-evidence-and-bounded-scheduling",
      githubMutations: false,
      localWrites: [
        "validated response history/current pointer, pending/final receipts, fingerprint locks and private public-evidence snapshots under ISSUE_GRAPH_HOME/classify unless --dry-run, --cached or --no-snapshot",
      ],
      gatewayCalls: true,
      gatewayCredentials:
        "AI_GATEWAY_API_KEY read lazily only for eligible new inference; ordinary cache hits need no key",
      dryRun:
        "GitHub capture, full request preparation and read-only cache checks; no Gateway key access, inference or local writes",
      noSnapshot:
        "No evidence/cache/receipt I/O; in-memory receipts with no crash recovery or cross-process exclusion. STOP control is still checked.",
      cached:
        "Explicit saved-evidence view for exact repo+limit, supplied taxonomy and current response-cache policy/TTL. No GitHub, Gateway, keys or writes; evidenceSource labels age and absence of live revalidation. Missing/expired answers defer; missing evidence fails without network fallback.",
      evidenceCache: {
        schemaVersion: 1,
        storage:
          "classify/evidence; owned 0700 directories/0600 files; includes public issue/comment text, not credentials",
        maxBytes: 16777216,
        scope: "normalized repo and limit",
        reuse:
          "Live verification of issue and all comment identities, versions, order and coverage before body reuse; parent updatedAt alone is insufficient",
        publication:
          "Complete or explicitly limit-capped ready evidence only; unchanged content writes nothing; history retained",
      },
      cache: {
        enabled: true,
        ttlMs: 86400000,
        epoch: "1",
        lookup:
          "Only matching validated responses with successful source receipts, no unresolved lock, current public metadata and unexpired evaluation time",
        refresh:
          "Ignore stored responses without deleting history; never bypass pending/unknown locks or unsafe storage",
        storage:
          "classify/cache/<inputHash>/<requestId>.json and atomic current.json; no bodies, comments, questions or credentials",
        policy:
          "Reapply current policy to stored distributions; policy version is not in the inference fingerprint",
        cost: "Current reportedCostUsd excludes hits; cachedHistoricalCostUsd and hasUnknownHistoricalCost account for reused provenance separately",
      },
      outputSchemaVersion: 1,
      outputKind: "classification-report",
      dryRunOutputKind: "classification-preview",
      errorKind: "classification-error",
      errorShape: {
        schemaVersion: 1,
        kind: "classification-error",
        error: "{code, message, hint}",
      },
      required: ["--repo owner/repo (single public repository)"],
      formats: ["auto", "json", "markdown"],
      defaultFormat: { tty: "markdown", pipe: "json" },
      flags: [
        "--repo",
        "--dry-run",
        "--cached",
        "--concurrency",
        "--max-retries",
        "--min-interval-ms",
        "--taxonomy",
        "--limit",
        "--max-calls",
        "--refresh",
        "--format",
        "--json",
        "--no-snapshot",
        "--help",
      ],
      unsupported: [
        "private/internal repositories",
        "PR targets",
        "automatic acceptance",
        "automatic recovery of unknown outcomes",
      ],
      limit: { default: 50, minimum: 1, maximum: 500 },
      maxCalls: {
        default: 50,
        minimum: 0,
        maximum: 500,
        meaning:
          "New HTTP attempts (planned only in preview); not a monetary budget. Zero reuses eligible hits and defers misses, expiry or refresh.",
      },
      pageSize: 20,
      initialCommentPageSize: 10,
      commentContinuationPageSize: 100,
      maxCommentPages: 4,
      maxCommentsPerIssue: 300,
      metadataBatchSize: 20,
      maxBatchResponseBytes: 16777216,
      maxInputBytes: 24000,
      inputBytesMeaning: "UTF-8 complete HTTP request including questions and provider routing",
      timeoutMs: 30000,
      maxResponseBytes: 262144,
      retries: 0,
      maxRetries: { default: 0, minimum: 0, maximum: 3, onlyStatus: 429, maxWaitMs: 30000 },
      inferenceConcurrency: { default: 1, minimum: 1, maximum: 4 },
      minIntervalMs: { default: 0, minimum: 0, maximum: 60000 },
      scheduling:
        "Global max-calls includes retries; pacing/backoff and STOP/abort checks happen outside the provider deadline. Long Retry-After hints defer; unknown outcomes never retry. No quota/tier assumption.",
      diagnostics:
        "Bounded redacted untrusted code/type and identifiers before error-body cancellation; arbitrary provider prose is omitted. No confirmed rate-limit origin inferred. Per-attempt headers/total client timing, not pure model latency.",
      providerFallback: false,
      model: "typesafe-ai/jev",
      endpoint: "https://ai-gateway.vercel.sh/v1/evaluate",
      stopControl:
        "Create ISSUE_GRAPH_HOME/classify/STOP (default ~/.issue-graph/classify/STOP); checked before each request, including memory-only mode",
      receipts:
        "Durable pending before transfer; cache publishes under the owned lock before successful finalization releases it. Unresolved pending/unknown or publication failure blocks reuse and repeat attempts. No automatic recovery.",
      taxonomy: {
        schemaVersion: 1,
        required: ["schemaVersion", "repo", "version", "components"],
        component: "{id, description, examples?}",
        idPattern: "^[a-z][a-z0-9-]{0,47}$",
        reservedIds: ["multiple", "new", "insufficient", "constructor", "prototype"],
        maxBytes: 65536,
        maxComponents: 64,
        maxDescriptionCharacters: 2000,
        maxExamples: 5,
        maxExampleCharacters: 500,
        missing: "componentStatus unavailable, taxonomy-missing; no inferred components",
      },
      jsonFields: [
        "schemaVersion",
        "kind",
        "scope",
        "captureWindow",
        "coverage",
        "coverageComplete",
        "taxonomy",
        "rubricVersion",
        "policyVersion",
        "projectionVersion",
        "cacheEpoch",
        "modelRequested",
        "modelResolved",
        "execution",
        "items",
        "totals",
        "nextSteps",
      ],
      optionalJsonFields: {
        evidenceSource: "{mode:live|cached,capturedAt,ageMs,liveRevalidated,reusedIssues}",
        performance:
          "{githubCalls,githubRequestMs,captureMs,evaluationMs,totalMs}; GitHub transport invocation count and aggregate request time, not pure network/server latency",
        attempts:
          "Item attempt history with receipt, attempted, gatewayTiming and redacted providerError. Existing receipt stays latest; earlier failed costs remain unknown.",
      },
      cacheEpochField: "cacheEpoch identifies the inference fingerprint epoch for this report",
      previewItemShape:
        "{key,url,inputHash,outcome,reviewRequired:true,reasonCodes,plannedCall,inputBytes,questionIds,componentStatus,cacheStatus,cacheEvaluatedAt,cacheSourceRequestId,evidence}",
      itemShape:
        "{key,url,inputHash,outcome,reviewRequired:true,reasonCodes,inputBytes,questionIds,componentStatus,cacheStatus,cacheEvaluatedAt,cacheSourceRequestId,evidence,answers,impactReportedStatus,provenance,receipt,providerError}",
      totalsShape:
        "{captured,evaluated,cacheHits,suggested,needsReview,skipped,failed,deferred,oversized,reportedCostUsd,hasUnknownCost,cachedHistoricalCostUsd,hasUnknownHistoricalCost}",
      reviewRequired: true,
      policyVersion: "2",
      distributionValidation: {
        unitSumTolerance: 0.001,
        roundedCompatibility: {
          decimalPlaces: 2,
          maximumSumError: 0.02,
          perOptionRoundingRadius: 0.005,
          requiresUnitMassWithinClampedRoundingIntervals: true,
          preservesRawProbabilities: true,
          reasonCode: "<questionId>-distribution-rounded",
          outcome: "needs-review",
          providerGuarantee: false,
        },
      },
      markdownView:
        "Component groups and explicit review/failure groups; probabilities are diagnostics, not acceptance",
      exitCodes: { completeScope: 0, incompleteOrFailureOrDeferred: 1, usageError: 2 },
      description:
        "Review-only suggestions with strictly validated distributions, uncalibrated diagnostics and nullable usage/cost. Live mode revalidates public issue/comment versions; cached mode explicitly labels unverified saved evidence. No GitHub mutations; provider quota, live retry behavior and semantic quality remain unverified.",
    },
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
    skills: {
      githubMutations: false,
      localWrites: [],
      network: false,
      authentication: false,
      outputSchemaVersion: 1,
      formats: ["text", "markdown", "json"],
      defaultFormat: { tty: "text/markdown", pipe: "text/markdown" },
      subcommands: ["list", "get core"],
      defaultCommand: "list",
      flags: ["--json", "--full (get only)", "--help"],
      listShape: {
        schemaVersion: 1,
        success: true,
        data: "{name, description}[]",
        nextSteps: "string[]",
      },
      getShape: {
        schemaVersion: 1,
        success: true,
        data: "{name, content, files?: {path, content}[]}[]",
        nextSteps: "string[]",
      },
      helpShape: { schemaVersion: 1, success: true, data: "{usage}", nextSteps: "string[]" },
      errorShape: { schemaVersion: 1, success: false, error: "{code, message, hint}" },
      errorCodes: ["USAGE_ERROR", "SKILL_READ_FAILED"],
      jsonFlag: "--json emits an envelope on stdout, including errors; takes no path",
      description:
        "Read guides bundled with the installed CLI, independent of the current directory. --full adds workflow references. Plain text/Markdown remains the default in pipes for direct agent loading.",
    },
    schema: {
      githubMutations: false,
      localWrites: [],
      formats: ["json"],
      description: "Print the stable agent-facing command contract.",
    },
  },
} as const;
