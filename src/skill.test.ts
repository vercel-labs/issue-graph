import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseStatusArgs } from "./status-cli.js";

const skill = readFileSync(new URL("../skills/xref/SKILL.md", import.meta.url), "utf8");

describe("xref skill routing", () => {
  test("discovery description includes PR status and English/Spanish count requests", () => {
    const frontmatter = skill.split("---")[1];
    const description =
      frontmatter
        .split("\n")
        .find((line) => line.startsWith("description: "))
        ?.slice(13) ?? "";
    expect(frontmatter).toContain("name: xref");
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
      "xref status",
    ])
      expect(description).toContain(intent);
  });

  test("count requests are routed before the graph workflow with honest filtering", () => {
    expect(skill.indexOf("## Choose the command first")).toBeLessThan(skill.indexOf("## Steps"));
    expect(skill).toContain("skip the graph steps");
    expect(skill).toContain("isDraft === false");
    expect(skill).toContain("explicitly empty `assignees` array");
    expect(skill).toContain("Do not subtract independent totals");
    expect(skill).toContain("does not inspect bot review findings or CI checks");
  });

  test("all concrete status examples parse against the installed CLI contract", () => {
    const commands = skill.split("\n").filter((line) => line.startsWith("xref status "));
    expect(commands.length).toBeGreaterThanOrEqual(4);
    for (const command of commands) {
      const args = parseStatusArgs(command.split(/\s+/).slice(2));
      expect(args.repos.length).toBeGreaterThan(0);
      expect(args.authors.length).toBeGreaterThan(0);
    }
  });
});
