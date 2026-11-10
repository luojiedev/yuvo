import { transactionBaseAmountMinor, type BookkeepingTransaction } from "./domain";

export type TransactionSearchScope = "all" | "category" | "note" | "account" | "creator";
export type TransactionSearchTimeRange = "all" | "7d" | "30d" | "90d" | "month" | "custom";
export type TransactionSearchStatsMode = "all" | "included" | "excluded";

export interface TransactionSearchFilters {
  query: string;
  scope: TransactionSearchScope;
  timeRange: TransactionSearchTimeRange;
  type: "all" | BookkeepingTransaction["type"];
  minimumAmountMinor: number | null;
  maximumAmountMinor: number | null;
  currency: string;
  categoryId: string;
  accountId: string;
  creatorKey: string;
  statsMode: TransactionSearchStatsMode;
  customStartDate?: string;
  customEndDate?: string;
}

export function transactionCreatorKey(transaction: BookkeepingTransaction): string {
  return transaction.createdByUserId
    ? `user:${transaction.createdByUserId}`
    : `local:${transaction.createdByDisplayName ?? "本机用户"}`;
}

export function amountInputToMinor(value: string): number | null {
  if (!value.trim()) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) : null;
}

export function filterTransactions(
  transactions: readonly BookkeepingTransaction[],
  filters: TransactionSearchFilters,
  now = new Date(),
): BookkeepingTransaction[] {
  const query = filters.query.trim().toLocaleLowerCase("zh-CN");
  const timeRange = timeRangeBounds(filters.timeRange, now, filters.customStartDate, filters.customEndDate);

  if (timeRange === null) return [];

  return transactions.filter((transaction) => {
    const settlementAmountMinor = transactionBaseAmountMinor(transaction);
    if (filters.type !== "all" && transaction.type !== filters.type) return false;
    if (filters.minimumAmountMinor !== null && settlementAmountMinor < filters.minimumAmountMinor) return false;
    if (filters.maximumAmountMinor !== null && settlementAmountMinor > filters.maximumAmountMinor) return false;
    if (filters.currency && transaction.currency !== filters.currency) return false;
    if (filters.categoryId && transaction.categoryId !== filters.categoryId) return false;
    if (filters.accountId && transaction.accountId !== filters.accountId) return false;
    if (filters.creatorKey && transactionCreatorKey(transaction) !== filters.creatorKey) return false;
    if (filters.statsMode === "included" && transaction.excludeFromStats) return false;
    if (filters.statsMode === "excluded" && !transaction.excludeFromStats) return false;
    if (timeRange) {
      const occurredTime = new Date(transaction.occurredAt).getTime();
      if (!Number.isFinite(occurredTime) || occurredTime < timeRange.start || occurredTime >= timeRange.end) return false;
    }
    return !query || searchableText(transaction, filters.scope).includes(query);
  });
}

function searchableText(transaction: BookkeepingTransaction, scope: TransactionSearchScope): string {
  const values = scope === "category"
    ? [transaction.categoryName, transaction.subcategoryName]
    : scope === "note"
      ? [transaction.note]
      : scope === "account"
        ? [transaction.accountName]
        : scope === "creator"
          ? [transaction.createdByDisplayName ?? "本机用户"]
          : [
              transaction.categoryName,
              transaction.subcategoryName,
              transaction.note,
              transaction.accountName,
              transaction.createdByDisplayName ?? "本机用户",
              transaction.currency,
              String(transaction.amountMinor / 100),
              String(transactionBaseAmountMinor(transaction) / 100),
            ];
  return values.join(" ").toLocaleLowerCase("zh-CN");
}

function timeRangeBounds(
  range: TransactionSearchTimeRange,
  now: Date,
  customStartDate = "",
  customEndDate = "",
): { start: number; end: number } | null | undefined {
  if (range === "all") return undefined;
  if (range === "custom") {
    const start = parseLocalDate(customStartDate);
    const inclusiveEnd = parseLocalDate(customEndDate);
    if (!start || !inclusiveEnd || start > inclusiveEnd) return null;
    return {
      start: start.getTime(),
      end: new Date(inclusiveEnd.getFullYear(), inclusiveEnd.getMonth(), inclusiveEnd.getDate() + 1).getTime(),
    };
  }
  if (range === "month") {
    return {
      start: new Date(now.getFullYear(), now.getMonth(), 1).getTime(),
      end: new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime(),
    };
  }
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
  return {
    start: new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1).getTime(),
    end: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime(),
  };
}

function parseLocalDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return null;
  const result = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return result.getFullYear() === Number(match[1])
    && result.getMonth() === Number(match[2]) - 1
    && result.getDate() === Number(match[3])
    ? result
    : null;
}
