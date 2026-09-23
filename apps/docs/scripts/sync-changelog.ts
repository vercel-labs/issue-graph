import { readFile, writeFile } from "node:fs/promises";

const changelog = await readFile(new URL("../../../CHANGELOG.md", import.meta.url), "utf8");
if (!changelog.startsWith("# Changelog\n")) throw new Error("Expected the canonical changelog");
const body = changelog
  .replace(/^# Changelog\s*/, "")
  .replace(/^<!-- release:(?:start|end) -->\r?\n?/gm, "")
  .trim();
await writeFile(
  new URL("../content/docs/changelog.mdx", import.meta.url),
  `---\ntitle: Changelog\ndescription: Release notes for issue-graph, covering agent guidance, CLI updates, and documentation.\n---\n\n${body}\n`,
);
console.log("Synced docs changelog from CHANGELOG.md");
