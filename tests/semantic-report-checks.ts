import assert from "node:assert/strict";
import type { SemanticReportItem } from "../src/semantic-types.js";

export function assertWarmReuse(source: SemanticReportItem, warm: SemanticReportItem): void {
  assert.equal(warm.key, source.key);
  assert.equal(warm.inputHash, source.inputHash);
  assert.equal(warm.cacheStatus, "hit");
  assert.equal(warm.provenance?.cacheHit, true);
  assert.ok(warm.reasonCodes.includes("cache-hit"));
  assert.deepEqual(warm.answers, source.answers);
  assert.deepEqual(
    warm.reasonCodes.filter((reason) => reason !== "cache-hit"),
    source.reasonCodes.filter((reason) => reason !== "cache-hit"),
  );
  assert.equal(warm.outcome, source.outcome);
  assert.equal(warm.cacheSourceRequestId, source.receipt?.pending.requestId);
  assert.equal(warm.provenance?.evaluatedAt, source.provenance?.evaluatedAt);
}
