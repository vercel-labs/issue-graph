import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

const [version, destination] = process.argv.slice(2);
assert.ok(version && destination, "usage: release-notes.ts VERSION OUTPUT");
assert.match(version, /^\d+\.\d+\.\d+$/);
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
assert.equal(changelog.match(/<!-- release:start -->/g)?.length, 1);
assert.equal(changelog.match(/<!-- release:end -->/g)?.length, 1);
const notes = changelog.match(/<!-- release:start -->\s*([\s\S]*?)\s*<!-- release:end -->/)?.[1];
assert.ok(notes?.startsWith(`## ${version}\n`), "changelog must match the approved version");
assert.match(notes, /^- \S/m, "changelog must contain release notes");
writeFileSync(destination, `${notes.trim()}\n`);
console.log(`Prepared release notes for ${version}`);
