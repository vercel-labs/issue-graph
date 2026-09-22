import { mkdir, readFile, writeFile } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import { generatePublicSkill } from "../scripts/sync-skill";

vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(), readFile: vi.fn(), writeFile: vi.fn() }));

const skill = (metadata: string, body = "\n# issue-graph\n") => `---\n${metadata}\n---\n${body}`;

describe("public skill generation", () => {
  test("imports without reading or writing assets", () => {
    expect(readFile).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  test("preserves canonical bytes and deterministically serializes YAML metadata", () => {
    const content = skill(
      'name: issue-graph\ndescription: |\n  Read "quoted" guidance.\n  Use core.',
    );
    const generated = generatePublicSkill(content);
    expect(generated.skill).toBe(content);
    expect(generatePublicSkill(content)).toEqual(generated);
    expect(JSON.parse(generated.index)).toEqual({
      skills: [
        {
          name: "issue-graph",
          description: 'Read "quoted" guidance.\nUse core.\n',
          files: ["SKILL.md"],
        },
      ],
    });
    expect(generated.index.endsWith("\n")).toBe(true);
  });

  test("preserves CRLF and a missing final newline", () => {
    const content = skill("name: issue-graph\ndescription: Read core", "body").replaceAll(
      "\n",
      "\r\n",
    );
    expect(generatePublicSkill(content).skill).toBe(content);
  });

  test("accepts the discovery description length limit", () => {
    const content = skill(`name: issue-graph\ndescription: ${"x".repeat(1024)}`);
    expect(JSON.parse(generatePublicSkill(content).index).skills[0].description).toHaveLength(1024);
  });

  test.each([
    "description: Read core",
    "name: other\ndescription: Read core",
    "name: ../escape\ndescription: Read core",
    "name: issue-graph",
    "name: issue-graph\ndescription: 42",
    "name: issue-graph\ndescription: []",
    "name: issue-graph\ndescription: null",
    'name: issue-graph\ndescription: " "',
    `name: issue-graph\ndescription: ${"x".repeat(1025)}`,
    "null",
  ])("rejects invalid discovery metadata: %s", (metadata) => {
    expect(() => generatePublicSkill(skill(metadata))).toThrow("Canonical skill requires");
  });

  test.each([
    "name: issue-graph\ndescription: [",
    "name: issue-graph\nname: other\ndescription: Read core",
    "name: issue-graph\ndescription: !unknown Read core",
  ])("rejects YAML errors and warnings: %s", (metadata) => {
    expect(() => generatePublicSkill(skill(metadata))).toThrow("valid YAML metadata");
  });

  test.each([
    "# No metadata\n",
    "---\nname: issue-graph\n",
    "---\nname: issue-graph\n---invalid\n",
  ])("rejects missing or incomplete frontmatter: %s", (content) => {
    expect(() => generatePublicSkill(content)).toThrow("YAML frontmatter");
  });
});
