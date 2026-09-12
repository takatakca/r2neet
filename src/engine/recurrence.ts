import { localToUtc } from '../scheduling/availability.js';
import {
  CleaningFrequency,
  RecurrenceKind,
  ShortMonthPolicy,
  type FrequencyRule,
} from '../domain/types.js';

/**
 * Recurrence date generation.
 *
 * WEEKLY is every 7 days — not "four visits per calendar month". Some months
 * contain five weekly visits and the customer is entitled to all of them.
 *
 * MONTHLY is a real calendar rule: same day-of-month, clamped to the last day
 * of shorter months, and RETURNING to the original day afterwards.
 *
 *   Jan 31 -> Feb 28/29 -> Mar 31 -> Apr 30 -> May 31
 *
 * The preferred day-of-month is stored on the series and never mutated, which
 * is why February does not permanently drag every later visit back to the 28th.
 */

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * Occurrences are generated in LOCAL wall-clock time, then converted back.
 *
 * Adding days in UTC looks correct and is not: a 10:00 EDT cleaning is 14:00
 * UTC, and after the November change 14:00 UTC is 09:00 EST. The customer's
 * cleaning would silently move an hour earlier for the whole winter.
 */
function localPartsIn(utc: Date, timezone: string) {
  const p: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(utc)) {
    if (part.type !== 'literal') p[part.type] = part.value;
  }
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour === '24' ? '0' : p.hour),
    minute: Number(p.minute),
  };
}

export interface RecurrenceDefinition {
  frequency: CleaningFrequency;
  kind: RecurrenceKind;
  intervalDays: number | null;
  shortMonthPolicy: ShortMonthPolicy | null;
  /** Immutable. Survives every clamp. */
  preferredDayOfMonth: number | null;
  timezone: string;
}

export function buildRecurrenceDefinition(
  rule: FrequencyRule,
  startDate: Date,
  timezone = 'America/Toronto',
): RecurrenceDefinition {
  return {
    frequency: rule.frequency,
    kind: rule.recurrenceKind,
    intervalDays: rule.intervalDays,
    shortMonthPolicy: rule.shortMonthPolicy,
    preferredDayOfMonth:
      rule.recurrenceKind === RecurrenceKind.CALENDAR_MONTH
        ? localPartsIn(startDate, timezone).day
        : null,
    timezone,
  };
}

export function generateOccurrences(
  definition: RecurrenceDefinition,
  startDate: Date,
  count: number,
): Date[] {
  if (definition.kind === RecurrenceKind.NONE) return [new Date(startDate)];

  const out: Date[] = [new Date(startDate)];

  const tz = definition.timezone;
  const anchor = localPartsIn(startDate, tz);
  const minuteOfDay = anchor.hour * 60 + anchor.minute;

  if (definition.kind === RecurrenceKind.FIXED_INTERVAL_DAYS) {
    const interval = definition.intervalDays;
    if (!interval) throw new Error('fixed-interval recurrence requires intervalDays');
    for (let i = 1; i < count; i++) {
      // Step whole LOCAL days, then rebuild the instant at the same
      // wall-clock time, so the hour survives both DST changes.
      const stepped = new Date(
        Date.UTC(anchor.year, anchor.month - 1, anchor.day) + interval * i * 86400000,
      );
      out.push(
        localToUtc(
          stepped.getUTCFullYear(),
          stepped.getUTCMonth() + 1,
          stepped.getUTCDate(),
          minuteOfDay,
        ),
      );
    }
    return out;
  }

  // CALENDAR_MONTH
  const preferred = definition.preferredDayOfMonth ?? anchor.day;
  for (let i = 1; i < count; i++) {
    const monthIndex = anchor.month - 1 + i;
    const targetYear = anchor.year + Math.floor(monthIndex / 12);
    const targetMonth = ((monthIndex % 12) + 12) % 12;

    // Clamp only for this month. `preferred` is never overwritten.
    const day = Math.min(preferred, daysInMonth(targetYear, targetMonth));
    out.push(localToUtc(targetYear, targetMonth + 1, day, minuteOfDay));
  }
  return out;
}
