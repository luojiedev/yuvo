import assert from "node:assert/strict";
import test from "node:test";
import { advanceSubscriptionDate, dayOfIsoDate } from "../lib/subscription-schedule.ts";

test("advances monthly charges by the configured interval", () => {
  assert.equal(advanceSubscriptionDate("2026-01-15", "month", 1), "2026-02-15");
  assert.equal(advanceSubscriptionDate("2026-11-15", "month", 3), "2027-02-15");
  assert.equal(advanceSubscriptionDate("2026-12-01", "month", 1), "2027-01-01");
});

test("clamps to month end but returns to the anchor day afterwards", () => {
  let next = advanceSubscriptionDate("2026-01-31", "month", 1, 31);
  assert.equal(next, "2026-02-28");
  next = advanceSubscriptionDate(next, "month", 1, 31);
  assert.equal(next, "2026-03-31");
  next = advanceSubscriptionDate(next, "month", 1, 31);
  assert.equal(next, "2026-04-30");
  next = advanceSubscriptionDate(next, "month", 1, 31);
  assert.equal(next, "2026-05-31");
});

test("falls back to the current day when no anchor is known", () => {
  assert.equal(advanceSubscriptionDate("2026-02-28", "month", 1), "2026-03-28");
  assert.equal(advanceSubscriptionDate("2026-02-28", "month", 1, null), "2026-03-28");
  assert.equal(advanceSubscriptionDate("2026-02-28", "month", 1, 0), "2026-03-28");
});

test("keeps Feb 29 yearly subscriptions anchored across leap years", () => {
  let next = advanceSubscriptionDate("2028-02-29", "year", 1, 29);
  assert.equal(next, "2029-02-28");
  next = advanceSubscriptionDate(next, "year", 1, 29);
  assert.equal(next, "2030-02-28");
  assert.equal(advanceSubscriptionDate("2031-02-28", "year", 1, 29), "2032-02-29");
});

test("reads the day from an ISO date", () => {
  assert.equal(dayOfIsoDate("2026-07-05"), 5);
  assert.equal(dayOfIsoDate("2026-07-31"), 31);
});
