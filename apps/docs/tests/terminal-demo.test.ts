import { readFileSync } from "node:fs";
import { WasmBridge } from "@wterm/dom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { TerminalDemo } from "../src/components/terminal-demo";
import graph from "../src/lib/example-graph.json";
import {
  CLEAR_TERMINAL,
  colorTerminalLine,
  createTerminalPlayback,
  plainTerminalText,
  terminalReplayFrames,
} from "../src/lib/terminal-demo";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const frames = terminalReplayFrames(graph.command, graph.terminalOutput);
const complete = frames.map((frame) => frame.text).join("");

function screen(core: WasmBridge) {
  return Array.from({ length: core.getRows() }, (_, row) =>
    Array.from({ length: core.getCols() }, (_, column) =>
      String.fromCodePoint(core.getCell(row, column).char || 32),
    )
      .join("")
      .trimEnd(),
  ).join("\n");
}

afterEach(() => vi.useRealTimers());

describe("terminal demo presentation", () => {
  test("keeps the original facts and identifiers while removing Markdown emphasis", () => {
    const text = plainTerminalText(graph.terminalOutput);
    expect(text).not.toContain("**");
    expect(text).not.toContain("_(depth");
    expect(text).toContain("PR_SET_PDEATHSIG");
    for (const node of graph.nodes) expect(text).toContain(node.key);
    expect(colorTerminalLine("## Nodes")).toBe("\x1b[1;36mNodes\x1b[0m\r\n");
    expect(colorTerminalLine("OPEN CLOSED MERGED")).toContain("\x1b[32mOPEN\x1b[0m");
    expect(colorTerminalLine("OPEN CLOSED MERGED")).toContain("\x1b[35mMERGED\x1b[0m");
  });

  test("types whole graphemes and emits complete ANSI sequences with CRLF", () => {
    const unicode = terminalReplayFrames("echo 👩‍💻", "## Result\nOPEN");
    expect(unicode.some((frame) => frame.text === "👩‍💻")).toBe(true);
    expect(complete).not.toMatch(/(?<!\r)\n/);
    expect(complete).toContain(graph.command);
    expect(complete.endsWith("\x1b[?25l")).toBe(true);
    expect(plainTerminalText(String.fromCharCode(0, 7, 27, 127))).toBe("");
  });

  test("renders only chrome and a bounded placeholder before client initialization", () => {
    const html = renderToStaticMarkup(
      createElement(TerminalDemo, { command: graph.command, output: graph.terminalOutput }),
    );
    expect(html).toContain('aria-label="Replay terminal demo"');
    expect(html).toContain('aria-label="Expand terminal"');
    expect(html).toContain('class="ig-demo-dots" aria-hidden="true"');
    expect(html).toContain('class="ig-demo-transcript"');
    expect(html).toContain(graph.terminalOutput);
    expect(html).not.toMatch(/Sources and capture limits|figcaption|not a live feed/);
    expect(html).not.toContain("textarea");
    expect(html.match(/<pre>/g)).toHaveLength(1);
  });

  test("isolates the heavy runtime and bounds layout, motion, input and fullscreen", () => {
    const loader = read("../src/components/terminal-demo.tsx");
    const runtime = read("../src/components/terminal-demo-runtime.tsx");
    const css = read("../src/components/terminal-demo.css");
    expect(loader).toContain('import("./terminal-demo-runtime")');
    expect(loader).toContain("ssr: false");
    expect(loader).toContain("document.fonts.ready");
    expect(loader).toContain("IntersectionObserver");
    expect(loader).toContain("!document.hidden");
    expect(loader).toContain("requestFullscreen");
    expect(loader).toContain('event.key !== "Escape"');
    expect(runtime).toContain('from "@wterm/react"');
    expect(runtime).toContain('import "@wterm/react/css"');
    expect(runtime).toContain("inert={!terminal}");
    expect(runtime).toContain("input.disabled = true");
    expect(runtime).toContain("input.tabIndex = -1");
    expect(runtime).toContain("onData={ignoreInput}");
    expect(loader + runtime).not.toMatch(/fetch\(|WebSocket|just-bash|libfx|wasmUrl=/);
    expect(css).toContain("height: 400px");
    expect(css).toContain("height: 300px");
    expect(css).toContain(".ig-demo:fullscreen");
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain(".dark-theme .ig-demo");
  });
});

describe("terminal replay lifecycle", () => {
  test("pauses without accumulating hidden work and resumes exactly once", () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const playback = createTerminalPlayback(frames, write);
    playback.setActive(true);
    vi.advanceTimersByTime(100);
    const prefix = playback.transcript;
    expect(prefix.length).toBeGreaterThan(0);
    expect(prefix.length).toBeLessThan(complete.length);
    playback.setActive(false);
    vi.advanceTimersByTime(10_000);
    expect(playback.transcript).toBe(prefix);
    expect(vi.getTimerCount()).toBe(0);
    playback.setActive(true);
    vi.runAllTimers();
    expect(playback.transcript).toBe(complete);
    expect(write.mock.calls.map(([text]) => text).join("")).toBe(complete);
    playback.setActive(true);
    expect(vi.getTimerCount()).toBe(0);
    playback.dispose();
  });

  test("reduced motion completes in one write and does not animate offscreen", () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const playback = createTerminalPlayback(frames, write);
    playback.setActive(false, true);
    expect(write).not.toHaveBeenCalled();
    playback.setActive(true, true);
    expect(write).toHaveBeenCalledExactlyOnceWith(complete);
    expect(vi.getTimerCount()).toBe(0);
    playback.dispose();
  });

  test("motion changes finish only the remaining prefix, and cleanup prevents late writes", () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const playback = createTerminalPlayback(frames, write);
    playback.setActive(true);
    vi.advanceTimersByTime(50);
    playback.setActive(true, true);
    expect(write.mock.calls.map(([text]) => text).join("")).toBe(complete);
    playback.dispose();
    playback.setActive(true);
    vi.runAllTimers();
    expect(write.mock.calls.map(([text]) => text).join("")).toBe(complete);
    const cancelledWrite = vi.fn();
    const cancelled = createTerminalPlayback(frames, cancelledWrite);
    cancelled.setActive(true);
    cancelled.dispose();
    vi.runAllTimers();
    expect(cancelledWrite).not.toHaveBeenCalled();
  });
});

describe("published wterm WASM", () => {
  test("renders the captured text and heading color with the actual embedded core", async () => {
    const core = await WasmBridge.load();
    core.init(200, 48);
    core.writeString(CLEAR_TERMINAL + complete);
    expect(screen(core)).toContain("Reference graph: vercel-labs/agent-browser#1113");
    expect(screen(core)).toContain("PR_SET_PDEATHSIG");
    expect(screen(core)).toContain("OPEN issue");
    expect(screen(core)).not.toContain("**");
    expect(core.getCell(2, 0).fg).toBe(6);
    expect(core.getCursor().visible).toBe(false);
  });

  test("clear and prefix redraw after shrinking matches a fresh terminal at that size", async () => {
    const resized = await WasmBridge.load();
    const fresh = await WasmBridge.load();
    resized.init(100, 16);
    resized.writeString(complete);
    resized.resize(40, 12);
    resized.writeString(CLEAR_TERMINAL);
    expect(resized.getScrollbackCount()).toBe(0);
    resized.writeString(complete);
    fresh.init(40, 12);
    fresh.writeString(complete);
    expect(screen(resized)).toBe(screen(fresh));
    expect(resized.getCursor()).toEqual(fresh.getCursor());
    expect(resized.getScrollbackCount()).toBe(fresh.getScrollbackCount());
  });
});
