import { releaseNotice } from "@/lib/discovery";
import capture from "@/lib/example-workflow.json";
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
      "Capture a backlog, filter saved work, and open the exact dashboard view before making changes. GitHub access is read-only. Captures and query history write local files. Query requires a saved capture.",
      "",
      "## Command examples",
      "",
      "Selected JSON fields from a public CLI capture, not live results. The website tabs only switch the displayed example; they do not run commands or call GitHub. Run Capture before the query examples.",
      "",
      ...terminalExampleCatalog.flatMap((source) => {
        const example = toTerminalExample(source);
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
          ...(example.image
            ? [`![${example.image.alt}](${canonicalUrl(example.image.src)})`, ""]
            : []),
          `Captured with issue-graph ${capture.cliVersion}: ${capture.capturedAt}. ${capture.coverageNote}`,
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
