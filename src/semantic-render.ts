import type {
  SemanticAnswer,
  SemanticCoverage,
  SemanticPreview,
  SemanticReport,
  SemanticReportItem,
} from "./semantic-types.js";

export function escapeSemanticMarkdown(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_{}[\]()#+.!|~-]/g, "\\$&");
}

function completeCoverage(coverage: SemanticCoverage): boolean {
  return (
    coverage.complete &&
    coverage.hasNextPage === false &&
    coverage.total !== null &&
    coverage.captured === coverage.total
  );
}

function inventoryComplete(report: SemanticPreview | SemanticReport): boolean {
  return (
    completeCoverage(report.coverage) &&
    report.coverage.captured === report.items.length &&
    report.totals.captured === report.items.length
  );
}

function coverageText(report: SemanticPreview | SemanticReport): string {
  const inventory = inventoryComplete(report);
  const evidence =
    inventory &&
    report.coverageComplete &&
    report.items.every((item) => completeCoverage(item.evidence.commentsCoverage));
  return `Issue inventory coverage: ${inventory ? "complete" : "incomplete"}; evidence coverage: ${evidence ? "complete" : "incomplete"}. Neither implies classification coverage.`;
}

function emptyScopeText(report: SemanticPreview | SemanticReport): string {
  return inventoryComplete(report) && report.coverageComplete
    ? "No open issues observed in the captured scope. No classifications available."
    : "No verified issue inventory is available. An empty capture does not establish an empty repository.";
}

function executionContext(report: SemanticPreview | SemanticReport): string[] {
  const lines: string[] = [];
  const source = report.evidenceSource;
  if (source) {
    lines.push(
      source.mode === "cached"
        ? `Saved evidence, NOT live revalidated. Captured ${escapeSemanticMarkdown(source.capturedAt)}; age ${source.ageMs}ms. No GitHub, Gateway, key access or writes.`
        : `Live evidence: ${source.liveRevalidated ? "scope revalidated" : "inspect incomplete coverage"}; bodies reused after version checks ${source.reusedIssues}.`,
    );
  }
  if (report.performance) {
    const metrics = report.performance;
    lines.push(
      `Work: GitHub queries ${metrics.githubCalls}; capture ${metrics.captureMs.toFixed(1)}ms; evaluation ${metrics.evaluationMs.toFixed(1)}ms; total ${metrics.totalMs.toFixed(1)}ms. Aggregate transport time ${metrics.githubRequestMs.toFixed(1)}ms can overlap; it is not model latency.`,
    );
  }
  return lines;
}

function nextSteps(report: SemanticPreview | SemanticReport): string[] {
  return [
    "## Next steps",
    "",
    ...report.nextSteps.flatMap((step) => [
      `- ${escapeSemanticMarkdown(step.description)}`,
      ...(step.command ? [`  Command: ${escapeSemanticMarkdown(step.command)}`] : []),
    ]),
    "",
  ];
}

export function renderClassificationPreview(report: SemanticPreview): string {
  const safeText = escapeSemanticMarkdown;
  const lines = [
    `# Classification preview: ${safeText(report.scope.repo)}`,
    "",
    "Preview only. No Jev calls, semantic suggestions or local writes. Human review required.",
    ...executionContext(report),
    `Evidence: ${report.totals.captured}/${report.coverage.total ?? "unknown"} issues captured (limit ${report.scope.limit}).`,
    coverageText(report),
    `Planned calls: ${report.totals.plannedCalls} (max ${report.scope.maxCalls}); deferred ${report.totals.deferred}; excluded ${report.totals.excluded}; failed ${report.totals.failed}; oversized ${report.totals.oversized}.`,
    report.taxonomy
      ? `Component taxonomy: ${safeText(report.taxonomy.version)} (${report.taxonomy.components.length} components).`
      : "Component classification unavailable: taxonomy-missing.",
    "Input bytes measure the complete Gateway request, not tokens. Preview does not validate live inference.",
    `Cache: ${safeText(report.execution.cache)}; reusable ${report.totals.cacheHits}; epoch ${safeText(report.cacheEpoch)}. No predictions are shown, including cache hits.`,
    "",
    "| Issue | Preview outcome | Planned call | Input bytes | Comments captured/total | Reasons | Cache |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...report.items.map(
      (item) =>
        `| ${safeText(item.key)} | ${safeText(item.outcome)} | ${item.plannedCall ? "yes" : "no"} | ${item.inputBytes ?? "unavailable"} | ${item.evidence.commentsCoverage.captured}/${item.evidence.commentsCoverage.total ?? "unknown"} | ${item.reasonCodes.map(safeText).join(", ")} | ${safeText(item.cacheStatus)} |`,
    ),
    "",
  ];
  if (!report.items.length) lines.push(emptyScopeText(report), "");
  if (report.coverage.reasonCodes.length)
    lines.push(`Coverage: ${report.coverage.reasonCodes.map(safeText).join(", ")}.`, "");
  lines.push(...nextSteps(report));
  return `${lines.join("\n")}\n`;
}

function tiedDistribution(answer: SemanticAnswer): boolean {
  if (answer.type === "boolean") return answer.probability === 0.5;
  const values = Object.values(answer.probabilities);
  const top = Math.max(...values);
  return values.filter((value) => value === top).length > 1;
}

function answerText(answer: SemanticAnswer | undefined, omitChoice = false): string {
  if (!answer) return "unavailable";
  if (answer.type === "boolean") {
    return `p(true)=${answer.probability}${tiedDistribution(answer) ? "; uncertainty: p=0.5" : ""}`;
  }
  const probability =
    answer.type === "choice" && Object.hasOwn(answer.probabilities, answer.choice)
      ? answer.probabilities[answer.choice]
      : "unavailable";
  const selected =
    answer.type === "choice"
      ? omitChoice
        ? `p=${probability}`
        : `${escapeSemanticMarkdown(answer.choice)} (p=${probability})`
      : `${answer.score} / ${answer.levels.length - 1}`;
  const top = Math.max(...Object.values(answer.probabilities));
  const mismatch = answer.type === "choice" && probability !== top;
  return `${selected}${tiedDistribution(answer) ? "; uncertainty: tied-top" : ""}${mismatch ? `; uncertainty: choice-probability-mismatch (top=${top})` : ""}`;
}

type ReviewGroup = "needs-review" | "failed" | "skipped" | "deferred" | "unknown" | "no-taxonomy";

function reviewGroup(item: SemanticReportItem, report: SemanticReport): ReviewGroup | null {
  if (
    (item.receipt && (!item.receipt.final || item.receipt.final.result.outcomeUnknown)) ||
    item.cacheStatus === "blocked" ||
    item.reasonCodes.includes("in-flight-or-unknown")
  )
    return "unknown";
  if (item.outcome === "failed") return "failed";
  if (
    !item.answers &&
    item.reasonCodes.some((reason) =>
      [
        "max-calls-reached",
        "input-too-large",
        "run-aborted",
        "inference-disabled",
        "gateway-credentials-unavailable",
        "provider-unavailable",
        "cache-write-failed",
        "receipt-finalization-failed",
      ].includes(reason),
    )
  )
    return "deferred";
  if (item.outcome === "skipped") return "skipped";
  if (!report.taxonomy || item.componentStatus === "unavailable") return "no-taxonomy";
  const component = item.answers?.component;
  if (component?.type !== "choice") return "unknown";
  if (
    !report.taxonomy.components.includes(component.choice) ||
    tiedDistribution(component) ||
    !Object.hasOwn(component.probabilities, component.choice) ||
    component.probabilities[component.choice] !==
      Math.max(...Object.values(component.probabilities))
  )
    return "needs-review";
  return null;
}

function itemRow(item: SemanticReportItem, grouped: boolean): string {
  const safeText = escapeSemanticMarkdown;
  const impact = item.answers?.impactReported;
  const comments = item.evidence.commentsCoverage;
  const review = [...item.reasonCodes.map(safeText)];
  const errors =
    item.attempts?.flatMap((attempt) => (attempt.providerError ? [attempt.providerError] : [])) ??
    (item.providerError ? [item.providerError] : []);
  for (const error of errors) {
    const diagnostic = error.diagnostic;
    review.push(`HTTP ${error.status ?? "unknown"}: ${safeText(error.code)}`);
    if (error.retryRefusalReason) review.push(safeText(error.retryRefusalReason));
    if (diagnostic) {
      const detail = [diagnostic.type, diagnostic.code, diagnostic.requestId, diagnostic.message]
        .filter((value): value is string => typeof value === "string")
        .join("; ");
      review.push(
        `provider diagnostic (untrusted): ${safeText(detail.slice(0, 240) || diagnostic.availability)}`,
      );
    }
  }
  if (item.cacheStatus !== "disabled" && item.cacheStatus !== "not-checked")
    review.push(`cache: ${safeText(item.cacheStatus)}`);
  if (!completeCoverage(comments) || comments.reasonCodes.length) {
    review.push(
      `comments ${comments.captured}/${comments.total ?? "unknown"} (${completeCoverage(comments) ? "complete" : "incomplete"})`,
      ...comments.reasonCodes.map(safeText),
    );
  }
  const cells = [
    safeText(item.key),
    safeText(item.outcome),
    answerText(item.answers?.requestType),
    answerText(item.answers?.component, grouped),
    `repro ${answerText(item.answers?.reproStepsPresent)}; expected/observed ${answerText(item.answers?.expectedActualPresent)}; regression ${answerText(item.answers?.regressionReported)}`,
    item.impactReportedStatus === "applicable"
      ? impact?.type === "score"
        ? answerText(impact)
        : "unavailable"
      : safeText(item.impactReportedStatus),
    review.join("; ") || "none reported",
  ];
  return `| ${cells.join(" | ")} |`;
}

function itemTable(items: SemanticReportItem[], grouped = false): string[] {
  return [
    `| Issue | Outcome | Request type | ${grouped ? "Component p" : "Component"} | Signals | Reported impact | Review |`,
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...items.map((item) => itemRow(item, grouped)),
    "",
  ];
}

export function renderClassificationReport(report: SemanticReport): string {
  const safeText = escapeSemanticMarkdown;
  const components = new Map<string, SemanticReportItem[]>(
    report.taxonomy?.components.map((component) => [component, []]) ?? [],
  );
  const groups = new Map<ReviewGroup, SemanticReportItem[]>([
    ["needs-review", []],
    ["failed", []],
    ["skipped", []],
    ["deferred", []],
    ["unknown", []],
    ["no-taxonomy", []],
  ]);
  for (const item of report.items) {
    const group = reviewGroup(item, report);
    const component = item.answers?.component;
    if (group) groups.get(group)?.push(item);
    else if (component?.type === "choice") components.get(component.choice)?.push(item);
  }
  const lines = [
    `# Classification suggestions: ${safeText(report.scope.repo)}`,
    "",
    "Human review required for every suggestion. Probabilities are uncalibrated diagnostics, not measured accuracy or permission to act.",
    ...executionContext(report),
    "Classify-only: component groups are suggestions, not accepted labels. No probability threshold auto-accepts an item. Signals show p(true), not verified facts; uncertainty is explicit for tied-top, choice-probability-mismatch and p=0.5. Exact distributions remain only in JSON, without normalization.",
    "No GitHub mutations. Reported impact is not confirmed technical priority. Alias responses do not pin model weights.",
    coverageText(report),
    `Captured ${report.totals.captured}/${report.coverage.total ?? "unknown"} issues (limit ${report.scope.limit}); displayed ${report.items.length}.`,
    `Classification availability: ${report.items.filter((item) => item.answers !== null).length}/${report.items.length} captured items have answers (including cache reuse); this is not validated classification coverage.`,
    `Gateway attempts: ${report.execution.gatewayCalls}/${report.scope.maxCalls}; evaluated ${report.totals.evaluated}; suggested ${report.totals.suggested}; needs review ${report.totals.needsReview}; skipped ${report.totals.skipped}; failed ${report.totals.failed}; deferred ${report.totals.deferred}; oversized ${report.totals.oversized}.`,
    `Reported cost known subtotal: USD ${report.totals.reportedCostUsd}; unknown cost: ${report.totals.hasUnknownCost ? "yes" : "no"}. Current run only, not a spending ceiling.`,
    `Cached historical cost (not current spend): USD ${report.totals.cachedHistoricalCostUsd}; unknown historical cost: ${report.totals.hasUnknownHistoricalCost ? "yes" : "no"}.`,
    `Cache: ${safeText(report.execution.cache)}; hits ${report.totals.cacheHits}; entries written ${report.execution.cacheEntriesWritten}; epoch ${safeText(report.cacheEpoch)}.`,
    `Receipts: ${safeText(report.execution.receipts)}; durable records written ${report.execution.receiptRecordsWritten}.`,
    report.taxonomy
      ? `Component taxonomy: ${safeText(report.taxonomy.version)} (${report.taxonomy.components.length} components).`
      : "Component classification unavailable: taxonomy-missing.",
    "",
  ];
  if (report.coverage.reasonCodes.length)
    lines.push(`Coverage: ${report.coverage.reasonCodes.map(safeText).join(", ")}.`, "");
  if (!report.items.length) lines.push(emptyScopeText(report), "");
  if (report.items.length)
    lines.push(
      "Original outcomes retained; pending/unknown execution is shown separately. Every item appears once.",
      "",
    );
  if ([...components.values()].some((items) => items.length)) lines.push("## Components", "");
  for (const [component, items] of components) {
    if (!items.length) continue;
    lines.push(
      `### Component: ${safeText(component)} (${items.length})`,
      "",
      ...itemTable(items, true),
    );
  }
  for (const [group, items] of groups) {
    if (!items.length) continue;
    lines.push(`## ${group} (${items.length})`, "", ...itemTable(items));
  }
  lines.push(
    "Inspect JSON for exact distributions, full comment coverage, token usage, nullable provider confidence, input references and pending/final receipts.",
    "Do not retry pending/unknown outcomes blindly. Live provider behavior and semantic quality remain unverified.",
    "",
    ...nextSteps(report),
  );
  return `${lines.join("\n")}\n`;
}
