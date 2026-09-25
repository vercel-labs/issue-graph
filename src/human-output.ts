import { safeStatusText, textWidth, wrapText } from "./status-render.js";

export type HumanRow =
  | { kind: "context" | "heading" | "text"; text: string }
  | {
      kind: "item";
      reference: string;
      state: string;
      title: string;
      details: string[];
      metrics?: string;
    };

type Item = Extract<HumanRow, { kind: "item" }>;
const reference = "[\\w.-]+/[\\w.-]+#\\d+";
const nodePattern = new RegExp(
  `^- (\\[ \\] )?(?:⚠️?\\s*)?(${reference}) (PR|issue|Unknown)(?: (?:🟪 |🟣 |🟢 |⚪ )?([A-Z][A-Z_]*))? — (.+)$`,
);

function decoration(line: string): string {
  return line
    .replace(new RegExp(`\\*\\*(${reference})\\*\\*`, "g"), "$1")
    .replace(
      /_((?:\(depth \d+\)|\(hub — not expanded\)|\(beyond depth\)|\(score [\d.]+\)|\(@[^)]+\)|by @[\w-]+))_/g,
      "$1",
    )
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(?:🟪 |🟣 |🟢 |⚪ )(?=[A-Z][A-Z_]*\b)/g, "");
}

export function humanPresentation(output: string, kind: "graph" | "plan"): HumanRow[] {
  const lines = output.split(/\r?\n/);
  const first = safeStatusText(lines.find((line) => line.trim()) ?? "").replace(/^# /, "");
  const graph = first.match(/^Reference graph: ([\w.-]+\/[\w.-]+)#(\d+)$/);
  const plan = first.match(/^Backlog plan: ([\w.-]+\/[\w.-]+)$/);
  const headerIndex = lines.findIndex((line) => line.trim());
  let headerEnd = headerIndex + 1;
  while (headerEnd < lines.length && /^(?:\s*|Seeds: .+|Nodes: \d+)$/.test(lines[headerEnd]))
    headerEnd++;
  const headerLines = lines.slice(headerIndex + 1, headerEnd);
  const seedLine = headerLines.find((line) => /^Seeds: /.test(line));
  const seeds = seedLine?.slice(7).split(/,\s*/);
  const nodeCount = headerLines.find((line) => /^Nodes: \d+$/.test(line));
  const seedRepos = new Set(seeds?.map((seed) => seed.match(/^([\w.-]+\/[\w.-]+)#\d+$/)?.[1]));
  const repository =
    kind === "plan"
      ? plan?.[1]
      : (graph?.[1] ??
        (first === "Reference graph (backlog slice)" && seedRepos.size === 1
          ? [...seedRepos][0]
          : undefined));
  const identity = (value: string) =>
    repository && value.startsWith(`${repository}#`) ? value.slice(repository.length) : value;
  const refs = (value: string) =>
    value.replace(
      new RegExp(`(^|[\\s(,→⇄])(${reference})(?=$|[\\s),:])`, "g"),
      (_, before, ref) => `${before}${identity(ref)}`,
    );
  const rows: HumanRow[] = [];
  const states = new Map<string, string>();
  let item: Item | undefined;
  let section = "";
  let group = "";
  let fence = false;
  let headerSeen = false;
  const heading = (text: string) => {
    rows.push({ kind: "heading", text });
    item = undefined;
    group = "";
  };
  for (const [lineIndex, raw] of lines.entries()) {
    const clean = safeStatusText(raw);
    if (!clean) continue;
    if (/^```(?:[\w-]+)?$/.test(clean)) {
      fence = !fence;
      item = undefined;
      continue;
    }
    if (fence) {
      rows.push({ kind: "text", text: clean });
      continue;
    }
    if (!headerSeen && clean.replace(/^# /, "") === first) {
      headerSeen = true;
      if (repository) {
        const context = [repository];
        if (kind === "graph") {
          if (!graph) context.push("Backlog slice");
          if (seeds) context.push(`Seeds: ${seeds.map(identity).join(", ")}`);
          else if (graph) context.push(`Seed: #${graph[2]}`);
          if (graph && seeds && !seeds.includes(`${graph[1]}#${graph[2]}`))
            context.push(`Reference: #${graph[2]}`);
          if (nodeCount) context.push(nodeCount);
        }
        rows.push({ kind: "context", text: context.join(" · ") });
        continue;
      }
    }
    if (
      repository &&
      kind === "graph" &&
      lineIndex > headerIndex &&
      lineIndex < headerEnd &&
      (raw === seedLine || raw === nodeCount)
    )
      continue;
    const line = clean.replace(new RegExp(`^(.*?)(\\*\\*)(${reference})\\2(?= )`), "$1$3");
    const title = line.match(/^#{1,6} (.+)$/)?.[1];
    const plainHeading =
      /^(Nodes|Orphan checklist \(classified\)|Next|Decision|Execution queue|Investigation queue|Blocked|Guardrails|Coverage gaps|Snapshot)$/.test(
        line,
      );
    if (title || plainHeading) {
      section = title ?? line;
      item = undefined;
      group = "";
      if (section !== "Orphan checklist (classified)" && !(kind === "graph" && section === "Nodes"))
        heading(refs(section));
      continue;
    }
    const node = kind === "graph" ? line.match(nodePattern) : null;
    if (node) {
      const checklist = Boolean(node[1]);
      if (!checklist && node[4]) states.set(node[2], node[4]);
      const state = node[4] ?? states.get(node[2]) ?? "";
      const nextGroup = checklist
        ? section === "Orphan checklist (classified)" && state === "OPEN"
          ? "Open follow-ups"
          : "Classified follow-ups"
        : state === "MERGED"
          ? "Merged fix"
          : state === "CLOSED"
            ? "Closed nodes"
            : state === "OPEN"
              ? "Open nodes"
              : "Other nodes";
      if (nextGroup && nextGroup !== group) {
        heading(nextGroup);
        group = nextGroup;
      }
      let titleText = node[5];
      const metadata = !checklist
        ? titleText.match(/ {2}_?\(depth (\d+)\)_?(?: ⭐ _?\(hub — not expanded\)_?)?$/)
        : null;
      const metadataParts = [node[3]];
      if (metadata) {
        titleText = titleText.slice(0, metadata.index);
        metadataParts.push(`depth ${metadata[1]}`);
        if (metadata[0].includes("hub — not expanded")) metadataParts.push("hub — not expanded");
      }
      item = {
        kind: "item",
        reference: identity(node[2]),
        state,
        title: titleText,
        metrics: metadataParts.join(" · "),
        details: /^- \[ \] ⚠/.test(line) ? ["Warning: classified follow-up"] : [],
      };
      rows.push(item);
      continue;
    }
    if (kind === "plan" && /^(Next|Execution queue|Investigation queue|Blocked)$/.test(section)) {
      const planned = line.match(
        new RegExp(`^(?:-|\\d+\\.) (?:\\[(${reference})\\]\\(([^)]+)\\)|(${reference})) (.+)$`),
      );
      if (planned) {
        item = {
          kind: "item",
          reference: identity(planned[1] ?? planned[3]),
          state: "",
          title: planned[4],
          details: planned[2] ? [`Link: ${planned[2]}`] : [],
        };
        rows.push(item);
        continue;
      }
    }
    if (item && /^\s+/.test(raw)) {
      const detail = refs(decoration(line.replace(/^- /, "").replace(/^→ /, "")));
      if (
        kind === "plan" &&
        / · score [\d.]+ · heat [\d.]+ · visible impact \d+$/.test(detail) &&
        !item.metrics
      ) {
        item.metrics = detail;
      } else {
        item.details.push(detail);
      }
      continue;
    }
    item = undefined;
    if (section === "Orphan checklist (classified)" && group !== "Classified follow-ups") {
      heading("Classified follow-ups");
      group = "Classified follow-ups";
    }
    rows.push({
      kind: "text",
      text: refs(
        decoration(line.replace(/^- (?:\[ \] )?/, "")).replace(/^_score = (.*)_$/, "score = $1"),
      ),
    });
  }
  return rows;
}

export function renderHumanOutput(
  output: string,
  options: { kind: "graph" | "plan"; width?: number; color?: boolean },
): string {
  const rows = humanPresentation(output, options.kind);
  const width = Number.isFinite(options.width)
    ? Math.min(100, Math.max(2, Math.floor(options.width as number)))
    : 100;
  const items = rows.filter((row): row is Item => row.kind === "item");
  const referenceWidth = Math.max(0, ...items.map((row) => textWidth(row.reference)));
  const stateWidth = Math.max(0, ...items.map((row) => textWidth(row.state)));
  const titleStart = referenceWidth + 2 + (stateWidth ? stateWidth + 2 : 0);
  const out: string[] = [];
  const paint = (value: string, tone: string) =>
    options.color ? `\u001b[${tone}m${value}\u001b[0m` : value;
  const wrapped = (value: string, tone?: string, indent = "") => {
    const prefix = width > textWidth(indent) + 1 ? indent : "";
    for (const part of wrapText(value, width - textWidth(prefix), true)) {
      const line = `${prefix}${part.trimEnd()}`;
      out.push(tone ? paint(line, tone) : line);
    }
  };
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (
      options.kind === "plan" &&
      row.kind === "text" &&
      /^Open items: (?:\d+|\?)$/.test(row.text)
    ) {
      const labels = ["Open items", "Ready actions", "Needs investigation", "Blocked"];
      const summary = rows.slice(index, index + labels.length);
      if (
        summary.length === labels.length &&
        summary.every(
          (part, offset) =>
            part.kind === "text" && new RegExp(`^${labels[offset]}: (?:\\d+|\\?)$`).test(part.text),
        )
      ) {
        wrapped(summary.map((part) => (part.kind === "text" ? part.text : "")).join(" · "), "1");
        index += labels.length - 1;
        continue;
      }
    }
    if (row.kind !== "item") {
      if (row.kind === "heading" && out.length && out.at(-1) !== "") out.push("");
      wrapped(row.text, row.kind === "heading" ? "1" : row.kind === "context" ? "2" : undefined);
      continue;
    }
    const wide = width - titleStart >= 16;
    const indent = wide ? " ".repeat(titleStart) : "  ";
    let metrics = row.metrics;
    const titleText =
      options.kind === "graph" ? row.title.replace(/ _by (@[\w-]+)_$/, " by $1") : row.title;
    if (wide) {
      const id = row.reference + " ".repeat(referenceWidth - textWidth(row.reference));
      const state = stateWidth
        ? `${paint(row.state, "1")}${" ".repeat(stateWidth - textWidth(row.state))}  `
        : "";
      const titleLines = wrapText(titleText, width - titleStart, true);
      const last = titleLines.length - 1;
      let suffix = "";
      if (
        options.kind === "graph" &&
        metrics &&
        textWidth(`${titleLines[last].trimEnd()} · ${metrics}`) <= width - titleStart
      ) {
        suffix = paint(` · ${metrics}`, "2");
        metrics = undefined;
      }
      out.push(`${paint(id, "2")}  ${state}${titleLines[0].trimEnd()}${last === 0 ? suffix : ""}`);
      for (let index = 1; index < titleLines.length; index++) {
        out.push(`${indent}${titleLines[index].trimEnd()}${index === last ? suffix : ""}`);
      }
    } else {
      if (textWidth(`${row.reference}  ${row.state}`) <= width) {
        out.push(`${paint(row.reference, "2")}${row.state ? `  ${paint(row.state, "1")}` : ""}`);
      } else {
        wrapped(row.reference, "2");
        if (row.state) wrapped(row.state, "1");
      }
      wrapped(titleText, undefined, indent);
    }
    if (options.kind === "plan") {
      for (const detail of row.details.filter((detail) => detail.startsWith("Next:"))) {
        wrapped(detail, "1", indent);
      }
      if (row.metrics) wrapped(row.metrics, "2", indent);
      for (const detail of row.details.filter((detail) => !detail.startsWith("Next:"))) {
        wrapped(detail, "2", indent);
      }
    } else {
      if (metrics) wrapped(metrics, "2", indent);
      for (const detail of row.details) wrapped(detail, "2", indent);
    }
  }
  return out.length ? `${out.join("\n")}\n` : "";
}
