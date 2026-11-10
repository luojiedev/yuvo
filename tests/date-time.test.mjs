import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMonthGrid,
  formatDateLabel,
  formatMonthTitle,
  formatTime,
  remainingDaysInLocalMonth,
  withSelectedDate,
  withSelectedTime,
} from "../lib/date-time.ts";

test("builds a stable six-week calendar grid", () => {
  const days = buildMonthGrid(new Date(2026, 6, 1));
  assert.equal(days.length, 42);
  assert.deepEqual(
    [days[0].date.getFullYear(), days[0].date.getMonth(), days[0].date.getDate()],
    [2026, 5, 28],
  );
  assert.equal(days[3].belongsToMonth, true);
});

test("changing the date retains time and changing time retains the date", () => {
  const initial = new Date(2026, 6, 14, 15, 47);
  const changedDate = withSelectedDate(initial, new Date(2026, 7, 3));
  assert.equal(formatTime(changedDate), "15:47");
  const changedTime = withSelectedTime(changedDate, 9, 5);
  assert.equal(formatTime(changedTime), "09:05");
  assert.equal(formatMonthTitle(changedTime), "2026年08月");
});

test("formats today and other dates for the amount card", () => {
  const today = new Date(2026, 6, 15, 10, 0);
  assert.equal(formatDateLabel(new Date(2026, 6, 15, 8, 0), today), "今天");
  assert.equal(formatDateLabel(new Date(2026, 6, 14, 8, 0), today), "07月14日");
});

test("counts the current day when calculating the remaining days in a month", () => {
  assert.equal(remainingDaysInLocalMonth(new Date(2026, 6, 15, 18, 0)), 17);
  assert.equal(remainingDaysInLocalMonth(new Date(2026, 6, 31, 23, 59)), 1);
  assert.equal(remainingDaysInLocalMonth(new Date(2028, 1, 10, 12, 0)), 20);
});
