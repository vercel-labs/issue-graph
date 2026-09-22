import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import Home from "../src/app/page";
import { CopyCommand } from "../src/components/copy-command";
import { GraphProof } from "../src/components/graph-proof";
import { InstallSelector } from "../src/components/install-selector";
import graph from "../src/lib/example-graph.json";
import { agentSetupPrompt, plannedInstallCommand } from "../src/lib/site";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("launch feedback", () => {
  test("uses the native Geistdocs Labs brand without replacing the library navbar", () => {
    const config = read("../src/lib/geistdocs/config.tsx");
    expect(config).toContain('navbarBrand: "labs"');
    const layout = read("../src/app/layout.tsx");
    expect(layout).toContain("<Navbar config={config} />");
    expect(layout).not.toContain("LogoVercelLabs");
  });

  test("removes the hero eyebrow and exposes the audience selector", () => {
    const html = renderToStaticMarkup(createElement(Home));
    expect(html).not.toContain("A Vercel Labs CLI for humans and agents");
    expect(html).not.toContain("ig-hero-eyebrow");
    expect(html).not.toContain("ig-graph-board");
    expect(html).toContain("Find related work.");
    expect(html).toContain("Before you start.");
    expect(html).toContain("For humans");
    expect(html).toContain("For agents");
  });

  test("uses native Geistdocs code blocks for the three workflows and final install", () => {
    const html = renderToStaticMarkup(createElement(Home));
    expect(html.match(/data-geist-code-block=""/g)).toHaveLength(4);
    expect(html.match(/data-section="tabs"/g)).toHaveLength(4);
    expect(html.match(/data-section="content"/g)).toHaveLength(4);
    expect(html).toContain(plannedInstallCommand);
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

  test("agent setup uses release-aware docs rather than an unavailable source skill", () => {
    expect(agentSetupPrompt).toBe("npx skills@latest add https://issue-graph.dev");
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

  test("renders a terminal window and accessible transcript without the explanatory footer", () => {
    const html = renderToStaticMarkup(createElement(GraphProof));
    expect(html).toContain('aria-label="issue-graph terminal demo"');
    expect(html).toContain('aria-label="Replay terminal demo"');
    expect(html).toContain('aria-label="Expand terminal"');
    expect(html).toContain('class="ig-demo-transcript"');
    expect(html).toContain(graph.terminalOutput);
    expect(html).toContain(graph.command);
    expect(html).not.toContain("not a live feed");
    expect(html).not.toContain("Sources and capture limits");
    expect(html).not.toContain("Reproduce this result");
    expect(html).not.toContain("ig-proof-caption");
    expect(html).not.toContain("ig-proof-coverage");
  });
});
