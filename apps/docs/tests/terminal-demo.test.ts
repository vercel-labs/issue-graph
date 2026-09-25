import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { GET as landingMarkdown } from "../src/app/api/landing-md/route";
import { TerminalDemo } from "../src/components/terminal-demo";
import { TerminalPresentation } from "../src/components/terminal-output";
import graph from "../src/lib/example-graph.json";
import plan from "../src/lib/example-plan.json";
import status from "../src/lib/example-status.json";
import { plainTerminalText, type TerminalDemoProps } from "../src/lib/terminal-demo";
import {
  selectTerminalLines,
  summarizePlanOutput,
  summarizeStatusOutput,
  terminalExampleCatalog,
  toTerminalExample,
} from "../src/lib/terminal-examples";

import { statusPresentation, terminalPresentation } from "../src/lib/terminal-presentation";

vi.mock("@/lib/discovery", () => ({ releaseNotice: () => "" }));

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const [first, ...rest] = terminalExampleCatalog;
const examples: TerminalDemoProps["examples"] = [
  toTerminalExample(first),
  ...rest.map(toTerminalExample),
];
const attribute = (html: string, name: string) =>
  html.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

test("SSR includes three semantic examples, short display commands and linked accessible tabs", () => {
  const html = renderToStaticMarkup(createElement(TerminalDemo, { examples }));
  const tabs = html.match(/<button\b[^>]*role="tab"[^>]*>[\s\S]*?<\/button>/g) ?? [];
  const panels = html.split(/(?=<div\b[^>]*role="tabpanel")/).slice(1);
  expect(tabs).toHaveLength(3);
  expect(panels).toHaveLength(3);
  expect(html).not.toMatch(
    /<details\b|Raw captured excerpt|Formatted excerpt|Formatted reading view|ig-demo-raw/,
  );
  const commands = [
    "issue-graph 1113 --repo vercel-labs/agent-browser --depth 1",
    "issue-graph status --repo vercel-labs/portless --author ctate,Railly --view projects",
    "issue-graph plan --repo vercel-labs/wterm",
  ];
  expect(html).toContain('role="tablist"');
  expect(html).toContain('aria-live="polite"');
  expect(html).toContain(examples[0].summary);
  for (const [index, example] of examples.entries()) {
    const tab = tabs[index] ?? "";
    const panel = panels[index] ?? "";
    expect(attribute(tab, "id")).toBeTruthy();
    expect(attribute(panel, "id")).toBeTruthy();
    expect(attribute(tab, "aria-controls")).toBe(attribute(panel, "id"));
    expect(attribute(panel, "aria-labelledby")).toBe(attribute(tab, "id"));
    expect(attribute(tab, "aria-selected")).toBe(String(index === 0));
    expect(attribute(tab, "tabindex")).toBe(index === 0 ? "0" : "-1");
    expect(/\bhidden(?:="")?(?:\s|>)/.test(panel)).toBe(index !== 0);
    expect(attribute(panel, "tabindex")).toBe(index === 0 ? "0" : "-1");
    const command = panel.match(/<div class="ig-demo-command">[\s\S]*?<\/div>/)?.[0];
    expect(command?.replace(/<\/?span\b[^>]*>/g, "")).toBe(
      renderToStaticMarkup(
        createElement("div", { className: "ig-demo-command" }, `$ ${commands[index]}`),
      ),
    );
    expect(panel).toContain(
      renderToStaticMarkup(
        createElement(TerminalPresentation, {
          output: example.output,
          exampleId: example.id,
        }),
      ),
    );
  }
  expect(html).toContain("? means unknown, not zero.");
  expect(html).toContain("Approval does not imply merge readiness.");
  expect(html).toContain("Validate repository-specific behavior before mutating GitHub.");
});

test("the compact demo uses scoped monochrome hierarchy without restyling shared commands", () => {
  const html = renderToStaticMarkup(createElement(TerminalDemo, { examples }));
  expect(html).toContain('class="ig-terminal-command"');
  expect(html).toContain('ig-demo-token-merged">issue-graph</span>');
  expect(html).toContain('ig-demo-token-reference">--repo</span>');
  expect(html).toContain('ig-demo-token-positive">vercel-labs/agent-browser</span>');
  expect(html).toContain('ig-demo-token-reference">Next:</span>');
  for (const count of [26, 9, 11, 6])
    expect(html).toContain(`ig-demo-token-strong">${count}</span>`);
  expect(html).toContain('ig-demo-status-zero"><th scope="row">Changes requested</th><td>0</td>');
  const css = read("../src/components/terminal-output.css");
  const monochrome = css.match(/\.ig-demo \.ig-demo-token-reference,[\s\S]*?\}/)?.[0] ?? "";
  expect(monochrome).toContain(".ig-demo .ig-demo-token-positive");
  expect(monochrome).toContain(".ig-demo .ig-demo-token-merged");
  expect(monochrome).toContain("color: var(--ig-demo-fg)");
  expect(monochrome).toContain("font-weight: 600");
  expect(css).toMatch(/\.ig-demo \.ig-demo-token-muted \{\s*color: var\(--ig-demo-muted\);/);
  expect(css).toContain("color: var(--ds-green-900)");
  const frame = read("../src/components/terminal-demo.css").match(/\.ig-demo \{[^}]+\}/)?.[0] ?? "";
  expect(frame).toContain("max-width: 600px");
  expect(frame).toContain("margin-inline: auto");
  expect(html).not.toMatch(/ig-demo-line-focus|ig-demo-token-(?:parameter|keyword|danger)/);
});

test("plain formatting preserves labels and URLs while React escapes display text", () => {
  const output = plainTerminalText(
    "## Result\r\n**OPEN** PR_SET_PDEATHSIG _(depth 1)_\r\n[public PR](https://example.com/pr)\nhttps://example.com/a?x=1&y=2\n\t🟢",
  );
  expect(output).toBe(
    "Result\nOPEN PR_SET_PDEATHSIG (depth 1)\npublic PR\nhttps://example.com/a?x=1&y=2\n\t🟢",
  );
  expect(plainTerminalText(String.fromCharCode(0, 7, 27, 127, 159))).toBe("");
  const text = '<script>example</script> & "quoted"';
  const example = {
    ...examples[0],
    id: "unknown-example",
    label: text,
    summary: text,
    command: text,
    output: text,
  };
  const html = renderToStaticMarkup(createElement(TerminalDemo, { examples: [example] }));
  expect(html).not.toMatch(/<(?:script|a)\b/);
  expect(
    html.match(/&lt;script&gt;example&lt;\/script&gt; &amp; &quot;quoted&quot;/g),
  ).toHaveLength(4);
});

test("graph reading view keeps identities, full titles and qualified follow-up reasons", () => {
  const output = examples[0].output;
  const rows = terminalPresentation(output, "graph");
  expect(rows?.[0]).toEqual({ kind: "context", text: "vercel-labs/agent-browser · #1113" });
  expect(rows?.filter((row) => row.kind === "item")).toEqual([
    {
      kind: "item",
      reference: "#1137",
      state: "MERGED",
      title: "fix: prevent orphaned Chrome processes on daemon exit",
      details: ["closes #1113 · CLOSED"],
    },
    {
      kind: "item",
      reference: "#1371",
      state: "OPEN",
      title:
        "Orphaned headless Chrome Helpers spin at high CPU under agent-browser-chrome temp profile",
      details: ["referenced by merged work, verify if resolved"],
    },
    {
      kind: "item",
      reference: "#1607",
      state: "OPEN",
      title: "chrome: headless daemon blocks GUI Chrome from opening on macOS",
      details: ["related, untracked"],
    },
  ]);
  const title = "修復 café 👩🏽‍💻 ".repeat(30);
  const unicode = output.replace("fix: prevent orphaned Chrome processes on daemon exit", title);
  const html = renderToStaticMarkup(
    createElement(TerminalPresentation, { output: unicode, exampleId: "graph" }),
  );
  expect(html).toContain(`<span class="ig-demo-item-title">${title}</span>`);
  expect(html).toContain("Open follow-ups");
  expect(html).not.toContain("🟢");
  const titleStyle =
    read("../src/components/terminal-output.css").match(/\.ig-demo-item-title \{[^}]+\}/)?.[0] ??
    "";
  expect(titleStyle).toContain("white-space: normal");
  expect(titleStyle).not.toMatch(/ellipsis|nowrap|overflow: hidden/);
});

test("unrecognized shapes stay verbatim and mixed repositories keep qualified references", () => {
  for (const output of [
    examples[0].output.replace("PR 🟪 MERGED", "PR UNKNOWN"),
    `${examples[0].output}\nUnexpected caveat: do not mutate`,
  ]) {
    expect(terminalPresentation(output, "graph")).toBeNull();
    const html = renderToStaticMarkup(
      createElement(TerminalPresentation, { output, exampleId: "graph" }),
    );
    expect(html.replace(/<\/?span\b[^>]*>/g, "")).toBe(
      renderToStaticMarkup(
        createElement(
          "pre",
          { className: "ig-demo-verbatim" },
          createElement("code", null, output),
        ),
      ),
    );
  }
  const output = examples[0].output.replace("vercel-labs/agent-browser#1607", "other/repo#1607");
  const rows = terminalPresentation(output, "graph");
  expect(rows?.filter((row) => row.kind === "item").map((row) => row.reference)).toEqual([
    "vercel-labs/agent-browser#1137",
    "vercel-labs/agent-browser#1371",
    "other/repo#1607",
  ]);
  expect(rows).toContainEqual(
    expect.objectContaining({ details: ["closes vercel-labs/agent-browser#1113 · CLOSED"] }),
  );
});

test("backlog retains counts, subordinate metrics, the next action and complete caveats", () => {
  const output = examples[2].output;
  const rows = terminalPresentation(output, "plan");
  expect(rows).toContainEqual({
    kind: "summary",
    text: "Open items: 26 · Ready actions: 9 · Needs investigation: 11 · Blocked: 6",
  });
  for (const text of [
    "- The next action is independent in the observed graph.",
    "- Caveat: Validate repository-specific behavior before mutating GitHub.",
  ])
    expect(rows).toContainEqual({ kind: "text", text });
  expect(rows).toContainEqual({
    kind: "item",
    reference: "#37",
    state: "",
    title: "feat: add @wterm/search for grid and scrollback find",
    metrics: "review-open-pr · score 570.2 · heat 20.2 · visible impact 0",
    details: ["Next: Run the repository review gate on the exact latest SHA."],
  });
  expect(terminalPresentation(`${output}\nUnrecognized warning`, "plan")).toBeNull();
  expect(
    terminalPresentation(output.replace("vercel-labs/wterm#37", "other/repo#37"), "plan"),
  ).toContainEqual(expect.objectContaining({ reference: "other/repo#37" }));
  const html = renderToStaticMarkup(
    createElement(TerminalPresentation, { output, exampleId: "plan" }),
  );
  const text = html.replace(/<[^>]+>/g, "");
  for (const line of output
    .split("\n")
    .filter((line) => /^- (?:Open items|Ready actions|Needs investigation|Blocked):/.test(line)))
    expect(text).toContain(line.slice(2));
  expect(html).toContain(
    'ig-demo-item-title">feat: add @wterm/search for grid and scrollback find</span>',
  );
  expect(text).toContain("The next action is independent in the observed graph.");
  expect(text).toContain("Caveat: Validate repository-specific behavior before mutating GitHub.");
  expect(text).toContain("Next: Run the repository review gate on the exact latest SHA.");
  expect(text.indexOf("Run the repository review gate")).toBeLessThan(text.indexOf("score 570.2"));
  expect(text).toContain("review-open-pr · score 570.2 · heat 20.2 · visible impact 0");
});

test("status maps captured cells to separate author and aggregate review tables with UTC coverage", () => {
  const output = examples[1].output;
  const captured =
    output
      .split("\n")
      .find((line) => line.startsWith("portless "))
      ?.trim()
      .split(/\s+/)
      .filter((cell) => cell !== "│") ?? [];
  expect(captured).toHaveLength(10);
  const html = renderToStaticMarkup(
    createElement(TerminalPresentation, { output, exampleId: "status" }),
  );
  const tables = html.match(/<table\b[^>]*>[\s\S]*?<\/table>/g) ?? [];
  expect(tables).toHaveLength(2);
  const cells = tables.map((table) =>
    (table.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g) ?? []).map((row) =>
      Array.from(row.matchAll(/<(?:th|td)\b[^>]*>([^<]*)<\/(?:th|td)>/g), (match) => match[1]),
    ),
  );
  expect(cells).toEqual([
    [
      ["Author", "Open PRs"],
      ["ctate", captured[1]],
      ["Railly", captured[2]],
    ],
    [
      ["Review state", "PRs"],
      ["Needs review", captured[4]],
      ["Approved", captured[6]],
      ["Changes requested", captured[5]],
      ["Not required", captured[7]],
      ["Unknown", captured[8]],
    ],
  ]);
  expect(attribute(tables[0] ?? "", "aria-label")).toBe("vercel-labs/portless Author");
  expect(attribute(tables[1] ?? "", "aria-label")).toBe("vercel-labs/portless Review state");
  expect(html).toContain(`<strong>${captured[3]} open PRs</strong>`);
  expect(html.match(/<h3>/g)).toHaveLength(1);
  const text = html.replace(/<[^>]+>/g, "");
  expect(text).toContain(`${captured[9]} conflicts`);
  expect(text).toContain(`${output.match(/Drafts (\d+|\?)/)?.[1]} drafts`);
  expect(text).toContain(`${output.match(/Unassigned (\d+|\?)/)?.[1]} unassigned`);
  expect(text).toContain("Captured Sep 22, 2026 at 20:49 UTC · Query 3.2s · Coverage complete");
  expect(text).toContain("? means unknown, not zero.");
  expect(text).toContain("Flags overlap review states. Approval does not imply merge readiness.");
  expect(html).not.toMatch(
    /Review state · (?:ctate|Railly)|<h3>Total<|Owner:|Query window:|ig-demo-scroll/,
  );
  expect(statusPresentation(output)?.projects[0].authors).toEqual([
    { label: "ctate", value: captured[1] },
    { label: "Railly", value: captured[2] },
  ]);
  const uncertain = output
    .replace("Coverage: complete", "Coverage: INCOMPLETE")
    .replace(/\b0(?=\s*│)/g, "?");
  const warning = renderToStaticMarkup(
    createElement(TerminalPresentation, { output: uncertain, exampleId: "status" }),
  );
  expect(warning).toContain('class="ig-demo-status-unknown">Coverage INCOMPLETE</span>');
  expect(warning).toContain('<tr><th scope="row">Unknown</th><td>?</td></tr>');
  const malformed = output.replace("Changes", "Unrecognized");
  expect(statusPresentation(malformed)).toBeNull();
  const fallback = renderToStaticMarkup(
    createElement(TerminalPresentation, { output: malformed, exampleId: "status" }),
  );
  expect(fallback.replace(/<\/?span\b[^>]*>/g, "")).toBe(
    renderToStaticMarkup(
      createElement("pre", { className: "ig-demo-table" }, createElement("code", null, malformed)),
    ),
  );
});

test("catalog selects captured lines and exposes only five display fields", () => {
  expect(examples.map(({ id }) => id)).toEqual(["graph", "status", "plan"]);
  const fixtures = { graph, status, plan };
  for (const entry of terminalExampleCatalog) {
    const fixture = fixtures[entry.id];
    const display = toTerminalExample(entry);
    expect(entry.output).toBe(fixture.terminalOutput);
    expect(display.command).toBe(fixture.command);
    expect(Object.keys(display).sort().join(",")).toBe("command,id,label,output,summary");
    expect(display.output).toBe(
      plainTerminalText(selectTerminalLines(fixture.terminalOutput, entry.selection.lineRanges)),
    );
  }
  expect(first.selection.lineRanges).toEqual([
    { startLine: 1, endLine: 3 },
    { startLine: 9, endLine: 10 },
    { startLine: 14, endLine: 20 },
  ]);
  expect(examples[0].output.split("\n")).toHaveLength(12);
  expect(examples[0].output).not.toContain("Nodes: 5");
  expect(graph.nodes).toHaveLength(5);
  expect(graph.terminalOutput).toContain("Nodes: 5");
  expect(examples[2].output).toContain("@wterm/search");
});

test("captures remain public with sane timestamps and matching in-repo excerpt hashes", () => {
  expect(
    [graph, status, plan].map((fixture) =>
      createHash("sha256").update(fixture.terminalOutput).digest("hex"),
    ),
  ).toEqual([
    "5b3dcd46e4e12973488849c7afaa73c4885f6db3504ff57c076f248290adcd5f",
    "0d5a85c8a9f3fa89afef52a18cbd19d0cd354b90e89a091d993cba162653675b",
    "38106656d5bd5d9acb68540299132694cb250937165ad0f561ab31fd88355bde",
  ]);
  for (const fixture of [graph, status, plan]) {
    expect(fixture.repositoryVisibility).toBe("PUBLIC");
    const times = [fixture.visibilityCheckedAt, fixture.captureStartedAt, fixture.capturedAt];
    const parsed = times.map(Date.parse);
    expect(parsed.every(Number.isFinite)).toBe(true);
    expect(parsed).toEqual([...parsed].sort((a, b) => a - b));
  }
  for (const fixture of [status, plan]) {
    expect(fixture.capturedAt).toBe(fixture.captureEndedAt);
    expect(fixture.terminalExcerpt).toMatchObject({
      source: "CLI stdout",
      excerpt: true,
      exitCode: 0,
    });
    expect(createHash("sha256").update(fixture.terminalOutput).digest("hex")).toBe(
      fixture.terminalExcerpt.excerptSha256,
    );
  }
  expect(plan.coverage).toMatchObject({ completeBacklog: false, depth: 0 });
});

test("summaries preserve unknown counts and never invent a missing next action", () => {
  expect(examples.map(({ summary }) => summary)).toEqual([
    "1 merged PR, 2 open follow-ups",
    "3 open PRs with their review states",
    "26 open items, a suggested next action",
  ]);
  for (const output of ["", "Totals: Open ?"])
    expect(summarizeStatusOutput(output)).toBe("? open PRs with their review states");
  for (const output of ["", "- Open items: ?"])
    expect(summarizePlanOutput(output)).toBe("? open items in the captured backlog");
  expect(summarizePlanOutput("- Open items: 0\n\n## Next\n")).toBe(
    "0 open items in the captured backlog",
  );
});

test("Markdown shares examples and distinguishes the full capture from the displayed subset", async () => {
  const response = landingMarkdown();
  expect(response.status).toBe(200);
  const markdown = await response.text();
  for (const example of examples) {
    for (const text of [example.label, example.summary, example.command, example.output])
      expect(markdown).toContain(text);
  }
  for (const fixture of [graph, status, plan]) expect(markdown).toContain(fixture.capturedAt);
  for (const fixture of [status, plan]) expect(markdown).toContain(fixture.coverage.note);
  expect(markdown).toContain("not live results");
  expect(markdown).toContain("they do not run commands or call GitHub");
  expect(markdown).toContain("The full captured graph contains 5 fetched nodes");
  expect(markdown).toContain("This displayed excerpt omits other captured nodes");
  expect(markdown).toContain("19 beyond-depth references and 22 edges");
  expect(markdown).not.toContain("All fetched nodes are shown");
});

test("terminal has no WASM, deferred output, replay timers or network execution", () => {
  const source = [
    "../src/components/terminal-demo.tsx",
    "../src/components/terminal-output.tsx",
    "../src/components/graph-proof.tsx",
    "../src/lib/terminal-demo.ts",
    "../src/lib/terminal-examples.ts",
    "../src/lib/terminal-presentation.ts",
  ]
    .map(read)
    .join("\n");
  expect(source).not.toMatch(/@wterm\/(?:dom|react)\b|WebAssembly|WasmBridge|\.wasm\b/);
  expect(source).not.toMatch(
    /next\/dynamic|\bimport\s*\(|terminalReplayFrames|createTerminalPlayback/,
  );
  expect(source).not.toMatch(
    /\b(?:setTimeout|setInterval|fetch|WebSocket)\b|dangerouslySetInnerHTML/,
  );
  expect(existsSync(new URL("../src/components/terminal-demo-runtime.tsx", import.meta.url))).toBe(
    false,
  );
  for (const path of ["../package.json", "../../../pnpm-lock.yaml"])
    expect(read(path)).not.toMatch(/@wterm\/(?:dom|react)(?=[@:'"\s])/);
});
