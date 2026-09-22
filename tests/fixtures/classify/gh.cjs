#!/usr/bin/env node
const assert = require("node:assert/strict");
const { appendFileSync } = require("node:fs");

const args = process.argv.slice(2);
assert.deepEqual(args.slice(0, 2), ["api", "graphql"]);
const fields = {};
for (let i = 2; i < args.length; i += 2) {
  assert.ok(args[i] === "-f" || args[i] === "-F");
  const split = args[i + 1].indexOf("=");
  fields[args[i + 1].slice(0, split)] = args[i + 1].slice(split + 1);
}
assert.equal(fields.owner, "sample");
assert.equal(fields.repo, "public-repo");
const operation = fields.query.match(/query Semantic(Repository|Issues|Bodies|Versions)\(/)?.[1];
assert.ok(operation);
appendFileSync(process.env.CLASSIFY_TEST_LOG, `${operation}\n`);
const mode = process.env.CLASSIFY_TEST_CASE ?? "good";
const time = "2026-09-20T00:00:00Z";
const total = mode === "empty" ? 0 : mode === "demo" || mode === "partial" ? 3 : 1;
const issue = (number) => ({
  __typename: "Issue",
  id: `SYNTHETIC_I_${number}`,
  number,
  title: "Synthetic title, not output",
  body: "SYNTHETIC_BODY_NOT_OUTPUT: open window, close it; it remains open.",
  state: "OPEN",
  updatedAt: time,
});
const connection = (nodes, count = nodes.length, hasNextPage = false, endCursor = null) => ({
  nodes,
  totalCount: count,
  pageInfo: { hasNextPage, endCursor },
});
if (mode === "failure") {
  console.log(JSON.stringify({ errors: [{ message: "SYNTHETIC_SECRET_NOT_OUTPUT" }] }));
  process.exit(0);
}
const bodies = /\bbody\b/.test(fields.query);
const node = (number, start, first) => {
  assert.ok(number >= 1 && number <= total);
  assert.ok(first >= 1 && first <= 100);
  const result = issue(number);
  if (!bodies) delete result.body;
  if (operation !== "Issues" && mode === "demo" && number === 3) result.state = "CLOSED";
  const count = mode === "demo" && number === 1 ? 101 : 0;
  const end = Math.min(start + first, count);
  result.comments = connection(
    Array.from({ length: end - start }, (_, i) => ({
      __typename: "IssueComment",
      id: `C${start + i + 1}`,
      url: `https://github.com/sample/public-repo/issues/${number}#issuecomment-${start + i + 1}`,
      ...(bodies ? { body: "x" } : {}),
      updatedAt: time,
      author: null,
    })),
    count,
    end < count,
    end > start ? String(end) : null,
  );
  return result;
};
const repository = {
  nameWithOwner: "sample/public-repo",
  visibility: mode === "private" ? "PRIVATE" : "PUBLIC",
  isPrivate: mode === "private",
};
if (operation === "Repository") repository.issues = { totalCount: total };
else if (operation === "Issues") {
  const start = Number(fields.after ?? 0);
  const first = Number(fields.query.match(/issues\(states: OPEN, first: (\d+)/)?.[1]);
  const commentFirst = Number(fields.query.match(/comments\(first: (\d+)/)?.[1]);
  assert.ok(first >= 1 && first <= 20);
  const end = Math.min(start + first, total);
  repository.issues = connection(
    Array.from({ length: end - start }, (_, i) => node(start + i + 1, 0, commentFirst)),
    total,
    end < total,
    end > start ? String(end) : null,
  );
} else {
  const aliases = [...fields.query.matchAll(/(i\d+): issue\(number: \$(number\d+)\)/g)];
  assert.ok(aliases.length >= 1 && aliases.length <= 20);
  for (const [, alias, variable] of aliases) {
    const index = alias.slice(1);
    repository[alias] = node(
      Number(fields[variable]),
      Number(fields[`after${index}`] ?? 0),
      Number(fields[`first${index}`]),
    );
  }
}
console.log(JSON.stringify({ data: { repository } }));
