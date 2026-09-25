#!/usr/bin/env node
import { runCli, UsageError } from "./cli.js";
import { JiraUsageError } from "./jira-cli.js";
import { StatusUsageError } from "./status-cli.js";

runCli().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode =
    error instanceof UsageError ||
    error instanceof JiraUsageError ||
    error instanceof StatusUsageError
      ? 2
      : 1;
});
