import { mkdir, writeFile } from "node:fs/promises";
import graph from "../src/lib/example-graph.json";

const escapeXml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character] ??
      character,
  );

function wrap(value: string, width: number) {
  const result: string[] = [];
  let remaining = value;
  while ([...remaining].length > width) {
    const prefix = [...remaining].slice(0, width).join("");
    const space = prefix.lastIndexOf(" ");
    const at = space > width / 2 ? space : prefix.length;
    result.push(remaining.slice(0, at));
    remaining = `  ${remaining.slice(at).trimStart()}`;
  }
  result.push(remaining);
  return result;
}

const commandLines = wrap(`$ ${graph.command}`, 132);
const outputLines = graph.terminalOutput
  .trimEnd()
  .split("\n")
  .flatMap((line) => wrap(line, 132));
const lines = [...commandLines, "", ...outputLines];
const width = 1200;
const lineHeight = 19;
const footerY = 86 + lines.length * lineHeight;
const height = footerY + 106;
const terminal = lines
  .map((line, index) => {
    const color =
      index < commandLines.length
        ? "#fafafa"
        : line.startsWith("#")
          ? "#93c5fd"
          : line.includes("MERGED")
            ? "#d8b4fe"
            : line.includes("OPEN")
              ? "#86efac"
              : "#d4d4d4";
    return `<text x="28" y="${83 + index * lineHeight}" fill="${color}" xml:space="preserve">${escapeXml(line)}</text>`;
  })
  .join("");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc"><title id="title">issue-graph CLI: a merged Chrome-process fix and open follow-ups</title><desc id="desc">Actual issue-graph ${escapeXml(graph.cliVersion)} stdout excerpt for ${escapeXml(graph.seed)}. ${graph.nodes.length} public nodes in one repository, with typed closing links and the orphan checklist. Attribution and nonessential output omitted. Captured ${escapeXml(graph.capturedAt)}. Depth ${graph.limits.depth}, maximum ${graph.limits.maxNodes} nodes; ${graph.coverage.beyondDepthReferences} references beyond depth, not complete history.</desc><rect width="${width}" height="${height}" rx="14" fill="#111111"/><path d="M0 48H${width}M0 ${footerY}H${width}" stroke="#333333"/><g font-family="Arial, Helvetica, sans-serif"><text x="28" y="30" fill="#fafafa" font-size="14" font-weight="bold">issue-graph / terminal</text><text x="${width - 28}" y="30" text-anchor="end" fill="#a3a3a3" font-size="12">${escapeXml(graph.repository)} · CLI ${escapeXml(graph.cliVersion)}</text></g><g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="13">${terminal}</g><g font-family="Arial, Helvetica, sans-serif" font-size="12" fill="#a3a3a3"><text x="28" y="${footerY + 27}">Captured ${escapeXml(graph.capturedAt)} · ${graph.nodes.length} nodes · ${graph.edges.length} typed edges · no nodes filtered</text><text x="28" y="${footerY + 50}">Depth ${graph.limits.depth} · max ${graph.limits.maxNodes} nodes · ${graph.coverage.beyondDepthReferences} beyond-depth references omitted · not complete history</text><text x="28" y="${footerY + 73}">Real stdout excerpt; attribution, non-closing edge lines, PR metadata, external links and snapshot section omitted.</text></g></svg>\n`;
await mkdir(new URL("../public/", import.meta.url), { recursive: true });
await writeFile(new URL("../public/issue-graph-demo.svg", import.meta.url), svg);
console.log(`Generated issue-graph-demo.svg (${width} x ${height}) from captured CLI stdout.`);
