import { releaseNotice } from "@/lib/discovery";
import graph from "@/lib/example-graph.json";
import plan from "@/lib/example-plan.json";
import status from "@/lib/example-status.json";
import {
  landingDescription,
  landingLastModified,
  landingTitle,
  workflows,
} from "@/lib/landing-content";
import {
  agentSetupPrompt,
  canonicalUrl,
  plannedInstallCommand,
  siteDescription,
  siteName,
} from "@/lib/site";
import { terminalExampleCatalog, toTerminalExample } from "@/lib/terminal-examples";
import { textResponse } from "@/lib/text-response";

export const dynamic = "force-dynamic";

const captures = { graph, status, plan };

export function GET() {
  return textResponse(
    [
      "---",
      `title: ${JSON.stringify(siteName)}`,
      `description: ${JSON.stringify(siteDescription)}`,
      `canonical_url: ${JSON.stringify(canonicalUrl("/"))}`,
      `lastUpdated: ${landingLastModified}`,
      "---",
      "",
      `# ${siteName}`,
      "",
      landingTitle,
      "",
      landingDescription,
      "",
      releaseNotice(),
      "",
      "## For humans",
      "",
      "```sh",
      plannedInstallCommand,
      "```",
      "",
      "## For agents",
      "",
      "```sh",
      agentSetupPrompt,
      "```",
      "",
      "Inspect references, competing fixes, status, and follow-ups before starting work. GitHub access is read-only. Local snapshots may write files; use --no-snapshot for a graph run without persisting a snapshot.",
      "",
      "## Command examples",
      "",
      "Static excerpts from public CLI captures, not live results. The website tabs only switch the displayed example; they do not run commands or call GitHub.",
      "",
      ...terminalExampleCatalog.flatMap((source) => {
        const example = toTerminalExample(source);
        const capture = captures[source.id];
        const coverageNote =
          source.id === "graph"
            ? `The full captured graph contains ${graph.coverage.capturedNodes} fetched nodes. This displayed excerpt omits other captured nodes. The depth-${graph.limits.depth} capture is not complete history: ${graph.coverage.beyondDepthReferences} beyond-depth references and ${graph.coverage.omittedEdges} edges to unfetched references are omitted from the captured graph. States were read during a capture window, not atomically.`
            : capture.coverage.note;
        return [
          `### ${example.label}`,
          "",
          example.summary,
          "",
          "```sh",
          example.command,
          "```",
          "",
          "```text",
          example.output,
          "```",
          "",
          `Captured: ${capture.capturedAt}. ${coverageNote}`,
          "",
        ];
      }),
      ...workflows.flatMap((workflow) => [
        `## ${workflow.title}`,
        "",
        workflow.description,
        "",
        "```sh",
        workflow.command,
        "```",
        "",
        `[${workflow.link}](${canonicalUrl(workflow.href)})`,
        "",
      ]),
      "## Resources",
      "",
      `- [Documentation](${canonicalUrl("/docs")})`,
      `- [Getting started](${canonicalUrl("/docs/get-started")})`,
      `- [For agents](${canonicalUrl("/docs/agents")})`,
      `- [Release-compatible agent setup](${canonicalUrl("/docs/agents.md")})`,
      `- [Documentation index](${canonicalUrl("/llms.txt")})`,
      "",
    ].join("\n"),
    "/",
  );
}
