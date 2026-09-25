import type { ReactNode } from "react";
import { statusPresentation, terminalPresentation } from "@/lib/terminal-presentation";
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
  if (line.startsWith("Totals:"))
    return highlight(line, /\b\d+\b/g, ([value]) => (value === "0" ? "muted" : "strong"));
  return highlight(line, /\b(?:OPEN|CLOSED|MERGED)\b|\bNext:|\(depth \d+\)/g, ([token]) => {
    if (token === "OPEN") return "positive";
    if (token === "Next:") return "reference";
    if (token.startsWith("(depth")) return "muted";
    return "merged";
  });
}

function lineTone(line: string) {
  if (
    /^(?:Reference graph:|Projects$|Backlog plan:|Next$|Decision$|Orphan checklist|Totals:)/.test(
      line,
    )
  )
    return "heading";
  if (/^(?:issue-graph status ·|Seeds:|Query window:|[─┼]|Review=)|^\s+- review-open-pr/.test(line))
    return "muted";
  return "plain";
}

function columnTone(label: string, value: string) {
  if (value === "?") return "attention";
  if (value === "0") return "muted";
  if (value === label) return "strong";
  if (label === "Review" || label === "Changes" || label === "Conflicts") return "attention";
  if (label === "Approved") return "positive";
  if (/^\d+$/.test(value)) return "strong";
  return label === "Project" ? "muted" : undefined;
}

export function TerminalPresentation({ output, exampleId }: { output: string; exampleId: string }) {
  const status = exampleId === "status" ? statusPresentation(output) : null;
  if (status)
    return (
      <div className="ig-demo-status">
        {status.projects.map((project) => (
          <div className="ig-demo-project" key={project.name}>
            <div className="ig-demo-status-heading">
              <h3>{project.name}</h3>
              <strong>
                {project.open} open PR{project.open === "1" ? "" : "s"}
              </strong>
            </div>
            <div className="ig-demo-status-capture">
              {status.capture} ·{" "}
              <span
                className={status.coverage === "complete" ? undefined : "ig-demo-status-unknown"}
              >
                Coverage {status.coverage}
              </span>
            </div>
            <div className="ig-demo-status-tables">
              {[
                { label: "Author", count: "Open PRs", rows: project.authors },
                { label: "Review state", count: "PRs", rows: project.reviews },
              ]
                .filter(({ rows }) => rows.length > 0)
                .map((table) => (
                  <table key={table.label} aria-label={`${project.name} ${table.label}`}>
                    <thead>
                      <tr>
                        <th scope="col">{table.label}</th>
                        <th scope="col">{table.count}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {table.rows.map(({ label, value }) => (
                        <tr
                          key={label}
                          className={value === "0" ? "ig-demo-status-zero" : undefined}
                        >
                          <th scope="row">{label}</th>
                          <td>{value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ))}
            </div>
            <div className="ig-demo-status-flags">
              <span>Flags:</span>
              {[
                { label: "conflicts", value: project.conflicts },
                ...(status.singleProject && project.name !== "Total" ? status.flags : []),
              ].map(({ label, value }) => (
                <span key={label} className={value === "0" ? "ig-demo-status-zero" : undefined}>
                  {value} {label}
                </span>
              ))}
            </div>
          </div>
        ))}
        {!status.singleProject ? (
          <div className="ig-demo-status-flags">
            <span>Scope flags:</span>
            {status.flags.map(({ label, value }) => (
              <span key={label} className={value === "0" ? "ig-demo-status-zero" : undefined}>
                {value} {label}
              </span>
            ))}
          </div>
        ) : null}
        <div className="ig-demo-status-prose">{status.caveats}</div>
      </div>
    );
  const rows = terminalPresentation(output, exampleId);
  if (!rows)
    return (
      <pre className={exampleId === "status" ? "ig-demo-table" : "ig-demo-verbatim"}>
        <code>
          <TerminalOutput output={output} exampleId={exampleId} />
        </code>
      </pre>
    );
  return (
    <div className={`ig-demo-reading ig-demo-reading-${exampleId}`}>
      {rows.map((row) =>
        row.kind === "item" ? (
          <div className="ig-demo-item" key={row.reference}>
            <span className="ig-demo-identity">{row.reference}</span>
            {row.state ? <span className="ig-demo-state">{outputTokens(row.state)}</span> : null}
            <span className="ig-demo-item-title">{row.title}</span>
            {row.details.map((detail) => (
              <div className="ig-demo-detail" key={detail}>
                {outputTokens(detail)}
              </div>
            ))}
            {row.metrics ? (
              <div className="ig-demo-detail ig-demo-metrics">{row.metrics}</div>
            ) : null}
          </div>
        ) : row.kind === "summary" ? (
          <div className="ig-demo-counts ig-demo-reading-summary" key={row.text}>
            {row.text.split(" · ").map((count) => (
              <span key={count}>
                {highlight(count, /(?:\d+|\?)$/g, ([value]) =>
                  value === "0" ? "muted" : "strong",
                )}
              </span>
            ))}
          </div>
        ) : (
          <div className={`ig-demo-reading-${row.kind}`} key={row.text}>
            {highlight(row.text, /(?<=: )\d+$/g, ([value]) => (value === "0" ? "muted" : "strong"))}
          </div>
        ),
      )}
    </div>
  );
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
