import assert from "node:assert/strict";
import test from "node:test";
import { dailyExpenseTotalsForMonth, summarizeTransactionsForMonth } from "../lib/ledger-calendar.ts";

function transaction(overrides) {
  return {
    id: crypto.randomUUID(),
    ledgerId: "ledger-default",
    operationId: crypto.randomUUID(),
    type: "expense",
    amountMinor: 0,
    currency: "CNY",
    occurredAt: "2026-07-01T08:00:00+08:00",
    categoryId: "category-food",
    categoryName: "餐饮",
    subcategoryId: null,
    subcategoryName: "",
    accountId: "account-cash",
    accountName: "现金",
    note: "",
    images: [],
    excludeFromStats: false,
    isReimbursable: false,
    isRecurring: false,
    isPrivate: false,
    version: 1,
    createdAt: "2026-07-01T08:00:00+08:00",
    deletedAt: null,
    ...overrides,
  };
}

test("aggregates only statistical expenses in the selected month by local day", () => {
  const totals = dailyExpenseTotalsForMonth([
    transaction({ amountMinor: 1200, occurredAt: "2026-07-03T08:00:00+08:00" }),
    transaction({ amountMinor: 350, occurredAt: "2026-07-03T19:00:00+08:00" }),
    transaction({ amountMinor: 9900, occurredAt: "2026-06-30T19:00:00+08:00" }),
    transaction({ type: "income", amountMinor: 5000, occurredAt: "2026-07-03T20:00:00+08:00" }),
    transaction({ amountMinor: 700, excludeFromStats: true, occurredAt: "2026-07-04T09:00:00+08:00" }),
  ], new Date(2026, 6, 1));

  assert.deepEqual(Array.from(totals.entries()), [["2026-07-03", 1550]]);
});

test("summarizes only visible statistical transactions in the selected local month", () => {
  const month = new Date(2026, 6, 1);
  const visibleOnDate = new Date(2026, 6, 15, 12, 0);
  const occurredAt = (year, monthIndex, day, hour = 8) => new Date(year, monthIndex, day, hour).toISOString();
  const summary = summarizeTransactionsForMonth([
    transaction({ amountMinor: 1200, categoryName: "餐饮", occurredAt: occurredAt(2026, 6, 3) }),
    transaction({ amountMinor: 1000, baseAmountMinor: 7200, currency: "USD", categoryName: "购物", occurredAt: occurredAt(2026, 6, 8) }),
    transaction({ type: "income", amountMinor: 5000, categoryName: "工资", occurredAt: occurredAt(2026, 6, 10) }),
    transaction({ amountMinor: 9900, occurredAt: occurredAt(2026, 5, 30) }),
    transaction({ amountMinor: 8800, occurredAt: occurredAt(2026, 7, 1) }),
    transaction({ amountMinor: 7700, occurredAt: occurredAt(2026, 6, 16) }),
    transaction({ amountMinor: 6600, excludeFromStats: true, occurredAt: occurredAt(2026, 6, 12) }),
  ], month, visibleOnDate);

  assert.equal(summary.expenseMinor, 8400);
  assert.equal(summary.incomeMinor, 5000);
  assert.deepEqual(summary.categoryTotals, [["购物", 7200], ["餐饮", 1200]]);
});
