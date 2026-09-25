import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseDocument } from "yaml";

export function generatePublicSkill(content: string) {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) throw new Error("Canonical skill must have YAML frontmatter");
  const document = parseDocument(frontmatter[1]);
  if (document.errors.length || document.warnings.length) {
    throw new Error("Canonical skill must have valid YAML metadata", {
      cause: [...document.errors, ...document.warnings],
    });
  }
  const metadata = document.toJSON();
  if (
    metadata?.name !== "issue-graph" ||
    typeof metadata.description !== "string" ||
    !metadata.description.trim() ||
    metadata.description.length > 1024
  ) {
    throw new Error(
      "Canonical skill requires name issue-graph and a description of 1–1024 characters",
    );
  }
  return {
    skill: content,
    index: `{
  "skills": [
    {
      "name": "issue-graph",
      "description": ${JSON.stringify(metadata.description)},
      "files": ["SKILL.md"]
    }
  ]
}
`,
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const content = await readFile(
    new URL("../../../skills/issue-graph/SKILL.md", import.meta.url),
    "utf8",
  );
  const { skill, index } = generatePublicSkill(content);
  const publicRoot = new URL("../public/.well-known/skills/", import.meta.url);
  await mkdir(new URL("issue-graph/", publicRoot), { recursive: true });
  await writeFile(new URL("issue-graph/SKILL.md", publicRoot), skill);
  await writeFile(new URL("index.json", publicRoot), index);
}
