import type { PrismaClient } from '@prisma/client';
import { SERVICES } from '../data/catalogue.js';

/**
 * The cleaner roster.
 *
 * Until now cleaners existed only in seed fixtures, which meant the owner
 * could not hire anyone without a developer. Availability is also what the
 * scheduling engine reads to decide whether a slot can be offered at all, so
 * a roster nobody can edit is a booking system nobody can adjust.
 *
 * `Staff` is a schedulable resource, distinct from `StaffUser`, which is a
 * login. An owner may have a login and never be dispatched; a cleaner may be
 * on the schedule before they have an account.
 */

export class RosterError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface AvailabilityWindow {
  weekday: number; // 0 = Sunday
  startMinute: number;
  endMinute: number;
}

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const minutesToTime = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export function timeToMinutes(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());

  if (!match) {
    throw new RosterError(
      `"${value}" is not a time like 08:00.`,
      'INVALID_TIME',
    );
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  const valid =
    hour >= 0 &&
    hour <= 24 &&
    minute >= 0 &&
    minute <= 59 &&
    !(hour === 24 && minute !== 0);

  if (!valid) {
    throw new RosterError(
      `"${value}" is not a valid time.`,
      'INVALID_TIME',
    );
  }

  return hour * 60 + minute;
}

/**
 * Validate a week of availability.
 *
 * Overlaps are rejected rather than merged: two overlapping windows usually
 * mean a typo, and silently merging them hides the mistake until someone is
 * booked at a time they never offered.
 */
export function validateAvailability(
  windows: AvailabilityWindow[],
): void {
  for (const window of windows) {
    if (
      !Number.isInteger(window.weekday) ||
      window.weekday < 0 ||
      window.weekday > 6
    ) {
      throw new RosterError(
        'Weekday must be 0 (Sunday) through 6.',
        'INVALID_WEEKDAY',
      );
    }

    if (
      !Number.isInteger(window.startMinute) ||
      !Number.isInteger(window.endMinute) ||
      window.startMinute < 0 ||
      window.endMinute > 24 * 60
    ) {
      throw new RosterError(
        `${WEEKDAY_NAMES[window.weekday]}: availability must stay inside the day.`,
        'INVALID_WINDOW',
      );
    }

    if (window.startMinute >= window.endMinute) {
      throw new RosterError(
        `${WEEKDAY_NAMES[window.weekday]}: the end time must be after the start time.`,
        'INVALID_WINDOW',
      );
    }
  }

  const weekdays = new Set(windows.map((window) => window.weekday));

  for (const weekday of weekdays) {
    const sameDay = windows
      .filter((window) => window.weekday === weekday)
      .sort((a, b) => a.startMinute - b.startMinute);

    for (let index = 1; index < sameDay.length; index++) {
      const previous = sameDay[index - 1]!;
      const current = sameDay[index]!;

      if (current.startMinute < previous.endMinute) {
        throw new RosterError(
          `${WEEKDAY_NAMES[weekday]}: two availability windows overlap.`,
          'OVERLAPPING_WINDOWS',
        );
      }
    }
  }
}

/** A sensible starting week, so a new cleaner is not created unbookable. */
export function defaultAvailability(): AvailabilityWindow[] {
  return [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 8 * 60, endMinute: 17 * 60 }));
}

export interface RosterTimeOff {
  id: string;
  startAt: string;
  endAt: string;
  reason: string | null;
}

export interface RosterMember {
  id: string;
  displayName: string;
  active: boolean;
  skills: string[];
  availability: AvailabilityWindow[];
  /** Hours offered per week, so the owner can see coverage at a glance. */
  weeklyHours: number;
  upcomingJobs: number;
  onTimeOffUntil: string | null;
  upcomingTimeOff: RosterTimeOff[];
  hasLogin: boolean;
}

export class RosterService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(): Promise<RosterMember[]> {
    const at = this.now();
    const staff = await this.prisma.staff.findMany({
      include: {
        availability: true,
        skills: true,
        timeOff: { where: { endAt: { gte: at } }, orderBy: { startAt: 'asc' } },
      },
      orderBy: [{ active: 'desc' }, { displayName: 'asc' }],
    });

    const out: RosterMember[] = [];
    for (const s of staff) {
      const [upcoming, login] = await Promise.all([
        this.prisma.bookingStaff.count({
          where: { staffId: s.id, booking: { startAt: { gte: at }, status: { notIn: ['CANCELLED'] } } },
        }),
        this.prisma.staffUser.findFirst({ where: { staffId: s.id } }),
      ]);

      const availability = s.availability.map((a) => ({
        weekday: a.weekday,
        startMinute: a.startMinute,
        endMinute: a.endMinute,
      }));
      const current = s.timeOff.find((t) => t.startAt <= at && t.endAt > at);

      out.push({
        id: s.id,
        displayName: s.displayName,
        active: s.active,
        skills: s.skills.map((k) => k.serviceOptionId),
        availability,
        weeklyHours:
          Math.round(
            (availability.reduce((n, w) => n + (w.endMinute - w.startMinute), 0) / 60) * 10,
          ) / 10,
        upcomingJobs: upcoming,
        onTimeOffUntil: current?.endAt.toISOString() ?? null,
        upcomingTimeOff: s.timeOff.map((t) => ({
          id: t.id,
          startAt: t.startAt.toISOString(),
          endAt: t.endAt.toISOString(),
          reason: t.reason,
        })),
        hasLogin: login !== null,
      });
    }
    return out;
  }

  async create(input: { displayName: string; availability?: AvailabilityWindow[]; skills?: string[] }) {
    const name = input.displayName.trim();
    if (!name) throw new RosterError('A cleaner needs a name.', 'NAME_REQUIRED');

    // Defaulting here rather than in the route: a cleaner created with no
    // availability can never be booked, and that must be a deliberate choice
    // whichever path created them.
    const availability = input.availability ?? defaultAvailability();
    validateAvailability(availability);
    this.assertKnownSkills(input.skills ?? []);

    return this.prisma.staff.create({
      data: {
        displayName: name,
        active: true,
        availability: { create: availability },
        skills: { create: (input.skills ?? []).map((serviceOptionId) => ({ serviceOptionId })) },
      },
    });
  }

  /**
   * Replace a cleaner's week.
   *
   * Reducing availability cannot orphan work: any already-booked job outside
   * the new window is reported so a dispatcher can move it deliberately.
   */
  async setAvailability(staffId: string, windows: AvailabilityWindow[]) {
    validateAvailability(windows);
    await this.prisma.staff.findUniqueOrThrow({ where: { id: staffId } });

    const conflicts = await this.jobsOutsideAvailability(staffId, windows);

    await this.prisma.$transaction([
      this.prisma.staffAvailability.deleteMany({ where: { staffId } }),
      this.prisma.staffAvailability.createMany({
        data: windows.map((w) => ({ staffId, ...w })),
      }),
    ]);

    return { conflicts };
  }

  /** Upcoming assignments that the proposed week would no longer cover. */
  async jobsOutsideAvailability(staffId: string, windows: AvailabilityWindow[]) {
    const at = this.now();
    const assignments = await this.prisma.bookingStaff.findMany({
      where: { staffId, booking: { startAt: { gte: at }, status: { notIn: ['CANCELLED'] } } },
      include: { booking: true },
    });

    const out: { bookingNumber: string; startAt: string }[] = [];
    for (const a of assignments) {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Toronto',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(a.booking.startAt);
      const weekdayName = parts.find((p) => p.type === 'weekday')!.value;
      const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekdayName);
      const startMinute =
        Number(parts.find((p) => p.type === 'hour')!.value) * 60 +
        Number(parts.find((p) => p.type === 'minute')!.value);
      const durationMinutes = Math.round(
        (a.booking.endAt.getTime() - a.booking.startAt.getTime()) / 60000,
      );

      const covered = windows.some(
        (w) =>
          w.weekday === weekday &&
          startMinute >= w.startMinute &&
          startMinute + durationMinutes <= w.endMinute,
      );
      if (!covered) {
        out.push({ bookingNumber: a.booking.bookingNumber, startAt: a.booking.startAt.toISOString() });
      }
    }
    return out;
  }

  async setSkills(staffId: string, requestedSkills: string[]) {
    const skills = [...new Set(requestedSkills)];

    this.assertKnownSkills(skills);

    await this.prisma.staff.findUniqueOrThrow({
      where: { id: staffId },
    });

    const conflicts = await this.jobsOutsideSkills(
      staffId,
      skills,
    );

    await this.prisma.$transaction([
      this.prisma.staffSkill.deleteMany({
        where: { staffId },
      }),

      this.prisma.staffSkill.createMany({
        data: skills.map((serviceOptionId) => ({
          staffId,
          serviceOptionId,
        })),
      }),
    ]);

    return { conflicts };
  }

  async jobsOutsideSkills(
    staffId: string,
    skills: string[],
  ): Promise<{ bookingNumber: string; startAt: string }[]> {
    // Empty means the cleaner may perform every service.
    if (skills.length === 0) {
      return [];
    }

    const assignments =
      await this.prisma.bookingStaff.findMany({
        where: {
          staffId,
          booking: {
            startAt: {
              gte: this.now(),
            },
            status: {
              notIn: ['CANCELLED'],
            },
          },
        },
        include: {
          booking: true,
        },
      });

    return assignments
      .filter(
        (assignment) =>
          !skills.includes(
            assignment.booking.serviceOptionId,
          ),
      )
      .map((assignment) => ({
        bookingNumber:
          assignment.booking.bookingNumber,

        startAt:
          assignment.booking.startAt.toISOString(),
      }));
  }

  /**
   * Deactivate rather than delete.
   *
   * A cleaner who has done work is part of the record: deleting them would
   * orphan history. Deactivation removes them from scheduling only, and is
   * refused while they still have upcoming jobs.
   */
  async setActive(staffId: string, active: boolean) {
    if (!active) {
      const upcoming = await this.prisma.bookingStaff.findMany({
        where: {
          staffId,
          booking: { startAt: { gte: this.now() }, status: { notIn: ['CANCELLED'] } },
        },
        include: { booking: true },
      });
      if (upcoming.length > 0) {
        const numbers = upcoming.map((a) => a.booking.bookingNumber).join(', ');
        throw new RosterError(
          `This cleaner still has ${upcoming.length} upcoming job${upcoming.length === 1 ? '' : 's'} (${numbers}). Reassign them first.`,
          'HAS_UPCOMING_JOBS',
          409,
        );
      }
    }
    return this.prisma.staff.update({ where: { id: staffId }, data: { active } });
  }

  /** Time off. Overlapping periods are refused so coverage stays legible. */
  async addTimeOff(staffId: string, startAt: Date, endAt: Date, reason?: string) {
    if (endAt <= startAt) {
      throw new RosterError('Time off must end after it starts.', 'INVALID_RANGE');
    }
    const overlap = await this.prisma.staffTimeOff.findFirst({
      where: { staffId, startAt: { lt: endAt }, endAt: { gt: startAt } },
    });
    if (overlap) {
      throw new RosterError('That overlaps existing time off.', 'OVERLAPPING_TIME_OFF', 409);
    }

    // Jobs inside the period must be dealt with, not silently abandoned.
    const affected = await this.prisma.bookingStaff.findMany({
      where: {
        staffId,
        booking: { startAt: { lt: endAt, gte: startAt }, status: { notIn: ['CANCELLED'] } },
      },
      include: { booking: true },
    });

    const created = await this.prisma.staffTimeOff.create({
      data: { staffId, startAt, endAt, reason: reason ?? null },
    });

    return {
      timeOff: created,
      affectedBookings: affected.map((a) => ({
        bookingNumber: a.booking.bookingNumber,
        startAt: a.booking.startAt.toISOString(),
      })),
    };
  }

  async removeTimeOff(id: string) {
    await this.prisma.staffTimeOff.delete({ where: { id } });
  }

  async timeOff(staffId: string) {
    return this.prisma.staffTimeOff.findMany({
      where: { staffId, endAt: { gte: this.now() } },
      orderBy: { startAt: 'asc' },
    });
  }

  /**
   * Coverage by weekday, so gaps are visible before a customer finds them.
   *
   * A day with no cleaners is a day the booking flow silently offers nothing,
   * which looks like "fully booked" to a customer.
   */
  async coverage() {
    const staff = await this.prisma.staff.findMany({
      where: {
        active: true,
      },

      include: {
        availability: true,
        skills: true,
      },
    });

    const twoCleanerServices = SERVICES.filter(
      (service) =>
        service.active &&
        service.requiredStaffCount === 2 &&
        service.appointmentDurationMinutes !== null,
    );

    return WEEKDAY_NAMES.map((name, weekday) => {
      const workingStaff = staff
        .map((member) => ({
          id: member.id,

          skills: member.skills.map(
            (skill) => skill.serviceOptionId,
          ),

          windows: member.availability.filter(
            (window) => window.weekday === weekday,
          ),
        }))
        .filter((member) => member.windows.length > 0);

      const allWindows = workingStaff.flatMap(
        (member) => member.windows,
      );

      const canStaffTwoPersonJobs =
        twoCleanerServices.some((service) => {
          const eligible = workingStaff.filter(
            (member) =>
              member.skills.length === 0 ||
              member.skills.includes(service.id),
          );

          const requiredMinutes =
            service.appointmentDurationMinutes!;

          for (
            let firstIndex = 0;
            firstIndex < eligible.length;
            firstIndex++
          ) {
            for (
              let secondIndex = firstIndex + 1;
              secondIndex < eligible.length;
              secondIndex++
            ) {
              const first = eligible[firstIndex]!;
              const second = eligible[secondIndex]!;

              for (const firstWindow of first.windows) {
                for (const secondWindow of second.windows) {
                  const overlapStart = Math.max(
                    firstWindow.startMinute,
                    secondWindow.startMinute,
                  );

                  const overlapEnd = Math.min(
                    firstWindow.endMinute,
                    secondWindow.endMinute,
                  );

                  if (
                    overlapEnd - overlapStart >=
                    requiredMinutes
                  ) {
                    return true;
                  }
                }
              }
            }
          }

          return false;
        });

      return {
        weekday,
        name,
        cleaners: workingStaff.length,

        earliest: allWindows.length
          ? minutesToTime(
              Math.min(
                ...allWindows.map(
                  (window) => window.startMinute,
                ),
              ),
            )
          : null,

        latest: allWindows.length
          ? minutesToTime(
              Math.max(
                ...allWindows.map(
                  (window) => window.endMinute,
                ),
              ),
            )
          : null,

        canStaffTwoPersonJobs,
      };
    });
  }

  private assertKnownSkills(skills: string[]): void {
    for (const id of skills) {
      if (!SERVICES.some((s) => s.id === id)) {
        throw new RosterError(`Unknown service "${id}".`, 'UNKNOWN_SERVICE');
      }
    }
  }
}

