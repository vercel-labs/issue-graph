import { CodeBlock } from "@vercel/geistdocs/components/code-block";
import Link from "next/link";
import { GraphProof } from "@/components/graph-proof";
import { InstallSelector } from "@/components/install-selector";
import { landingDescription, landingTitle, workflows } from "@/lib/landing-content";
import { pageMetadata } from "@/lib/page-metadata";
import {
  packageReleasePending,
  plannedInstallCommand,
  siteDescription,
  siteName,
  siteUrl,
} from "@/lib/site";
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
        <h1 id="hero-title">{landingTitle}</h1>
        <p className="ig-hero-description">{landingDescription}</p>
        <div className="ig-hero-action">
          <InstallSelector />
          <span className="ig-hero-note">Read-only on GitHub. No model required.</span>
        </div>
      </section>

      <section className="ig-proof-section" aria-label="A real issue-graph result">
        <GraphProof />
      </section>

      <section className="ig-workflows" aria-labelledby="workflow-title">
        <div className="ig-section-intro">
          <span className="ig-eyebrow">Less tab-hopping. More context.</span>
          <h2 id="workflow-title">
            Start with the work,
            <br />
            not another search.
          </h2>
          <p>
            From a single issue to an entire backlog. Use the same evidence in your terminal, your
            editor, or your agent.
          </p>
        </div>
        <div className="ig-workflow-grid">
          {workflows.map((workflow) => (
            <article className="ig-workflow" key={workflow.number}>
              <span className="ig-workflow-number">{workflow.number}</span>
              <h3>{workflow.title}</h3>
              <p>{workflow.description}</p>
              <CodeBlock title="Terminal" className="ig-workflow-command">
                <code>{workflow.command}</code>
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
          <span className="ig-eyebrow">The same tool. Your workflow.</span>
          <h2 id="agent-title">
            Give your agent
            <br />
            the missing context.
          </h2>
          <p>
            Let the CLI gather the references. Let your agent reason about the work. Keep the
            decision to close, merge, or ship with you.
          </p>
          <Link href="/docs/agents" className="ig-text-link">
            Read the agent workflow <span aria-hidden="true">↗</span>
          </Link>
        </div>
        <div className="ig-agent-contract">
          <div>
            <span className="ig-contract-label">Gather</span>
            <p>
              Typed relationships, status, and coverage. Deterministic, with no model in the core.
            </p>
          </div>
          <div>
            <span className="ig-contract-label">Understand</span>
            <p>
              JSON for tools. Readable output for people. An optional clustering task for your
              agent.
            </p>
          </div>
          <div>
            <span className="ig-contract-label">Decide</span>
            <p>
              References are evidence, not verdicts. Review the code before closing or merging
              anything.
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
          <span className="ig-eyebrow">One useful first run</span>
          <h2 id="install-title">
            Bring the context
            <br />
            back to your terminal.
          </h2>
        </div>
        <div className="ig-install-details">
          <span className="ig-release-label">
            {packageReleasePending ? "npm release in preparation" : "Run with Node.js 20+"}
          </span>
          <CodeBlock title="Terminal">
            <code>{plannedInstallCommand}</code>
          </CodeBlock>
          <p>
            {packageReleasePending
              ? "This command is for the upcoming functional npm release. Today, source installation requires repository access. The quickstart explains both paths."
              : "Authenticate with GitHub CLI, then point issue-graph at a public repository or one you can access."}
          </p>
          <Link className="ig-text-link" href="/docs/get-started">
            Read the installation guide <span aria-hidden="true">↗</span>
          </Link>
        </div>
      </section>
    </main>
  );
}
