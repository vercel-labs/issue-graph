import {
  buildJiraGraph,
  type JiraReader,
  jiraSiteConflicts,
  parseJiraLocator,
  parseJiraSite,
  renderJira,
} from "./jira.js";

export const JIRA_USAGE = `usage: issue-graph jira <issue-key|browse-url> [options]

Read explicit Jira issue links, parents, subtasks, and remote links through the
Atlassian Teamwork Graph CLI (twg).

  --site SITE           Atlassian site prefix, domain, or cloud ID (default: the twg default site)
  --depth N             same-project link depth, 0..8 (default 1)
  --max-nodes N         node cap, 1..1000 (default 80)
  --hub-threshold N     stop expanding non-seed hubs, 1..1000 (default 12)
  --concurrency N       twg reads in flight, 1..16 (default 4)
  --json                print JSON to stdout
  -h, --help            show help without running twg

Install twg 1.4 or later and sign in with \`twg login\` first. Each issue is one
\`twg jira workitem get\` read; nothing is written to Jira or to local files, and
no Atlassian credential is read or stored.
A browse URL names the site; a --site domain must match it, and a prefix or cloud
ID is checked against the site twg reports for the issue.
Links into other projects are read one hop and not expanded. Remote link targets
are reported without fetching. Text mentions are not collected. Children of an
epic or higher-level issue are not read: an expanded issue with such children is
partial, and one at the depth limit is listed as a depth boundary. An issue whose
type has no hierarchy level, or whose subtasks field is missing or null, is
treated the same way unless its type is a sub-task.
Exit codes: 0 complete within scope, 1 partial or failed, 2 invalid usage.`;

export interface JiraIO {
  stdout(value: string): void;
  stderr(value: string): void;
}

export async function runJira(
  argv: string[],
  reader: (site?: string) => JiraReader | Promise<JiraReader>,
  io: JiraIO,
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    io.stdout(`${JIRA_USAGE}\n`);
    return 0;
  }
  const options = { maxDepth: 1, maxNodes: 80, hubThreshold: 12, concurrency: 4 };
  const integers = {
    "--depth": ["maxDepth", 0, 8],
    "--max-nodes": ["maxNodes", 1, 1000],
    "--hub-threshold": ["hubThreshold", 1, 1000],
    "--concurrency": ["concurrency", 1, 16],
  } as const;
  let seed: string | undefined;
  let site: string | undefined;
  let json = false;
  try {
    for (let index = 0; index < argv.length; index++) {
      const arg = argv[index];
      if (arg === "--json") json = true;
      else if (arg === "--site") {
        const value = argv[++index];
        if (!value || value.startsWith("-")) throw new Error("--site requires a Jira site");
        site = parseJiraSite(value);
      } else if (Object.hasOwn(integers, arg)) {
        const [name, minimum, maximum] = integers[arg as keyof typeof integers];
        const raw = argv[++index];
        const value = Number(raw);
        if (!raw || !/^\d+$/.test(raw) || value < minimum || value > maximum)
          throw new Error(`${arg} must be an integer from ${minimum} to ${maximum}`);
        options[name] = value;
      } else if (arg.startsWith("-")) throw new Error(`Unknown Jira flag: ${arg}`);
      else if (seed) throw new Error("Specify exactly one Jira issue");
      else seed = arg;
    }
    if (!seed) throw new Error("Specify a Jira issue key or browse URL");
    const locator = parseJiraLocator(seed);
    if (locator.site && site && jiraSiteConflicts(locator.site, site))
      throw new Error("Jira URL and --site disagree");
    site ??= locator.site;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : "Invalid Jira arguments"}\n`);
    return 2;
  }
  try {
    const report = await buildJiraGraph(await reader(site), seed, { ...options, site });
    io.stdout(json ? `${JSON.stringify(report, null, 2)}\n` : renderJira(report));
    return report.coverageComplete ? 0 : 1;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : "Jira read failed"}\n`);
    return 1;
  }
}
