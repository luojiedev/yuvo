import assert from "node:assert/strict";
import test from "node:test";
import {
  beginTransactionSwipe,
  moveTransactionSwipe,
  shouldOpenTransactionActions,
} from "../lib/transaction-swipe.ts";

test("locks a deliberate left swipe to the horizontal axis", () => {
  let state = beginTransactionSwipe("transaction-1", 220, 100, false);
  const movement = moveTransactionSwipe(state, 150, 106);
  state = movement.state;

  assert.equal(state.axis, "horizontal");
  assert.equal(movement.offset, -70);
  assert.equal(movement.isHorizontal, true);
  assert.equal(shouldOpenTransactionActions(state, 150), true);
});

test("locks page scrolling to the vertical axis despite horizontal drift", () => {
  let state = beginTransactionSwipe("transaction-1", 220, 100, false);
  state = moveTransactionSwipe(state, 214, 116).state;
  const movement = moveTransactionSwipe(state, 150, 220);

  assert.equal(state.axis, "vertical");
  assert.equal(movement.offset, 0);
  assert.equal(movement.isHorizontal, false);
  assert.equal(shouldOpenTransactionActions(state, 150), false);
});

test("keeps an open action row unchanged during vertical scrolling", () => {
  let state = beginTransactionSwipe("transaction-1", 220, 100, true);
  state = moveTransactionSwipe(state, 212, 118).state;

  assert.equal(state.axis, "vertical");
  assert.equal(shouldOpenTransactionActions(state, 150), true);
});

test("allows a clear right swipe to close an open action row", () => {
  let state = beginTransactionSwipe("transaction-1", 120, 100, true);
  const movement = moveTransactionSwipe(state, 220, 104);
  state = movement.state;

  assert.equal(state.axis, "horizontal");
  assert.equal(movement.offset, -44);
  assert.equal(shouldOpenTransactionActions(state, 220), false);
});
