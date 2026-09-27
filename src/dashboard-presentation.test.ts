import { runInNewContext, Script } from "node:vm";
import { expect, test } from "vitest";
import { dashboardModel, renderDashboard } from "./html.js";

function presentation<T>(expression: string, data: unknown = { groups: [] }): T {
  const html = renderDashboard([dashboardModel(new Map(), [], "test/project")]);
  const script = html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>"));
  new Script(script);
  const helpers = script.slice(
    script.indexOf("function statusInfo("),
    script.indexOf("const statGrid="),
  );
  return runInNewContext(`${helpers}\n${expression}`, { DATA: data });
}

test("cluster colors remain unique through the node limit without wrapping a short palette", () => {
  const colors = presentation<string[]>("Array.from({length:1000},(_,i)=>groupColor(i))");
  expect(new Set(colors).size).toBe(1000);
  expect(presentation<string>("groupColor(3)")).toBe(colors[3]);
});

test("shared statuses distinguish completed, canceled, archived and unavailable items", () => {
  const statuses = presentation<Array<{ label: string; color: string }>>(
    `[
      {state:'OPEN',kind:'Issue'},
      {state:'CLOSED',stateType:'completed'},
      {state:'CLOSED',stateType:'canceled'},
      {state:'CLOSED',stateType:'duplicate'},
      {state:'OPEN',archived:true},
      {state:'UNKNOWN',read:{fetched:false}}
    ].map(statusInfo)`,
  );
  expect(statuses.map((s) => s.label)).toEqual([
    "Open issue",
    "Completed",
    "Canceled",
    "Duplicate",
    "Archived",
    "Unavailable",
  ]);
  expect(new Set(statuses.map((s) => s.color)).size).toBe(statuses.length);
});

test("legends partition actual items and omit absent categories for any provider", () => {
  const groups = presentation<Array<{ members: string[] }>>(
    "statusGroups([{key:'a',state:'OPEN',kind:'Issue'},{key:'b',state:'OPEN',kind:'Issue'},{key:'c',state:'MERGED',kind:'PullRequest'}])",
  );
  expect(groups.map((g) => g.members)).toEqual([["a", "b"], ["c"]]);
  expect(presentation("statusGroups([])")).toEqual([]);
});

test("superseded open work retains its hollow category without overriding closed or archived states", () => {
  expect(
    presentation("['OPEN','CLOSED'].map(state=>statusInfo({state,verdict:'SUPERSEDED'}).label)"),
  ).toEqual(["Superseded", "Closed"]);
});

test.each([
  [{ grouping: "themes", groups: [] }, true],
  [{ grouping: "components", groups: [{ label: "Component 1" }] }, false],
  [{ groups: [{ label: "Component 12" }] }, false],
  [{ groups: [{ label: "Keyboard input" }] }, true],
])("saved grouping metadata stays meaningful without a provider branch", (data, expected) => {
  expect(presentation("proposedGroups()", data)).toBe(expected);
});
