"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  plainTerminalText,
  type TerminalDemoProps,
  type TerminalDemoRuntimeProps,
} from "@/lib/terminal-demo";
import "./terminal-demo.css";

function TerminalFallback({ command, output }: TerminalDemoProps) {
  return (
    <div className="ig-demo-fallback" aria-hidden="true">
      <code>$ {command}</code>
      <pre>{plainTerminalText(output).split("\n").slice(0, 9).join("\n")}</pre>
    </div>
  );
}

const Runtime = dynamic<TerminalDemoRuntimeProps>(
  () => import("./terminal-demo-runtime").catch(() => ({ default: TerminalFallback })),
  { ssr: false },
);

export function TerminalDemo({ command, output }: TerminalDemoProps) {
  const windowRef = useRef<HTMLElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  const [canMount, setCanMount] = useState(false);
  const [active, setActive] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [replay, setReplay] = useState(0);
  const [failed, setFailed] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const handleError = useCallback(() => setFailed(true), []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let visible = false;
    let fontsReady = false;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotion = () => setReducedMotion(motion.matches);
    const update = () => {
      if (cancelled) return;
      const rect = host.getBoundingClientRect();
      const running = visible && !document.hidden && rect.width > 0 && rect.height > 0;
      setActive(running);
      if (running && fontsReady) setCanMount(true);
    };
    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      update();
    });
    const resize = new ResizeObserver(update);
    intersection.observe(host);
    resize.observe(host);
    document.addEventListener("visibilitychange", update);
    motion.addEventListener("change", updateMotion);
    updateMotion();
    void document.fonts.ready.then(() => {
      fontsReady = true;
      update();
    });
    return () => {
      cancelled = true;
      intersection.disconnect();
      resize.disconnect();
      document.removeEventListener("visibilitychange", update);
      motion.removeEventListener("change", updateMotion);
    };
  }, []);

  useEffect(() => {
    let wasFullscreen = false;
    const changed = () => {
      const next = document.fullscreenElement === windowRef.current;
      setFullscreen(next);
      if (wasFullscreen && !next) expandRef.current?.focus({ preventScroll: true });
      wasFullscreen = next;
    };
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);

  useEffect(() => {
    if (!expanded) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setExpanded(false);
      expandRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [expanded]);

  const toggleExpanded = async () => {
    const element = windowRef.current;
    if (!element) return;
    if (document.fullscreenElement === element) {
      try {
        await document.exitFullscreen();
      } catch {
        expandRef.current?.focus({ preventScroll: true });
      }
    } else if (expanded) {
      setExpanded(false);
    } else {
      try {
        if (!element.requestFullscreen) throw new Error("Fullscreen unavailable");
        await element.requestFullscreen();
      } catch {
        setExpanded(true);
      }
    }
  };

  return (
    <section
      ref={windowRef}
      className={`ig-demo${expanded ? " ig-demo-expanded" : ""}`}
      aria-label="issue-graph terminal demo"
    >
      <div className="ig-demo-bar">
        <div className="ig-demo-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <span className="ig-demo-title">issue-graph</span>
        <div className="ig-demo-controls">
          <button
            type="button"
            aria-label="Replay terminal demo"
            title="Replay"
            onClick={() => {
              setFailed(false);
              setReplay((value) => value + 1);
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M3 10a9 9 0 1 1 2 8M3 4v6h6" />
            </svg>
          </button>
          <button
            ref={expandRef}
            type="button"
            aria-label={fullscreen || expanded ? "Collapse terminal" : "Expand terminal"}
            aria-expanded={fullscreen || expanded}
            title={fullscreen || expanded ? "Collapse" : "Expand"}
            onClick={() => void toggleExpanded()}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d={
                  fullscreen || expanded
                    ? "m3 3 7 7M4 10h6V4m11 17-7-7m6 0h-6v6"
                    : "M15 3h6v6m0-6-7 7M9 21H3v-6m0 6 7-7"
                }
              />
            </svg>
          </button>
        </div>
      </div>
      <div ref={hostRef} className="ig-demo-body">
        {failed ? (
          <TerminalFallback command={command} output={output} />
        ) : canMount ? (
          <Runtime
            command={command}
            output={output}
            active={active}
            reducedMotion={reducedMotion}
            replay={replay}
            onError={handleError}
          />
        ) : (
          <div className="ig-demo-placeholder" aria-hidden="true">
            <span>$</span> {command}
          </div>
        )}
      </div>
      <div className="ig-demo-transcript">
        <p>issue-graph command and output</p>
        <pre>{`$ ${command}\n\n${output}`}</pre>
      </div>
    </section>
  );
}
