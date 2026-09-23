import { CodeBlock } from "@vercel/geistdocs/components/code-block";
import Link from "next/link";
import { GraphProof } from "@/components/graph-proof";
import { InstallSelector } from "@/components/install-selector";
import { renderTerminalCommand } from "@/components/terminal-output";
import { landingDescription, landingTitle, workflows } from "@/lib/landing-content";
import { pageMetadata } from "@/lib/page-metadata";
import { plannedInstallCommand, siteDescription, siteName, siteUrl } from "@/lib/site";
import "@/components/landing.css";

export const metadata = pageMetadata("/", landingTitle, siteDescription);

export default function Home() {
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: siteName,
    url: siteUrl,
    description: siteDescription,
  };

  return (
    <main id="main-content" className="ig-home">
      <script type="application/ld+json">
        {JSON.stringify(structuredData).replace(/</g, "\\u003c")}
      </script>
      <section className="ig-hero" aria-labelledby="hero-title">
        <h1 id="hero-title">
          Find related work
          <br />
          before you start
        </h1>
        <p className="ig-hero-description">{landingDescription}</p>
        <div className="ig-hero-action">
          <InstallSelector />
          <span className="ig-hero-note">
            Read-only GitHub access. Works with your GitHub CLI login.
          </span>
        </div>
      </section>

      <section className="ig-proof-section" aria-label="A real issue-graph result">
        <GraphProof />
      </section>

      <section className="ig-workflows" aria-labelledby="workflow-title">
        <div className="ig-section-intro">
          <h2 id="workflow-title">Inspect a task or an entire backlog</h2>
          <p>
            Trace references, check PR status, or plan your next review. Each command supports
            structured output for scripts and agents.
          </p>
        </div>
        <div className="ig-workflow-grid">
          {workflows.map((workflow) => (
            <article className="ig-workflow" key={workflow.number}>
              <span className="ig-workflow-number">{workflow.number}</span>
              <h3>{workflow.title}</h3>
              <p>{workflow.description}</p>
              <CodeBlock title="Terminal" className="ig-workflow-command">
                <code>{renderTerminalCommand(workflow.command)}</code>
              </CodeBlock>
              <Link href={workflow.href}>
                {workflow.link} <span aria-hidden="true">↗</span>
              </Link>
            </article>
          ))}
        </div>
      </section>

      <section className="ig-agent-section" aria-labelledby="agent-title">
        <div className="ig-agent-copy">
          <h2 id="agent-title">Use issue-graph with your coding agent</h2>
          <p>
            Install the skill to let your agent trace related work, check PR status, and review a
            backlog before making changes.
          </p>
          <Link href="/docs/agents" className="ig-text-link">
            Read the agent workflow <span aria-hidden="true">↗</span>
          </Link>
        </div>
        <div className="ig-agent-contract">
          <div>
            <span className="ig-contract-label">Collect</span>
            <p>The CLI reads GitHub references and review states, and reports missing data.</p>
          </div>
          <div>
            <span className="ig-contract-label">Inspect</span>
            <p>
              Your agent reads the JSON results and follows links to the relevant issues and PRs.
            </p>
          </div>
          <div>
            <span className="ig-contract-label">Decide</span>
            <p>
              Review the suggested actions and check the code before closing issues or merging PRs.
            </p>
          </div>
          <div className="ig-agent-links">
            <Link href="/docs/agents.md">Agent setup</Link>
            <Link href="/llms.txt">llms.txt</Link>
            <Link href="/docs/library">Library API</Link>
          </div>
        </div>
      </section>

      <section className="ig-install-section" aria-labelledby="install-title">
        <div>
          <h2 id="install-title">Get started</h2>
        </div>
        <div className="ig-install-details">
          <span className="ig-release-label">Requires Node.js 20+</span>
          <CodeBlock title="Terminal">
            <code>{renderTerminalCommand(plannedInstallCommand)}</code>
          </CodeBlock>
          <p>Sign in with GitHub CLI, then run issue-graph against a repository you can access.</p>
          <Link className="ig-text-link" href="/docs/get-started">
            Read the installation guide <span aria-hidden="true">↗</span>
          </Link>
        </div>
      </section>
    </main>
  );
}
