"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { agentSetupPrompt, plannedInstallCommand } from "@/lib/site";
import "./install-selector.css";

type Audience = "human" | "agent";

export function InstallSelector() {
  const [audience, setAudience] = useState<Audience>("human");
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const [width, setWidth] = useState<number>();
  const [overflowing, setOverflowing] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const prefixRef = useRef<HTMLSpanElement>(null);
  const copyRef = useRef<HTMLButtonElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestRef = useRef(0);
  const errorId = useId();
  const isAgent = audience === "agent";
  const command = isAgent ? agentSetupPrompt : plannedInstallCommand;

  useLayoutEffect(() => {
    const root = rootRef.current;
    const pill = pillRef.current;
    const measure = measureRef.current;
    const copyButton = copyRef.current;
    if (!root || !pill || !measure || !copyButton) return;
    let active = true;

    function updateWidth() {
      if (!active || !root || !pill || !measure || !copyButton) return;
      if (measure.textContent !== command) return;
      const style = getComputedStyle(pill);
      const prefixWidth = prefixRef.current?.getBoundingClientRect().width ?? 0;
      const gaps = Number.parseFloat(style.columnGap) * (prefixWidth ? 2 : 1);
      const available = Math.max(
        0,
        root.getBoundingClientRect().width -
          Number.parseFloat(style.paddingLeft) -
          Number.parseFloat(style.paddingRight) -
          copyButton.getBoundingClientRect().width -
          prefixWidth -
          gaps,
      );
      const natural = measure.getBoundingClientRect().width;
      setWidth(Math.min(natural, available));
      setOverflowing(natural > available);
    }

    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(root);
    observer.observe(measure);
    document.fonts.addEventListener("loadingdone", updateWidth);
    void document.fonts.ready.then(updateWidth);

    return () => {
      active = false;
      observer.disconnect();
      document.fonts.removeEventListener("loadingdone", updateWidth);
    };
  }, [command]);

  useEffect(
    () => () => {
      requestRef.current += 1;
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  function selectAudience(next: Audience) {
    if (next === audience) return;
    requestRef.current += 1;
    if (timerRef.current) clearTimeout(timerRef.current);
    setStatus("idle");
    setAudience(next);
  }

  async function copy() {
    const request = ++requestRef.current;
    if (timerRef.current) clearTimeout(timerRef.current);
    setStatus("idle");
    try {
      await navigator.clipboard.writeText(command);
      if (request !== requestRef.current) return;
      setStatus("copied");
      timerRef.current = setTimeout(() => setStatus("idle"), 1000);
    } catch {
      if (request === requestRef.current) setStatus("failed");
    }
  }

  return (
    <div className="ig-install-selector ig-selector" ref={rootRef}>
      <fieldset className="ig-selector-audience" aria-label="Installation audience">
        <button type="button" onClick={() => selectAudience("human")} aria-pressed={!isAgent}>
          For humans
        </button>
        <span className="ig-selector-divider" aria-hidden="true" />
        <button type="button" onClick={() => selectAudience("agent")} aria-pressed={isAgent}>
          For agents
        </button>
      </fieldset>
      <div className="ig-selector-pill" ref={pillRef}>
        <span className="ig-selector-prefix" ref={prefixRef} aria-hidden="true">
          $
        </span>
        <div
          className="ig-selector-viewport"
          style={{ width }}
          data-overflow={overflowing || undefined}
        >
          <span className="ig-selector-measure" ref={measureRef} aria-hidden="true">
            {command}
          </span>
          <pre className="ig-selector-text" key={command} tabIndex={overflowing ? 0 : undefined}>
            <code>{command}</code>
          </pre>
        </div>
        <button
          className="ig-selector-copy"
          type="button"
          ref={copyRef}
          onClick={copy}
          aria-label={
            status === "copied"
              ? "Copied"
              : isAgent
                ? "Copy skill install command"
                : "Copy npm install command"
          }
          aria-describedby={status === "failed" ? errorId : undefined}
          data-copied={status === "copied" || undefined}
        >
          <span className="ig-selector-icon ig-selector-copy-icon" aria-hidden="true">
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
              <rect x="5.75" y="5.25" width="8.5" height="9.5" rx="1.25" />
              <path d="M3.75 10.75h-1A1.25 1.25 0 0 1 1.5 9.5V2.25A1.25 1.25 0 0 1 2.75 1h4.5A1.25 1.25 0 0 1 8.5 2.25v1" />
            </svg>
          </span>
          <span className="ig-selector-icon ig-selector-check-icon" aria-hidden="true">
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
              <path d="m2 8 4 4 8-8" />
            </svg>
          </span>
        </button>
      </div>
      <span className="ig-selector-status" role="status" aria-live="polite" aria-atomic="true">
        {status === "copied" ? "Copied" : ""}
      </span>
      {status === "failed" ? (
        <p className="ig-selector-error" id={errorId} role="alert">
          Could not copy. Select the text to copy it manually, or try again.
        </p>
      ) : null}
    </div>
  );
}
