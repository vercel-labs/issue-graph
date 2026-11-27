import {
  buildJiraGraph,
  type JiraReader,
  type JiraReport,
  jiraSiteConflicts,
  parseJiraLocator,
  parseJiraSite,
  renderJira,
} from "./jira.js";
import { jiraDashboardModel } from "./jira-html.js";
import { runWorkCommand, type WorkCommand, type WorkIO } from "./work-command.js";

export const JIRA_USAGE = `usage: issue-graph jira <issue-key|browse-url> [options]

Read explicit Jira issue links, parents, subtasks, and remote links through the
Atlassian Teamwork Graph CLI (twg).

  --site SITE           Atlassian site prefix, domain, or cloud ID (default: the twg default site)
  --depth N             same-project link depth, 0..8 (default 1)
  --max-nodes N         node cap, 1..1000 (default 80)
  --hub-threshold N     stop expanding non-seed hubs, 1..1000 (default 12)
  --concurrency N       twg reads in flight, 1..16 (default 4)
  --json                print JSON to stdout
  --html PATH           write an HTML explorer and save this project to the dashboard
  --open                open the HTML explorer (creates a temporary file if needed)
  --no-save             do not save this run to the dashboard
  --cluster             print a thematic clustering task for the calling agent
  --clusters PATH       apply proposed themes from JSON to --html or --open
  -h, --help            show help without running twg

Install twg 1.4 or later and sign in with \`twg login\` first. Each issue is one
\`twg jira workitem get\` read. Nothing is written to Jira, local files are written
only with --html or --open, and no Atlassian credential is read or stored.
A browse URL names the site. A --site domain must equal each issue's site and a
prefix must be its first label; a cloud ID with a browse URL is checked against
the site twg reports for the first issue.
Links into other projects are read one hop and not expanded. Remote link targets
are reported without fetching. Text mentions are not collected. Children of an
epic or higher-level issue are not read: an expanded issue with such children is
partial, and one at the depth limit is listed as a depth boundary. An issue whose
type has no hierarchy level, or whose subtasks field is missing or null, is
treated the same way unless its type is a sub-task.
Exit codes: 0 complete within scope, 1 partial or failed, 2 invalid usage.`;

export type JiraIO = WorkIO<JiraReport>;

const JIRA_COMMAND: WorkCommand<JiraReport, JiraReader> = {
  name: "Jira",
  usage: JIRA_USAGE,
  maxConcurrency: 16,
  authority: { flag: "--site", missing: "--site requires a Jira site", parse: parseJiraSite },
  oneSeed: "Specify exactly one Jira issue",
  noSeed: "Specify a Jira issue key or browse URL",
  resolve([seed], site) {
    const locator = parseJiraLocator(seed);
    if (locator.site && site && jiraSiteConflicts(locator.site, site))
      throw new Error("Jira URL and --site disagree");
    return site ?? locator.site;
  },
  build: (reader, [seed], { authority, ...options }) =>
    buildJiraGraph(reader, seed, { ...options, site: authority }),
  render: renderJira,
  label: (report) => jiraDashboardModel(report).label ?? report.site,
};

export function runJira(
  argv: string[],
  reader: (site?: string) => JiraReader | Promise<JiraReader>,
  io: JiraIO,
): Promise<number> {
  return runWorkCommand(JIRA_COMMAND, argv, reader, io);
}
