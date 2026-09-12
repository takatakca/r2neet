import type {
  SchedulingRepository,
  QuoteRepository,
  QuoteRecord,
  BookingHold,
  Booking,
} from '../booking/booking.js';
import type { StaffBusy, StaffMember } from '../scheduling/availability.js';
import type { CustomerProfile, CustomerRepository } from '../identity/identity.js';

/**
 * In-memory implementations of the repository boundaries.
 *
 * These make the domain testable today and define exactly what the Prisma
 * implementations must provide. `withCapacityLock` here serializes through a
 * promise chain; in Postgres it becomes SELECT ... FOR UPDATE over the staff
 * rows in the window.
 */

export class MemorySchedulingRepo implements SchedulingRepository {
  staff: StaffMember[] = [];
  busy: StaffBusy[] = [];
  holds = new Map<string, BookingHold>();
  bookings: Booking[] = [];
  private sequences = new Map<number, number>();
  private chain: Promise<unknown> = Promise.resolve();

  async withCapacityLock<T>(_w: { startUtc: Date; endUtc: Date }, fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  async listStaff(): Promise<StaffMember[]> {
    return this.staff;
  }

  async listBusy(): Promise<StaffBusy[]> {
    return this.busy;
  }

  async insertHold(hold: BookingHold): Promise<void> {
    this.holds.set(hold.id, hold);
    // A live hold occupies capacity exactly like a booking until it expires.
    for (const staffId of hold.staffIds) {
      this.busy.push({
        staffId,
        startUtc: hold.startUtc,
        endUtc: hold.endUtc,
        kind: 'HOLD',
        expiresAtUtc: hold.expiresAt,
      });
    }
  }

  async getHold(id: string): Promise<BookingHold | null> {
    return this.holds.get(id) ?? null;
  }

  async markHoldConsumed(id: string, at: Date): Promise<void> {
    const h = this.holds.get(id);
    if (h) h.consumedAt = at;
  }

  async insertBooking(booking: Booking): Promise<void> {
    this.bookings.push(booking);
    for (const staffId of booking.staffIds) {
      this.busy.push({
        staffId,
        startUtc: booking.startUtc,
        endUtc: booking.endUtc,
        kind: 'BOOKING',
      });
    }
  }

  async nextBookingSequence(year: number): Promise<number> {
    const next = (this.sequences.get(year) ?? 0) + 1;
    this.sequences.set(year, next);
    return next;
  }
}

export class MemoryQuoteRepo implements QuoteRepository {
  quotes = new Map<string, QuoteRecord>();
  async get(id: string): Promise<QuoteRecord | null> {
    return this.quotes.get(id) ?? null;
  }
  put(q: QuoteRecord): void {
    this.quotes.set(q.id, q);
  }
}

export class MemoryCustomerRepo implements CustomerRepository {
  customers = new Map<string, CustomerProfile>();
  private seq = 0;

  async findByPhone(phoneE164: string): Promise<CustomerProfile | null> {
    for (const c of this.customers.values()) if (c.phoneE164 === phoneE164) return c;
    return null;
  }

  async create(phoneE164: string): Promise<CustomerProfile> {
    const c: CustomerProfile = {
      id: `cus_${++this.seq}`,
      phoneE164,
      firstName: null,
      email: null,
      preferredStaffId: null,
      lastServiceOptionId: null,
      lastProductSupply: null,
      lastFrequency: null,
      addresses: [],
    };
    this.customers.set(c.id, c);
    return c;
  }

  seed(c: CustomerProfile): void {
    this.customers.set(c.id, c);
  }
}

/* ------------------------------------------------------------------ */
/* integration status                                                  */
/* ------------------------------------------------------------------ */

export type IntegrationStatus = 'CONNECTED' | 'NOT_CONFIGURED' | 'ERROR';

export interface IntegrationDescriptor {
  key: string;
  label: string;
  /** Every one of these must be present before we claim CONNECTED. */
  requiredEnv: string[];
  /** What stops working while this is unconfigured. */
  blocks: string;
}

export const INTEGRATIONS: IntegrationDescriptor[] = [
  {
    key: 'stripe',
    label: 'Stripe payments',
    requiredEnv: ['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY', 'STRIPE_WEBHOOK_SECRET'],
    blocks: 'Card payment, Apple Pay, Google Pay, Link, saved cards, recurring charges',
  },
  {
    key: 'twilio_verify',
    label: 'Twilio Verify (SMS codes)',
    requiredEnv: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_VERIFY_SERVICE_SID'],
    blocks: 'Phone verification and returning-customer recognition',
  },
  {
    key: 'twilio_voice',
    label: 'Twilio Voice (callbacks)',
    requiredEnv: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_VOICE_NUMBER'],
    blocks: 'Automatic callback dialling. Requests are still queued for staff.',
  },
  {
    key: 'google_maps',
    label: 'Google Places & Routes',
    requiredEnv: ['GOOGLE_MAPS_API_KEY'],
    blocks: 'Address autocomplete and authoritative travel distance',
  },
  {
    key: 'google_reviews',
    label: 'Google Business Profile reviews',
    requiredEnv: [
      'GOOGLE_BUSINESS_CLIENT_ID',
      'GOOGLE_BUSINESS_CLIENT_SECRET',
      'GOOGLE_BUSINESS_REFRESH_TOKEN',
      'GOOGLE_BUSINESS_LOCATION_ID',
    ],
    blocks: 'Live review sync and the real rating average',
  },
  {
    key: 'ai',
    label: 'AI concierge provider',
    requiredEnv: ['AI_PROVIDER_API_KEY'],
    blocks: 'Free-text concierge. Guided buttons keep working without it.',
  },
];

export interface IntegrationState {
  key: string;
  label: string;
  status: IntegrationStatus;
  missingEnv: string[];
  blocks: string;
}

/**
 * Report integration status from the environment only.
 *
 * There is deliberately no way to mark something CONNECTED by hand. A green
 * light here always means the credentials are actually present.
 */
export function integrationStatus(
  env: Record<string, string | undefined> = process.env,
): IntegrationState[] {
  return INTEGRATIONS.map((i) => {
    const missing = i.requiredEnv.filter((k) => !env[k] || env[k]!.trim() === '');
    return {
      key: i.key,
      label: i.label,
      status: missing.length === 0 ? 'CONNECTED' : 'NOT_CONFIGURED',
      missingEnv: missing,
      blocks: i.blocks,
    };
  });
}
