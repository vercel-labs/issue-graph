import { describe, expect, test } from "vitest";
import {
  buildStatusReport,
  type StatusCoverage,
  type StatusPullRequest,
  type StatusReport,
  type StatusView,
} from "./status.js";
import { formatStatusCapture, renderStatus, safeStatusText, textWidth } from "./status-render.js";

const start = "2026-09-09T10:00:00.000Z";
const end = "2026-09-09T10:00:03.000Z";
const esc = String.fromCharCode(27);
const stripColor = (value: string) => value.replace(new RegExp(`${esc}\\[[0-9;]*m`, "g"), "");

function pr(number: number, overrides: Partial<StatusPullRequest> = {}): StatusPullRequest {
  return {
    id: `acme/app#${number}`,
    repo: "acme/app",
    number,
    author: "alice",
    title: `Change ${number}`,
    url: `https://github.com/acme/app/pull/${number}`,
    headSha: "1234567890abcdef1234567890abcdef12345678",
    updatedAt: end,
    isDraft: false,
    reviewState: "required",
    mergeability: "MERGEABLE",
    assignees: ["alice"],
    requestedReviewers: ["acme/reviewers", "bob"],
    ...overrides,
  };
}

function coverage(repo: string, complete = true): StatusCoverage {
  return {
    repo,
    complete,
    pages: complete ? 2 : 1,
    scanned: complete ? 51 : 50,
    errors: complete ? [] : [{ code: "PAGE_LIMIT", message: "Inventory stopped at the page cap." }],
  };
}

function fixture(
  prs: StatusPullRequest[] = [
    pr(1),
    pr(2, { reviewState: "changes-requested", mergeability: "CONFLICTING", assignees: [] }),
    pr(3, { reviewState: "approved", isDraft: true }),
    pr(4, { reviewState: "not-required" }),
    pr(5, { reviewState: "unknown", mergeability: "UNKNOWN", assignees: null, isDraft: null }),
    pr(6, { repo: "acme/api", author: "bob", reviewState: "approved" }),
  ],
  repositories = [coverage("acme/app"), coverage("acme/api")],
): StatusReport {
  return buildStatusReport(prs, repositories, {
    repos: repositories.map((item) => item.repo),
    authors: ["alice", "bob"],
    startedAt: start,
    generatedAt: end,
  });
}

function body(output: string): string {
  return output
    .slice(output.indexOf("\n\n") + 2)
    .split(/(?:Incomplete|Unknown) count details/)[0]
    .split("? means unknown, not zero.")[0];
}

function block(output: string, name: string): string {
  const section = body(output)
    .split(/(?=^(?:[\w.-]+\/[\w.-]+(?: ·[^\n]+)?|Total ·[^\n]+)$)/m)
    .find((part) => part.startsWith(`${name}\n`) || part.startsWith(`${name} ·`));
  if (!section) throw new Error(`Expected status block for ${name}`);
  return section;
}

function tableRows(section: string, heading: string, count: number): string[][] {
  const lines = section.split("\n");
  const index = lines.findIndex((line) => line.includes(heading));
  if (index < 0) throw new Error(`Expected table ${heading}`);
  const from = lines[index].indexOf(heading);
  const to =
    heading === "Author" ? lines[index].indexOf("Open PRs") + "Open PRs".length : undefined;
  return lines.slice(index + 1, index + 1 + count).map((line) => {
    const row = line
      .slice(from, to)
      .trim()
      .match(/^(.+?)\s+(\d+|\?)$/);
    if (!row) throw new Error(`Expected labeled count: ${line}`);
    return [row[1], row[2]];
  });
}

const views: StatusView[] = ["authors", "projects", "prs"];

describe("safeStatusText", () => {
  test("removes ANSI, OSC links, control strings, C0/C1 controls and bidi spoofing", () => {
    const value = `${esc}[31mred${esc}[0m ${esc}]8;;https://evil.test${esc}\\link${esc}]8;;\x07 ${esc}Psecret${esc}\\done\x00\x7f\x85next\nline\tcell\u202eevil\u2066`;
    expect(safeStatusText(value)).toBe("red link done next line cellevil");
    expect(safeStatusText("\x9b31mhello\x9b0m \x9dtitle\x9cworld")).toBe("hello world");
    expect(safeStatusText(`${esc}]unterminated payload`)).toBe("");
    expect(safeStatusText(`safe${esc}[`)).toBe("safe");
    expect(safeStatusText(`a${esc}(Bb${esc}7c`)).toBe("abc");
  });

  test("preserves Unicode graphemes, visible text and idempotence", () => {
    const value = "修正 👩🏽‍💻 cafe\u0301 🇵🇪 <title> [link]";
    expect(safeStatusText(value)).toBe(value);
    expect(safeStatusText(safeStatusText(`${esc}[1m${value}\n`))).toBe(value);
    expect(safeStatusText("a\r\nb\u2028c\u2029d")).toBe("a  b c d");
  });
});

describe("formatStatusCapture", () => {
  test("uses the absolute UTC end date and measured duration, including year rollover", () => {
    expect(formatStatusCapture("2026-09-22T20:49:02.373Z", "2026-09-22T20:49:05.606Z")).toBe(
      "Captured Sep 22, 2026 at 20:49 UTC · Query 3.2s",
    );
    expect(formatStatusCapture("2026-12-31T23:59:58.500Z", "2027-01-01T00:00:01.000Z")).toBe(
      "Captured Jan 1, 2027 at 00:00 UTC · Query 2.5s",
    );
    expect(formatStatusCapture("2024-02-29T23:59:59Z", "2024-03-01T00:00:00Z")).toBe(
      "Captured Mar 1, 2024 at 00:00 UTC · Query 1.0s",
    );
  });

  test("missing, impossible and backwards timestamps never invent a duration", () => {
    for (const value of [
      "",
      "invalid",
      "2026-02-30T10:00:00Z",
      "2026-09-09T25:00:00Z",
      "2026-09-09T10:00:00.000001Z",
    ])
      expect(formatStatusCapture(start, value)).toBe("Captured unknown · Query unknown");
    expect(formatStatusCapture("", end)).toBe("Captured Sep 9, 2026 at 10:00 UTC · Query unknown");
    expect(formatStatusCapture(end, start)).toBe(
      "Captured Sep 9, 2026 at 10:00 UTC · Query unknown",
    );
  });

  test("distinguishes a zero query from sub-tenth-second work without printing date milliseconds", () => {
    expect(formatStatusCapture(start, start)).toBe(
      "Captured Sep 9, 2026 at 10:00 UTC · Query 0.0s",
    );
    expect(formatStatusCapture(start, "2026-09-09T10:00:00.001Z")).toBe(
      "Captured Sep 9, 2026 at 10:00 UTC · Query <0.1s",
    );
    expect(formatStatusCapture(start, "2026-09-09T10:00:00.100Z")).toBe(
      "Captured Sep 9, 2026 at 10:00 UTC · Query 0.1s",
    );
  });
});

describe("renderStatus authors", () => {
  test("leads with an absolute UTC capture and preserves coverage and truthful totals", () => {
    const output = renderStatus(fixture());
    expect(output.split("\n\n")[0].split("\n")).toEqual([
      "issue-graph status",
      "Captured Sep 9, 2026 at 10:00 UTC · Query 3.0s · Coverage complete",
    ]);
    expect(block(output, "Total")).toContain("Total · 6 open PRs");
    const unwrapped = output.replaceAll("\n", "");
    expect(unwrapped).toContain("Drafts ? (at least 1 known; 1 unknown PRs)");
    expect(unwrapped).toContain("Unassigned ? (at least 1 known; 1 unknown PRs)");
    expect(unwrapped).toContain("Merge unknown 1");
    expect(output).toContain("Unknown count details");
    expect(output).toContain("Conflicts: ? (at least 1 known; 1 unknown PRs)");
    expect(output).not.toContain("scanned");
    expect(output).toContain("Approval does not imply merge readiness.");
    expect(output).toContain("Flags overlap review states.");
    expect(output).not.toContain("Approved is not mergeable");
  });

  test("groups each repository once without losing per-author reviews or independent flags", () => {
    const output = renderStatus(fixture());
    const app = block(output, "acme/app");
    const api = block(output, "acme/api");
    expect(body(output).match(/^acme\/(?:app|api)$/gm)).toHaveLength(2);
    expect(tableRows(app, "Author", 2)).toEqual([
      ["alice", "5"],
      ["bob", "0"],
    ]);
    expect(tableRows(api, "Author", 2)).toEqual([
      ["alice", "0"],
      ["bob", "1"],
    ]);
    expect(tableRows(app, "Review state · alice", 5)).toEqual([
      ["Needs review", "1"],
      ["Approved", "1"],
      ["Changes requested", "1"],
      ["Not required", "1"],
      ["Unknown", "1"],
    ]);
    expect(tableRows(app, "Review state · bob", 5).map((row) => row[1])).toEqual([
      "0",
      "0",
      "0",
      "0",
      "0",
    ]);
    expect(tableRows(api, "Review state · bob", 5).map((row) => row[1])).toEqual([
      "0",
      "1",
      "0",
      "0",
      "0",
    ]);
    expect(tableRows(api, "Review state · alice", 5).map((row) => row[1])).toEqual([
      "0",
      "0",
      "0",
      "0",
      "0",
    ]);
    expect(tableRows(block(output, "Total"), "Review state", 5).map((row) => row[1])).toEqual([
      "1",
      "2",
      "1",
      "1",
      "1",
    ]);
    expect(app.replaceAll("\n", "")).toContain(
      "Flags (alice): Drafts ? (at least 1 known; 1 unknown PRs) · Conflicts ?",
    );
    expect(app.replaceAll("\n", "")).toContain(
      "Flags (bob): Drafts 0 · Conflicts 0 · Unassigned 0 · Merge unknown 0",
    );
    expect(output).not.toContain(" │ ");
  });

  test("uses supplied counts, never recalculates from evidence or subtracts review buckets", () => {
    const report = fixture([]);
    report.rows[0].counts.open = { count: 47, prIds: [], unknownIds: [] };
    report.rows[0].counts.approved = { count: 99, prIds: [], unknownIds: [] };
    report.totals.open = { count: 200, prIds: [], unknownIds: [] };
    const output = renderStatus(report);
    expect(block(output, "Total")).toContain("Total · 200 open PRs");
    const api = block(output, "acme/api");
    expect(tableRows(api, "Author", 2)).toEqual([
      ["alice", "47"],
      ["bob", "0"],
    ]);
    expect(tableRows(api, "Review state · alice", 5)).toEqual([
      ["Needs review", "0"],
      ["Approved", "99"],
      ["Changes requested", "0"],
      ["Not required", "0"],
      ["Unknown", "0"],
    ]);
    expect(body(output)).not.toMatch(/-\d/);
  });

  test("five repositories keep ten author rows grouped with a full-scope drilldown", () => {
    const repos = ["acme/alpha", "acme/bravo", "acme/charlie", "acme/delta", "acme/echo"];
    const report = fixture(
      repos.flatMap((repo, index) => [
        pr(index * 2 + 1, { repo }),
        pr(index * 2 + 2, { repo, author: "bob" }),
      ]),
      repos.map((repo) => coverage(repo)),
    );
    const output = renderStatus(report);
    expect(output.trimEnd().split("\n").length).toBeLessThanOrEqual(110);
    expect(output.split("\n\n")[0].split("\n")).toHaveLength(2);
    expect(body(output).match(/^acme\/\w+$/gm)).toHaveLength(5);
    for (const repo of repos) {
      const section = block(output, repo);
      expect(tableRows(section, "Author", 2)).toEqual([
        ["alice", "1"],
        ["bob", "1"],
      ]);
      for (const author of ["alice", "bob"])
        expect(tableRows(section, `Review state · ${author}`, 5).map((row) => row[1])).toEqual([
          "1",
          "0",
          "0",
          "0",
          "0",
        ]);
    }
    const total = block(output, "Total");
    expect(total).toContain("Total · 10 open PRs");
    expect(tableRows(total, "Review state", 5).map((row) => row[1])).toEqual([
      "10",
      "0",
      "0",
      "0",
      "0",
    ]);
    expect(total).toContain("Flags: Drafts 0 · Conflicts 0 · Unassigned 0 · Merge unknown 0");
    expect(output).not.toContain("count details");
    expect(output).not.toContain("scanned");
    const command = `issue-graph status ${repos.map((repo) => `--repo ${repo}`).join(" ")} --author alice,bob --view prs`;
    const unwrapped = output.replaceAll("\\\n", "");
    expect(unwrapped).toContain(command);
    expect(output).toContain("alice,bob --view prs");
    expect(unwrapped.match(/issue-graph status --repo/g)).toHaveLength(1);
    for (const line of output.split("\n")) expect(line.length).toBeLessThanOrEqual(120);
    expect(stripColor(renderStatus(report, { color: true }))).toBe(output);
  });

  test("80-column TTY aligns the compact tables and narrow output stacks without lost data", () => {
    const repos = [
      "vercel-labs/agent-browser",
      "vercel-labs/agent-skills",
      "vercel-labs/just-bash",
      "vercel-labs/next-browser",
      "vercel-labs/skills",
    ];
    const report = fixture(
      repos.flatMap((repo, index) => [
        pr(index * 2 + 1, { repo }),
        pr(index * 2 + 2, { repo, author: "bob" }),
      ]),
      repos.map((repo) => coverage(repo)),
    );
    for (const width of [80, 120]) {
      const output = renderStatus(report, { width });
      expect(output.trimEnd().split("\n").length).toBeLessThanOrEqual(112);
      expect(body(output).match(/^vercel-labs\/[\w-]+$/gm)).toHaveLength(5);
      for (const repo of repos) {
        const section = block(output, repo);
        const lines = section.split("\n");
        const header = lines.findIndex((line) => line.startsWith("Author "));
        expect(lines[header]).toContain("Review state · alice");
        expect(tableRows(section, "Author", 2)).toEqual([
          ["alice", "1"],
          ["bob", "1"],
        ]);
        const numberEdge = lines[header].indexOf("Open PRs") + "Open PRs".length;
        for (const line of lines.slice(header + 1, header + 3))
          expect(line.slice(0, numberEdge).trimEnd().length).toBe(numberEdge);
        for (const author of ["alice", "bob"])
          expect(tableRows(section, `Review state · ${author}`, 5).map((row) => row[1])).toEqual([
            "1",
            "0",
            "0",
            "0",
            "0",
          ]);
      }
      const total = block(output, "Total");
      expect(total).toContain("Total · 10 open PRs");
      expect(tableRows(total, "Review state", 5).map((row) => row[1])).toEqual([
        "10",
        "0",
        "0",
        "0",
        "0",
      ]);
      for (const line of output.split("\n")) expect(textWidth(line)).toBeLessThanOrEqual(width);
      expect(stripColor(renderStatus(report, { width, color: true }))).toBe(output);
    }
    const narrow = renderStatus(report, { width: 40 });
    expect(narrow).toMatch(/^Author\s+Open PRs$/m);
    expect(narrow).toMatch(/^Review state · alice\s+PRs$/m);
    expect(narrow.replaceAll("\n", "")).toContain("Conflicts 0");
    expect(narrow).not.toContain(" │ ");
    for (const line of narrow.split("\n")) expect(textWidth(line)).toBeLessThanOrEqual(40);
    const longRepo = `acme/${"long-project-".repeat(5)}`;
    const long = renderStatus(fixture([pr(1, { repo: longRepo })], [coverage(longRepo)]), {
      width: 80,
    });
    expect(long).toMatch(/^alice\s+1\s+Needs review\s+1$/m);
    expect(long.replaceAll("\n", "")).toContain(longRepo);
    expect(long).not.toContain(" │ ");
  });

  test("total rows use report totals even when rows and evidence disagree", () => {
    const report = fixture([]);
    report.totals.open.count = 91;
    for (const view of ["authors", "projects"] as const) {
      const output = renderStatus(report, { view, width: 240 });
      const total = block(output, "Total");
      expect(total).toContain("Total · 91 open PRs");
      expect(tableRows(total, "Review state", 5).map((row) => row[1])).toEqual([
        "0",
        "0",
        "0",
        "0",
        "0",
      ]);
      expect(total).toContain("Conflicts 0");
    }
  });

  test("compact summary retains custom next steps without narrowing scope", () => {
    const report = fixture();
    const custom = "issue-graph status --repo acme/app --author alice --max-pages 20";
    report.nextSteps.push(custom);
    for (const format of ["table", "markdown"] as const) {
      const output = renderStatus(report, { format });
      expect(output).toContain(
        "issue-graph status --repo acme/api --repo acme/app --author alice,bob --view prs",
      );
      expect(output).toContain(custom);
      expect(output).not.toContain(
        "issue-graph status --repo acme/app --author alice,bob --view prs",
      );
    }
  });

  test("incomplete totals retain known lower bounds without invalidating sibling repositories", () => {
    const report = fixture(
      [pr(1), pr(2, { repo: "acme/api", author: "bob" })],
      [coverage("acme/app", false), coverage("acme/api")],
    );
    const output = renderStatus(report);
    expect(output).toContain("Coverage INCOMPLETE");
    expect(output).toContain("PAGE_LIMIT: Inventory stopped at the page cap.");
    expect(block(output, "Total")).toContain("Total · ? open PRs");
    expect(output).toContain("Open: ? (at least 2 known)");
    const app = block(output, "acme/app");
    expect(tableRows(app, "Author", 2)).toEqual([
      ["alice", "?"],
      ["bob", "?"],
    ]);
    for (const author of ["alice", "bob"])
      expect(tableRows(app, `Review state · ${author}`, 5).map((row) => row[1])).toEqual([
        "?",
        "?",
        "?",
        "?",
        "?",
      ]);
    const api = block(output, "acme/api");
    expect(tableRows(api, "Author", 2)).toEqual([
      ["alice", "0"],
      ["bob", "1"],
    ]);
    expect(tableRows(api, "Review state · bob", 5).map((row) => row[1])).toEqual([
      "1",
      "0",
      "0",
      "0",
      "0",
    ]);
    expect(output).toContain("Open: ? (at least 0 known)");
    expect(output).toContain("Open: ? (at least 1 known)");
  });

  test("does not omit owners when repository basenames collide", () => {
    const report = fixture(
      [pr(1), pr(2, { repo: "other/app" })],
      [coverage("acme/app"), coverage("other/app")],
    );
    const output = renderStatus(report, { width: 200 });
    expect(body(output)).toContain("acme/app");
    expect(body(output)).toContain("other/app");
    expect(output).not.toContain("Owner:");
  });
});

describe("renderStatus projects and PRs", () => {
  test("projects pair author open counts with aggregate reviews without inventing a breakdown", () => {
    const report = fixture();
    report.projects[0].authors[0].count = { count: 27, prIds: [], unknownIds: [] };
    const output = renderStatus(report, { view: "projects", width: 240 });
    expect(body(output).match(/^acme\/(?:api|app) ·/gm)).toHaveLength(2);
    const api = block(output, "acme/api");
    expect(api).toContain("acme/api · 1 open PR");
    expect(tableRows(api, "Author", 2)).toEqual([
      ["alice", "27"],
      ["bob", "1"],
    ]);
    expect(tableRows(api, "Review state", 5)).toEqual([
      ["Needs review", "0"],
      ["Approved", "1"],
      ["Changes requested", "0"],
      ["Not required", "0"],
      ["Unknown", "0"],
    ]);
    expect(api).toContain("Flags: Drafts 0 · Conflicts 0 · Unassigned 0 · Merge unknown 0");
    expect(api).not.toContain("Review state · alice");
    const total = block(output, "Total");
    expect(total).toContain("Total · 6 open PRs");
    expect(tableRows(total, "Review state", 5).map((row) => row[1])).toEqual([
      "1",
      "2",
      "1",
      "1",
      "1",
    ]);
    expect(total).not.toContain("Author");
    expect(output).toContain("Unknown count details");
    expect(output).toContain("Merge unknown 1");
  });

  test("project author column one right-aligns numbers and unknowns before coloring", () => {
    const report = buildStatusReport([], [coverage("acme/api"), coverage("acme/app")], {
      repos: ["acme/api", "acme/app"],
      authors: ["a", "b"],
      startedAt: start,
      generatedAt: end,
    });
    report.projects[0].authors[0].count.count = 123;
    report.projects[1].authors[0].count.count = 7;
    report.projects[1].authors[1].count.count = null;
    for (const width of [80, 120]) {
      const output = renderStatus(report, { view: "projects", width });
      const api = block(output, "acme/api");
      const app = block(output, "acme/app");
      expect(tableRows(api, "Author", 2)).toEqual([
        ["a", "123"],
        ["b", "0"],
      ]);
      expect(tableRows(app, "Author", 2)).toEqual([
        ["a", "7"],
        ["b", "?"],
      ]);
      const header = api.split("\n").find((line) => line.startsWith("Author ")) ?? "";
      const rightEdge = header.indexOf("Open PRs") + "Open PRs".length;
      const numericStart = header.indexOf("Open PRs");
      expect(
        api
          .split("\n")
          .find((line) => line.startsWith("a "))
          ?.slice(numericStart, rightEdge),
      ).toBe("     123");
      expect(
        app
          .split("\n")
          .find((line) => line.startsWith("a "))
          ?.slice(numericStart, rightEdge),
      ).toBe("       7");
      expect(
        app
          .split("\n")
          .find((line) => line.startsWith("b "))
          ?.slice(numericStart, rightEdge),
      ).toBe("       ?");
      const colored = renderStatus(report, { view: "projects", width, color: true });
      expect(stripColor(colored)).toBe(output);
      expect(colored).toContain(`${esc}[1m       ?${esc}[0m`);
    }
  });

  test("numeric-looking author identities remain left aligned", () => {
    const report = fixture([]);
    report.rows[0].author = "7";
    const output = renderStatus(report);
    const api = block(output, "acme/api");
    expect(tableRows(api, "Author", 2)).toEqual([
      ["7", "0"],
      ["bob", "0"],
    ]);
    expect(
      api
        .split("\n")
        .find((line) => line.startsWith("7 "))
        ?.slice(0, 6),
    ).toBe("7     ");
  });

  test("projects preserve zero rows and zero portfolio totals without inventing author totals", () => {
    const output = renderStatus(fixture([]), { view: "projects" });
    const total = block(output, "Total");
    expect(total).toContain("Total · 0 open PRs");
    expect(total).not.toContain("Author");
    expect(tableRows(total, "Review state", 5).map((row) => row[1])).toEqual([
      "0",
      "0",
      "0",
      "0",
      "0",
    ]);
    for (const repo of ["acme/api", "acme/app"]) {
      const section = block(output, repo);
      expect(section).toContain(`${repo} · 0 open PRs`);
      expect(tableRows(section, "Author", 2)).toEqual([
        ["alice", "0"],
        ["bob", "0"],
      ]);
      expect(tableRows(section, "Review state", 5).map((row) => row[1])).toEqual([
        "0",
        "0",
        "0",
        "0",
        "0",
      ]);
      expect(section).toContain("Flags: Drafts 0 · Conflicts 0 · Unassigned 0 · Merge unknown 0");
    }
  });

  test("projects preserve unknown author counts and portfolio lower bounds for incomplete captures", () => {
    const report = fixture([pr(1)], [coverage("acme/app", false), coverage("acme/api")]);
    const output = renderStatus(report, { view: "projects", width: 240 });
    const app = block(output, "acme/app");
    expect(app).toContain("acme/app · ? open PRs");
    expect(tableRows(app, "Author", 2)).toEqual([
      ["alice", "?"],
      ["bob", "?"],
    ]);
    for (const section of [app, block(output, "Total")]) {
      expect(tableRows(section, "Review state", 5).map((row) => row[1])).toEqual([
        "?",
        "?",
        "?",
        "?",
        "?",
      ]);
      expect(section.replaceAll("\n", "")).toContain("Conflicts ?");
    }
    expect(output).toContain("acme/app / alice Open: ? (at least 1 known)");
    expect(output).toContain("acme/app / bob Open: ? (at least 0 known)");
    expect(output).toContain("PAGE_LIMIT: Inventory stopped at the page cap.");
    expect(output).toContain("acme/api: complete");
  });

  test("deduplicates only fully known identical totals, including flags, and retains distinct unknown evidence", () => {
    const report = fixture([pr(1)], [coverage("acme/app")]);
    expect(renderStatus(report, { view: "projects" })).not.toMatch(/^Total ·/m);
    const oneAuthor = buildStatusReport([pr(1)], [coverage("acme/app")], {
      repos: ["acme/app"],
      authors: ["alice"],
      startedAt: start,
      generatedAt: end,
    });
    expect(renderStatus(oneAuthor)).not.toMatch(/^Total ·/m);
    report.totals.drafts.count = 9;
    expect(block(renderStatus(report, { view: "projects" }), "Total")).toContain("Drafts 9");
    report.totals.drafts.count = 0;
    report.projects[0].counts.conflicts = { count: null, prIds: [], unknownIds: ["acme/app#1"] };
    report.totals.conflicts = { count: null, prIds: ["acme/app#2"], unknownIds: ["acme/app#1"] };
    const output = renderStatus(report, { view: "projects" });
    expect(block(output, "acme/app").replaceAll("\n", "")).toContain(
      "Conflicts ? (at least 0 known; 1 unknown PRs)",
    );
    expect(block(output, "Total").replaceAll("\n", "")).toContain(
      "Conflicts ? (at least 1 known; 1 unknown PRs)",
    );
    expect(output).toContain("Unknown count details");
    expect(output).not.toContain("INCOMPLETE");
  });

  test("Unicode and taller author tables preserve visible numeric alignment before ANSI", () => {
    const report = fixture([], [coverage("acme/app")]);
    const names = ["界", "e\u0301", "👩🏽‍💻", "four", "five", "six", "seven", "eight"];
    report.scope.authors = names;
    report.projects[0].authors = names.map((author, index) => ({
      author,
      count: {
        count: index === 2 ? null : index === 0 ? 123 : index === 1 ? 7 : 0,
        prIds: [],
        unknownIds: [],
      },
    }));
    const plain = renderStatus(report, { view: "projects", width: 80 });
    const colored = renderStatus(report, { view: "projects", width: 80, color: true });
    expect(colored.length).toBeGreaterThan(plain.length);
    expect(stripColor(colored)).toBe(plain);
    const lines = block(plain, "acme/app").split("\n");
    const header = lines.find((line) => line.startsWith("Author ")) ?? "";
    const edge = textWidth(header.slice(0, header.indexOf("Open PRs") + 8));
    for (const [index, name] of names.entries()) {
      const line = lines.find((line) => line.startsWith(`${name} `)) ?? "";
      const prefix = line.match(/^.+?\s+(\d+|\?)(?=\s|$)/);
      expect(prefix?.[1]).toBe(index === 2 ? "?" : index === 0 ? "123" : index === 1 ? "7" : "0");
      expect(textWidth(prefix?.[0] ?? "")).toBe(edge);
    }
    const wide = lines.find((line) => line.startsWith("界 ")) ?? "";
    expect(textWidth(wide.slice(0, wide.indexOf("Needs review")))).toBe(
      header.indexOf("Review state"),
    );
    expect(wide.indexOf("Needs review")).not.toBe(header.indexOf("Review state"));
    for (const width of [8, 20, 40]) {
      const narrow = renderStatus(report, { view: "projects", width });
      expect(stripColor(renderStatus(report, { view: "projects", width, color: true }))).toBe(
        narrow,
      );
      for (const line of narrow.split("\n")) expect(textWidth(line)).toBeLessThanOrEqual(width);
      expect(narrow.replaceAll("\n", "")).toContain("👩🏽‍💻");
      expect(narrow).toContain("?");
    }
  });

  test("ledger preserves full evidence below state fields and offers real graph commands", () => {
    const title = "修正 👩🏽‍💻 cafe\u0301 🇵🇪 ".repeat(25);
    const report = fixture([
      pr(1, { title }),
      pr(2, {
        assignees: [],
        requestedReviewers: [],
        isDraft: true,
        mergeability: "CONFLICTING",
        reviewState: "approved",
      }),
      pr(3, {
        assignees: null,
        requestedReviewers: null,
        headSha: null,
        updatedAt: null,
        isDraft: null,
        mergeability: "UNKNOWN",
      }),
    ]);
    const output = renderStatus(report, { view: "prs", width: 2000 });
    expect(output).toContain(`Title: ${title.trim()}`);
    expect(output).toContain("Author: alice · State: open · Review: approved");
    expect(output).toContain("Draft: yes · Conflict: yes");
    expect(output).toContain("Draft: ? · Conflict: ?");
    expect(output).toContain("Assignees: none (unassigned)");
    expect(output).toContain("Assignees: ?");
    expect(output).toContain("Review requests: acme/reviewers, bob");
    expect(output).toContain("Review requests: none");
    expect(output).toContain("Review requests: ?");
    expect(output).toContain("Head: 1234567890abcdef1234567890abcdef12345678");
    expect(output).toContain("Head: ?");
    expect(output).toContain("Updated: ?");
    for (const item of report.pullRequests) {
      expect(output).toContain(`URL: ${item.url}`);
      expect(output).toContain(`ID: ${item.id}`);
      expect(output).toContain(
        `issue-graph ${item.number} --repo ${item.repo} --depth 1 --no-snapshot`,
      );
    }
    for (const step of report.nextSteps) expect(output).toContain(step);
    expect(body(renderStatus(report))).toBe(
      body(renderStatus(fixture(report.pullRequests.map((item) => ({ ...item, title: "short" }))))),
    );
  });

  test("empty ledgers distinguish complete zero from missing inventory", () => {
    expect(renderStatus(fixture([]), { view: "prs" })).toContain("No open PRs in scope.");
    const output = renderStatus(fixture([], [coverage("acme/app", false)]), { view: "prs" });
    expect(output).toContain("No PRs observed; incomplete coverage is not an empty backlog.");
    expect(output).toContain("Totals: Open ? (at least 0 known)");
    expect(output).not.toContain("No open PRs in scope.");
  });
});

describe("presentation and safety", () => {
  for (const view of views) {
    test(`${view}: deterministic injected color strips exactly to plain output`, () => {
      const report = fixture();
      const before = JSON.stringify(report);
      for (const width of [40, 60, 80, 120, 240]) {
        const plain = renderStatus(report, { view, width });
        const colored = renderStatus(report, { view, width, color: true });
        expect(stripColor(colored)).toBe(plain);
        expect(renderStatus(report, { view, width })).toBe(plain);
        expect(plain).not.toContain(esc);
      }
      expect(JSON.stringify(report)).toBe(before);
    });

    test(`${view}: Markdown keeps full identities and ignores terminal color and width`, () => {
      const report = fixture();
      const output = renderStatus(report, { view, format: "markdown", color: true, width: 20 });
      expect(output).toBe(renderStatus(report, { view, format: "markdown" }));
      expect(output).not.toContain(esc);
      expect(output).toContain("acme/app");
      if (view !== "prs") {
        expect(output).toContain("| acme/api | ");
        expect(output).toContain("| None | Unknown | Conflicts |");
      } else {
        expect(output).toContain(
          "[https://github\\.com/acme/app/pull/1](https://github.com/acme/app/pull/1)",
        );
      }
    });
  }

  test("bold and dim wrap padded cells without changing alignment or inventing colors", () => {
    const report = fixture([
      pr(1, { reviewState: "changes-requested", mergeability: "CONFLICTING" }),
    ]);
    const output = renderStatus(report, { color: true, width: 240 });
    const plain = renderStatus(report, { width: 240 });
    expect(output).toContain(`${esc}[2m  0${esc}[0m`);
    expect(output).toContain(`${esc}[1m  1${esc}[0m`);
    expect(output).toContain(`Conflicts ${esc}[1m1${esc}[0m`);
    expect(renderStatus(fixture(), { color: true })).toContain(`${esc}[1m?${esc}[0m`);
    const codes = [...output.matchAll(new RegExp(`${esc}\\[([0-9;]*)m`, "g"))].map(
      (match) => match[1],
    );
    expect(new Set(codes)).toEqual(new Set(["0", "1", "2"]));
    expect(output.length).toBeGreaterThan(plain.length);
    expect(stripColor(output)).toBe(plain);
    const lines = block(plain, "acme/app").split("\n");
    const index = lines.findIndex((line) => line.includes("Review state · alice"));
    const edge = lines[index].lastIndexOf("PRs") + 3;
    for (const line of lines.slice(index + 1, index + 6))
      expect(textWidth(line.trimEnd())).toBe(edge);
  });

  test("narrow blocks preserve all columns, flags, long repository names and Unicode evidence", () => {
    const repo = `acme/${"long-project-name-".repeat(6)}`;
    const report = fixture(
      [pr(1, { repo, title: "修正 👩🏽‍💻 cafe\u0301 ".repeat(20) })],
      [coverage(repo)],
    );
    const output = renderStatus(report, { width: 40 });
    expect(output).toMatch(/^alice\s+1$/m);
    expect(output).toMatch(/^Not required\s+0$/m);
    expect(output).toMatch(/^Unknown\s+0$/m);
    expect(output.replaceAll("\n", "")).toContain("Conflicts 0");
    expect(output.replaceAll("\n", "")).toContain(repo);
    expect(output.replaceAll("\n", "")).toContain(
      "Drafts 0 · Conflicts 0 · Unassigned 0 · Merge unknown 0",
    );
    for (const line of output.split("\n")) expect(textWidth(line)).toBeLessThanOrEqual(40);
    const ledger = renderStatus(report, { view: "prs", width: 40 });
    expect(ledger.replaceAll("\n", "")).toContain(safeStatusText(report.pullRequests[0].title));
    expect(ledger.replaceAll("\n", "")).toContain(
      `issue-graph 1 --repo ${repo} --depth 1 --no-snapshot`,
    );
    expect(renderStatus(report, { width: Number.NaN })).toBe(renderStatus(report));
  });

  test("Markdown neutralizes links, HTML, table delimiters and terminal escape injection", () => {
    const report = fixture([
      pr(1, {
        title: `${esc}]8;;https://evil.test\x07[click](javascript:alert(1)) | <img src=x> \`code\`\n# heading`,
        url: "https://github.com/acme/app/pull/1) [evil](javascript:alert(1))",
        requestedReviewers: ["team|injected", "[bad](https://evil.test)"],
      }),
    ]);
    report.nextSteps.push("issue-graph status --repo acme/app; [bad](javascript:alert(1))");
    const output = renderStatus(report, { view: "prs", format: "markdown" });
    expect(output).not.toContain(esc);
    expect(output).not.toContain("<img");
    expect(output).not.toContain("[click](javascript:");
    expect(output).toContain("\\[click\\]\\(javascript:alert\\(1\\)\\)");
    expect(output).toContain("\\| &lt;img src=x&gt;");
    expect(output).toContain("/1%29%20%5Bevil%5D%28javascript:alert%281%29%29)");
    expect(output).toContain("team\\|injected");
    report.pullRequests[0].url = "javascript:alert(1)";
    const unsafe = renderStatus(report, { view: "prs", format: "markdown" });
    expect(unsafe).toContain("URL: javascript:alert\\(1\\)");
    expect(unsafe).not.toContain("- URL: [");
  });

  test("Markdown keeps commands copyable inside safe code spans and metadata on separate lines", () => {
    const report = fixture();
    const step = "issue-graph status ``` [not a link](javascript:alert(1))";
    report.nextSteps.push(step);
    const output = renderStatus(report, { view: "prs", format: "markdown" });
    expect(output).toContain("- Graph: ` issue-graph 1 --repo acme/app --depth 1 --no-snapshot `");
    expect(output).toContain(`- \`\`\`\` ${step} \`\`\`\``);
    expect(output).toContain("Coverage: complete  \n");
    for (const command of report.nextSteps) expect(output).toContain(command);
  });

  test("sanitizes every view and does not turn invalid identities into shell commands", () => {
    const report = fixture();
    report.rows[0].author = `alice${esc}[2J\n|bad`;
    report.projects[0].authors[0].author = `bob${esc}[31m\r|bad`;
    report.pullRequests[0].repo = "acme/app;touch /tmp/pwned";
    report.coverageComplete = false;
    report.coverage[0].complete = false;
    report.coverage[0].errors.push({
      code: `${esc}[2JERROR`,
      message: `${esc}]0;title\x07safe\nmessage`,
    });
    for (const view of views) {
      for (const format of ["table", "markdown"] as const) {
        const output = renderStatus(report, { view, format });
        expect(output).not.toContain(esc);
        expect(output).toContain("ERROR: safe message");
        expect(output).not.toContain("issue-graph 6 ");
        expect(output).not.toContain("\n|bad");
      }
    }
    expect(renderStatus(report, { view: "prs" })).toContain(
      "Graph: Unavailable: invalid PR identity",
    );
  });
});
