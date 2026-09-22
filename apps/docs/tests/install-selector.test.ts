import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { InstallSelector } from "../src/components/install-selector";
import { plannedInstallCommand } from "../src/lib/site";

const css = readFileSync(
  new URL("../src/components/install-selector.css", import.meta.url),
  "utf8",
);

describe("install selector", () => {
  test("renders the human command with accessible audience and copy buttons", () => {
    const html = renderToStaticMarkup(createElement(InstallSelector));
    expect(html).toContain('aria-label="Installation audience"');
    expect(html).toContain('aria-pressed="true">For humans');
    expect(html).toContain('aria-pressed="false">For agents');
    expect(html).toContain(`<code>${plannedInstallCommand}</code>`);
    expect(html).toContain('aria-label="Copy npm install command"');
    expect(html).toContain('class="ig-selector-divider" aria-hidden="true"');
  });

  test("keeps both icons mounted and the measurement text out of the accessibility tree", () => {
    const html = renderToStaticMarkup(createElement(InstallSelector));
    expect(html).toContain("ig-selector-copy-icon");
    expect(html).toContain("ig-selector-check-icon");
    expect(html).toContain('class="ig-selector-measure" aria-hidden="true"');
    expect(html).toContain('role="status" aria-live="polite" aria-atomic="true"');
    expect(html).not.toContain('role="alert"');
  });

  test("starts without helper paragraphs, navigation, or source-only skill links", () => {
    const html = renderToStaticMarkup(createElement(InstallSelector));
    expect(html).not.toMatch(/<p[\s>]/);
    expect(html).not.toMatch(/<a[\s>]/);
    expect(html).not.toContain("npx skills");
    expect(html).not.toContain("/skill.md");
  });

  test("uses the shared CSS motion values, reduced motion, and touch target sizes", () => {
    expect(css).toContain("width 400ms cubic-bezier(0.32, 0.72, 0, 1)");
    expect(css).toContain("opacity 200ms cubic-bezier(0.23, 1, 0.32, 1)");
    expect(css).toContain("scale 200ms cubic-bezier(0.23, 1, 0.32, 1)");
    expect(css).toContain("ig-selector-fade-in 200ms ease-out forwards");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("transition: none");
    expect(css).toContain("animation: none");
    expect(css).toContain("min-height: 44px");
    expect(css).toContain("width: 44px");
    expect(css).toContain("height: 44px");
  });
});
