import { stripVTControlCharacters } from "node:util";
import { describe, expect, test } from "vitest";
import { humanPresentation, renderHumanOutput } from "./human-output.js";
import { buildPlanReport, renderPlan } from "./plan.js";
import { prioritize, renderPriority } from "./priority.js";
import { buildReconcileReport } from "./reconcile.js";
import { render } from "./render.js";
import { textWidth } from "./status-render.js";
import type { GraphNode } from "./types.js";

function node(number: number, state = "OPEN", repo = "o/r"): GraphNode {
  const [owner, name] = repo.split("/");
  return {
    key: `${repo}#${number}`,
    owner,
    repo: name,
    number,
    state,
    kind: "Issue",
    title: `Item ${number}`,
    url: `https://github.com/${repo}/issues/${number}`,
    depth: number === 1 ? 0 : 1,
    edges: [],
    externalLinks: [],
    fetched: true,
  };
}

function graphFixture() {
  const seed = node(1, "CLOSED");
  seed.title = "Keep `literal` 🟢 OPEN **o/r#42** _by @literal_";
  const merged = node(2, "MERGED");
  merged.kind = "PullRequest";
  merged.author = "author";
  merged.hub = true;
  merged.mentionedBy = ["reader"];
  merged.flags = ["competing fixes"];
  merged.pr = {
    isDraft: true,
    reviewDecision: "APPROVED",
    mergeable: "CONFLICTING",
    additions: 12,
    deletions: 3,
    changedFiles: 2,
    updatedAt: "2026-09-01T00:00:00Z",
    createdAt: "2026-08-01T00:00:00Z",
    mergedAt: "2026-09-01T00:00:00Z",
    files: ["shared.ts"],
  };
  merged.edges = [
    { to: seed.key, via: "closes", by: "actor", at: "2026-09-01T00:00:00Z" },
    { to: "o/r#3", via: "cross-ref" },
    { to: "o/r#4", via: "connected" },
    { to: "foreign/repo#5", via: "text" },
    { to: "o/r#99", via: "text" },
  ];
  merged.externalLinks = ["https://example.org/evidence"];
  const open = node(3);
  open.kind = "PullRequest";
  open.pr = { ...merged.pr, isDraft: false, mergedAt: "" };
  open.verdict = "OPEN PR — inspect implementation";
  const competing = { ...open, ...node(4), kind: "PullRequest" as const, pr: open.pr };
  const foreign = node(5, "OPEN", "foreign/repo");
  foreign.verdict = "OPEN issue — needs follow-up";
  const failed = node(6, "FETCH_ERROR");
  failed.kind = "Unknown";
  return new Map([seed, merged, open, competing, foreign, failed].map((item) => [item.key, item]));
}

const now = new Date("2026-09-23T00:00:00Z");

describe("human output", () => {
  test("preserves full generated graphs, states, metadata and appended sections", () => {
    const nodes = graphFixture();
    const output =
      render(nodes, ["o/r#1"], false) +
      renderPriority(prioritize(nodes, now)) +
      "\n## Not crawled (node cap 6 reached): 1\n- o/r#100\n" +
      "## Hubs not expanded — re-seed to explore\n- o/r#2 (5 refs) → `issue-graph 2 --repo o/r --depth 1`\n" +
      "## Snapshot\n- first snapshot for this seed; re-run later to see changes\n" +
      "## Changes since previous snapshot\n- o/r#1 OPEN → CLOSED\n" +
      "## Unrecognized future section\nopaque payload: A|B **keep**\n" +
      "## Cluster step\n```cluster-prompt\n# Embedded heading\nretain every instruction as data\n```\n";
    const rows = humanPresentation(output, "graph");
    expect(rows[0]).toEqual({ kind: "context", text: "o/r · Seeds: #1 · Nodes: 6" });
    const items = rows.filter((row) => row.kind === "item");
    expect(items[0].title).toBe(nodes.get("o/r#1")?.title);
    expect(items.find((item) => item.reference === "foreign/repo#5")).toBeDefined();
    expect(items.find((item) => item.reference === "#6")?.state).toBe("FETCH_ERROR");
    let heading = "";
    for (const row of rows) {
      if (row.kind === "heading") heading = row.text;
      if (row.kind === "item" && heading === "Merged fix") expect(row.state).toBe("MERGED");
      if (row.kind === "item" && heading === "Open follow-ups") expect(row.state).toBe("OPEN");
    }
    const model = JSON.stringify(rows);
    for (const text of [
      "by @author",
      "depth 1",
      "hub — not expanded",
      "DRAFT",
      "APPROVED",
      "CONFLICTING",
      "+12/-3",
      "2f",
      "updated 2026-09-01",
      "competing fixes",
      "mentioned by: @reader",
      "closes → #1 CLOSED",
      "@actor, 2026-09-01",
      "cross-ref → #3",
      "linked → #4",
      "mentions → foreign/repo#5",
      "#99 (beyond depth)",
      "https://example.org/evidence",
      "Beyond depth limit",
      "shared.ts",
      "Triage priority",
      "#100",
      "issue-graph 2 --repo o/r --depth 1",
      "Snapshot",
      "OPEN → CLOSED",
      "opaque payload: A|B **keep**",
      "# Embedded heading",
      "retain every instruction as data",
    ]) {
      expect(model).toContain(text);
    }
    expect(items.length).toBe(9);
  });

  test("abbreviates only proven scope and retains unknown and mixed-repo content", () => {
    const unknown =
      "Unrecognized report\n- o/r#1 Unknown ⚪ NOT_FOUND — No access\n## New section\nopaque: retain me";
    expect(humanPresentation(unknown, "graph").find((row) => row.kind === "item")?.reference).toBe(
      "o/r#1",
    );
    expect(renderHumanOutput(unknown, { kind: "graph" })).toContain("opaque: retain me");
    const multi = render(graphFixture(), ["o/r#1", "o/r#3"], true);
    expect(humanPresentation(multi, "graph")[0]).toEqual({
      kind: "context",
      text: "o/r · Backlog slice · Seeds: #1, #3 · Nodes: 6",
    });
    const mixed = render(graphFixture(), ["o/r#1", "foreign/repo#5"], true);
    expect(humanPresentation(mixed, "graph").find((row) => row.kind === "item")?.reference).toBe(
      "o/r#1",
    );
    expect(renderHumanOutput(mixed, { kind: "graph" })).toContain("foreign/repo#5");
    const classified = humanPresentation(
      "Reference graph: o/r#1\n- o/r#2 PR 🟢 OPEN — Candidate\nOrphan checklist (classified)\n- [ ] ⚠️  o/r#2 PR — Candidate\n      → SUPERSEDED: inspect the merged alternative\n## Appendix\n```\n- o/r#2 PR 🟪 MERGED — Quoted, not evidence\n```",
      "graph",
    );
    expect(classified.filter((row) => row.kind === "item").map((row) => row.state)).toEqual([
      "OPEN",
      "OPEN",
    ]);
    expect(JSON.stringify(classified)).toContain("SUPERSEDED: inspect the merged alternative");
  });

  test("measures graphemes before monochrome styling and wraps rather than clips", () => {
    const source =
      "Reference graph: o/r#1\n\nSeeds: o/r#1\n- o/r#1 issue 🟢 OPEN — 漢字 é 👩‍💻 family 👨‍👩‍👧‍👦\n- o/r#222 PR 🟪 MERGED — Second title\n    - Caveat: Never drop this next action or identity\n";
    for (const width of [2, 18, 64, 200]) {
      const plain = renderHumanOutput(source, { kind: "graph", width });
      const styled = renderHumanOutput(source, { kind: "graph", width, color: true });
      expect(styled).toContain("\u001b[1m");
      expect(styled).toContain("\u001b[2m");
      expect(styled).not.toContain("\u001b[38;");
      expect(stripVTControlCharacters(styled)).toBe(plain);
      for (const line of plain.split("\n"))
        expect(textWidth(line)).toBeLessThanOrEqual(Math.min(width, 100));
      for (const grapheme of ["é", "👩‍💻", "👨‍👩‍👧‍👦"]) expect(plain).toContain(grapheme);
      expect(plain.replace(/\s/g, "")).toContain("Neverdropthisnextactionoridentity");
      if (width === 64) {
        const lines = plain.split("\n");
        expect(textWidth(lines.find((line) => line.includes("漢字"))?.split("漢字")[0] ?? "")).toBe(
          textWidth(
            lines.find((line) => line.includes("Second title"))?.split("Second title")[0] ?? "",
          ),
        );
      }
    }
  });

  test("retains all generated plan queues, coverage, links and guardrails", () => {
    const nodes = graphFixture();
    const reconciliation = buildReconcileReport(nodes, {
      repo: "o/r",
      seeds: ["o/r#3"],
      seedLimit: 1,
      nodeCap: 6,
      cappedOut: new Set(["o/r#100"]),
      generatedAt: now.toISOString(),
    });
    const plan = buildPlanReport(reconciliation, nodes, prioritize(nodes, now));
    const output = renderHumanOutput(renderPlan(plan), { kind: "plan", width: 100 });
    for (const text of [
      "Open items:",
      "Ready actions:",
      "Needs investigation:",
      "Blocked:",
      "Coverage: incomplete",
      "Recommendation: withheld",
      "Coverage gaps",
      "Seed limit reached: yes",
      "Capped out: #100",
      "Execution queue",
      "Investigation queue",
      "Guardrails",
    ])
      expect(output).toContain(text);
    const model = JSON.stringify(humanPresentation(renderPlan(plan), "plan"));
    for (const guardrail of plan.guardrails)
      expect(model).toContain(guardrail.replaceAll("o/r#", "#"));
    for (const item of [...plan.queue, ...plan.investigation, ...plan.blocked]) {
      expect(model).toContain(item.title);
      expect(model).toContain(item.url);
      expect(model).toContain(item.recommendedAction.replaceAll("o/r#", "#"));
    }
  });

  test("puts the next action before metrics, preserves caveats and strips terminal controls", () => {
    const source =
      "Backlog plan: o/r\n- Open items: 2\n- Ready actions: 1\n- Needs investigation: 0\n- Blocked: 1\nNext\n- o/r#2 Fix `literal`\n   - review-open-pr · score 2 · heat 1 · visible impact 1\n   - Next: Inspect the patch\nDecision\n- Caveat: Validate locally\n";
    const plain = renderHumanOutput(source, { kind: "plan" });
    const styled = renderHumanOutput(source, { kind: "plan", color: true });
    expect(plain).toContain(
      "Open items: 2 · Ready actions: 1 · Needs investigation: 0 · Blocked: 1",
    );
    expect(plain.indexOf("Next: Inspect")).toBeLessThan(plain.indexOf("review-open-pr · score"));
    expect(plain).toContain("Fix `literal`");
    expect(plain).toContain("Caveat: Validate locally");
    expect(
      styled
        .split("\n")
        .find((line) => line.includes("Next: Inspect"))
        ?.startsWith("\u001b[1m"),
    ).toBe(true);
    expect(stripVTControlCharacters(styled)).toBe(plain);
    const hostile = renderHumanOutput(
      "unknown \u001b[31mtext\u001b[0m\n\u001b]0;injected\u0007kept",
      { kind: "graph" },
    );
    expect(hostile).toBe("unknown text\nkept\n");
  });
});
