import { formatStatusCapture } from "../../../../src/status-render";

export function statusPresentation(output: string) {
  const lines = output.split("\n");
  const owner = lines[0]?.match(/^issue-graph status · Owner: ([\w.-]+) · /)?.[1];
  const start = lines.findIndex((line) => line.startsWith("Project  "));
  const end = lines.findIndex((line, index) => index > start && line === "");
  if (!owner || start < 0 || end <= start) return null;
  const columns = Array.from(lines[start].matchAll(/\S+(?: \(open\))?/g)).filter(
    ([label]) => label !== "│",
  );
  const reviewLabels: Record<string, string> = {
    Review: "Needs review",
    Approved: "Approved",
    Changes: "Changes requested",
    None: "Not required",
    Unknown: "Unknown",
  };
  if (columns[0]?.[0] !== "Project" || columns.length < 2) return null;
  if (
    columns
      .slice(1)
      .some(
        ([label]) =>
          !label.endsWith(" (open)") &&
          !["Open", "Conflicts", ...Object.keys(reviewLabels)].includes(label),
      )
  )
    return null;
  const query = lines
    .find((line) => line.startsWith("Query window:"))
    ?.match(/^Query window: (\S+) → (\S+) · Coverage: (.+)$/);
  const totals = lines
    .find((line) => line.startsWith("Totals:"))
    ?.match(
      /^Totals: Open (\d+|\?) · Drafts (\d+|\?) · Unassigned (\d+|\?)(?: · Merge unknown (\d+|\?))?$/,
    );
  if (
    !totals ||
    lines
      .slice(1, start)
      .some((line) => line && line !== "Projects" && line !== query?.[0] && line !== totals[0])
  )
    return null;
  const projects: { name: string; metrics: { label: string; value: string }[] }[] = [];
  for (const line of lines.slice(start + 1, end)) {
    if (/^[─┼ ]+$/.test(line)) continue;
    const cells = Array.from(line.matchAll(/\S+/g)).filter(([value]) => value !== "│");
    const name = cells.shift();
    if (name?.index !== 0 || !/^[\w.-]+$/.test(name[0])) return null;
    const metrics: { label: string; value: string }[] = [];
    for (const cell of cells) {
      const column = columns.findLast((column) => column.index <= cell.index);
      if (!column || column[0] === "Project" || !/^(?:\d+|\?)$/.test(cell[0])) return null;
      if (metrics.some((metric) => metric.label === column[0])) return null;
      metrics.push({ label: column[0], value: cell[0] });
    }
    const expected = columns
      .slice(1)
      .filter(([label]) => name[0] !== "Total" || !label.endsWith(" (open)"));
    if (
      metrics.length !== expected.length ||
      expected.some(([label]) => !metrics.some((metric) => metric.label === label))
    )
      return null;
    projects.push({ name: name[0] === "Total" ? "Total" : `${owner}/${name[0]}`, metrics });
  }
  if (!projects.length) return null;
  const actual = projects.filter(({ name }) => name !== "Total");
  const singleProject = actual.length === 1 && / · 1 repos · /.test(lines[0]);
  const total = projects.find(({ name }) => name === "Total");
  if (!total || total.metrics.find(({ label }) => label === "Open")?.value !== totals[1])
    return null;
  const displayed = projects.filter(
    (project) =>
      project.name !== "Total" ||
      !singleProject ||
      !project.metrics.every(
        (metric) =>
          metric.value !== "?" &&
          actual[0].metrics.some(
            (item) => item.label === metric.label && item.value === metric.value,
          ),
      ),
  );
  if (
    projects.some((project) =>
      ["Open", "Conflicts", ...Object.keys(reviewLabels)].some(
        (label) => !project.metrics.some((metric) => metric.label === label),
      ),
    )
  )
    return null;
  const flags = [
    { label: "drafts", value: totals[2] },
    { label: "unassigned", value: totals[3] },
  ];
  if (totals[4]) flags.push({ label: "merge unknown", value: totals[4] });
  return {
    projects: displayed.map((project) => ({
      name: project.name,
      open: project.metrics.find(({ label }) => label === "Open")?.value ?? "?",
      authors: project.metrics
        .filter(({ label }) => label.endsWith(" (open)"))
        .map(({ label, value }) => ({ label: label.replace(/ \(open\)$/, ""), value })),
      reviews: Object.entries(reviewLabels).map(([key, label]) => ({
        label,
        value: project.metrics.find((metric) => metric.label === key)?.value ?? "?",
      })),
      conflicts: project.metrics.find(({ label }) => label === "Conflicts")?.value ?? "?",
    })),
    capture: formatStatusCapture(query?.[1] ?? "", query?.[2] ?? ""),
    coverage: query?.[3] ?? "unknown",
    flags,
    singleProject,
    caveats: lines
      .slice(end)
      .join("\n")
      .trim()
      .replace(
        "Review=required; None=not required; Unknown=review unknown; ?=unknown, not zero.",
        "? means unknown, not zero.",
      ),
  };
}

type PresentationRow =
  | { kind: "context" | "heading" | "text" | "summary"; text: string }
  | {
      kind: "item";
      reference: string;
      state: string;
      title: string;
      details: string[];
      metrics?: string;
    };

function backlogPresentation(output: string): PresentationRow[] | null {
  const lines = output.split("\n");
  const repository = lines[0]?.match(/^Backlog plan: ([\w.-]+\/[\w.-]+)$/)?.[1];
  if (!repository) return null;
  const sameRepository = Array.from(output.matchAll(/([\w.-]+\/[\w.-]+)#\d+/g)).every(
    (match) => match[1] === repository,
  );
  const rows: PresentationRow[] = [{ kind: "context", text: repository }];
  let item: Extract<PresentationRow, { kind: "item" }> | undefined;
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const count = line.match(
      /^- ((?:Open items|Ready actions|Needs investigation|Blocked): (?:\d+|\?))$/,
    );
    if (count) {
      const previous = rows.at(-1);
      if (previous?.kind === "summary") previous.text += ` · ${count[1]}`;
      else rows.push({ kind: "summary", text: count[1] });
      item = undefined;
      continue;
    }
    if (line === "Next" || line === "Decision") {
      rows.push({ kind: "heading", text: line });
      item = undefined;
      continue;
    }
    const node = line.match(/^- ([\w.-]+\/[\w.-]+#\d+) (.+)$/);
    const metrics = line.match(
      /^ {3}- (review-open-pr · score \d+(?:\.\d+)? · heat \d+(?:\.\d+)? · visible impact \d+)$/,
    );
    const action = line.match(/^ {3}- (Next: .+)$/);
    if (node) {
      item = {
        kind: "item",
        reference: sameRepository ? node[1].slice(repository.length) : node[1],
        state: "",
        title: node[2],
        details: [],
      };
      rows.push(item);
    } else if (metrics && item && !item.metrics && item.details.length === 0) {
      item.metrics = metrics[1];
    } else if (action && item) {
      item.details.push(action[1]);
    } else if (/^- (?:The next action .+|Caveat: .+)$/.test(line)) {
      rows.push({ kind: "text", text: line });
      item = undefined;
    } else {
      return null;
    }
  }
  return rows;
}

export function terminalPresentation(output: string, exampleId: string): PresentationRow[] | null {
  if (exampleId === "plan") return backlogPresentation(output);
  if (exampleId !== "graph") return null;
  const lines = output.split("\n");
  const context = lines[0]?.match(/^Reference graph: ([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (!context || lines[1] !== "" || lines[2] !== `Seeds: ${context[1]}#${context[2]}`) return null;
  const repository = context[1];
  const sameRepository = Array.from(output.matchAll(/([\w.-]+\/[\w.-]+)#\d+/g)).every(
    (match) => match[1] === repository,
  );
  const identity = (reference: string) =>
    sameRepository && reference.startsWith(`${repository}#`)
      ? reference.slice(repository.length)
      : reference;
  const rows: PresentationRow[] = [
    {
      kind: "context",
      text: sameRepository ? `${repository} · #${context[2]}` : `${repository}#${context[2]}`,
    },
  ];
  let item: Extract<PresentationRow, { kind: "item" }> | undefined;
  let followUps = false;
  for (const line of lines.slice(3)) {
    if (!line) continue;
    if (line === "Orphan checklist (classified)") {
      rows.push({ kind: "heading", text: "Open follow-ups" });
      followUps = true;
      item = undefined;
      continue;
    }
    const node = line.match(
      /^- (\[ \] )?([\w.-]+\/[\w.-]+#\d+) (PR 🟪 MERGED|issue 🟢 OPEN) — (.+?)(?: {2}\(depth \d+\))?$/,
    );
    if (node) {
      const merged = node[3] === "PR 🟪 MERGED";
      if (followUps !== Boolean(node[1]) || followUps === merged) return null;
      if (merged) rows.push({ kind: "heading", text: "Merged fix" });
      item = {
        kind: "item",
        reference: identity(node[2]),
        state: merged ? "MERGED" : "OPEN",
        title: node[4],
        details: [],
      };
      rows.push(item);
      continue;
    }
    const edge = line.match(/^ {4}- closes → ([\w.-]+\/[\w.-]+#\d+) 🟣 CLOSED$/);
    const reason = line.match(/^ {6}→ OPEN issue — (.+)$/);
    if (item && edge && !followUps) {
      item.details.push(`closes ${identity(edge[1])} · CLOSED`);
    } else if (item && reason && followUps) {
      item.details.push(reason[1]);
    } else {
      return null;
    }
  }
  return rows;
}
