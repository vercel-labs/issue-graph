import { CodeBlock } from "@vercel/geistdocs/components/code-block";
import Link from "next/link";
import { ClusterBoard } from "@/components/cluster-board";
import { ClusterFigure } from "@/components/cluster-figure";
import { GraphProof } from "@/components/graph-proof";
import { InstallSelector } from "@/components/install-selector";
import { ProviderCards } from "@/components/provider-cards";
import { RankFigure } from "@/components/rank-figure";
import { renderTerminalCommand } from "@/components/terminal-output";
import { clusterCommands, landingDescription, landingTitle } from "@/lib/landing-content";
import { pageMetadata } from "@/lib/page-metadata";
import { showcase } from "@/lib/showcase";
import {
  plannedInstallCommand,
  repositoryUrl,
  siteDescription,
  siteName,
  siteUrl,
} from "@/lib/site";
import "@/components/landing.css";

export const metadata = pageMetadata("/", landingTitle, siteDescription);

export default function Home() {
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        name: siteName,
        url: siteUrl,
        description: siteDescription,
      },
      {
        "@type": "SoftwareApplication",
        name: siteName,
        url: siteUrl,
        description: siteDescription,
        applicationCategory: "DeveloperApplication",
        operatingSystem: "Node.js 20+",
        license: "https://www.apache.org/licenses/LICENSE-2.0",
        sameAs: [repositoryUrl, "https://www.npmjs.com/package/issue-graph"],
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      },
    ],
  };

  return (
    <main id="main-content" className="ig-home">
      <script type="application/ld+json">
        {JSON.stringify(structuredData).replace(/</g, "\\u003c")}
      </script>
      <section className="ig-hero" aria-labelledby="hero-title">
        <div className="ig-hero-copy">
          <h1 id="hero-title">
            Find related work
            <br />
            before you start
          </h1>
          <p className="ig-hero-description">{landingDescription}</p>
          <div className="ig-hero-action">
            <InstallSelector />
            <span className="ig-hero-note">Read-only access to GitHub and Linear.</span>
          </div>
        </div>
        <ClusterFigure />
      </section>

      <section className="ig-section" aria-labelledby="providers-title">
        <div className="ig-section-intro">
          <h2 id="providers-title">Bring every tracker into one graph</h2>
          <p>
            Each provider follows the references its tracker records and keeps native states. GitHub
            and Linear are built in, and other trackers can import the same normalized model. Saved
            runs open in one dashboard with a project switcher.
          </p>
        </div>
        <ProviderCards />
      </section>

      <section className="ig-section" aria-labelledby="clusters-title">
        <div className="ig-section-intro">
          <h2 id="clusters-title">Group open work by root cause</h2>
          <p>
            The dashboard starts with connected components. To group by underlying defect instead,
            ask your agent: <code>issue-graph cluster</code> prints the task, and{" "}
            <code>cluster --apply</code> loads its answer for you to review. These are 4 of the{" "}
            {showcase.clusterCount} clusters an agent proposed in one run on {showcase.repo}.
          </p>
        </div>
        <ClusterBoard />
        <CodeBlock title="Terminal" className="ig-section-command">
          <code>{renderTerminalCommand(clusterCommands)}</code>
        </CodeBlock>
      </section>

      <section className="ig-section" aria-labelledby="rank-title">
        <div className="ig-section-intro">
          <h2 id="rank-title">Rank what to fix first</h2>
          <p>
            Heat measures discussion, not severity. It weighs comments, participants, reactions,
            inbound references, and age. Change a weight to reorder the list, then keep the weights
            you prefer with <code>issue-graph config set</code>.
          </p>
        </div>
        <RankFigure />
      </section>

      <section className="ig-section" aria-labelledby="terminal-title">
        <div className="ig-section-intro">
          <h2 id="terminal-title">Capture, filter, and open the exact view</h2>
          <p>
            Capture once, filter the saved run from the CLI, and open the same result in the
            dashboard. Structured output keeps your agent and your browser on the same work.
          </p>
        </div>
        <GraphProof />
      </section>

      <section className="ig-agent-section" aria-labelledby="agent-title">
        <div className="ig-agent-copy">
          <h2 id="agent-title">Use issue-graph with your coding agent</h2>
          <p>
            Install the skill to let your agent inspect related work, propose clusters, and return a
            filtered dashboard link before making changes.
          </p>
          <Link href="/docs/agents" className="ig-text-link">
            Read the agent workflow <span aria-hidden="true">↗</span>
          </Link>
        </div>
        <div className="ig-agent-contract">
          <div>
            <span className="ig-contract-label">Collect</span>
            <p>The CLI reads GitHub and Linear references and reports missing data.</p>
          </div>
          <div>
            <span className="ig-contract-label">Inspect</span>
            <p>
              Your agent filters saved captures, ranks open work, and returns the exact dashboard
              view.
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

      <section className="ig-closing" aria-labelledby="install-title">
        <h2 id="install-title">Map your backlog before the next fix</h2>
        <p>Requires Node.js 20 or later. Sign in with the GitHub CLI or connect Linear.</p>
        <CodeBlock title="Terminal" className="ig-closing-command">
          <code>{renderTerminalCommand(plannedInstallCommand)}</code>
        </CodeBlock>
        <Link className="ig-button" href="/docs/get-started">
          Get started
        </Link>
      </section>
    </main>
  );
}
