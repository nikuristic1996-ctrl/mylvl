import assert from "node:assert/strict";
import test from "node:test";
import { NOSE_COUNTER_COOLDOWN_MS, noseCounterWaitRemainingMs } from "../src/noseCounter.ts";

test("Nose Counter blocks another tap for exactly two seconds", () => {
  assert.equal(NOSE_COUNTER_COOLDOWN_MS, 2000);
  assert.equal(noseCounterWaitRemainingMs(1000, 3000), 2000);
  assert.equal(noseCounterWaitRemainingMs(2500, 3000), 500);
  assert.equal(noseCounterWaitRemainingMs(3000, 3000), 0);
  assert.equal(noseCounterWaitRemainingMs(3500, 3000), 0);
});
