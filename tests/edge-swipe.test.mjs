import assert from "node:assert/strict";
import test from "node:test";
import { beginEdgeSwipe, edgeSwipeOffset, shouldFinishEdgeSwipe } from "../lib/edge-swipe.ts";

test("starts only from the left screen edge", () => {
  assert.deepEqual(beginEdgeSwipe(20, 100, 0), { startX: 20, startY: 100, startedAt: 0 });
  assert.equal(beginEdgeSwipe(60, 100, 0), null);
});

test("accepts a deliberate right swipe and rejects vertical movement", () => {
  const swipe = beginEdgeSwipe(18, 100, 0);
  assert.ok(swipe);
  assert.equal(edgeSwipeOffset(swipe, 112, 108), 94);
  assert.equal(shouldFinishEdgeSwipe(swipe, 112, 108, 300), true);
  assert.equal(edgeSwipeOffset(swipe, 70, 180), 0);
  assert.equal(shouldFinishEdgeSwipe(swipe, 70, 180, 120), false);
});

test("accepts a shorter fast swipe but not an accidental slow drag", () => {
  const swipe = beginEdgeSwipe(12, 80, 0);
  assert.ok(swipe);
  assert.equal(shouldFinishEdgeSwipe(swipe, 62, 82, 80), true);
  assert.equal(shouldFinishEdgeSwipe(swipe, 62, 82, 500), false);
});
