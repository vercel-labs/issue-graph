"use client";

import { type KeyboardEvent, useId, useLayoutEffect, useRef, useState } from "react";
import type { TerminalDemoProps } from "@/lib/terminal-demo";
import { renderTerminalCommand, TerminalPresentation } from "./terminal-output";
import "./terminal-demo.css";

const displayCommands: Record<string, string> = {
  graph: "issue-graph 1113 --repo vercel-labs/agent-browser --depth 1",
  status: "issue-graph status --repo vercel-labs/portless --author ctate,Railly --view projects",
  plan: "issue-graph plan --repo vercel-labs/wterm",
};

export function TerminalDemo({ examples }: TerminalDemoProps) {
  const instanceId = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const tabsRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [indicator, setIndicator] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  }>();

  useLayoutEffect(() => {
    const tabs = tabsRef.current;
    const selected = tabRefs.current[selectedIndex];
    if (!tabs || !selected) return;
    const measure = () => {
      setIndicator({
        left: selected.offsetLeft,
        top: selected.offsetTop,
        width: selected.offsetWidth,
        height: selected.offsetHeight,
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(tabs);
    for (const tab of tabRefs.current) if (tab) observer.observe(tab);
    return () => observer.disconnect();
  }, [selectedIndex]);

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    let nextIndex: number;
    switch (event.key) {
      case "ArrowLeft":
        nextIndex = (index - 1 + examples.length) % examples.length;
        break;
      case "ArrowRight":
        nextIndex = (index + 1) % examples.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = examples.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    setSelectedIndex(nextIndex);
    tabRefs.current[nextIndex]?.focus({ preventScroll: true });
    tabRefs.current[nextIndex]?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: "instant",
    });
  };

  return (
    <section className="ig-demo" aria-label="issue-graph terminal examples">
      <div
        ref={tabsRef}
        className="ig-demo-tabs"
        role="tablist"
        aria-label="Terminal examples"
        data-indicator-ready={indicator ? "true" : undefined}
      >
        {indicator ? (
          <span
            className="ig-demo-tab-indicator"
            aria-hidden="true"
            style={{
              transform: `translateX(${indicator.left}px)`,
              top: indicator.top,
              width: indicator.width,
              height: indicator.height,
            }}
          />
        ) : null}
        {examples.map((example, index) => (
          <button
            key={example.id}
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`${instanceId}-tab-${example.id}`}
            aria-controls={`${instanceId}-panel-${example.id}`}
            aria-selected={selectedIndex === index}
            tabIndex={selectedIndex === index ? 0 : -1}
            className="ig-demo-tab"
            onClick={() => setSelectedIndex(index)}
            onKeyDown={(event) => handleTabKeyDown(event, index)}
          >
            {example.label}
          </button>
        ))}
      </div>
      <p className="ig-demo-summary" aria-live="polite" aria-atomic="true">
        {examples[selectedIndex].summary}
      </p>
      <div className="ig-demo-frame">
        <div className="ig-demo-bar">
          <div className="ig-demo-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <span className="ig-demo-title">issue-graph</span>
        </div>
        {examples.map((example, index) => (
          <div
            key={example.id}
            role="tabpanel"
            data-example={example.id}
            id={`${instanceId}-panel-${example.id}`}
            aria-labelledby={`${instanceId}-tab-${example.id}`}
            hidden={selectedIndex !== index}
            tabIndex={selectedIndex === index ? 0 : -1}
            className="ig-demo-panel"
          >
            <div className="ig-demo-command">
              <span className="ig-demo-prompt">$ </span>
              {renderTerminalCommand(displayCommands[example.id] ?? example.command)}
            </div>
            <TerminalPresentation output={example.output} exampleId={example.id} />
          </div>
        ))}
      </div>
    </section>
  );
}
