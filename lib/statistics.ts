import { transactionBaseAmountMinor, type BookkeepingTransaction } from "./domain.ts";

export type StatisticsPeriod = "month" | "year";
export type StatisticsFlow = BookkeepingTransaction["type"];
export type StatisticsDimension = "category" | "account" | "creator";

export interface StatisticsTrendBucket {
  key: string;
  label: string;
  expenseMinor: number;
  incomeMinor: number;
}

export interface StatisticsBreakdownItem {
  key: string;
  label: string;
  amountMinor: number;
  count: number;
  share: number;
}

export interface StatisticsSummary {
  period: StatisticsPeriod;
  start: Date;
  end: Date;
  effectiveEnd: Date;
  previousStart: Date;
  previousEffectiveEnd: Date;
  startDate: string;
  endDate: string;
  isCurrentPeriod: boolean;
  isFuturePeriod: boolean;
  expenseMinor: number;
  incomeMinor: number;
  previousExpenseMinor: number;
  previousIncomeMinor: number;
  forecastExpenseMinor: number | null;
  trend: StatisticsTrendBucket[];
  breakdown: StatisticsBreakdownItem[];
}

interface StatisticsOptions {
  period: StatisticsPeriod;
  anchor: Date;
  visibleOnDate?: Date;
  flow: StatisticsFlow;
  dimension: StatisticsDimension;
}

interface PeriodRange {
  start: Date;
  end: Date;
  effectiveEnd: Date;
  isCurrentPeriod: boolean;
  isFuturePeriod: boolean;
}

interface MutableBreakdownItem {
  key: string;
  label: string;
  amountMinor: number;
  count: number;
  latestOccurredAt: number;
}

export function summarizeStatistics(
  transactions: readonly BookkeepingTransaction[],
  options: StatisticsOptions,
): StatisticsSummary {
  const visibleOnDate = options.visibleOnDate ?? new Date();
  const range = buildPeriodRange(options.period, options.anchor, visibleOnDate);
  const previousRange = buildPreviousPeriodRange(options.period, range);
  const currentTransactions = statisticalTransactionsBetween(transactions, range.start, range.effectiveEnd);
  const previousTransactions = statisticalTransactionsBetween(transactions, previousRange.start, previousRange.effectiveEnd);
  const totals = totalTransactions(currentTransactions);
  const previousTotals = totalTransactions(previousTransactions);
  const totalDayCount = localDayDifference(range.start, range.end);
  const elapsedDayCount = localDayDifference(range.start, range.effectiveEnd);
  const forecastExpenseMinor = range.isFuturePeriod
    ? null
    : range.isCurrentPeriod && elapsedDayCount > 0
      ? Math.round((totals.expenseMinor / elapsedDayCount) * totalDayCount)
      : totals.expenseMinor;

  return {
    period: options.period,
    ...range,
    previousStart: previousRange.start,
    previousEffectiveEnd: previousRange.effectiveEnd,
    startDate: localDateKey(range.start),
    endDate: localDateKey(new Date(range.effectiveEnd.getFullYear(), range.effectiveEnd.getMonth(), range.effectiveEnd.getDate() - 1)),
    expenseMinor: totals.expenseMinor,
    incomeMinor: totals.incomeMinor,
    previousExpenseMinor: previousTotals.expenseMinor,
    previousIncomeMinor: previousTotals.incomeMinor,
    forecastExpenseMinor,
    trend: buildTrend(options.period, range, currentTransactions),
    breakdown: buildBreakdown(currentTransactions, options.flow, options.dimension),
  };
}

function buildPeriodRange(period: StatisticsPeriod, anchor: Date, visibleOnDate: Date): PeriodRange {
  const start = period === "month"
    ? new Date(anchor.getFullYear(), anchor.getMonth(), 1)
    : new Date(anchor.getFullYear(), 0, 1);
  const end = period === "month"
    ? new Date(start.getFullYear(), start.getMonth() + 1, 1)
    : new Date(start.getFullYear() + 1, 0, 1);
  const todayStart = new Date(visibleOnDate.getFullYear(), visibleOnDate.getMonth(), visibleOnDate.getDate());
  const tomorrowStart = new Date(todayStart.getFullYear(), todayStart.getMonth(), todayStart.getDate() + 1);
  const isCurrentPeriod = todayStart >= start && todayStart < end;
  const isFuturePeriod = start > todayStart;
  const effectiveEnd = isFuturePeriod ? start : new Date(Math.min(end.getTime(), tomorrowStart.getTime()));
  return { start, end, effectiveEnd, isCurrentPeriod, isFuturePeriod };
}

function buildPreviousPeriodRange(
  period: StatisticsPeriod,
  currentRange: PeriodRange,
): Pick<PeriodRange, "start" | "effectiveEnd"> {
  const start = period === "month"
    ? new Date(currentRange.start.getFullYear(), currentRange.start.getMonth() - 1, 1)
    : new Date(currentRange.start.getFullYear() - 1, 0, 1);
  const end = period === "month"
    ? new Date(start.getFullYear(), start.getMonth() + 1, 1)
    : new Date(start.getFullYear() + 1, 0, 1);
  if (currentRange.isFuturePeriod) return { start, effectiveEnd: start };
  if (!currentRange.isCurrentPeriod) return { start, effectiveEnd: end };

  if (period === "year") {
    const lastIncludedDate = new Date(
      currentRange.effectiveEnd.getFullYear(),
      currentRange.effectiveEnd.getMonth(),
      currentRange.effectiveEnd.getDate() - 1,
    );
    const previousMonthLastDay = new Date(start.getFullYear(), lastIncludedDate.getMonth() + 1, 0).getDate();
    const sameCalendarDateEnd = new Date(
      start.getFullYear(),
      lastIncludedDate.getMonth(),
      Math.min(lastIncludedDate.getDate(), previousMonthLastDay) + 1,
    );
    return { start, effectiveEnd: new Date(Math.min(end.getTime(), sameCalendarDateEnd.getTime())) };
  }

  const elapsedDayCount = localDayDifference(currentRange.start, currentRange.effectiveEnd);
  const sameProgressEnd = new Date(start.getFullYear(), start.getMonth(), start.getDate() + elapsedDayCount);
  const effectiveEnd = new Date(Math.min(end.getTime(), sameProgressEnd.getTime()));
  return { start, effectiveEnd };
}

function statisticalTransactionsBetween(
  transactions: readonly BookkeepingTransaction[],
  start: Date,
  end: Date,
): BookkeepingTransaction[] {
  const startTime = start.getTime();
  const endTime = end.getTime();
  return transactions.filter((transaction) => {
    if (transaction.excludeFromStats || transaction.deletedAt) return false;
    const occurredTime = new Date(transaction.occurredAt).getTime();
    return Number.isFinite(occurredTime) && occurredTime >= startTime && occurredTime < endTime;
  });
}

function totalTransactions(transactions: readonly BookkeepingTransaction[]): { expenseMinor: number; incomeMinor: number } {
  let expenseMinor = 0;
  let incomeMinor = 0;
  transactions.forEach((transaction) => {
    const amountMinor = transactionBaseAmountMinor(transaction);
    if (transaction.type === "income") incomeMinor += amountMinor;
    else expenseMinor += amountMinor;
  });
  return { expenseMinor, incomeMinor };
}

function buildTrend(
  period: StatisticsPeriod,
  range: PeriodRange,
  transactions: readonly BookkeepingTransaction[],
): StatisticsTrendBucket[] {
  const buckets = period === "month"
    ? Array.from({ length: new Date(range.start.getFullYear(), range.start.getMonth() + 1, 0).getDate() }, (_, index) => ({
        key: localDateKey(new Date(range.start.getFullYear(), range.start.getMonth(), index + 1)),
        label: String(index + 1),
        expenseMinor: 0,
        incomeMinor: 0,
      }))
    : Array.from({ length: 12 }, (_, index) => ({
        key: `${range.start.getFullYear()}-${String(index + 1).padStart(2, "0")}`,
        label: `${index + 1}月`,
        expenseMinor: 0,
        incomeMinor: 0,
      }));
  const bucketsByKey = new Map(buckets.map((bucket) => [bucket.key, bucket]));
  transactions.forEach((transaction) => {
    const occurredAt = new Date(transaction.occurredAt);
    const key = period === "month"
      ? localDateKey(occurredAt)
      : `${occurredAt.getFullYear()}-${String(occurredAt.getMonth() + 1).padStart(2, "0")}`;
    const bucket = bucketsByKey.get(key);
    if (!bucket) return;
    const amountMinor = transactionBaseAmountMinor(transaction);
    if (transaction.type === "income") bucket.incomeMinor += amountMinor;
    else bucket.expenseMinor += amountMinor;
  });
  return buckets;
}

function buildBreakdown(
  transactions: readonly BookkeepingTransaction[],
  flow: StatisticsFlow,
  dimension: StatisticsDimension,
): StatisticsBreakdownItem[] {
  const totals = new Map<string, MutableBreakdownItem>();
  transactions.filter((transaction) => transaction.type === flow).forEach((transaction) => {
    const identity = breakdownIdentity(transaction, dimension);
    const occurredAt = new Date(transaction.occurredAt).getTime();
    const current = totals.get(identity.key) ?? {
      ...identity,
      amountMinor: 0,
      count: 0,
      latestOccurredAt: Number.NEGATIVE_INFINITY,
    };
    current.amountMinor += transactionBaseAmountMinor(transaction);
    current.count += 1;
    if (occurredAt >= current.latestOccurredAt) {
      current.label = identity.label;
      current.latestOccurredAt = occurredAt;
    }
    totals.set(identity.key, current);
  });
  const totalMinor = Array.from(totals.values()).reduce((total, item) => total + item.amountMinor, 0);
  return Array.from(totals.values())
    .sort((left, right) => right.amountMinor - left.amountMinor || left.label.localeCompare(right.label, "zh-CN"))
    .map((item) => ({
      key: item.key,
      label: item.label,
      amountMinor: item.amountMinor,
      count: item.count,
      share: totalMinor > 0 ? item.amountMinor / totalMinor : 0,
    }));
}

function breakdownIdentity(
  transaction: BookkeepingTransaction,
  dimension: StatisticsDimension,
): Pick<MutableBreakdownItem, "key" | "label"> {
  if (dimension === "category") {
    return { key: transaction.categoryId, label: transaction.categoryName || "未分类" };
  }
  if (dimension === "account") {
    return { key: transaction.accountId, label: transaction.accountName || "未命名账户" };
  }
  return {
    key: transaction.createdByUserId
      ? `user:${transaction.createdByUserId}`
      : `local:${transaction.createdByDisplayName ?? "本机用户"}`,
    label: transaction.createdByDisplayName ?? "本机用户",
  };
}

function localDayDifference(start: Date, end: Date): number {
  const startUtc = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const endUtc = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.max(0, Math.round((endUtc - startUtc) / 86_400_000));
}

function localDateKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}
