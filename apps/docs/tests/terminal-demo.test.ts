import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { GET as landingMarkdown } from "../src/app/api/landing-md/route";
import { TerminalDemo } from "../src/components/terminal-demo";
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

vi.mock("@/lib/discovery", () => ({ releaseNotice: () => "" }));

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const [first, ...rest] = terminalExampleCatalog;
const examples: TerminalDemoProps["examples"] = [
  toTerminalExample(first),
  ...rest.map(toTerminalExample),
];
const attribute = (html: string, name: string) =>
  html.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

test("SSR includes three full outputs, the selected summary and linked accessible tabs", () => {
  const html = renderToStaticMarkup(createElement(TerminalDemo, { examples }));
  const tabs = html.match(/<button\b[^>]*role="tab"[^>]*>[\s\S]*?<\/button>/g) ?? [];
  const panels = html.match(/<div\b[^>]*role="tabpanel"[^>]*>[\s\S]*?<\/div>/g) ?? [];
  expect(tabs).toHaveLength(3);
  expect(panels).toHaveLength(3);
  expect(html.match(/<pre><code>/g)).toHaveLength(3);
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
    const code = panel.match(/<code>[\s\S]*?<\/code>/)?.[0];
    expect(code?.replace(/<\/?span\b[^>]*>/g, "")).toBe(
      renderToStaticMarkup(
        createElement("code", null, `$ ${example.command}\n\n${example.output}`),
      ),
    );
  }
  expect(html).toContain("?=unknown, not zero.");
  expect(html).toContain("Approval does not imply merge readiness.");
  expect(html).toContain("Validate repository-specific behavior before mutating GitHub.");
});

test("minimal Geist accents keep commands readable and emphasize only useful output signals", () => {
  const html = renderToStaticMarkup(createElement(TerminalDemo, { examples }));
  expect(html).toContain('class="ig-terminal-command"');
  expect(html).toContain('ig-demo-token-merged">issue-graph</span>');
  expect(html).toContain('ig-demo-token-reference">--repo</span>');
  expect(html).toContain('ig-demo-token-positive">vercel-labs/agent-browser</span>');
  expect(html).toContain('ig-demo-token-attention">2</span>');
  expect(html).toContain('ig-demo-token-positive">1</span>');
  expect(html).toContain('ig-demo-token-reference">Next:</span>');
  expect(html).toContain('ig-demo-line ig-demo-line-plain">- Blocked: 6');
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
  const example = { ...examples[0], label: text, summary: text, command: text, output: text };
  const html = renderToStaticMarkup(createElement(TerminalDemo, { examples: [example] }));
  expect(html).not.toMatch(/<(?:script|a)\b/);
  expect(
    html.match(/&lt;script&gt;example&lt;\/script&gt; &amp; &quot;quoted&quot;/g),
  ).toHaveLength(4);
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
