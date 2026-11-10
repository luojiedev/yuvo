import assert from "node:assert/strict";
import test from "node:test";
import { summarizeStatistics } from "../lib/statistics.ts";

function transaction(overrides = {}) {
  return {
    id: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    ledgerId: "ledger-default",
    type: "expense",
    amountMinor: 100,
    currency: "CNY",
    occurredAt: new Date(2026, 6, 1, 8).toISOString(),
    categoryId: "category-food",
    categoryName: "餐饮",
    subcategoryId: null,
    subcategoryName: "",
    accountId: "account-cash",
    accountName: "现金",
    note: "",
    images: [],
    excludeFromStats: false,
    version: 1,
    createdAt: new Date(2026, 6, 1, 8).toISOString(),
    deletedAt: null,
    ...overrides,
  };
}

function occurredAt(year, monthIndex, day, hour = 8) {
  return new Date(year, monthIndex, day, hour).toISOString();
}

test("summarizes a current month through today and compares the same number of days", () => {
  const summary = summarizeStatistics([
    transaction({ id: "current-expense", amountMinor: 1_000, occurredAt: occurredAt(2026, 6, 3) }),
    transaction({ id: "current-income", type: "income", amountMinor: 5_000, occurredAt: occurredAt(2026, 6, 10) }),
    transaction({ id: "future", amountMinor: 9_000, occurredAt: occurredAt(2026, 6, 16) }),
    transaction({ id: "excluded", amountMinor: 8_000, excludeFromStats: true, occurredAt: occurredAt(2026, 6, 8) }),
    transaction({ id: "deleted", amountMinor: 7_000, deletedAt: occurredAt(2026, 6, 9), occurredAt: occurredAt(2026, 6, 9) }),
    transaction({ id: "previous-in-range", amountMinor: 600, occurredAt: occurredAt(2026, 5, 15) }),
    transaction({ id: "previous-out-of-range", amountMinor: 500, occurredAt: occurredAt(2026, 5, 16) }),
  ], {
    period: "month",
    anchor: new Date(2026, 6, 1),
    visibleOnDate: new Date(2026, 6, 15, 12),
    flow: "expense",
    dimension: "category",
  });

  assert.equal(summary.expenseMinor, 1_000);
  assert.equal(summary.incomeMinor, 5_000);
  assert.equal(summary.previousExpenseMinor, 600);
  assert.equal(summary.startDate, "2026-07-01");
  assert.equal(summary.endDate, "2026-07-15");
  assert.equal(summary.trend[2].expenseMinor, 1_000);
  assert.equal(summary.trend[15].expenseMinor, 0);
  assert.equal(summary.forecastExpenseMinor, Math.round((1_000 / 15) * 31));
});

test("clamps same-progress comparison at the previous month end", () => {
  const summary = summarizeStatistics([
    transaction({ id: "current-last-day", amountMinor: 3_100, occurredAt: occurredAt(2026, 2, 31) }),
    transaction({ id: "previous-last-day", amountMinor: 2_800, occurredAt: occurredAt(2026, 1, 28) }),
    transaction({ id: "outside-previous-month", amountMinor: 9_000, occurredAt: occurredAt(2026, 0, 31) }),
  ], {
    period: "month",
    anchor: new Date(2026, 2, 1),
    visibleOnDate: new Date(2026, 2, 31, 12),
    flow: "expense",
    dimension: "category",
  });

  assert.equal(summary.expenseMinor, 3_100);
  assert.equal(summary.previousExpenseMinor, 2_800);
  assert.equal(summary.endDate, "2026-03-31");
  assert.equal(summary.forecastExpenseMinor, 3_100);
});

test("keeps historical month boundaries local and end-exclusive", () => {
  const summary = summarizeStatistics([
    transaction({ id: "before", amountMinor: 100, occurredAt: occurredAt(2025, 11, 31, 23) }),
    transaction({ id: "first", amountMinor: 200, occurredAt: occurredAt(2026, 0, 1, 0) }),
    transaction({ id: "last", amountMinor: 300, occurredAt: occurredAt(2026, 0, 31, 23) }),
    transaction({ id: "after", amountMinor: 400, occurredAt: occurredAt(2026, 1, 1, 0) }),
  ], {
    period: "month",
    anchor: new Date(2026, 0, 1),
    visibleOnDate: new Date(2026, 6, 15),
    flow: "expense",
    dimension: "category",
  });

  assert.equal(summary.expenseMinor, 500);
  assert.equal(summary.previousExpenseMinor, 100);
  assert.equal(summary.startDate, "2026-01-01");
  assert.equal(summary.endDate, "2026-01-31");
});

test("uses frozen base amounts and builds category, account and creator rankings", () => {
  const transactions = [
    transaction({
      id: "usd-food",
      amountMinor: 1_000,
      baseAmountMinor: 7_200,
      currency: "USD",
      categoryId: "food",
      categoryName: "旧餐饮名",
      accountId: "card",
      accountName: "信用卡",
      createdByUserId: "wife",
      createdByDisplayName: "爱人",
      occurredAt: occurredAt(2026, 6, 2),
    }),
    transaction({
      id: "cny-food",
      amountMinor: 800,
      categoryId: "food",
      categoryName: "餐饮",
      accountId: "cash",
      accountName: "现金",
      createdByUserId: "wife",
      createdByDisplayName: "爱人",
      occurredAt: occurredAt(2026, 6, 3),
    }),
    transaction({ id: "shopping", amountMinor: 2_000, categoryId: "shopping", categoryName: "购物", accountId: "cash", accountName: "现金", occurredAt: occurredAt(2026, 6, 4) }),
  ];
  const options = {
    period: "month",
    anchor: new Date(2026, 6, 1),
    visibleOnDate: new Date(2026, 7, 1),
    flow: "expense",
  };

  const categories = summarizeStatistics(transactions, { ...options, dimension: "category" });
  assert.deepEqual(categories.breakdown.map(({ key, label, amountMinor, count }) => ({ key, label, amountMinor, count })), [
    { key: "food", label: "餐饮", amountMinor: 8_000, count: 2 },
    { key: "shopping", label: "购物", amountMinor: 2_000, count: 1 },
  ]);
  assert.equal(categories.breakdown[0].share, 0.8);

  const accounts = summarizeStatistics(transactions, { ...options, dimension: "account" });
  assert.deepEqual(accounts.breakdown.map((item) => [item.key, item.amountMinor]), [["card", 7_200], ["cash", 2_800]]);

  const creators = summarizeStatistics(transactions, { ...options, dimension: "creator" });
  assert.deepEqual(creators.breakdown.map((item) => [item.key, item.label, item.amountMinor]), [
    ["user:wife", "爱人", 8_000],
    ["local:本机用户", "本机用户", 2_000],
  ]);
});

test("builds a complete yearly monthly trend and compares complete historical years", () => {
  const summary = summarizeStatistics([
    transaction({ amountMinor: 1_000, occurredAt: occurredAt(2025, 0, 5) }),
    transaction({ amountMinor: 2_000, occurredAt: occurredAt(2025, 11, 20) }),
    transaction({ amountMinor: 900, occurredAt: occurredAt(2024, 0, 5) }),
    transaction({ amountMinor: 600, occurredAt: occurredAt(2024, 11, 20) }),
  ], {
    period: "year",
    anchor: new Date(2025, 0, 1),
    visibleOnDate: new Date(2026, 6, 15),
    flow: "expense",
    dimension: "category",
  });

  assert.equal(summary.trend.length, 12);
  assert.equal(summary.trend[0].expenseMinor, 1_000);
  assert.equal(summary.trend[11].expenseMinor, 2_000);
  assert.equal(summary.expenseMinor, 3_000);
  assert.equal(summary.previousExpenseMinor, 1_500);
  assert.equal(summary.forecastExpenseMinor, 3_000);
  assert.equal(summary.endDate, "2025-12-31");
});

test("compares a current leap year with the same calendar date in the previous year", () => {
  const summary = summarizeStatistics([
    transaction({ id: "previous-same-date", amountMinor: 1_000, occurredAt: occurredAt(2027, 2, 1) }),
    transaction({ id: "previous-next-date", amountMinor: 2_000, occurredAt: occurredAt(2027, 2, 2) }),
    transaction({ id: "current", amountMinor: 3_000, occurredAt: occurredAt(2028, 2, 1) }),
  ], {
    period: "year",
    anchor: new Date(2028, 0, 1),
    visibleOnDate: new Date(2028, 2, 1, 12),
    flow: "expense",
    dimension: "category",
  });

  assert.equal(summary.expenseMinor, 3_000);
  assert.equal(summary.previousExpenseMinor, 1_000);

  const leapDaySummary = summarizeStatistics([
    transaction({ id: "previous-february", amountMinor: 400, occurredAt: occurredAt(2027, 1, 28) }),
    transaction({ id: "previous-march", amountMinor: 500, occurredAt: occurredAt(2027, 2, 1) }),
  ], {
    period: "year",
    anchor: new Date(2028, 0, 1),
    visibleOnDate: new Date(2028, 1, 29, 12),
    flow: "expense",
    dimension: "category",
  });
  assert.equal(leapDaySummary.previousExpenseMinor, 400);
});

test("returns an empty, non-forecasting result for future periods", () => {
  const summary = summarizeStatistics([
    transaction({ amountMinor: 1_000, occurredAt: occurredAt(2027, 0, 1) }),
  ], {
    period: "month",
    anchor: new Date(2027, 0, 1),
    visibleOnDate: new Date(2026, 6, 15),
    flow: "expense",
    dimension: "category",
  });

  assert.equal(summary.expenseMinor, 0);
  assert.equal(summary.previousExpenseMinor, 0);
  assert.equal(summary.forecastExpenseMinor, null);
  assert.deepEqual(summary.breakdown, []);
});
