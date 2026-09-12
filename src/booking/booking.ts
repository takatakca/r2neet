import type { ServiceOption } from '../domain/types.js';
import {
  verifySlotStillOpen,
  type StaffBusy,
  type StaffMember,
  type BufferPolicy,
  DEFAULT_BUFFERS,
} from '../scheduling/availability.js';

/**
 * Slot holds and booking creation.
 *
 * The rule this file exists to enforce: a customer never sees "You're booked"
 * unless a row exists, capacity is reserved, and the price came from a live
 * server quote. The old prototype generated a booking number in the browser.
 * That number meant nothing.
 */

export class BookingError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export const HOLD_TTL_MINUTES = 10;

export interface BookingHold {
  id: string;
  serviceOptionId: string;
  startUtc: Date;
  endUtc: Date;
  staffIds: string[];
  customerId: string;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}

export type BookingStatus =
  | 'DRAFT'
  | 'HELD'
  | 'PENDING_PAYMENT'
  | 'PAYMENT_ACTION_REQUIRED'
  | 'CONFIRMED'
  | 'ASSIGNED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'NO_SHOW';

export interface Booking {
  id: string;
  bookingNumber: string;
  customerId: string;
  serviceOptionId: string;
  addressId: string;
  startUtc: Date;
  endUtc: Date;
  staffIds: string[];
  status: BookingStatus;
  quoteId: string;
  /** Frozen copy of the quote. Never recomputed from today's price table. */
  priceSnapshot: unknown;
  grandTotalCents: number;
  createdAt: Date;
}

/* ------------------------------------------------------------------ */
/* repository boundary                                                 */
/* ------------------------------------------------------------------ */

export interface SchedulingRepository {
  /**
   * Run `fn` with the staff rows for this window locked against concurrent
   * writers. The Postgres implementation uses SELECT ... FOR UPDATE; the
   * in-memory one serializes. Without this, two customers can buy the same
   * last crew.
   */
  withCapacityLock<T>(window: { startUtc: Date; endUtc: Date }, fn: () => Promise<T>): Promise<T>;
  listStaff(): Promise<StaffMember[]>;
  listBusy(window: { startUtc: Date; endUtc: Date }): Promise<StaffBusy[]>;
  insertHold(hold: BookingHold): Promise<void>;
  getHold(id: string): Promise<BookingHold | null>;
  markHoldConsumed(id: string, at: Date): Promise<void>;
  insertBooking(booking: Booking): Promise<void>;
  nextBookingSequence(year: number): Promise<number>;
}

/** Minimum contract the quote must satisfy before it can be charged. */
export interface QuoteRecord {
  id: string;
  serviceOptionId: string;
  grandTotalCents: number;
  expiresAt: Date;
  customerId: string | null;
  snapshot: unknown;
}

export interface QuoteRepository {
  get(id: string): Promise<QuoteRecord | null>;
}

/* ------------------------------------------------------------------ */
/* booking numbers                                                     */
/* ------------------------------------------------------------------ */

/**
 * R2N-YYYY-NNNNNN, allocated by the database, never by the browser.
 * Sequential per year so operations can reason about volume, and it is not
 * a database primary key, so it is safe to print and read aloud.
 */
export function formatBookingNumber(year: number, sequence: number): string {
  return `R2N-${year}-${String(sequence).padStart(6, '0')}`;
}

/* ------------------------------------------------------------------ */
/* service                                                             */
/* ------------------------------------------------------------------ */

export class BookingService {
  constructor(
    private readonly repo: SchedulingRepository,
    private readonly quotes: QuoteRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = () => crypto.randomUUID(),
    private readonly buffers: BufferPolicy = DEFAULT_BUFFERS,
  ) {}

  /**
   * Reserve capacity while the customer completes checkout.
   *
   * The hold is created inside the capacity lock after a fresh availability
   * check, so two simultaneous requests for the last crew cannot both win.
   */
  async holdSlot(params: {
    service: ServiceOption;
    startUtc: Date;
    customerId: string;
  }): Promise<BookingHold> {
    const { service, startUtc, customerId } = params;

    if (service.appointmentDurationMinutes === null) {
      throw new BookingError(
        'This service is priced and scheduled after we quote it.',
        'QUOTE_REQUIRED',
      );
    }
    const endUtc = new Date(startUtc.getTime() + service.appointmentDurationMinutes * 60000);
    const window = { startUtc, endUtc };

    return this.repo.withCapacityLock(window, async () => {
      const now = this.now();
      const staff = await this.repo.listStaff();
      const busy = await this.repo.listBusy(window);

      const check = verifySlotStillOpen(service, startUtc, staff, busy, now, this.buffers);
      if (!check.ok) {
        throw new BookingError(
          'That time was just taken. Pick another.',
          'SLOT_UNAVAILABLE',
        );
      }

      const hold: BookingHold = {
        id: this.newId(),
        serviceOptionId: service.id,
        startUtc,
        endUtc,
        staffIds: check.staffIds,
        customerId,
        createdAt: now,
        expiresAt: new Date(now.getTime() + HOLD_TTL_MINUTES * 60000),
        consumedAt: null,
      };
      await this.repo.insertHold(hold);
      return hold;
    });
  }

  /**
   * Turn a hold plus a live quote into a real booking.
   *
   * Five things must be true, and all five are checked server-side:
   * the hold exists, is unconsumed and unexpired; the quote exists, is
   * unexpired and matches the service; the customer owns both; capacity is
   * still genuinely free; and the total comes from the quote, never from
   * anything the browser sent.
   */
  async confirmBooking(params: {
    holdId: string;
    quoteId: string;
    customerId: string;
    addressId: string;
    service: ServiceOption;
    /** Present only so we can prove we ignore it. */
    clientClaimedTotalCents?: number;
  }): Promise<Booking> {
    const { holdId, quoteId, customerId, addressId, service } = params;
    const now = this.now();

    const hold = await this.repo.getHold(holdId);
    if (!hold) throw new BookingError('That reservation has gone.', 'HOLD_NOT_FOUND');
    if (hold.customerId !== customerId) {
      throw new BookingError('That reservation has gone.', 'HOLD_NOT_FOUND');
    }
    if (hold.consumedAt !== null) {
      throw new BookingError('That reservation was already used.', 'HOLD_CONSUMED');
    }
    if (hold.expiresAt <= now) {
      throw new BookingError('Your held time expired. Pick a time again.', 'HOLD_EXPIRED');
    }

    const quote = await this.quotes.get(quoteId);
    if (!quote) throw new BookingError('We could not find that price.', 'QUOTE_NOT_FOUND');
    if (quote.expiresAt <= now) {
      throw new BookingError('Your price expired. We will refresh it.', 'QUOTE_EXPIRED');
    }
    if (quote.serviceOptionId !== service.id || hold.serviceOptionId !== service.id) {
      throw new BookingError('That price does not match the service.', 'QUOTE_SERVICE_MISMATCH');
    }
    if (quote.customerId !== null && quote.customerId !== customerId) {
      throw new BookingError('We could not find that price.', 'QUOTE_NOT_FOUND');
    }

    return this.repo.withCapacityLock(
      { startUtc: hold.startUtc, endUtc: hold.endUtc },
      async () => {
        const staff = await this.repo.listStaff();
        const busy = await this.repo.listBusy({
          startUtc: hold.startUtc,
          endUtc: hold.endUtc,
        });

        // The hold itself is in `busy`; exclude it so it does not block its own confirmation.
        const others = busy.filter(
          (b) => !(b.kind === 'HOLD' && hold.staffIds.includes(b.staffId) && b.startUtc.getTime() === hold.startUtc.getTime()),
        );
        const check = verifySlotStillOpen(service, hold.startUtc, staff, others, now, this.buffers);
        if (!check.ok) {
          throw new BookingError('That time is no longer free.', 'SLOT_UNAVAILABLE');
        }

        const year = now.getUTCFullYear();
        const seq = await this.repo.nextBookingSequence(year);

        const booking: Booking = {
          id: this.newId(),
          bookingNumber: formatBookingNumber(year, seq),
          customerId,
          serviceOptionId: service.id,
          addressId,
          startUtc: hold.startUtc,
          endUtc: hold.endUtc,
          staffIds: hold.staffIds,
          status: 'CONFIRMED',
          quoteId: quote.id,
          priceSnapshot: quote.snapshot,
          // authoritative: from the quote row, never from the request body
          grandTotalCents: quote.grandTotalCents,
          createdAt: now,
        };

        await this.repo.insertBooking(booking);
        await this.repo.markHoldConsumed(hold.id, now);
        return booking;
      },
    );
  }
}
