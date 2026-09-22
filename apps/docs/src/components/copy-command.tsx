"use client";

import { useEffect, useRef, useState } from "react";

export function CopyCommand({
  command,
  label = "Copy command",
  prompt = "$",
}: {
  command: string;
  label?: string;
  prompt?: string;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus("idle"), 2500);
  }

  return (
    <div className="ig-command">
      {prompt ? (
        <span className="ig-prompt" aria-hidden="true">
          {prompt}
        </span>
      ) : null}
      <code>{command}</code>
      <button type="button" onClick={copy} aria-label={label}>
        <svg viewBox="0 0 20 20" width="18" height="18" fill="none" aria-hidden="true">
          {status === "copied" ? (
            <path d="m4 10 4 4 8-8" stroke="currentColor" strokeWidth="1.5" />
          ) : (
            <>
              <rect
                x="6"
                y="6"
                width="10"
                height="11"
                rx="2"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <path
                d="M12 6V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"
                stroke="currentColor"
                strokeWidth="1.5"
              />
            </>
          )}
        </svg>
      </button>
      <span className="ig-copy-status" aria-live="polite">
        {status === "copied" ? "Copied" : status === "failed" ? "Select the command to copy" : ""}
      </span>
    </div>
  );
}
