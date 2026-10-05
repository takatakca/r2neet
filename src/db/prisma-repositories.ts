import { AsyncLocalStorage } from 'node:async_hooks';
import { PrismaClient, Prisma } from '@prisma/client';
import type {
  SchedulingRepository,
  QuoteRepository,
  QuoteRecord,
  BookingHold,
  Booking,
} from '../booking/booking.js';
import { localDateKey, type StaffBusy, type StaffMember } from '../scheduling/availability.js';
import type { CustomerProfile, CustomerRepository } from '../identity/identity.js';

/**
 * Prisma-backed repositories.
 *
 * CONCURRENCY STRATEGY — the important part of this file.
 *
 * An in-process mutex is worthless the moment R2NETTE runs two Node
 * processes, two containers, or serverless invocations. So capacity
 * serialization uses PostgreSQL *transaction-level advisory locks*
 * (`pg_advisory_xact_lock`), one per local service day.
 *
 * Properties that matter:
 *   - the lock lives in the database, so every process contends for the
 *     same lock regardless of where it runs;
 *   - it is transaction-scoped, so it is released automatically on COMMIT
 *     or ROLLBACK, including if the process crashes mid-transaction;
 *   - any two windows that could compete for the same cleaner — identical,
 *     overlapping, or merely within travel-buffer distance — share a key,
 *     because they share a service day. Keying by the exact window did not
 *     do this: 10:00–13:00 and 11:00–14:00 took different locks and both
 *     claimed the last crew;
 *   - bookings on unrelated days still never block each other.
 *
 * Every writer that consumes capacity (holds, confirmations, reschedules,
 * recurring generation) must take these locks via `withCapacityLock` or
 * `acquireCapacityLocks`. A writer that derives its own key is not
 * serialized against anyone.
 *
 * Booking numbers use `UPDATE ... RETURNING` on a per-year counter row,
 * which is atomic under Postgres. `SELECT MAX(n)+1` would race.
 */

/**
 * How far either side of a window another job can still compete for the
 * same cleaner. Must be at least the largest travel buffer; `listBusy`
 * widens its read by the same amount.
 */
const CAPACITY_PAD_MS = 4 * 60 * 60000;

/** FNV-1a 64-bit, as the signed bigint advisory locks take. */
function lockHash(s: string): bigint {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = (1n << 64n) - 1n;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash ^ BigInt(s.charCodeAt(i))) * prime) & mask;
  }
  return BigInt.asIntN(64, hash);
}

/**
 * Stable 64-bit advisory-lock key of the local service day a window starts
 * on. Every window that starts that day shares it; other days do not.
 * `withCapacityLock` also takes the neighbouring day's key when the
 * window's buffers reach across midnight — see `capacityLockKeys`.
 */
export function capacityLockKey(startUtc: Date, _endUtc?: Date): bigint {
  return lockHash(`capacity-day:${localDateKey(startUtc)}`);
}

/**
 * Every advisory-lock key a capacity decision about this window must hold:
 * one per local service day touched by the window widened by
 * CAPACITY_PAD_MS. Sorted ascending so all callers acquire in the same
 * order and two transactions cannot deadlock on them.
 */
export function capacityLockKeys(window: { startUtc: Date; endUtc: Date }): bigint[] {
  const from = window.startUtc.getTime() - CAPACITY_PAD_MS;
  const to = window.endUtc.getTime() + CAPACITY_PAD_MS;
  const keys = new Set<bigint>();
  // Hourly steps cannot skip a local day, even a 23-hour DST day.
  for (let t = from; t < to; t += 3600000) keys.add(capacityLockKey(new Date(t)));
  keys.add(capacityLockKey(new Date(to)));
  return [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

type Tx = Prisma.TransactionClient;

/** Take every capacity lock for `window` inside an open transaction. */
export async function acquireCapacityLocks(
  tx: Tx,
  window: { startUtc: Date; endUtc: Date },
): Promise<void> {
  for (const key of capacityLockKeys(window)) {
    // pg_advisory_xact_lock() returns void, which Prisma cannot
    // deserialize; cast to a concrete type so the driver is happy.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${key}::bigint)::text AS locked`;
  }
}

/**
 * Everything consuming capacity in this window, read through `db` (the
 * client or an open transaction).
 *
 * ACTIVE holds are returned with their `expiresAtUtc`; whether one is
 * still alive is decided by the caller's clock (`busyIsLive` in
 * availability), the same clock that stamped its expiry. Filtering here on
 * this process's wall clock judged expiry against a second clock: with an
 * injected clock behind the wall clock, every hold looked expired and
 * nothing blocked capacity. A lapsed hold still stops blocking without the
 * cleanup job, and its row is never deleted.
 */
export async function loadBusy(
  db: PrismaClient | Tx,
  window: { startUtc: Date; endUtc: Date },
): Promise<StaffBusy[]> {
  const pad = CAPACITY_PAD_MS; // widen for buffer arithmetic at the edges
  const from = new Date(window.startUtc.getTime() - pad);
  const to = new Date(window.endUtc.getTime() + pad);

  const [bookings, holds, timeOff] = await Promise.all([
    db.booking.findMany({
      where: {
        status: { notIn: ['CANCELLED', 'NO_SHOW'] },
        startAt: { lt: to },
        endAt: { gt: from },
      },
      include: { staff: true },
    }),
    db.bookingHold.findMany({
      where: {
        status: 'ACTIVE',
        startAt: { lt: to },
        endAt: { gt: from },
      },
    }),
    db.staffTimeOff.findMany({
      where: { startAt: { lt: to }, endAt: { gt: from } },
    }),
  ]);

  const busy: StaffBusy[] = [];
  for (const b of bookings) {
    for (const a of b.staff) {
      busy.push({ staffId: a.staffId, startUtc: b.startAt, endUtc: b.endAt, kind: 'BOOKING' });
    }
  }
  for (const h of holds) {
    for (const staffId of h.staffIds) {
      busy.push({
        staffId,
        startUtc: h.startAt,
        endUtc: h.endAt,
        kind: 'HOLD',
        expiresAtUtc: h.expiresAt,
      });
    }
  }
  for (const t of timeOff) {
    busy.push({ staffId: t.staffId, startUtc: t.startAt, endUtc: t.endAt, kind: 'TIME_OFF' });
  }
  return busy;
}

export class PrismaSchedulingRepo implements SchedulingRepository {
  /**
   * The transaction of the withCapacityLock call this async context is
   * inside, if any. One repo instance serves every concurrent request, so
   * this must be per-call, not an instance field: a shared field let one
   * request's queries run in another request's transaction and, once both
   * finished, left the repo pointing at a closed transaction (P2028 on every
   * later query until the process restarted).
   */
  private readonly scope = new AsyncLocalStorage<Tx>();

  constructor(private readonly prisma: PrismaClient) {}

  private get db(): PrismaClient | Tx {
    return this.scope.getStore() ?? this.prisma;
  }

  /**
   * Serialize everyone competing for this appointment window, across
   * processes, for the life of the transaction. A nested call joins the
   * enclosing transaction and takes any additional keys there.
   */
  async withCapacityLock<T>(
    window: { startUtc: Date; endUtc: Date },
    fn: () => Promise<T>,
  ): Promise<T> {
    const outer = this.scope.getStore();
    if (outer) {
      await acquireCapacityLocks(outer, window);
      return fn();
    }
    return this.prisma.$transaction(
      async (tx) => {
        await acquireCapacityLocks(tx, window);
        return this.scope.run(tx, fn);
      },
      { timeout: 20000 },
    );
  }

  async listStaff(): Promise<StaffMember[]> {
    const rows = await this.db.staff.findMany({
      where: { active: true },
      include: { skills: true, availability: true },
    });
    return rows.map((s) => ({
      id: s.id,
      displayName: s.displayName,
      active: s.active,
      skills: s.skills.map((k) => k.serviceOptionId),
      weeklyAvailability: s.availability.map((a) => ({
        weekday: a.weekday,
        startMinute: a.startMinute,
        endMinute: a.endMinute,
      })),
    }));
  }

  /** Everything consuming capacity in this window. See `loadBusy`. */
  async listBusy(window: { startUtc: Date; endUtc: Date }): Promise<StaffBusy[]> {
    return loadBusy(this.db, window);
  }

  async insertHold(hold: BookingHold): Promise<void> {
    await this.db.bookingHold.create({
      data: {
        id: hold.id,
        customerId: hold.customerId,
        serviceOptionId: hold.serviceOptionId,
        startAt: hold.startUtc,
        endAt: hold.endUtc,
        requiredStaffCount: hold.staffIds.length,
        staffIds: hold.staffIds,
        status: 'ACTIVE',
        createdAt: hold.createdAt,
        expiresAt: hold.expiresAt,
      },
    });
  }

  async getHold(id: string): Promise<BookingHold | null> {
    const h = await this.db.bookingHold.findUnique({ where: { id } });
    if (!h) return null;
    return {
      id: h.id,
      serviceOptionId: h.serviceOptionId,
      startUtc: h.startAt,
      endUtc: h.endAt,
      staffIds: h.staffIds,
      customerId: h.customerId,
      createdAt: h.createdAt,
      expiresAt: h.expiresAt,
      consumedAt: h.consumedAt,
    };
  }

  async markHoldConsumed(id: string, at: Date): Promise<void> {
    await this.db.bookingHold.update({
      where: { id },
      data: { status: 'CONSUMED', consumedAt: at },
    });
  }

  async insertBooking(booking: Booking): Promise<void> {
    await this.db.booking.create({
      data: {
        id: booking.id,
        bookingNumber: booking.bookingNumber,
        customerId: booking.customerId,
        serviceOptionId: booking.serviceOptionId,
        addressId: booking.addressId,
        quoteId: booking.quoteId,
        startAt: booking.startUtc,
        endAt: booking.endUtc,
        status: booking.status,
        grandTotalCents: booking.grandTotalCents,
        priceSnapshot: booking.priceSnapshot as Prisma.InputJsonValue,
        createdAt: booking.createdAt,
        staff: {
          create: booking.staffIds.map((staffId) => ({ staffId })),
        },
        history: {
          create: [{ status: booking.status, actor: 'SYSTEM', reason: 'Booking confirmed' }],
        },
      },
    });
  }

  /**
   * Atomic per-year increment. UPSERT then UPDATE ... RETURNING; Postgres
   * serializes concurrent updates to the same row, so no two callers can
   * receive the same value.
   */
  async nextBookingSequence(year: number): Promise<number> {
    const db = this.db;
    await db.$executeRaw`
      INSERT INTO "BookingNumberSequence" ("year", "lastValue", "updatedAt")
      VALUES (${year}, 0, now())
      ON CONFLICT ("year") DO NOTHING
    `;
    const rows = await db.$queryRaw<{ lastValue: number }[]>`
      UPDATE "BookingNumberSequence"
      SET "lastValue" = "lastValue" + 1, "updatedAt" = now()
      WHERE "year" = ${year}
      RETURNING "lastValue"
    `;
    const value = rows[0]?.lastValue;
    if (value === undefined) throw new Error('booking sequence allocation failed');
    return value;
  }
}

export class PrismaQuoteRepo implements QuoteRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async get(id: string): Promise<QuoteRecord | null> {
    const q = await this.prisma.quote.findUnique({ where: { id } });
    if (!q) return null;
    return {
      id: q.id,
      serviceOptionId: q.serviceOptionId,
      grandTotalCents: q.grandTotalCents,
      expiresAt: q.expiresAt,
      customerId: q.customerId,
      snapshot: q.priceSnapshot,
    };
  }
}

export class PrismaCustomerRepo implements CustomerRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByPhone(phoneE164: string): Promise<CustomerProfile | null> {
    const phone = await this.prisma.customerPhone.findUnique({
      where: { phoneE164 },
      include: { customer: { include: { addresses: true } } },
    });
    if (!phone) return null;
    const c = phone.customer;
    return {
      id: c.id,
      phoneE164: phone.phoneE164,
      firstName: c.firstName,
      email: c.email,
      preferredStaffId: c.preferredStaffId,
      lastServiceOptionId: c.lastServiceOptionId,
      lastProductSupply: c.lastProductSupply,
      lastFrequency: c.lastFrequency,
      addresses: c.addresses.map((a) => ({
        id: a.id,
        customerId: a.customerId,
        label: a.label,
        formattedAddress: a.formattedAddress,
        placeId: a.placeId,
        city: a.city,
        province: a.province,
        postalCode: a.postalCode,
        latitude: a.latitude,
        longitude: a.longitude,
        isDefault: a.isDefault,
      })),
    };
  }

  /**
   * Create the customer and their phone together.
   *
   * `phoneE164` is UNIQUE, so two concurrent verifications of the same
   * number cannot both create a customer — the loser catches P2002 and
   * re-reads the winner's row.
   */
  async create(phoneE164: string): Promise<CustomerProfile> {
    try {
      const customer = await this.prisma.customer.create({
        data: { phones: { create: { phoneE164, verifiedAt: new Date(), isPrimary: true } } },
      });
      return {
        id: customer.id,
        phoneE164,
        firstName: null,
        email: null,
        preferredStaffId: null,
        lastServiceOptionId: null,
        lastProductSupply: null,
        lastFrequency: null,
        addresses: [],
      };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const existing = await this.findByPhone(phoneE164);
        if (existing) return existing;
      }
      throw e;
    }
  }
}
