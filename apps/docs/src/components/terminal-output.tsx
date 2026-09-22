import type { ReactNode } from "react";
import "./terminal-output.css";

function highlight(
  text: string,
  pattern: RegExp,
  toneFor: (match: RegExpExecArray) => string | undefined,
) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    parts.push(text.slice(cursor, match.index));
    const tone = toneFor(match);
    parts.push(
      tone ? (
        <span key={match.index} className={`ig-demo-token-${tone}`}>
          {match[0]}
        </span>
      ) : (
        match[0]
      ),
    );
    cursor = match.index + match[0].length;
  }
  parts.push(text.slice(cursor));
  return parts;
}

export function renderTerminalCommand(command: string) {
  return (
    <span className="ig-terminal-command">
      {highlight(
        command,
        /--?[\w-]+|\bissue-graph@latest\b|\b(?:issue-graph|npm)\b|\b(?:status|plan|install)\b|[\w.-]+\/[\w.-]+|\b\d+\b/g,
        ([token]) => {
          if (token === "issue-graph" || token === "npm") return "merged";
          return token.includes("/") || token.endsWith("@latest") ? "positive" : "reference";
        },
      )}
    </span>
  );
}

function outputTokens(line: string) {
  return highlight(line, /\b(?:OPEN|CLOSED|MERGED)\b|\bNext:|\(depth \d+\)/g, ([token]) => {
    if (token === "OPEN") return "positive";
    if (token === "Next:") return "reference";
    if (token.startsWith("(depth")) return "muted";
    return "merged";
  });
}

function lineTone(line: string) {
  if (
    /^(?:Reference graph:|issue-graph status ·|Projects$|Backlog plan:|Next$|Decision$|Orphan checklist|Totals:)/.test(
      line,
    )
  )
    return "heading";
  if (/^(?:Seeds:|Query window:|[─┼]|Review=|Flags overlap)|^\s+- review-open-pr/.test(line))
    return "muted";
  return "plain";
}

function columnTone(label: string, value: string) {
  if (value === "?") return "attention";
  if (value === "0") return "muted";
  if (value === label) return "strong";
  if (label === "Review" || label === "Changes" || label === "Conflicts") return "attention";
  if (label === "Approved") return "positive";
  return undefined;
}

export function TerminalOutput({ output, exampleId }: { output: string; exampleId: string }) {
  const header =
    exampleId === "status" ? output.split("\n").find((line) => line.startsWith("Project  ")) : "";
  const columns = Array.from(header?.matchAll(/\S+(?: \(open\))?/g) ?? []).filter(
    ([label]) => label !== "│",
  );

  return Array.from(output.matchAll(/[^\n]+|\n/g), (match) => {
    const line = match[0];
    if (line === "\n") return line;
    const tone = lineTone(line);
    const isTableRow = columns.length > 0 && /^[^\s─]+\s{2,}/.test(line);
    let content: ReactNode = tone === "muted" ? line : outputTokens(line);
    if (isTableRow) {
      content = highlight(line, /\S+(?: \(open\))?/g, (cell) => {
        if (cell[0] === "│") return "muted";
        const column = columns.findLast((column) => column.index <= cell.index);
        return columnTone(column?.[0] ?? "", cell[0]);
      });
    }
    return (
      <span key={match.index} className={`ig-demo-line ig-demo-line-${tone}`}>
        {content}
      </span>
    );
  });
}
