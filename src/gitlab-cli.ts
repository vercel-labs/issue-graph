import {
  buildGitLabGraph,
  type GitLabReader,
  type GitLabReport,
  parseGitLabHost,
  parseGitLabLocator,
  renderGitLab,
} from "./gitlab.js";
import { gitlabDashboardModel } from "./gitlab-html.js";
import { runWorkCommand, type WorkCommand, type WorkIO } from "./work-command.js";

export const GITLAB_USAGE = `usage: issue-graph gitlab <issue-or-mr-url|group/project#N|group/project!N> [options]

Read GitLab issue links, closing merge requests, and mentions from system notes
through the GitLab CLI (glab).

  --host HOST           GitLab host (default: the URL's host, or the authenticated host of the current Git directory, or gitlab.com)
  --depth N             same-project reference depth, 0..8 (default 1)
  --max-nodes N         node cap, 1..1000 (default 80)
  --hub-threshold N     stop expanding non-seed hubs, 1..1000 (default 12)
  --concurrency N       items read in parallel, 1..16 (default 4)
  --json                print JSON to stdout
  --html PATH           write an HTML explorer and save this project to the dashboard
  --open                open the HTML explorer (creates a temporary file if needed)
  --no-save             do not save this run to the dashboard
  --cluster             print a thematic clustering task for the calling agent
  --clusters PATH       apply proposed themes from JSON to --html or --open
  -h, --help            show help without running glab

Install glab 1.126 or later and sign in with \`glab auth login\`, or set
GITLAB_TOKEN, which glab sends only to its default or configured hosts. Every
read is a \`glab api --method GET\` call. Nothing is written to GitLab, local
files are written only with --html or --open, and issue-graph reads or stores no
GitLab credential.
Issues (#N) and merge requests (!N) are separate nodes. References into other
projects are read one hop and not expanded. Mentions come from "mentioned in"
system notes on the item that was mentioned, so an item's own outgoing text
references appear only when GitLab recorded them on the target. Group-level
work items, such as epics, are listed as link targets but not read.
Exit codes: 0 complete within scope, 1 partial or failed, 2 invalid usage.`;

export type GitLabIO = WorkIO<GitLabReport>;

const GITLAB_COMMAND: WorkCommand<GitLabReport, GitLabReader> = {
  name: "GitLab",
  usage: GITLAB_USAGE,
  maxConcurrency: 16,
  authority: { flag: "--host", missing: "--host requires a GitLab host", parse: parseGitLabHost },
  oneSeed: "Specify exactly one GitLab issue or merge request",
  noSeed: "Specify a GitLab issue or merge request URL or reference",
  resolve(seed, host) {
    const locator = parseGitLabLocator(seed);
    if (locator.host && host && locator.host !== host)
      throw new Error("GitLab URL and --host disagree");
    return host ?? locator.host;
  },
  build: (reader, seed, { authority, ...options }) =>
    buildGitLabGraph(reader, seed, { ...options, host: authority }),
  render: renderGitLab,
  label: (report) => gitlabDashboardModel(report).label ?? report.host,
};

export function runGitLab(
  argv: string[],
  reader: (host?: string) => GitLabReader | Promise<GitLabReader>,
  io: GitLabIO,
): Promise<number> {
  return runWorkCommand(GITLAB_COMMAND, argv, reader, io);
}
