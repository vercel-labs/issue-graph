"use client";

import { Terminal, type TerminalHandle, type WTerm } from "@wterm/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CLEAR_TERMINAL,
  createTerminalPlayback,
  type TerminalDemoRuntimeProps,
  terminalReplayFrames,
} from "@/lib/terminal-demo";
import "@wterm/react/css";

const ignoreInput = () => {};

export default function TerminalDemoRuntime({
  command,
  output,
  active,
  reducedMotion,
  replay,
  onError,
}: TerminalDemoRuntimeProps) {
  const ref = useRef<TerminalHandle>(null);
  const [terminal, setTerminal] = useState<WTerm | null>(null);
  const playback = useRef<ReturnType<typeof createTerminalPlayback> | null>(null);
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const activity = useRef({ active, reducedMotion });
  const sequence = useMemo(
    () => ({ frames: terminalReplayFrames(command, output), replay }),
    [command, output, replay],
  );

  const ready = useCallback((instance: WTerm) => {
    if (ref.current?.instance !== instance) return;
    instance.element.removeAttribute("aria-multiline");
    const input = instance.element.querySelector("textarea");
    if (input) {
      input.readOnly = true;
      input.disabled = true;
      input.tabIndex = -1;
    }
    setTerminal(instance);
  }, []);

  const redraw = useCallback(() => {
    if (!terminal || ref.current?.instance !== terminal) return;
    clearTimeout(resizeTimer.current);
    resizeTimer.current = setTimeout(() => {
      if (!terminal || ref.current?.instance !== terminal) return;
      try {
        terminal.write(CLEAR_TERMINAL + (playback.current?.transcript ?? ""));
      } catch {
        onError();
      }
    }, 80);
  }, [terminal, onError]);

  useEffect(() => {
    activity.current = { active, reducedMotion };
    playback.current?.setActive(active, reducedMotion);
  }, [active, reducedMotion]);

  useEffect(() => {
    if (!terminal || ref.current?.instance !== terminal) return;
    try {
      terminal.write(CLEAR_TERMINAL);
    } catch {
      onError();
      return;
    }
    const controller = createTerminalPlayback(sequence.frames, (text) => {
      if (ref.current?.instance !== terminal) return;
      try {
        terminal.write(text);
      } catch {
        onError();
      }
    });
    playback.current = controller;
    controller.setActive(activity.current.active, activity.current.reducedMotion);
    return () => {
      controller.dispose();
      clearTimeout(resizeTimer.current);
      playback.current = null;
    };
  }, [terminal, sequence, onError]);

  return (
    <div className="ig-demo-runtime" inert={!terminal}>
      <Terminal
        ref={ref}
        role="region"
        aria-label="Terminal output"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey) return;
          const viewport = event.currentTarget;
          const destinations: Record<string, number> = {
            ArrowUp: viewport.scrollTop - 21,
            ArrowDown: viewport.scrollTop + 21,
            PageUp: viewport.scrollTop - viewport.clientHeight,
            PageDown: viewport.scrollTop + viewport.clientHeight,
            Home: 0,
            End: viewport.scrollHeight,
          };
          const destination = destinations[event.key];
          if (destination === undefined) return;
          event.preventDefault();
          viewport.scrollTop = destination;
        }}
        autoResize
        cursorBlink={active && !reducedMotion}
        onReady={ready}
        onResize={redraw}
        onData={ignoreInput}
        onError={onError}
        className="ig-demo-screen"
      />
    </div>
  );
}
