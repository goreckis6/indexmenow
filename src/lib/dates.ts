/** Dzien w UTC jako "RRRR-MM-DD" - format kolumn DATE w MySQL. */
export function todayIso(offsetDays = 0): string {
  const now = new Date();
  now.setUTCDate(now.getUTCDate() + offsetDays);
  return now.toISOString().slice(0, 10);
}

export function isoDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

/** Lista kolejnych dni od najstarszego do dzisiejszego, wlacznie. */
export function dayRange(days: number): string[] {
  return Array.from({ length: days }, (_, i) => todayIso(-(days - 1 - i)));
}

export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
