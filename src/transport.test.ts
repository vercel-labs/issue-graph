import { describe, expect, test } from "bun:test";
import { paginate } from "./transport.js";

describe("paginate", () => {
  test("collects multiple pages up to the requested limit", async () => {
    const seen: Array<[number, number]> = [];
    const values = Array.from({ length: 250 }, (_, index) => index + 1);
    const result = await paginate(230, async (page, perPage) => {
      seen.push([page, perPage]);
      const start = (page - 1) * 100;
      return values.slice(start, start + perPage);
    });
    expect(result).toHaveLength(230);
    expect(seen).toEqual([
      [1, 100],
      [2, 100],
      [3, 30],
    ]);
  });

  test("stops after a short page and caps GitHub search at 1000", async () => {
    let calls = 0;
    const result = await paginate(5000, async () => {
      calls++;
      return calls === 1 ? [1, 2] : [];
    });
    expect(result).toEqual([1, 2]);
    expect(calls).toBe(1);
  });
});
