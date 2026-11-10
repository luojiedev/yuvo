import { describe, expect, it } from "vitest";
import type { BookkeepingTransaction } from "../lib/domain";
import { amountInputToMinor, filterTransactions } from "../lib/transaction-search";
import type { TransactionSearchFilters } from "../lib/transaction-search";

const baseFilters: TransactionSearchFilters = {
  query: "",
  scope: "all",
  timeRange: "all",
  type: "all",
  minimumAmountMinor: null,
  maximumAmountMinor: null,
  currency: "",
  categoryId: "",
  accountId: "",
  creatorKey: "",
  statsMode: "all",
  customStartDate: "",
  customEndDate: "",
};

const transactions: BookkeepingTransaction[] = [
  transaction({ id: "breakfast", amountMinor: 1680, occurredAt: "2026-07-16T01:00:00.000Z", categoryName: "餐饮", subcategoryName: "早餐", note: "豆浆", createdByUserId: "wife", createdByDisplayName: "爱人" }),
  transaction({ id: "salary", type: "income", amountMinor: 200000, occurredAt: "2026-06-01T01:00:00.000Z", categoryName: "工资", accountId: "bank", accountName: "银行卡", excludeFromStats: true }),
];

describe("transaction search", () => {
  it("searches category, subcategory, note and creator text", () => {
    expect(filterTransactions(transactions, { ...baseFilters, query: "早餐" }).map((item) => item.id)).toEqual(["breakfast"]);
    expect(filterTransactions(transactions, { ...baseFilters, query: "豆浆" }).map((item) => item.id)).toEqual(["breakfast"]);
    expect(filterTransactions(transactions, { ...baseFilters, query: "豆浆", scope: "note" }).map((item) => item.id)).toEqual(["breakfast"]);
    expect(filterTransactions(transactions, { ...baseFilters, query: "爱人", scope: "creator" }).map((item) => item.id)).toEqual(["breakfast"]);
  });

  it("combines time, type, amount and statistics filters", () => {
    const result = filterTransactions(transactions, {
      ...baseFilters,
      timeRange: "30d",
      type: "expense",
      minimumAmountMinor: 1000,
      maximumAmountMinor: 2000,
      statsMode: "included",
    }, new Date("2026-07-16T12:00:00.000Z"));
    expect(result.map((item) => item.id)).toEqual(["breakfast"]);
  });

  it("keeps bounded time ranges inside the selected local calendar period", () => {
    const localOccurredAt = (year: number, monthIndex: number, day: number) => new Date(year, monthIndex, day, 8).toISOString();
    const datedTransactions = [
      transaction({ id: "previous-month", occurredAt: localOccurredAt(2026, 5, 30) }),
      transaction({ id: "current-month", occurredAt: localOccurredAt(2026, 6, 10) }),
      transaction({ id: "tomorrow", occurredAt: localOccurredAt(2026, 6, 17) }),
      transaction({ id: "next-month", occurredAt: localOccurredAt(2026, 7, 1) }),
    ];
    const now = new Date(2026, 6, 16, 12);

    expect(filterTransactions(datedTransactions, { ...baseFilters, timeRange: "month" }, now).map((item) => item.id))
      .toEqual(["current-month", "tomorrow"]);
    expect(filterTransactions(datedTransactions, { ...baseFilters, timeRange: "7d" }, now).map((item) => item.id))
      .toEqual(["current-month"]);
    expect(filterTransactions(datedTransactions, baseFilters, now).map((item) => item.id))
      .toEqual(["previous-month", "current-month", "tomorrow", "next-month"]);
  });

  it("filters an exact inclusive local date range for statistics drill-down", () => {
    const localOccurredAt = (year: number, monthIndex: number, day: number) => new Date(year, monthIndex, day, 8).toISOString();
    const datedTransactions = [
      transaction({ id: "before", occurredAt: localOccurredAt(2026, 5, 30) }),
      transaction({ id: "first", occurredAt: localOccurredAt(2026, 6, 1) }),
      transaction({ id: "last", occurredAt: localOccurredAt(2026, 6, 15) }),
      transaction({ id: "after", occurredAt: localOccurredAt(2026, 6, 16) }),
    ];

    expect(filterTransactions(datedTransactions, {
      ...baseFilters,
      timeRange: "custom",
      customStartDate: "2026-07-01",
      customEndDate: "2026-07-15",
    }).map((item) => item.id)).toEqual(["first", "last"]);
    expect(filterTransactions(datedTransactions, {
      ...baseFilters,
      timeRange: "custom",
      customStartDate: "2026-07-20",
      customEndDate: "2026-07-10",
    })).toEqual([]);
  });

  it("filters foreign-currency records by their frozen CNY settlement amount", () => {
    const usdTransaction = transaction({
      id: "usd-subscription",
      amountMinor: 1_000,
      currency: "USD",
      baseAmountMinor: 7_200,
      exchangeRateMicros: 7_200_000,
      exchangeRateSource: "frankfurter",
      exchangeRateAt: "2026-07-16T00:00:00.000Z",
    });
    expect(filterTransactions([usdTransaction], {
      ...baseFilters,
      minimumAmountMinor: 7_000,
      maximumAmountMinor: 7_500,
    }).map((item) => item.id)).toEqual(["usd-subscription"]);
  });

  it("converts decimal amount input to minor units", () => {
    expect(amountInputToMinor("16.80")).toBe(1680);
    expect(amountInputToMinor("")).toBeNull();
    expect(amountInputToMinor("invalid")).toBeNull();
  });
});

function transaction(overrides: Partial<BookkeepingTransaction>): BookkeepingTransaction {
  return {
    id: "transaction",
    operationId: "operation",
    ledgerId: "ledger",
    type: "expense",
    amountMinor: 100,
    currency: "CNY",
    occurredAt: "2026-07-16T00:00:00.000Z",
    categoryId: "category",
    categoryName: "其他",
    subcategoryId: null,
    subcategoryName: "",
    accountId: "cash",
    accountName: "现金",
    note: "",
    images: [],
    excludeFromStats: false,
    version: 1,
    createdAt: "2026-07-16T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}
