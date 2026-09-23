import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import Home, { metadata } from "../src/app/page";
import { CopyCommand } from "../src/components/copy-command";
import { GraphProof } from "../src/components/graph-proof";
import { InstallSelector } from "../src/components/install-selector";
import { landingTitle, workflows } from "../src/lib/landing-content";
import { agentSetupPrompt, plannedInstallCommand, siteName } from "../src/lib/site";
import { terminalExampleCatalog, toTerminalExample } from "../src/lib/terminal-examples";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("launch feedback", () => {
  test("uses the native Geistdocs Labs brand without replacing the library navbar", () => {
    const config = read("../src/lib/geistdocs/config.tsx");
    expect(config).toContain('navbarBrand: "labs"');
    const layout = read("../src/app/layout.tsx");
    expect(layout).toContain("<Navbar config={config} />");
    expect(layout).not.toContain("LogoVercelLabs");
  });

  test("keeps the canonical headline with a line break after work", () => {
    const html = renderToStaticMarkup(createElement(Home));
    const headings = html.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/g);
    expect(landingTitle).toBe("Find related work before you start");
    expect(metadata.title).toEqual({ absolute: `${siteName} | ${landingTitle}` });
    expect(headings).toEqual(['<h1 id="hero-title">Find related work<br/>before you start</h1>']);
    expect(headings?.[0]?.replace(/<br\s*\/?>(?:\s*)/g, " ").replace(/<[^>]+>/g, "")).toBe(
      landingTitle,
    );
    expect(headings?.[0]).not.toContain(".");
  });

  test("removes the hero eyebrow and exposes the audience selector", () => {
    const html = renderToStaticMarkup(createElement(Home));
    expect(html).not.toContain("A Vercel Labs CLI for humans and agents");
    expect(html).not.toContain("ig-hero-eyebrow");
    expect(html).not.toContain("ig-graph-board");
    expect(html).toContain("For humans");
    expect(html).toContain("For agents");
  });

  test("uses native Geistdocs code blocks for the three workflows and final install", () => {
    const html = renderToStaticMarkup(createElement(Home));
    expect(html.match(/data-geist-code-block=""/g)).toHaveLength(4);
    expect(html.match(/data-section="tabs"/g)).toHaveLength(4);
    expect(html.match(/data-section="content"/g)).toHaveLength(4);
    const codes = html.match(/<code\b[^>]*>[\s\S]*?<\/code>/g) ?? [];
    for (const command of [
      ...workflows.map((workflow) => workflow.command),
      plannedInstallCommand,
    ]) {
      expect(
        codes.some(
          (code) =>
            code.includes("ig-demo-token-") &&
            code.replace(/<code\b[^>]*>/, "<code>").replace(/<\/?span\b[^>]*>/g, "") ===
              renderToStaticMarkup(createElement("code", null, command)),
        ),
      ).toBe(true);
    }
    expect(html).not.toContain('class="ig-command"');
    expect(read("../src/app/page.tsx")).toContain("@vercel/geistdocs/components/code-block");
  });

  test("starts with the npm command and accessible audience buttons", () => {
    const html = renderToStaticMarkup(createElement(InstallSelector));
    expect(html).toContain('aria-label="Installation audience"');
    expect(html).toContain('aria-pressed="true">For humans');
    expect(html).toContain('aria-pressed="false">For agents');
    expect(html).toContain(plannedInstallCommand);
    expect(html).toContain('aria-label="Copy npm install command"');
    expect(html).toContain('class="ig-selector-pill"');
    expect(html).toContain('class="ig-selector-divider"');
    expect(plannedInstallCommand).toBe("npm install -g issue-graph@latest");
  });

  test("agent setup uses the repository shorthand and retains public discovery", () => {
    expect(agentSetupPrompt).toBe("npx skills@latest add vercel-labs/issue-graph");
    const index = JSON.parse(read("../public/.well-known/skills/index.json"));
    expect(index.skills[0]).toMatchObject({ name: "issue-graph", files: ["SKILL.md"] });
    expect(agentSetupPrompt.length).toBeLessThan(60);
    expect(agentSetupPrompt).not.toMatch(/skills get core|\/skill\.md/);
    for (const path of [
      "../src/app/page.tsx",
      "../src/app/api/landing-md/route.ts",
      "../src/lib/discovery.ts",
    ]) {
      expect(read(path)).toContain("/docs/agents.md");
      expect(read(path)).not.toContain('"/skill.md"');
    }
    const html = renderToStaticMarkup(
      createElement(CopyCommand, { command: agentSetupPrompt, prompt: "", label: "Copy prompt" }),
    );
    expect(html).not.toContain('class="ig-prompt"');
    expect(html).toContain('aria-label="Copy prompt"');
  });

  test("server-renders the catalog's three static terminal examples without replay chrome or metadata", () => {
    const html = renderToStaticMarkup(createElement(GraphProof));
    expect(html).toContain('aria-label="issue-graph terminal examples"');
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html.match(/role="tabpanel"/g)).toHaveLength(3);
    expect(html.match(/hidden=""/g)).toHaveLength(2);
    const panels = html.match(/<div\b[^>]*role="tabpanel"[^>]*>[\s\S]*?<\/div>/g) ?? [];
    for (const [index, example] of terminalExampleCatalog.map(toTerminalExample).entries()) {
      expect(html).toContain(`>${example.label}</button>`);
      const code = panels[index]?.match(/<pre><code>[\s\S]*?<\/code><\/pre>/)?.[0];
      expect(code).toBeDefined();
      expect(renderToStaticMarkup(createElement(Home))).toContain(code);
      expect(code?.replace(/<\/?span\b[^>]*>/g, "")).toBe(
        renderToStaticMarkup(
          createElement(
            "pre",
            null,
            createElement("code", null, `$ ${example.command}\n\n${example.output}`),
          ),
        ),
      );
    }
    expect(html).toContain("Approval does not imply merge readiness.");
    expect(html).not.toMatch(/Replay terminal demo|Expand terminal|ig-demo-transcript|Nodes: 5/);
    expect(html).not.toMatch(/stdoutSha256|excerptSha256|receiptFile|lineRanges|captureStartedAt/);
    expect(html).not.toContain("not a live feed");
    expect(html).not.toContain("Sources and capture limits");
    expect(html).not.toContain("Reproduce this result");
    expect(html).not.toContain("ig-proof-caption");
    expect(html).not.toContain("ig-proof-coverage");
  });
});
