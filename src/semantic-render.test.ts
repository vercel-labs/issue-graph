import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  escapeSemanticMarkdown,
  renderClassificationPreview,
  renderClassificationReport,
} from "./semantic-render.js";
import type {
  SemanticAnswer,
  SemanticCoverage,
  SemanticPreview,
  SemanticPreviewItem,
  SemanticReport,
  SemanticReportItem,
} from "./semantic-types.js";

const TIME = "2026-09-20T00:00:00.000Z";
const WINDOW = { startedAt: TIME, completedAt: TIME };
const network = vi.fn(() => {
  throw new Error("Network and model calls are forbidden");
});

beforeEach(() => {
  network.mockClear();
  vi.stubGlobal("fetch", network);
});

afterEach(() => {
  try {
    expect(network).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

function coverage(count: number): SemanticCoverage {
  return {
    captured: count,
    total: count,
    hasNextPage: false,
    pages: 1,
    complete: true,
    reasonCodes: [],
  };
}

function choice(
  selected: string,
  probabilities: Record<string, number> = { [selected]: 0.8, insufficient: 0.2 },
): SemanticAnswer {
  const ranked = Object.values(probabilities).sort((a, b) => b - a);
  return {
    type: "choice",
    choice: selected,
    probabilities,
    topProbability: ranked[0],
    margin: ranked[0] - ranked[1],
    providerConfidence: null,
  };
}

function item(number = 1, overrides: Partial<SemanticReportItem> = {}): SemanticReportItem {
  return {
    key: `o/r#${number}`,
    url: `https://github.com/o/r/issues/${number}`,
    inputHash: null,
    outcome: "suggested",
    reviewRequired: true,
    reasonCodes: [],
    inputBytes: 100,
    questionIds: [
      "requestType",
      "component",
      "reproStepsPresent",
      "expectedActualPresent",
      "regressionReported",
      "impactReported",
    ],
    componentStatus: "available",
    cacheStatus: "disabled",
    cacheEvaluatedAt: null,
    cacheSourceRequestId: null,
    evidence: {
      id: `I_${number}`,
      updatedAt: TIME,
      state: "OPEN",
      captureWindow: { ...WINDOW },
      comments: [],
      commentsCoverage: coverage(0),
      excludedSources: ["attachments", "external-urls", "pull-requests", "relations"],
    },
    answers: {
      requestType: choice("bug"),
      component: choice("cli"),
      reproStepsPresent: { type: "boolean", probability: 0.9, providerConfidence: null },
      expectedActualPresent: { type: "boolean", probability: 0.7, providerConfidence: null },
      regressionReported: { type: "boolean", probability: 0.3, providerConfidence: null },
      impactReported: {
        type: "score",
        score: 1.9,
        levels: ["none", "minor", "workaround", "blocked"],
        probabilities: { "0": 0.1, "1": 0.2, "2": 0.4, "3": 0.3 },
        topProbability: 0.4,
        margin: 0.1,
        providerConfidence: null,
      },
    },
    impactReportedStatus: "applicable",
    provenance: null,
    receipt: null,
    providerError: null,
    ...overrides,
  };
}

function preview(items: SemanticReportItem[] = [item()]): SemanticPreview {
  return {
    schemaVersion: 1,
    kind: "classification-preview",
    scope: { repo: "o/r", state: "OPEN", limit: 50, maxCalls: 50 },
    captureWindow: { ...WINDOW },
    coverage: coverage(items.length),
    coverageComplete: true,
    taxonomy: { version: "v1", components: ["cli", "engine", "unused"] },
    rubricVersion: "1",
    policyVersion: "1",
    projectionVersion: "1",
    modelRequested: "typesafe-ai/jev",
    modelResolved: null,
    cacheEpoch: "1",
    execution: { dryRun: true, gatewayCalls: 0, localWrites: 0, cache: "disabled" },
    items: items.map((value): SemanticPreviewItem => {
      const {
        answers: _answers,
        impactReportedStatus: _impact,
        provenance: _provenance,
        receipt: _receipt,
        providerError: _error,
        ...rest
      } = value;
      return { ...rest, outcome: "needs-review", plannedCall: true };
    }),
    totals: {
      captured: items.length,
      eligible: items.length,
      plannedCalls: items.length,
      cacheHits: 0,
      deferred: 0,
      excluded: 0,
      failed: 0,
      oversized: 0,
      reportedCostUsd: 0,
      hasUnknownCost: false,
    },
    nextSteps: [{ action: "review-evidence", description: "Review evidence and taxonomy." }],
  };
}

function report(items: SemanticReportItem[] = [item()]): SemanticReport {
  return {
    ...preview(items),
    kind: "classification-report",
    execution: {
      dryRun: false,
      gatewayCalls: 0,
      receiptRecordsWritten: 0,
      receipts: "memory-only",
      cache: "disabled",
      cacheEntriesWritten: 0,
    },
    items,
    totals: {
      captured: items.length,
      evaluated: items.filter((value) => value.answers !== null).length,
      cacheHits: 0,
      suggested: items.filter((value) => value.outcome === "suggested").length,
      needsReview: items.filter((value) => value.outcome === "needs-review").length,
      skipped: items.filter((value) => value.outcome === "skipped").length,
      failed: items.filter((value) => value.outcome === "failed").length,
      deferred: 0,
      reportedCostUsd: 0,
      hasUnknownCost: false,
      cachedHistoricalCostUsd: 0,
      hasUnknownHistoricalCost: false,
      oversized: 0,
    },
  };
}

function pending(): NonNullable<SemanticReportItem["receipt"]> {
  return {
    pending: {
      schemaVersion: 1,
      requestId: "request-1",
      inputHash: "hash",
      modelRequested: "typesafe-ai/jev",
      adapterVersion: "gateway-http-v1",
      createdAt: TIME,
      phase: "pending",
      durable: true,
    },
    final: null,
  };
}

function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function render(value: SemanticPreview | SemanticReport): string {
  return value.kind === "classification-preview"
    ? renderClassificationPreview(value)
    : renderClassificationReport(value);
}

function section(output: string, heading: string, level = 2): string {
  const marker = `\n${"#".repeat(level)} ${heading}`;
  const start = output.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = output.indexOf(`\n${"#".repeat(level)} `, start + marker.length);
  return output.slice(start, end < 0 ? undefined : end);
}

describe("classification report component view", () => {
  test("retains every item once, separates outcomes and preserves the original JSON and order", () => {
    const engine = item(9);
    engine.answers = { ...engine.answers, component: choice("engine") };
    const ambiguous = item(7, { outcome: "needs-review" });
    ambiguous.answers = { ...ambiguous.answers, component: choice("multiple") };
    const values = [
      engine,
      item(3),
      item(2, { outcome: "needs-review", reasonCodes: ["evidence-incomplete"] }),
      item(5, { outcome: "failed", answers: null }),
      item(6, { outcome: "skipped", answers: null, reasonCodes: ["state-changed"] }),
      item(4, { outcome: "skipped", answers: null, reasonCodes: ["max-calls-reached"] }),
      ambiguous,
      item(8, { outcome: "failed", answers: null, receipt: pending() }),
      item(1, { componentStatus: "unavailable", answers: { requestType: choice("bug") } }),
      item(10, { outcome: "needs-review", answers: null }),
      item(11),
    ];
    const value = report(values);
    const before = JSON.stringify(value);
    const references = [...value.items];
    const output = renderClassificationReport(freeze(value));
    expect(JSON.stringify(value)).toBe(before);
    expect(value.items).toEqual(references);
    for (const [index, entry] of references.entries()) {
      expect(value.items[index]).toBe(entry);
      expect(output.split(`| ${escapeSemanticMarkdown(entry.key)} |`)).toHaveLength(2);
    }
    const cli = section(output, "Component: cli (3)", 3);
    expect(cli).toContain("| o/r\\#3 | suggested |");
    expect(cli).toContain("| o/r\\#2 | needs\\-review |");
    expect(cli.indexOf("o/r\\#3")).toBeLessThan(cli.indexOf("o/r\\#2"));
    expect(cli.indexOf("o/r\\#2")).toBeLessThan(cli.indexOf("o/r\\#11"));
    expect(section(output, "Component: engine (1)", 3)).toContain("o/r\\#9");
    expect(section(output, "needs-review (1)")).toContain("o/r\\#7");
    expect(section(output, "failed (1)")).toContain("o/r\\#5");
    expect(section(output, "skipped (1)")).toContain("o/r\\#6");
    expect(section(output, "deferred (1)")).toContain("o/r\\#4");
    expect(section(output, "unknown (2)")).toContain("o/r\\#8");
    expect(section(output, "unknown (2)")).toContain("o/r\\#10");
    expect(section(output, "no-taxonomy (1)")).toContain("o/r\\#1");
    expect(output).not.toContain("Component: unused");
  });

  test("shows compact selected probabilities and signals, leaving exact distributions only in JSON", () => {
    const value = report();
    const before = JSON.stringify(value);
    const output = renderClassificationReport(freeze(value));
    expect(output).toContain(
      "| Issue | Outcome | Request type | Component p | Signals | Reported impact | Review |",
    );
    expect(output).toContain(
      "| repro p(true)=0.9; expected/observed p(true)=0.7; regression p(true)=0.3 |",
    );
    expect(output).toContain("| bug (p=0.8) | p=0.8 |");
    expect(output).toContain("| 1.9 / 3 |");
    expect(output).not.toContain("cli (p=");
    expect(output).not.toContain("probabilities:");
    expect(output).not.toContain("insufficient=0.2");
    expect(output).not.toContain("margin=");
    expect(output).toContain("Exact distributions remain only in JSON, without normalization.");
    expect(JSON.stringify(value)).toBe(before);
    expect(output).toContain("Human review required for every suggestion.");
    expect(output).toContain("not measured accuracy or permission to act");
    expect(output).toContain("Reported impact is not confirmed technical priority.");
    expect(output).toContain("No probability threshold auto-accepts an item.");
  });

  test("marks tied components as uncertainty without choosing an arbitrary group", () => {
    const entry = item();
    entry.answers = { ...entry.answers, component: choice("cli", { cli: 0.5, engine: 0.5 }) };
    const output = renderClassificationReport(report([entry]));
    expect(output).not.toContain("### Component:");
    expect(section(output, "needs-review (1)")).toContain("cli (p=0.5); uncertainty: tied-top");
    expect(section(output, "needs-review (1)")).toContain("| suggested |");
  });

  test.each([
    "requestType",
    "impactReported",
  ])("shows uncertainty for tied %s diagnostics", (id) => {
    const entry = item();
    entry.answers = {
      ...entry.answers,
      [id]:
        id === "requestType"
          ? choice("bug", { bug: 0.5, feature: 0.5 })
          : {
              type: "score",
              score: 0.5,
              levels: ["none", "some"],
              probabilities: { "0": 0.5, "1": 0.5 },
              topProbability: 0.5,
              margin: 0,
              providerConfidence: null,
            },
    };
    expect(renderClassificationReport(report([entry]))).toContain("uncertainty: tied-top");
  });

  test.each([
    0, 0.4999, 0.5, 0.5001, 1,
  ])("shows boolean probability %s without invented verdicts or rounding", (probability) => {
    const entry = item();
    entry.answers = {
      ...entry.answers,
      reproStepsPresent: { type: "boolean", probability, providerConfidence: null },
    };
    const row = renderClassificationReport(report([entry]))
      .split("\n")
      .find((line) => line.startsWith("| o/r"));
    expect(row).toContain(`p(true)=${probability}`);
    expect(row?.includes("uncertainty: p=0.5")).toBe(probability === 0.5);
    expect(row).not.toContain("confirmed");
  });

  test("does not promote high probabilities or demote lower ones", () => {
    const review = item(1, { outcome: "needs-review" });
    review.answers = { ...review.answers, component: choice("cli", { cli: 1, engine: 0 }) };
    const suggested = item(2);
    suggested.answers = {
      ...suggested.answers,
      component: choice("cli", { cli: 0.34, engine: 0.33, insufficient: 0.33 }),
    };
    const output = renderClassificationReport(report([review, suggested]));
    expect(output).toContain("| o/r\\#1 | needs\\-review |");
    expect(output).toContain("| o/r\\#2 | suggested |");
    expect(output).toContain("| p=0.34 |");
    expect(output).toContain("### Component: cli (2)");
    expect(output).not.toContain("####");
  });

  test("preserves rounded distributions and parent reason codes without normalization or JSON additions", () => {
    const entry = item(1, {
      outcome: "needs-review",
      reasonCodes: ["component-distribution-rounded", "requestType-distribution-rounded"],
    });
    entry.answers = {
      ...entry.answers,
      component: choice("cli", { cli: 0.4444, engine: 0.3333, insufficient: 0.2222 }),
    };
    const value = report([entry]);
    const before = JSON.stringify(value);
    const output = renderClassificationReport(freeze(value));
    expect(output).toContain("| p=0.4444 |");
    expect(output).not.toContain("0.3333");
    expect(output).not.toContain("0.2222");
    expect(output).toContain("component\\-distribution\\-rounded");
    expect(output).toContain("requestType\\-distribution\\-rounded");
    expect(JSON.stringify(value)).toBe(before);
  });

  test("does not group a component whose selected choice differs from the highest probability", () => {
    const entry = item();
    entry.answers = { ...entry.answers, component: choice("cli", { cli: 0.1, engine: 0.9 }) };
    const output = renderClassificationReport(report([entry]));
    expect(section(output, "needs-review (1)")).toContain(
      "cli (p=0.1); uncertainty: choice-probability-mismatch (top=0.9)",
    );
    expect(output).not.toContain("### Component:");
  });

  test.each([
    "multiple",
    "new",
    "insufficient",
    "outside-taxonomy",
  ])("retains unresolved component %s", (component) => {
    const entry = item(1, { outcome: "needs-review" });
    entry.answers = { ...entry.answers, component: choice(component, { [component]: 1, cli: 0 }) };
    expect(section(renderClassificationReport(report([entry])), "needs-review (1)")).toContain(
      escapeSemanticMarkdown(component),
    );
  });

  test("keeps no-taxonomy separate without hiding the remaining signals", () => {
    const entry = item(1, { componentStatus: "unavailable" });
    const value = report([entry]);
    value.taxonomy = null;
    if (entry.answers) delete entry.answers.component;
    const output = renderClassificationReport(value);
    expect(output).toContain("Component classification unavailable: taxonomy-missing.");
    expect(section(output, "no-taxonomy (1)")).toContain(
      "| repro p(true)=0.9; expected/observed p(true)=0.7; regression p(true)=0.3 |",
    );
    expect(section(output, "no-taxonomy (1)")).toContain("bug (p=0.8)");
  });

  test.each([
    "max-calls-reached",
    "input-too-large",
    "run-aborted",
    "inference-disabled",
    "provider-unavailable",
    "gateway-credentials-unavailable",
    "cache-write-failed",
    "receipt-finalization-failed",
  ])("separates deferred %s from ordinary skipped and failed items", (reason) => {
    const value = report([
      item(1, { outcome: "skipped", answers: null, reasonCodes: [reason] }),
      item(2, { outcome: "failed", answers: null, reasonCodes: [reason] }),
    ]);
    const output = renderClassificationReport(value);
    expect(section(output, "deferred (1)")).toContain("| o/r\\#1 | skipped |");
    expect(section(output, "failed (1)")).toContain("| o/r\\#2 | failed |");
  });

  test("distinguishes a finalized unknown request and a blocked cache from known failures", () => {
    const receipt = pending();
    receipt.final = {
      ...receipt.pending,
      phase: "final",
      completedAt: TIME,
      result: {
        status: "failed",
        evaluatedAt: null,
        tokenUsage: { inputTokens: null, outputTokens: null },
        reportedCostUsd: null,
        errorCode: "timeout",
        outcomeUnknown: true,
      },
    };
    const value = report([
      item(1, { outcome: "failed", answers: null, receipt }),
      item(2, { outcome: "failed", answers: null, cacheStatus: "blocked" }),
      item(3, { outcome: "failed", answers: null, reasonCodes: ["in-flight-or-unknown"] }),
    ]);
    const output = renderClassificationReport(value);
    expect(section(output, "unknown (3)")).toContain("| o/r\\#1 | failed |");
    expect(output).not.toContain("## failed");
    expect(output).toContain("Do not retry pending/unknown outcomes blindly.");
  });

  test("hides inapplicable impact rather than treating it as technical priority", () => {
    const output = renderClassificationReport(
      report([item(1, { impactReportedStatus: "not-applicable" })]),
    );
    expect(output).toContain("| not\\-applicable |");
    expect(output).not.toContain("1.9 / 3");
  });

  test("shows unavailable signals rather than inferring absence", () => {
    const entry = item(1, {
      answers: { component: choice("cli") },
      impactReportedStatus: "unavailable",
    });
    const row = renderClassificationReport(report([entry]))
      .split("\n")
      .find((line) => line.startsWith("| o/r"));
    expect(row).toContain(
      "| repro unavailable; expected/observed unavailable; regression unavailable | unavailable |",
    );
    expect(row).not.toContain("p(true)=0");
  });

  test("retains current and historical cache costs as different diagnostics", () => {
    const value = report([item(1, { cacheStatus: "hit" })]);
    value.execution.cache = "enabled";
    value.totals.cacheHits = 1;
    value.totals.cachedHistoricalCostUsd = 0.012;
    value.totals.hasUnknownHistoricalCost = true;
    value.totals.hasUnknownCost = true;
    const output = renderClassificationReport(value);
    expect(output).toContain("Gateway attempts: 0/50");
    expect(output).toContain("Reported cost known subtotal: USD 0; unknown cost: yes");
    expect(output).toContain(
      "Cached historical cost (not current spend): USD 0.012; unknown historical cost: yes",
    );
    expect(output).toContain("Cache: enabled; hits 1");
    expect(output).toContain("cache: hit");
  });

  test("omits unused components and empty review groups for a nonempty scope", () => {
    const value = report();
    value.taxonomy = { version: "v1", components: ["cli", "a", "b", "c", "d", "e", "f", "g"] };
    const output = renderClassificationReport(value);
    expect(output.match(/^### Component:/gm)).toHaveLength(1);
    expect(output).not.toMatch(/^#{2,4} .*\(0\)$/m);
    expect(output).not.toContain("No items in this group.");
    expect(output.match(/^\| Issue /gm)).toHaveLength(1);
    for (const group of ["needs-review", "failed", "skipped", "deferred", "unknown", "no-taxonomy"])
      expect(output).not.toContain(`## ${group}`);
  });

  test("keeps request-type mismatch evidence visible without displaying its vector", () => {
    const entry = item(1, {
      outcome: "needs-review",
      reasonCodes: ["choice-probability-mismatch"],
    });
    entry.answers = { ...entry.answers, requestType: choice("bug", { bug: 0.1, feature: 0.9 }) };
    const value = report([entry]);
    const before = JSON.stringify(value);
    const output = renderClassificationReport(freeze(value));
    expect(output).toContain("bug (p=0.1); uncertainty: choice-probability-mismatch (top=0.9)");
    expect(output).toContain("choice\\-probability\\-mismatch");
    expect(output).not.toContain("feature=0.9");
    expect(JSON.stringify(value)).toBe(before);
  });
});

describe.each(["preview", "report"] as const)("%s coverage and adversarial text", (kind) => {
  const create = kind === "preview" ? preview : report;

  test("keeps a verified empty scope explicit", () => {
    const output = render(create([]));
    expect(output).toContain("No open issues observed in the captured scope.");
    expect(output).toContain("No classifications available.");
    expect(output).toContain("Issue inventory coverage: complete");
    expect(output).toContain("Neither implies classification coverage.");
    if (kind === "report")
      expect(output).toContain("Classification availability: 0/0 captured items have answers");
  });

  test.each([
    null,
    1,
  ])("does not claim an empty repository for an empty capture with total %s", (total) => {
    const value = create([]);
    value.coverage.total = total;
    const output = render(value);
    expect(output).toContain("Issue inventory coverage: incomplete");
    expect(output).toContain("No verified issue inventory is available.");
    expect(output).not.toContain("No open issues observed");
  });

  test("does not trust a complete flag when pagination remains open", () => {
    const value = create();
    value.coverage.hasNextPage = true;
    expect(render(value)).toContain(
      "Issue inventory coverage: incomplete; evidence coverage: incomplete",
    );
  });

  test("does not trust a complete flag when displayed items do not match capture totals", () => {
    const value = create();
    value.totals.captured = 2;
    expect(render(value)).toContain("Issue inventory coverage: incomplete");
  });

  test("separates complete issue inventory from incomplete comments and classification", () => {
    const value = create();
    value.items[0].evidence.commentsCoverage = {
      ...coverage(1),
      total: 2,
      complete: false,
      reasonCodes: ["comment-page-limit"],
    };
    const output = render(value);
    expect(output).toContain("Issue inventory coverage: complete; evidence coverage: incomplete");
    expect(output).toContain("1/2");
    if (kind === "report") expect(output).toContain("comment\\-page\\-limit");
  });

  test("preserves coverage reasons and stale metadata even for an otherwise complete inventory", () => {
    const value = create();
    value.coverageComplete = false;
    value.coverage.reasonCodes = ["needs [refresh]"];
    const output = render(value);
    expect(output).toContain("evidence coverage: incomplete");
    expect(output).toContain("Coverage: needs \\[refresh\\].");
  });

  test("escapes Markdown, HTML, controls, bidi and next-step commands without rendering hidden evidence", () => {
    const attack = "<script>&|[link](javascript:alert(1))\n## injected\r\u001b\u202e`code`";
    const value = create();
    value.scope.repo = attack;
    value.cacheEpoch = attack;
    value.items[0].key = `o/r#1${attack}`;
    value.items[0].reasonCodes = [attack];
    value.items[0].url = "https://example.invalid/hidden-url";
    value.items[0].evidence.comments = [
      {
        id: "hidden-comment-id",
        url: "https://example.invalid/hidden-comment-url",
        author: "hidden-author",
        updatedAt: TIME,
      },
    ];
    value.coverage.reasonCodes = [attack];
    value.taxonomy = { version: attack, components: [attack] };
    value.nextSteps = [{ action: "rerun-preview", description: attack, command: attack }];
    if (value.kind === "classification-report") {
      value.items[0].answers = { component: choice(attack), requestType: choice(attack) };
    }
    const output = render(freeze(value));
    expect(output).toContain(escapeSemanticMarkdown(attack));
    expect(output).toContain(`Command: ${escapeSemanticMarkdown(attack)}`);
    expect(output).not.toContain("<script>");
    expect(output).not.toContain("[link](javascript:");
    expect(output).not.toContain("\n## injected");
    expect(output).not.toMatch(/\p{Cf}/u);
    expect(output).not.toContain("\r");
    expect(output).not.toContain(String.fromCharCode(27));
    expect(output).not.toContain("hidden-author");
    expect(output).not.toContain("hidden-comment");
    expect(output).not.toContain("hidden-url");
    const rows = output.split("\n").filter((line) => line.startsWith("| o/r"));
    expect(rows).toHaveLength(1);
    expect(rows[0].split(/(?<!\\)\|/)).toHaveLength(9);
    if (kind === "report")
      expect(output).toContain(`### Component: ${escapeSemanticMarkdown(attack)} (1)`);
  });
});

describe("preview has no predictions", () => {
  test("a cache hit shows only preview metadata even if extra answer fields are present", () => {
    const value = preview();
    value.execution.cache = "read-only";
    value.totals.cacheHits = 1;
    value.totals.plannedCalls = 0;
    value.items[0].plannedCall = false;
    value.items[0].cacheStatus = "hit";
    Object.assign(value.items[0], { answers: item().answers });
    const before = JSON.stringify(value);
    const output = renderClassificationPreview(freeze(value));
    expect(JSON.stringify(value)).toBe(before);
    expect(output).toContain("No predictions are shown, including cache hits.");
    expect(output).toContain("Planned calls: 0");
    expect(output).toContain("| hit |");
    expect(output).toContain("No Jev calls, semantic suggestions or local writes.");
    expect(output).not.toContain("p(true)");
    expect(output).not.toContain("probabilities:");
    expect(output).not.toContain("bug (p=");
    expect(output).not.toContain("### Component:");
  });
});
