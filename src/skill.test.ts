import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parseStatusArgs } from "./status-cli.js";

const stub = readFileSync(new URL("../skills/issue-graph/SKILL.md", import.meta.url), "utf8");
const skill = readFileSync(
  new URL("../skill-data/core/references/workflows.md", import.meta.url),
  "utf8",
);
const core = readFileSync(new URL("../skill-data/core/SKILL.md", import.meta.url), "utf8");

describe("issue-graph skill routing", () => {
  test("discovery description includes PR status and English/Spanish count requests", () => {
    const frontmatter = stub.split("---")[1];
    const description =
      frontmatter
        .split("\n")
        .find((line) => line.startsWith("description: "))
        ?.slice(13) ?? "";
    expect(frontmatter).toContain("name: issue-graph");
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(1024);
    for (const intent of [
      "PR counts",
      "by author",
      "review state",
      "ready-for-review",
      "unassigned",
      "conteo por autor",
      "tabla por proyecto",
      "sin asignar",
      "issue-graph status",
    ])
      expect(description).toContain(intent);
  });

  test("the discovery stub stays evergreen and delegates operational guidance", () => {
    expect(stub.split("\n").length).toBeLessThanOrEqual(45);
    expect(stub).toContain("issue-graph skills get core");
    expect(stub).toContain("issue-graph skills get core --full");
    expect(stub).toContain("issue-graph skills list");
    expect(stub).not.toMatch(
      /\b\d+\.\d+\.\d+\b|release candidate|publication.*pending|compatibility:/i,
    );
    expect(stub).not.toContain("## Steps");
    expect(stub).not.toContain("## Flags");
    expect(core).toContain("## Route status first");
    expect(core).toContain("issue-graph skills get core --full");
    expect(core).toContain("untrusted");
    expect(core).toContain("isDraft === false");
    expect(core).toContain("Status saves only with `--save`");
  });

  test("count requests are routed before the graph workflow with honest filtering", () => {
    const routing = skill.indexOf("## Invocation and routing");
    const graph = skill.indexOf("## Graph steps");
    expect(routing).toBeGreaterThanOrEqual(0);
    expect(graph).toBeGreaterThan(routing);
    expect(skill).toContain("skip the graph steps");
    expect(skill).toContain("isDraft === false");
    expect(skill).toContain("explicitly empty `assignees` array");
    expect(skill).toContain("Do not subtract independent totals");
    expect(skill).toContain("does not inspect bot review findings or CI checks");
  });

  test("all concrete status examples parse against the installed CLI contract", () => {
    const commands = skill.split("\n").filter((line) => line.startsWith("issue-graph status "));
    expect(commands.length).toBeGreaterThanOrEqual(4);
    for (const command of commands) {
      const args = parseStatusArgs(command.split(/\s+/).slice(2));
      expect(args.repos.length).toBeGreaterThan(0);
      expect(args.authors.length).toBeGreaterThan(0);
    }
  });
});
