import { runWorkCommand, type WorkCommand, type WorkIO } from "./work-command.js";
import {
  buildYouTrackGraph,
  parseYouTrackBase,
  parseYouTrackLocator,
  renderYouTrack,
  type YouTrackReader,
  type YouTrackReport,
} from "./youtrack.js";
import { youTrackDashboardModel } from "./youtrack-html.js";

export const YOUTRACK_USAGE = `usage: issue-graph youtrack <issue-id|issue-url> [options]

Read explicit YouTrack issue links, linked pull requests, and linked commits through the REST API.

  --url BASE            YouTrack base URL, https (default: YOUTRACK_URL)
  --depth N             same-project link depth, 0..8 (default 1)
  --max-nodes N         node cap, 1..1000 (default 80)
  --hub-threshold N     stop expanding non-seed hubs, 1..1000 (default 12)
  --concurrency N       issues read in flight, 1..16 (default 4)
  --json                print JSON to stdout
  --html PATH           write an HTML explorer and save this project to the dashboard
  --open                open the HTML explorer (creates a temporary file if needed)
  --no-save             do not save this run to the dashboard
  --cluster             print a thematic clustering task for the calling agent
  --clusters PATH       apply proposed themes from JSON to --html or --open
  -h, --help            show help without reading YouTrack

Set YOUTRACK_TOKEN to a permanent token. Cloud instances use https://NAME.youtrack.cloud and
standalone ones may have a path prefix such as https://host/youtrack. The base URL must be
https; http is accepted only for localhost. The token is sent only to that configured base: an
issue URL is checked against it and must match, and is never used to choose the host. Issues,
links, and pull request and commit activity are read with GET requests; nothing is written to
YouTrack, the token is never stored, and local files are written only with --html or --open.
Links into other projects are read one hop and not expanded. Linked pull request and commit URLs
are reported without fetching. Text mentions are not collected. A link or activity list that
reaches the page limit or fails to read marks the issue partial.
Exit codes: 0 complete within scope, 1 partial or failed, 2 invalid usage.`;

export type YouTrackIO = WorkIO<YouTrackReport>;

/** `defaultUrl` is the base URL used when neither --url nor an issue URL names one. */
function command(defaultUrl: string | undefined): WorkCommand<YouTrackReport, YouTrackReader> {
  return {
    name: "YouTrack",
    usage: YOUTRACK_USAGE,
    maxConcurrency: 16,
    authority: {
      flag: "--url",
      missing: "--url requires a YouTrack base URL",
      parse: parseYouTrackBase,
    },
    oneSeed: "Specify exactly one YouTrack issue",
    noSeed: "Specify a YouTrack issue ID or issue URL",
    resolve(seed, url) {
      const locator = parseYouTrackLocator(seed);
      const configured = url ?? (defaultUrl ? parseYouTrackBase(defaultUrl) : undefined);
      if (!configured) {
        throw new Error(
          locator.baseUrl
            ? "An issue URL needs --url or YOUTRACK_URL naming the same instance"
            : "Pass --url or set YOUTRACK_URL",
        );
      }
      if (locator.baseUrl && locator.baseUrl !== configured)
        throw new Error(
          `The issue URL does not match ${url ? "--url" : "YOUTRACK_URL"}; the token is only sent to the configured base URL`,
        );
      return configured;
    },
    build: (reader, seed, options) => buildYouTrackGraph(reader, seed, options),
    render: renderYouTrack,
    label: (report) => youTrackDashboardModel(report).label ?? report.authority,
  };
}

export function runYouTrack(
  argv: string[],
  reader: (baseUrl?: string) => YouTrackReader | Promise<YouTrackReader>,
  io: YouTrackIO,
  defaultUrl?: string,
): Promise<number> {
  return runWorkCommand(command(defaultUrl), argv, reader, io);
}
