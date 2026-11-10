export type SubscriptionFrequency = "month" | "year";

export function dayOfIsoDate(dateValue: string): number {
  return Number(dateValue.slice(8, 10));
}

export function isValidAnchorDay(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 31;
}

/**
 * 计算下一个扣费日。`anchorDay` 是用户最初设定的扣费日（如 31 号）：短月份会临时落到月末，
 * 但之后的周期仍要回到锚点日，否则 1/31 → 2/28 → 3/28 会永久漂移。
 * 未提供锚点（旧数据）时退回到当前日期的日。
 */
export function advanceSubscriptionDate(
  dateValue: string,
  frequency: SubscriptionFrequency,
  interval: number,
  anchorDay?: number | null,
): string {
  const [year, month, day] = dateValue.split("-").map(Number);
  const targetDay = isValidAnchorDay(anchorDay) ? anchorDay : day;
  const sourceMonthIndex = month - 1;
  const targetMonthIndex = frequency === "year" ? sourceMonthIndex : sourceMonthIndex + interval;
  const targetYear = frequency === "year" ? year + interval : year + Math.floor(targetMonthIndex / 12);
  const normalizedMonthIndex = ((targetMonthIndex % 12) + 12) % 12;
  const lastDayOfTargetMonth = new Date(targetYear, normalizedMonthIndex + 1, 0).getDate();
  const result = new Date(targetYear, normalizedMonthIndex, Math.min(targetDay, lastDayOfTargetMonth));
  return `${result.getFullYear()}-${String(result.getMonth() + 1).padStart(2, "0")}-${String(result.getDate()).padStart(2, "0")}`;
}
