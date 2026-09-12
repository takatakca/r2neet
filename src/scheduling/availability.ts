import type { ServiceOption } from '../domain/types.js';

/**
 * R2NETTE availability engine.
 *
 * THE RULE THAT MATTERS: a "2 cleaners × 3 hours" appointment occupies
 * THREE hours of clock time and requires TWO cleaners free for that entire
 * window. Six labour-hours is not six hours of calendar. Treating labour
 * time as clock time is how a scheduler double-books a crew.
 *
 * Everything here is pure and timezone-explicit. Persistence lives behind
 * the repository interfaces so the Prisma implementation can slot in
 * without touching this logic.
 */

export const TIMEZONE = 'America/Toronto';

/** Minutes since local midnight. */
export type Minutes = number;

export interface WorkingWindow {
  /** 0 = Sunday .. 6 = Saturday */
  weekday: number;
  startMinute: Minutes;
  endMinute: Minutes;
}

export interface StaffMember {
  id: string;
  displayName: string;
  active: boolean;
  /** Service option ids this cleaner is qualified for. Empty = all. */
  skills: string[];
  weeklyAvailability: WorkingWindow[];
}

export interface Interval {
  startUtc: Date;
  endUtc: Date;
}

export interface StaffBusy extends Interval {
  staffId: string;
  /** BOOKING blocks capacity permanently; HOLD blocks it until it expires. */
  kind: 'BOOKING' | 'HOLD' | 'TIME_OFF';
  expiresAtUtc?: Date;
}

export interface BufferPolicy {
  preJobMinutes: number;
  postJobMinutes: number;
}

export const DEFAULT_BUFFERS: BufferPolicy = { preJobMinutes: 0, postJobMinutes: 30 };

export interface SlotCandidate {
  startUtc: Date;
  endUtc: Date;
  /** Cleaners who could actually take this slot. */
  eligibleStaffIds: string[];
  /** The subset the dispatcher would assign, honouring preference. */
  proposedStaffIds: string[];
  /** True when the customer's usual cleaner is in the proposed set. */
  preferredStaffAvailable: boolean;
}

/* ------------------------------------------------------------------ */
/* timezone helpers                                                    */
/* ------------------------------------------------------------------ */

const OFFSET_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** Parts of a UTC instant as seen in America/Toronto. */
function localParts(utc: Date) {
  const p: Record<string, string> = {};
  for (const part of OFFSET_FMT.formatToParts(utc)) {
    if (part.type !== 'literal') p[part.type] = part.value;
  }
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour === '24' ? '0' : p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

/** Toronto offset in minutes at a given instant (handles DST). */
function offsetMinutes(utc: Date): number {
  const l = localParts(utc);
  const asUtc = Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second);
  return (asUtc - utc.getTime()) / 60000;
}

/**
 * Convert a local Toronto wall-clock time to a UTC instant.
 *
 * DST-safe: we guess with a first offset, then re-derive the offset at the
 * candidate instant and correct. This is what keeps an 8:00 AM slot at
 * 8:00 AM on the Sunday the clocks move.
 */
export function localToUtc(
  year: number,
  month: number,
  day: number,
  minuteOfDay: Minutes,
): Date {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = new Date(naive - offsetMinutes(new Date(naive)) * 60000);
  // one correction pass resolves the spring-forward / fall-back edge
  guess = new Date(naive - offsetMinutes(guess) * 60000);
  return guess;
}

export function localWeekday(utc: Date): number {
  const l = localParts(utc);
  return new Date(Date.UTC(l.year, l.month - 1, l.day)).getUTCDay();
}

export function localDateKey(utc: Date): string {
  const l = localParts(utc);
  return `${l.year}-${String(l.month).padStart(2, '0')}-${String(l.day).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ */
/* core                                                                */
/* ------------------------------------------------------------------ */

function overlaps(a: Interval, b: Interval): boolean {
  return a.startUtc < b.endUtc && b.startUtc < a.endUtc;
}

/** A hold only blocks capacity while it is still alive. */
function busyIsLive(b: StaffBusy, now: Date): boolean {
  if (b.kind !== 'HOLD') return true;
  return b.expiresAtUtc !== undefined && b.expiresAtUtc > now;
}

export function staffIsQualified(staff: StaffMember, service: ServiceOption): boolean {
  if (!staff.active) return false;
  if (staff.skills.length === 0) return true;
  return staff.skills.includes(service.id);
}

/**
 * Is this cleaner free for the whole window, including buffers, and does
 * the window fall inside their working hours for that weekday?
 */
export function staffIsFree(
  staff: StaffMember,
  window: Interval,
  busy: StaffBusy[],
  now: Date,
  buffers: BufferPolicy,
): boolean {
  const padded: Interval = {
    startUtc: new Date(window.startUtc.getTime() - buffers.preJobMinutes * 60000),
    endUtc: new Date(window.endUtc.getTime() + buffers.postJobMinutes * 60000),
  };

  for (const b of busy) {
    if (b.staffId !== staff.id) continue;
    if (!busyIsLive(b, now)) continue;

    // A job already on the books needs its own travel time either side.
    // Without this, the scheduler happily offers 11:00 to a cleaner who
    // finishes across town at 11:00.
    const paddedBusy: Interval =
      b.kind === 'TIME_OFF'
        ? b
        : {
            startUtc: new Date(b.startUtc.getTime() - buffers.postJobMinutes * 60000),
            endUtc: new Date(b.endUtc.getTime() + buffers.postJobMinutes * 60000),
          };

    if (overlaps(padded, paddedBusy)) return false;
  }

  // Working hours are evaluated on the local weekday of the slot start.
  const weekday = localWeekday(window.startUtc);
  const l = localParts(window.startUtc);
  const windows = staff.weeklyAvailability.filter((w) => w.weekday === weekday);
  if (windows.length === 0) return false;

  return windows.some((w) => {
    const wStart = localToUtc(l.year, l.month, l.day, w.startMinute);
    const wEnd = localToUtc(l.year, l.month, l.day, w.endMinute);
    return window.startUtc >= wStart && window.endUtc <= wEnd;
  });
}

export interface SlotQuery {
  service: ServiceOption;
  /** Local Toronto calendar day, e.g. '2026-09-14'. */
  dateKey: string;
  staff: StaffMember[];
  busy: StaffBusy[];
  now: Date;
  /** Earliest bookable lead time from now, in minutes. */
  minimumLeadMinutes?: number;
  /** Slot grid, in minutes. */
  granularityMinutes?: number;
  buffers?: BufferPolicy;
  /** Business opening window for the day. */
  openMinute?: Minutes;
  closeMinute?: Minutes;
  preferredStaffId?: string | null;
  /** Days the business is closed regardless of staff availability. */
  blockedDateKeys?: string[];
}

export class SchedulingError extends Error {
  readonly code = 'SCHEDULING_ERROR';
}

/**
 * Generate genuinely bookable slots for one local day.
 *
 * A slot is returned ONLY when at least `requiredStaffCount` qualified
 * cleaners are simultaneously free for the entire appointment duration.
 */
export function findAvailableSlots(q: SlotQuery): SlotCandidate[] {
  const {
    service,
    dateKey,
    staff,
    busy,
    now,
    minimumLeadMinutes = 120,
    granularityMinutes = 30,
    buffers = DEFAULT_BUFFERS,
    openMinute = 8 * 60,
    closeMinute = 17 * 60,
    preferredStaffId = null,
    blockedDateKeys = [],
  } = q;

  if (service.durationMode === 'QUOTE_REQUIRED' || service.appointmentDurationMinutes === null) {
    throw new SchedulingError(
      `${service.name.en} has no fixed duration until a quote is accepted, so it cannot be scheduled yet.`,
    );
  }
  if (blockedDateKeys.includes(dateKey)) return [];

  const [year, month, day] = dateKey.split('-').map(Number);
  if (!year || !month || !day) throw new SchedulingError(`invalid dateKey: ${dateKey}`);

  const duration = service.appointmentDurationMinutes;
  const need = service.requiredStaffCount;
  const qualified = staff.filter((s) => staffIsQualified(s, service));
  if (qualified.length < need) return [];

  const earliest = new Date(now.getTime() + minimumLeadMinutes * 60000);
  const slots: SlotCandidate[] = [];

  for (let m = openMinute; m + duration <= closeMinute; m += granularityMinutes) {
    const startUtc = localToUtc(year, month, day, m);
    const endUtc = new Date(startUtc.getTime() + duration * 60000);
    if (startUtc < earliest) continue;

    const window = { startUtc, endUtc };
    const free = qualified.filter((s) => staffIsFree(s, window, busy, now, buffers));
    if (free.length < need) continue;

    // Preferred cleaner first, then stable order for deterministic tests.
    const ordered = free.slice().sort((a, b) => {
      if (a.id === preferredStaffId) return -1;
      if (b.id === preferredStaffId) return 1;
      return a.id.localeCompare(b.id);
    });
    const proposed = ordered.slice(0, need);

    slots.push({
      startUtc,
      endUtc,
      eligibleStaffIds: free.map((s) => s.id),
      proposedStaffIds: proposed.map((s) => s.id),
      preferredStaffAvailable:
        preferredStaffId !== null && proposed.some((s) => s.id === preferredStaffId),
    });
  }

  return slots;
}

/**
 * Recheck a specific slot at commit time.
 *
 * The availability list a customer saw may be seconds or minutes stale.
 * Never create a booking without re-running this inside the transaction.
 */
export function verifySlotStillOpen(
  service: ServiceOption,
  startUtc: Date,
  staff: StaffMember[],
  busy: StaffBusy[],
  now: Date,
  buffers: BufferPolicy = DEFAULT_BUFFERS,
): { ok: boolean; staffIds: string[]; reason?: string } {
  if (service.appointmentDurationMinutes === null) {
    return { ok: false, staffIds: [], reason: 'service has no fixed duration' };
  }
  const endUtc = new Date(startUtc.getTime() + service.appointmentDurationMinutes * 60000);
  const qualified = staff.filter((s) => staffIsQualified(s, service));
  const free = qualified.filter((s) => staffIsFree(s, { startUtc, endUtc }, busy, now, buffers));

  if (free.length < service.requiredStaffCount) {
    return {
      ok: false,
      staffIds: [],
      reason: `needs ${service.requiredStaffCount} cleaner(s), ${free.length} free`,
    };
  }
  return { ok: true, staffIds: free.slice(0, service.requiredStaffCount).map((s) => s.id) };
}
