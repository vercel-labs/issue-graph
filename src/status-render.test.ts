import { describe, expect, test } from "bun:test";
import {
  buildStatusReport,
  type StatusCoverage,
  type StatusPullRequest,
  type StatusReport,
  type StatusView,
} from "./status.js";
import { renderStatus, safeStatusText } from "./status-render.js";

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
    .split("Repository × author\n")[1]
    .split("Incomplete count details")[0]
    .split("Review=required;")[0];
}

function cells(line: string, output: string): string[] {
  const header = output
    .split("\n")
    .find((row) => /^(Repo|Project)\s/.test(row) && row.includes(" │ "));
  if (!header) throw new Error("Expected a terminal table header");
  const columns = [...header.matchAll(/[^\s│]+(?: \(open\))?/g)].map((match) => match.index);
  return columns.map((start, index) =>
    line
      .slice(start, columns[index + 1])
      .replace("│", "")
      .trim(),
  );
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

describe("renderStatus authors", () => {
  test("leads with the query window, coverage and truthful totals", () => {
    const output = renderStatus(fixture());
    const header = output.split("\n\n")[0].split("\n");
    expect(header).toHaveLength(3);
    expect(header[0]).toBe("issue-graph status · Owner: acme · 2 repos · Authors: alice, bob");
    expect(header[1]).toBe(`Query window: ${start} → ${end} · Coverage: complete`);
    expect(header[2]).toContain("Totals: Open 6 · Drafts ? (≥1 known) · Unassigned ? (≥1 known)");
    expect(header[2]).toContain("Merge unknown 1");
    expect(output).not.toContain("scanned");
    expect(output).not.toContain("Flags and count details");
    expect(output).toContain("Approval does not imply merge readiness.");
    expect(output).not.toContain("Approved is not mergeable");
  });

  test("has stable review columns, separated conflicts, grouped repositories and a total row", () => {
    const output = renderStatus(fixture());
    const lines = body(output).split("\n");
    expect(cells(lines[0], output)).toEqual([
      "Repo",
      "Author",
      "Open",
      "Review",
      "Changes",
      "Approved",
      "None",
      "Unknown",
      "Conflicts",
    ]);
    expect(cells(lines.find((line) => line.startsWith("app ")) ?? "", output)).toEqual([
      "app",
      "alice",
      "5",
      "1",
      "1",
      "1",
      "1",
      "1",
      "?",
    ]);
    expect(cells(lines.find((line) => line.trimStart().startsWith("bob ")) ?? "", output)).toEqual([
      "",
      "bob",
      "1",
      "0",
      "0",
      "1",
      "0",
      "0",
      "0",
    ]);
    expect(
      lines.some(
        (line) =>
          JSON.stringify(cells(line, output)) ===
          JSON.stringify(["api", "alice", "0", "0", "0", "0", "0", "0", "0"]),
      ),
    ).toBe(true);
    expect(cells(lines.find((line) => line.startsWith("Total ")) ?? "", output)).toEqual([
      "Total",
      "",
      "6",
      "1",
      "1",
      "2",
      "1",
      "1",
      "?",
    ]);
    expect(lines[0]).toContain(" │ Conflicts");
    expect(output).not.toContain("acme/app / alice: Drafts");
    expect(output).not.toContain("acme/app / bob: Drafts");
  });

  test("uses supplied counts, never recalculates from evidence or subtracts review buckets", () => {
    const report = fixture([]);
    report.rows[0].counts.open = { count: 47, prIds: [], unknownIds: [] };
    report.rows[0].counts.approved = { count: 99, prIds: [], unknownIds: [] };
    report.totals.open = { count: 200, prIds: [], unknownIds: [] };
    const output = renderStatus(report);
    expect(output).toContain("Totals: Open 200");
    expect(cells(body(output).split("\n")[2], output)).toEqual([
      "api",
      "alice",
      "47",
      "0",
      "0",
      "99",
      "0",
      "0",
      "0",
    ]);
    expect(body(output)).not.toMatch(/-\d/);
  });

  test("five complete repositories and ten author rows fit in 32 lines with a full-scope drilldown", () => {
    const repos = ["acme/alpha", "acme/bravo", "acme/charlie", "acme/delta", "acme/echo"];
    const report = fixture(
      repos.flatMap((repo, index) => [
        pr(index * 2 + 1, { repo }),
        pr(index * 2 + 2, { repo, author: "bob" }),
      ]),
      repos.map((repo) => coverage(repo)),
    );
    const output = renderStatus(report);
    expect(output.trimEnd().split("\n").length).toBeLessThanOrEqual(32);
    expect(output.split("\n\n")[0].split("\n")).toHaveLength(3);
    const rows = body(output)
      .split("\n")
      .filter((line) => line.includes(" │ "));
    expect(rows).toHaveLength(12);
    expect(cells(rows.at(-1) ?? "", output)).toEqual([
      "Total",
      "",
      "10",
      "10",
      "0",
      "0",
      "0",
      "0",
      "0",
    ]);
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

  test("80-column TTY keeps ten author rows as a compact aligned table", () => {
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
      expect(output.trimEnd().split("\n").length).toBeLessThanOrEqual(35);
      expect(output).not.toContain("  Open:");
      const rows = body(output)
        .split("\n")
        .filter((line) => line.includes(" │ "));
      expect(rows).toHaveLength(12);
      const header = rows[0];
      expect(header.indexOf("Author")).toBe(13 + (width === 80 ? 1 : 2));
      expect(cells(header, output)).toEqual([
        "Repo",
        "Author",
        "Open",
        "Review",
        "Changes",
        "Approved",
        "None",
        "Unknown",
        "Conflicts",
      ]);
      for (const row of rows) {
        expect(row.indexOf("│")).toBe(header.indexOf("│"));
        expect(row.length).toBe(header.length);
      }
      const rules = body(output)
        .split("\n")
        .filter((line) => line.includes("┼"));
      expect(rules).toHaveLength(2);
      for (const rule of rules) {
        expect(rule.indexOf("┼")).toBe(header.indexOf("│"));
        expect(rule.length).toBe(header.length);
      }
      expect(cells(rows.at(-1) ?? "", output)).toEqual([
        "Total",
        "",
        "10",
        "10",
        "0",
        "0",
        "0",
        "0",
        "0",
      ]);
      for (const row of rows.slice(1, -1))
        expect(cells(row, output).slice(2)).toEqual(["1", "1", "0", "0", "0", "0", "0"]);
      for (const line of output.split("\n")) expect(line.length).toBeLessThanOrEqual(width);
      expect(stripColor(renderStatus(report, { width, color: true }))).toBe(output);
    }
    const narrow = renderStatus(report, { width: 60 });
    expect(narrow).toContain("  Open: 1");
    expect(narrow).toContain("  Conflicts: 0");
    expect(narrow).not.toContain(" │ ");
    const longRepo = `acme/${"long-project-".repeat(5)}`;
    const long = renderStatus(fixture([pr(1, { repo: longRepo })], [coverage(longRepo)]), {
      width: 80,
    });
    expect(long).toContain("  Open: 1");
    expect(long).not.toContain(" │ ");
  });

  test("total rows use report totals even when rows and evidence disagree", () => {
    const report = fixture([]);
    report.totals.open.count = 91;
    for (const view of ["authors", "projects"] as const) {
      const output = renderStatus(report, { view, width: 240 });
      const total = cells(
        output.split("\n").find((line) => line.startsWith("Total ")) ?? "",
        output,
      );
      expect(total.slice(-7)).toEqual(["91", "0", "0", "0", "0", "0", "0"]);
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
    expect(output).toContain("Coverage: INCOMPLETE");
    expect(output).toContain("PAGE_LIMIT: Inventory stopped at the page cap.");
    expect(output).toContain("Totals: Open ? (at least 2 known)");
    const rows = body(output).split("\n");
    expect(cells(rows.find((line) => line.startsWith("app ")) ?? "", output)).toEqual([
      "app",
      "alice",
      "?",
      "?",
      "?",
      "?",
      "?",
      "?",
      "?",
    ]);
    expect(
      rows.some(
        (line) =>
          JSON.stringify(cells(line, output)) ===
          JSON.stringify(["", "bob", "1", "1", "0", "0", "0", "0", "0"]),
      ),
    ).toBe(true);
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
  test("projects show one row per repository with author counts, all review buckets and flags", () => {
    const report = fixture();
    report.projects[0].authors[0].count = { count: 27, prIds: [], unknownIds: [] };
    const output = renderStatus(report, { view: "projects", width: 240 });
    expect(output).toContain("alice (open)");
    expect(output).toContain("bob (open)");
    expect(output).not.toContain("Authors (open)");
    const table = output.split("Projects\n")[1].split("Review=required;")[0];
    expect(
      table.split("\n").filter((line) => line.startsWith("api ") || line.startsWith("app ")),
    ).toHaveLength(2);
    expect(cells(table.split("\n").find((line) => line.startsWith("api ")) ?? "", output)).toEqual([
      "api",
      "27",
      "1",
      "1",
      "0",
      "0",
      "1",
      "0",
      "0",
      "0",
    ]);
    expect(
      cells(table.split("\n").find((line) => line.startsWith("Total ")) ?? "", output),
    ).toEqual(["Total", "", "", "6", "1", "1", "2", "1", "1", "?"]);
    expect(output).not.toContain("count details");
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
      const header = output.split("\n").find((line) => line.startsWith("Project ")) ?? "";
      const gap = width === 80 ? 1 : 2;
      const first = header.indexOf("a (open)");
      const second = header.indexOf("b (open)");
      expect(first).toBe(7 + gap);
      const api = output.split("\n").find((line) => line.startsWith("api ")) ?? "";
      const app = output.split("\n").find((line) => line.startsWith("app ")) ?? "";
      expect(api.slice(first, second - gap)).toBe("     123");
      expect(app.slice(first, second - gap)).toBe("       7");
      expect(app.slice(second, header.indexOf("Open") - gap)).toBe("       ?");
      const colored = renderStatus(report, { view: "projects", width, color: true });
      expect(stripColor(colored)).toBe(output);
      expect(colored).toContain(`${esc}[38;5;179m       ?${esc}[0m`);
    }
  });

  test("numeric-looking author identities remain left aligned", () => {
    const report = fixture([]);
    report.rows[0].author = "7";
    const output = renderStatus(report);
    const rows = body(output).split("\n");
    const start = rows[0].indexOf("Author");
    expect(rows[2].slice(start, start + 6)).toBe("7     ");
  });

  test("projects preserve zero rows and zero portfolio totals without inventing author totals", () => {
    const output = renderStatus(fixture([]), { view: "projects" });
    const total = cells(output.split("\n").find((line) => line.startsWith("Total ")) ?? "", output);
    expect(total).toEqual(["Total", "", "", "0", "0", "0", "0", "0", "0", "0"]);
    for (const repo of ["api", "app"]) {
      expect(
        cells(output.split("\n").find((line) => line.startsWith(`${repo} `)) ?? "", output),
      ).toEqual([repo, "0", "0", "0", "0", "0", "0", "0", "0", "0"]);
    }
  });

  test("projects preserve unknown author counts and portfolio lower bounds for incomplete captures", () => {
    const report = fixture([pr(1)], [coverage("acme/app", false), coverage("acme/api")]);
    const output = renderStatus(report, { view: "projects", width: 240 });
    expect(cells(output.split("\n").find((line) => line.startsWith("app ")) ?? "", output)).toEqual(
      ["app", "?", "?", "?", "?", "?", "?", "?", "?", "?"],
    );
    expect(
      cells(output.split("\n").find((line) => line.startsWith("Total ")) ?? "", output).slice(-7),
    ).toEqual(["?", "?", "?", "?", "?", "?", "?"]);
    expect(output).toContain("acme/app / alice Open: ? (at least 1 known)");
    expect(output).toContain("acme/app / bob Open: ? (at least 0 known)");
    expect(output).toContain("PAGE_LIMIT: Inventory stopped at the page cap.");
    expect(output).toContain("acme/api: complete");
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

  test("semantic color wraps padded cells, with muted zeros and conflict/changes/unknown highlights", () => {
    const report = fixture([
      pr(1, { reviewState: "changes-requested", mergeability: "CONFLICTING" }),
    ]);
    const output = renderStatus(report, { color: true, width: 240 });
    expect(output).toContain(`${esc}[38;5;244m   0${esc}[0m`);
    expect(output).toContain(`${esc}[38;5;203m        1${esc}[0m`);
    expect(output).toContain(`${esc}[38;5;214m      1${esc}[0m`);
    expect(renderStatus(fixture(), { color: true })).toContain(`${esc}[38;5;179m`);
    const lines = body(stripColor(output))
      .split("\n")
      .filter((line) => line.includes(" │ "));
    expect(lines).toHaveLength(6);
    for (const line of lines) {
      expect(line.indexOf("│")).toBe(lines[0].indexOf("│"));
      expect(line.length).toBe(lines[0].length);
    }
  });

  test("narrow blocks preserve all columns, flags, long repository names and Unicode evidence", () => {
    const repo = `acme/${"long-project-name-".repeat(6)}`;
    const report = fixture(
      [pr(1, { repo, title: "修正 👩🏽‍💻 cafe\u0301 ".repeat(20) })],
      [coverage(repo)],
    );
    const output = renderStatus(report, { width: 40 });
    expect(output).toContain("  Open: 1");
    expect(output).toContain("  None: 0");
    expect(output).toContain("  Unknown: 0");
    expect(output).toContain("  Conflicts: 0");
    expect(output.replaceAll("\n", "")).toContain(repo);
    expect(output.replaceAll("\n", "")).toContain("Drafts 0 · Unassigned 0");
    for (const line of output.split("\n")) expect(line.length).toBeLessThanOrEqual(40);
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
      const output = renderStatus(report, { view, format: "markdown" });
      expect(output).not.toContain(esc);
      expect(output).toContain("ERROR: safe message");
      expect(output).not.toContain("issue-graph 6 ");
    }
    expect(renderStatus(report, { view: "prs" })).toContain(
      "Graph: Unavailable: invalid PR identity",
    );
  });
});
