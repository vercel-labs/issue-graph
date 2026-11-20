import { expect, test } from "vitest";
import { fakeYouTrack } from "../tests/youtrack-fixtures.js";
import { parseModel } from "./model-validation.js";
import { buildYouTrackGraph, youTrackNodeKey } from "./youtrack.js";
import { youTrackDashboardModel } from "./youtrack-html.js";

const key = (id: string) => youTrackNodeKey("acme.youtrack.cloud", id);

async function model() {
  const report = await buildYouTrackGraph(
    fakeYouTrack({
      "ABC-1": {
        links: [
          { type: "Depend", direction: "OUTWARD", targets: ["ABC-2"] },
          { type: "Duplicate", direction: "OUTWARD", targets: ["ABC-4"] },
          { type: "Relates", direction: "BOTH", targets: ["PAY-7"] },
        ],
        pulls: [{ timestamp: 1, added: [["https://github.com/o/r/pull/5", "Fix"]] }],
      },
      "ABC-2": {
        resolved: 1_700_000_100_000,
        links: [{ type: "Depend", direction: "INWARD", targets: ["ABC-1"] }],
      },
      "PAY-7": { links: [{ type: "Relates", direction: "BOTH", targets: ["ABC-1"] }] },
    }),
    "ABC-1",
    { maxDepth: 1, maxNodes: 80, hubThreshold: 12, concurrency: 2 },
  );
  return { report, model: youTrackDashboardModel(report) };
}

test("saves one model per base URL and seed project that the dashboard accepts", async () => {
  const { model: result } = await model();
  expect(result.id).toBe("youtrack:acme.youtrack.cloud:project:ABC");
  expect(result.label).toBe("acme.youtrack.cloud / ABC");
  expect(result.url).toBe("https://acme.youtrack.cloud/issue/ABC-1");
  expect(result.provider).toMatchObject({ id: "youtrack", name: "YouTrack" });
  expect(result.provider.logo).toContain("youtrack-mark");
  expect(parseModel(JSON.parse(JSON.stringify(result)))).toBeTruthy();
});

test("keeps link direction, deduplicates both endpoints, and closes resolved issues", async () => {
  const { model: result } = await model();
  const root = result.nodes[key("ABC-1")];
  expect(root.out.map((edge) => [edge.to, edge.via])).toEqual([
    [key("ABC-2"), "blocks"],
    [key("PAY-7"), "relates to"],
  ]);
  expect(root.in.map((edge) => [edge.from, edge.via])).toEqual([[key("ABC-4"), "duplicated by"]]);
  expect(result.nodes[key("ABC-2")].in).toHaveLength(1);
  expect(result.nodes[key("ABC-2")].state).toBe("CLOSED");
  expect(root.state).toBe("OPEN");
  expect(result.nodes[key("ABC-4")]).toMatchObject({
    state: "UNKNOWN",
    flags: ["Issue unavailable"],
  });
  expect(root.attachments?.[0].evidence.kind).toBe("remote-link");
});

test("a partial run says so in the dashboard coverage", async () => {
  const { report, model: result } = await model();
  expect(report.coverageComplete).toBe(false);
  expect(result.coverage?.complete).toBe(false);
  expect(result.coverage?.warnings).toContain("1 issues unavailable");
});
