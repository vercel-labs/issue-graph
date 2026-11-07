import { CodeBlock } from "@vercel/geistdocs/components/code-block";
import Link from "next/link";
import { renderTerminalCommand } from "@/components/terminal-output";
import { providerCommands } from "@/lib/landing-content";

const GITHUB_PATH =
  "M8 .2a8 8 0 0 0-2.5 15.6c.4 0 .5-.2.5-.4v-1.5c-2.2.5-2.7-1-2.7-1-.4-.9-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.3 1.9.9 2.3.7.1-.5.3-.9.5-1.1-1.8-.2-3.6-.9-3.6-4 0-.9.3-1.6.8-2.1-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8a7.5 7.5 0 0 1 4 0c1.5-1 2.2-.8 2.2-.8.5 1.1.2 1.9.1 2.1.5.6.8 1.3.8 2.1 0 3.1-1.9 3.8-3.6 4 .3.3.6.8.6 1.5v2.2c0 .2.1.5.6.4A8 8 0 0 0 8 .2";
const LINEAR_PATH =
  "M12.927 16.371a1.47 1.47 0 0 0 .061 2.027l68.595 68.594c.555.555 1.446.59 2.026.062 10.058-9.152 16.372-22.348 16.372-37.018C99.98 22.402 77.579 0 49.945 0c-14.67 0-27.866 6.313-37.018 16.371M4.353 29.39a1.47 1.47 0 0 0 .309 1.648L68.943 95.32c.434.434 1.09.562 1.648.308a50 50 0 0 0 4.335-2.227c.834-.482.962-1.62.28-2.3L8.882 24.773c-.68-.68-1.818-.553-2.3.281a50 50 0 0 0-2.228 4.334m-3.9 18.407a1.48 1.48 0 0 1-.432-1.14q.2-2.986.74-5.866c.215-1.15 1.62-1.55 2.448-.722l56.703 56.704c.828.827.429 2.233-.722 2.448a50 50 0 0 1-5.865.74 1.48 1.48 0 0 1-1.14-.433zm3.48 13.963c-1.033-1.033-2.7-.143-2.322 1.268C6.221 80.22 19.761 93.76 36.954 98.37c1.41.379 2.3-1.289 1.268-2.322z";

interface Relation {
  from: [number, number];
  to: [number, number];
  label: string;
}

interface Provider {
  id: "github" | "linear" | "model";
  name: string;
  logo: React.ReactNode;
  summary: string;
  reads: string[];
  nodes: Array<{ id: string; x: number; y: number; kind: "issue" | "pr"; tone: string }>;
  relations: Relation[];
  command: string;
  href: string;
  link: string;
}

const providers: Provider[] = [
  {
    id: "github",
    name: "GitHub",
    logo: (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path fill="currentColor" d={GITHUB_PATH} />
      </svg>
    ),
    summary: "Issues and pull requests in a repository, through your GitHub CLI login.",
    reads: [
      "Closing keywords and linked pull requests",
      "Mentions and cross-references",
      "Review state, draft status, and overlapping files",
    ],
    nodes: [
      { id: "#412", x: 70, y: 52, kind: "issue", tone: "open-issue" },
      { id: "#430", x: 290, y: 44, kind: "pr", tone: "open-pr" },
      { id: "#418", x: 150, y: 140, kind: "pr", tone: "merged" },
      { id: "#455", x: 380, y: 132, kind: "issue", tone: "open-issue" },
    ],
    relations: [
      { from: [290, 44], to: [70, 52], label: "closes" },
      { from: [150, 140], to: [70, 52], label: "mentions" },
      { from: [290, 44], to: [380, 132], label: "cross-ref" },
    ],
    command: providerCommands.github,
    href: "/docs/graph",
    link: "Map a repository",
  },
  {
    id: "linear",
    name: "Linear",
    logo: (
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <path fill="currentColor" d={LINEAR_PATH} />
      </svg>
    ),
    summary: "Issues in a workspace or a whole project, with read-only browser sign-in.",
    reads: [
      "Blocking, related, and duplicate relations in both directions",
      "Parents and sub-issues",
      "Native workflow states and attachment links",
    ],
    nodes: [
      { id: "ENG-21", x: 70, y: 52, kind: "issue", tone: "started" },
      { id: "ENG-34", x: 290, y: 44, kind: "issue", tone: "unstarted" },
      { id: "ENG-27", x: 150, y: 140, kind: "issue", tone: "done" },
      { id: "ENG-40", x: 380, y: 132, kind: "issue", tone: "unstarted" },
    ],
    relations: [
      { from: [70, 52], to: [290, 44], label: "blocks" },
      { from: [70, 52], to: [150, 140], label: "parent of" },
      { from: [290, 44], to: [380, 132], label: "related" },
    ],
    command: providerCommands.linear,
    href: "/docs/linear",
    link: "Connect Linear",
  },
  {
    id: "model",
    name: "Your tracker",
    logo: (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          d="M5.5 2.5c-1.5 0-2 .7-2 2v1.6c0 .9-.5 1.4-1.5 1.9 1 .5 1.5 1 1.5 1.9v1.6c0 1.3.5 2 2 2M10.5 2.5c1.5 0 2 .7 2 2v1.6c0 .9.5 1.4 1.5 1.9-1 .5-1.5 1-1.5 1.9v1.6c0 1.3-.5 2-2 2"
        />
      </svg>
    ),
    summary: "Any other tracker, exported to the normalized dashboard model.",
    reads: [
      "Items, native states, and typed relationships in one JSON file",
      "The same filters, Heat ranking, and exact view links",
      "No provider requests or credentials at query time",
    ],
    nodes: [
      { id: "item", x: 70, y: 52, kind: "issue", tone: "neutral" },
      { id: "item", x: 290, y: 44, kind: "issue", tone: "neutral" },
      { id: "item", x: 150, y: 140, kind: "issue", tone: "neutral" },
      { id: "item", x: 380, y: 132, kind: "issue", tone: "neutral" },
    ],
    relations: [
      { from: [290, 44], to: [70, 52], label: "relation" },
      { from: [70, 52], to: [150, 140], label: "relation" },
      { from: [290, 44], to: [380, 132], label: "relation" },
    ],
    command: providerCommands.model,
    href: "/docs/dashboard",
    link: "Import a model",
  },
];

function RelationDiagram({ provider }: { provider: Provider }) {
  return (
    <svg
      className="ig-provider-diagram"
      viewBox="0 0 450 184"
      role="img"
      aria-label={`Example ${provider.name} relations: ${provider.relations.map((r) => r.label).join(", ")}`}
    >
      <defs>
        <marker
          id={`ig-arrow-${provider.id}`}
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M0,0L8,4 0,8Z" className="ig-provider-arrow" />
        </marker>
      </defs>
      {provider.relations.map((relation) => {
        const [x1, y1] = relation.from;
        const [x2, y2] = relation.to;
        const len = Math.hypot(x2 - x1, y2 - y1);
        const ux = (x2 - x1) / len;
        const uy = (y2 - y1) / len;
        // Place the label beside the line, on the side of its normal that points up.
        const sign = ux > 0 || (ux === 0 && uy < 0) ? -1 : 1;
        const nx = -uy * sign;
        const ny = ux * sign;
        const lx = (x1 + x2) / 2 + nx * 12;
        const ly = (y1 + y2) / 2 + ny * 12;
        return (
          <g key={`${x1}-${y1}-${x2}-${y2}`} className="ig-provider-relation">
            <line
              x1={x1 + ux * 12}
              y1={y1 + uy * 12}
              x2={x2 - ux * 14}
              y2={y2 - uy * 14}
              markerEnd={`url(#ig-arrow-${provider.id})`}
            />
            <text
              x={lx}
              y={ly + 3}
              textAnchor={Math.abs(ux) > 0.8 ? "middle" : nx > 0 ? "start" : "end"}
            >
              {relation.label}
            </text>
          </g>
        );
      })}
      {provider.nodes.map((node) => (
        <g key={`${node.x}-${node.y}`} className="ig-provider-node" data-tone={node.tone}>
          {node.kind === "pr" ? (
            <path
              d={`M${node.x},${node.y - 8}L${node.x + 8},${node.y} ${node.x},${node.y + 8} ${node.x - 8},${node.y}Z`}
            />
          ) : (
            <circle cx={node.x} cy={node.y} r={6.5} />
          )}
          <text x={node.x} y={node.y + 26} textAnchor="middle">
            {node.id}
          </text>
        </g>
      ))}
    </svg>
  );
}

export function ProviderCards() {
  return (
    <div className="ig-provider-grid">
      {providers.map((provider) => (
        <article className="ig-provider" key={provider.id} data-provider={provider.id}>
          <header>
            <span className="ig-provider-logo">{provider.logo}</span>
            <h3>{provider.name}</h3>
          </header>
          <p>{provider.summary}</p>
          <RelationDiagram provider={provider} />
          <ul>
            {provider.reads.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <CodeBlock title="Terminal" className="ig-provider-command">
            <code>{renderTerminalCommand(provider.command)}</code>
          </CodeBlock>
          <Link href={provider.href} className="ig-text-link">
            {provider.link} <span aria-hidden="true">↗</span>
          </Link>
        </article>
      ))}
    </div>
  );
}
