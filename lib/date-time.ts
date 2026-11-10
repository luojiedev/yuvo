export interface CalendarDay {
  date: Date;
  belongsToMonth: boolean;
}

export function startOfLocalMonth(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), 1);
}

export function remainingDaysInLocalMonth(value: Date): number {
  const lastDay = new Date(value.getFullYear(), value.getMonth() + 1, 0).getDate();
  return lastDay - value.getDate() + 1;
}

export function buildMonthGrid(month: Date): CalendarDay[] {
  const firstDay = startOfLocalMonth(month);
  const gridStart = new Date(firstDay.getFullYear(), firstDay.getMonth(), 1 - firstDay.getDay());
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index);
    return { date, belongsToMonth: date.getMonth() === firstDay.getMonth() };
  });
}

export function isSameLocalDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

export function withSelectedDate(value: Date, selectedDate: Date): Date {
  const next = new Date(value);
  next.setFullYear(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate());
  return next;
}

export function withSelectedTime(value: Date, hour: number, minute: number): Date {
  const next = new Date(value);
  next.setHours(hour, minute, 0, 0);
  return next;
}

export function formatMonthTitle(value: Date): string {
  return `${value.getFullYear()}年${String(value.getMonth() + 1).padStart(2, "0")}月`;
}

export function formatTime(value: Date): string {
  return `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
}

export function formatDateLabel(value: Date, today = new Date()): string {
  if (isSameLocalDay(value, today)) return "今天";
  return `${String(value.getMonth() + 1).padStart(2, "0")}月${String(value.getDate()).padStart(2, "0")}日`;
}
