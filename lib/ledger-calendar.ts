import {
  isTransactionVisibleOnDate,
  transactionBaseAmountMinor,
  type BookkeepingTransaction,
} from "./domain.ts";

export interface MonthlyTransactionSummary {
  expenseMinor: number;
  incomeMinor: number;
  categoryTotals: Array<[string, number]>;
}

export function localDateKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function occurredInLocalMonth(transaction: BookkeepingTransaction, month: Date): boolean {
  const occurredAt = new Date(transaction.occurredAt);
  return !Number.isNaN(occurredAt.getTime())
    && occurredAt.getFullYear() === month.getFullYear()
    && occurredAt.getMonth() === month.getMonth();
}

export function summarizeTransactionsForMonth(
  transactions: BookkeepingTransaction[],
  month: Date,
  visibleOnDate = new Date(),
): MonthlyTransactionSummary {
  let expenseMinor = 0;
  let incomeMinor = 0;
  const totalsByCategory = new Map<string, number>();

  transactions
    .filter((item) => !item.excludeFromStats
      && occurredInLocalMonth(item, month)
      && isTransactionVisibleOnDate(item, visibleOnDate))
    .forEach((item) => {
      const amountMinor = transactionBaseAmountMinor(item);
      if (item.type === "income") {
        incomeMinor += amountMinor;
        return;
      }
      expenseMinor += amountMinor;
      totalsByCategory.set(item.categoryName, (totalsByCategory.get(item.categoryName) ?? 0) + amountMinor);
    });

  return {
    expenseMinor,
    incomeMinor,
    categoryTotals: Array.from(totalsByCategory.entries()).sort((left, right) => right[1] - left[1]),
  };
}

export function dailyExpenseTotalsForMonth(
  transactions: BookkeepingTransaction[],
  month: Date,
): Map<string, number> {
  const totals = new Map<string, number>();
  transactions
    .filter((item) => {
      if (item.type !== "expense" || item.excludeFromStats) return false;
      return occurredInLocalMonth(item, month);
    })
    .forEach((item) => {
      const key = localDateKey(new Date(item.occurredAt));
      totals.set(key, (totals.get(key) ?? 0) + transactionBaseAmountMinor(item));
    });
  return totals;
}
