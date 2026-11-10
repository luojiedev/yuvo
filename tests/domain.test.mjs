import assert from "node:assert/strict";
import test from "node:test";
import { convertToBaseAmountMinor, formatTransactionCategory, groupTransactionsByLocalDay, isTransactionVisibleOnDate } from "../lib/domain.ts";

function transaction(id, type, amountMinor, occurredAt) {
  return {
    id,
    operationId: `operation-${id}`,
    ledgerId: "ledger-default",
    type,
    amountMinor,
    currency: "CNY",
    occurredAt: occurredAt.toISOString(),
    categoryId: "category-food",
    categoryName: "餐饮",
    accountId: "account-cash",
    accountName: "现金",
    note: "",
    excludeFromStats: false,
    version: 1,
    createdAt: occurredAt.toISOString(),
    deletedAt: null,
  };
}

test("formats a transaction category with its subtag", () => {
  assert.equal(formatTransactionCategory("餐饮", "午餐"), "餐饮[午餐]");
});

test("does not render empty brackets without a subtag", () => {
  assert.equal(formatTransactionCategory("餐饮", ""), "餐饮");
  assert.equal(formatTransactionCategory("交通", "   "), "交通");
});

test("groups transactions by local day with daily income and expense totals", () => {
  const today = new Date(2026, 6, 15, 18, 0);
  const groups = groupTransactionsByLocalDay([
    transaction("expense-today", "expense", 1500, new Date(2026, 6, 15, 12, 0)),
    transaction("income-today", "income", 5000, new Date(2026, 6, 15, 9, 0)),
    transaction("expense-yesterday", "expense", 800, new Date(2026, 6, 14, 20, 0)),
  ], today);

  assert.equal(groups.length, 2);
  assert.equal(groups[0].label, "今天");
  assert.equal(groups[0].expenseMinor, 1500);
  assert.equal(groups[0].incomeMinor, 5000);
  assert.equal(groups[1].label, "昨天");
  assert.equal(groups[1].expenseMinor, 800);
});

test("uses frozen CNY settlement amounts for foreign-currency totals", () => {
  const today = new Date(2026, 6, 15, 18, 0);
  const usd = { ...transaction("usd", "expense", 1000, today), currency: "USD", baseAmountMinor: 7200 };
  assert.equal(convertToBaseAmountMinor(1000, 7_200_000), 7200);
  assert.equal(groupTransactionsByLocalDay([usd], today)[0].expenseMinor, 7200);
});

test("shows transactions on their local date but hides future-dated records", () => {
  const today = new Date(2026, 6, 20, 8, 0);
  assert.equal(isTransactionVisibleOnDate({ occurredAt: new Date(2026, 6, 20, 23, 0).toISOString() }, today), true);
  assert.equal(isTransactionVisibleOnDate({ occurredAt: new Date(2026, 6, 21, 0, 0).toISOString() }, today), false);
});
