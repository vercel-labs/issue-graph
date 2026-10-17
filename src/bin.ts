#!/usr/bin/env node
import { runCli, UsageError } from "./cli.js";
import { QueryUsageError } from "./query-cli.js";
import { StatusUsageError } from "./status-cli.js";

runCli().catch((error) => {
  const code =
    error instanceof UsageError ||
    error instanceof StatusUsageError ||
    error instanceof QueryUsageError
      ? 2
      : 1;
  const message = error instanceof Error ? error.message : String(error);
  if (["query", "config"].includes(process.argv[2]))
    console.error(
      JSON.stringify({
        schemaVersion: 1,
        error: { code: code === 2 ? "USAGE_ERROR" : "RUNTIME_ERROR", message },
      }),
    );
  else console.error(message);
  process.exitCode = code;
});
