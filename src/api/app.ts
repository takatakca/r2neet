import express, { type Request, type Response, type NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { randomUUID, createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';

import { createQuote } from '../engine/quote.js';
import { GUEST } from '../engine/discounts.js';
import { SERVICES } from '../data/catalogue.js';
import { CleaningFrequency, ProductSupplyType } from '../domain/types.js';
import { findAvailableSlots, localToUtc, verifySlotStillOpen } from '../scheduling/availability.js';
import { BookingService, BookingError } from '../booking/booking.js';
import {
  PrismaSchedulingRepo,
  PrismaQuoteRepo,
  PrismaCustomerRepo,
} from '../db/prisma-repositories.js';
import {
  IdentityService,
  IdentityError,
  RateLimiter,
  type VerificationProvider,
} from '../identity/identity.js';
import { integrationStatus } from '../data/repositories.js';
import {
  PrismaSessionStore,
  PrismaIdempotencyStore,
  IdempotencyConflict,
} from '../db/durable-stores.js';
import { PaymentService, PaymentError, amountDueNowCents } from '../payments/payment-service.js';
import { QuoteRevalidator, REPRICE_COPY } from '../payments/reprice.js';
import {
  securityHeaders,
  requireHttps,
  rateLimit,
  requestLogger,
  RateLimiter as EdgeRateLimiter,
  livenessHandler,
  readinessHandler,
  type LogSink,
} from './hardening.js';
import { ReviewService } from '../reviews/review-service.js';
import { RecurrenceService } from '../booking/recurrence-service.js';
import { CallbackService, type VoiceProvider } from '../callbacks/callback-service.js';
import { createOpsApi } from './ops.js';
import { AuthError } from '../auth/staff-auth.js';
import { RosterError } from '../staff/roster-service.js';
import { normalizePhone } from '../identity/identity.js';
import {
  SessionTokenManager,
  PlacesError,
  type PlacesProvider,
} from '../integrations/places.js';
import { StripeError, type StripeProvider } from '../payments/stripe-provider.js';

/**
 * R2NETTE HTTP API (v1).
 *
 * Two rules govern every route here:
 *
 *   1. Customer identity comes from the session cookie, never from the
 *      request body. A `customerId` in a payload is ignored.
 *   2. Money comes from the server. A `total` in a payload is ignored.
 *
 * Both are enforced by tests, not just by convention.
 */

export const SESSION_COOKIE = 'r2n_session';
const SESSION_TTL_MS = 60 * 60 * 1000;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface SessionRecord {
  customerId: string;
  verifiedAt: Date;
  expiresAt: Date;
}

/**
 * Opaque server-side sessions. The cookie carries a random id and nothing
 * else — no customer data ever rides in the browser.
 *
 * Backed by a Map here; the interface is what matters, and a `Session` table
 * or Redis slots in without touching route code. Documented as a
 * multi-instance requirement in docs/reservation-system/api.md.
 */
export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  create(customerId: string): { id: string; expiresAt: Date } {
    const id = randomUUID();
    const at = this.now();
    const expiresAt = new Date(at.getTime() + SESSION_TTL_MS);
    this.sessions.set(id, { customerId, verifiedAt: at, expiresAt });
    return { id, expiresAt };
  }

  get(id: string | undefined): SessionRecord | null {
    if (!id) return null;
    const s = this.sessions.get(id);
    if (!s) return null;
    if (s.expiresAt <= this.now()) {
      this.sessions.delete(id);
      return null;
    }
    return s;
  }

  destroy(id: string | undefined): void {
    if (id) this.sessions.delete(id);
  }
}

/* ------------------------------------------------------------------ */
/* idempotency                                                         */
/* ------------------------------------------------------------------ */

function fingerprint(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex');
}

/**
 * Durable idempotency, scoped to (customer, route, key).
 *
 * Same key + same payload returns the stored result. Same key + a materially
 * different payload is a 409 rather than a silent second command — a retry
 * that changed its mind is a bug, not a retry.
 */
export class IdempotencyStore {
  private readonly entries = new Map<
    string,
    { fingerprint: string; status: number; body: unknown }
  >();

  private key(customerId: string, route: string, key: string): string {
    return `${customerId}:${route}:${key}`;
  }

  lookup(
    customerId: string,
    route: string,
    key: string,
    body: unknown,
  ): { status: number; body: unknown } | null {
    const entry = this.entries.get(this.key(customerId, route, key));
    if (!entry) return null;
    if (entry.fingerprint !== fingerprint(body)) {
      throw new ApiError(
        409,
        'IDEMPOTENCY_CONFLICT',
        'This Idempotency-Key was already used with a different request.',
      );
    }
    return { status: entry.status, body: entry.body };
  }

  save(
    customerId: string,
    route: string,
    key: string,
    body: unknown,
    status: number,
    result: unknown,
  ): void {
    this.entries.set(this.key(customerId, route, key), {
      fingerprint: fingerprint(body),
      status,
      body: result,
    });
  }
}

/* ------------------------------------------------------------------ */
/* validation                                                          */
/* ------------------------------------------------------------------ */

const phoneSchema = z.object({ phone: z.string().min(1) });
const verifySchema = z.object({ phone: z.string().min(1), code: z.string().min(4).max(10) });

const quoteSchema = z.object({
  serviceOptionId: z.string(),
  frequency: z.string(),
  productSupplyOption: z.string().optional(),
  addOns: z.array(z.object({ id: z.string(), quantity: z.number().int().min(0) })).optional(),
  /** Server resolves distance from this. A distanceKm in the body is ignored. */
  addressId: z.string().optional(),
  distanceKm: z.number().min(0).max(500).optional(),
  // Deliberately permissive: clients may send these, and we ignore them.
  // Rejecting outright would break naive clients for no security benefit,
  // since the server never reads them.
}).passthrough();

const holdSchema = z.object({
  quoteId: z.string(),
  startAt: z.string(),
}).passthrough();

const bookingSchema = z.object({
  holdId: z.string(),
  quoteId: z.string(),
  addressId: z.string(),
}).passthrough();

/* ------------------------------------------------------------------ */
/* app                                                                 */
/* ------------------------------------------------------------------ */

export interface ApiDeps {
  prisma: PrismaClient;
  verification: VerificationProvider;
  stripe?: StripeProvider;
  stripeWebhookSecret?: string;
  places?: PlacesProvider;
  /** Production hardening. Off by default so tests stay fast and quiet. */
  hardening?: {
    enabled?: boolean;
    hsts?: boolean;
    requireHttps?: boolean;
    rateLimit?: boolean;
    log?: LogSink | null;
    isShuttingDown?: () => boolean;
  };
  /** R2NETTE dispatch origin. Never sent to the browser. */
  origin?: { latitude: number; longitude: number };
  now?: () => Date;
  /** Twilio Voice for the callback dialler. Unset = queue for a manual call. */
  voice?: VoiceProvider | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      customerId?: string;
      sessionId?: string;
    }
  }
}

export function createApi(deps: ApiDeps) {
  const { prisma, verification } = deps;
  const now = deps.now ?? (() => new Date());
  // Both stores are Postgres-backed: sessions and payment idempotency must
  // survive a restart and be shared across instances.
  const sessions = new PrismaSessionStore(prisma, now);
  const idempotency = new PrismaIdempotencyStore(prisma, now);

  const customers = new PrismaCustomerRepo(prisma);
  const identity = new IdentityService(verification, customers, new RateLimiter(), now);
  const scheduling = new PrismaSchedulingRepo(prisma);
  const quotes = new PrismaQuoteRepo(prisma);
  const bookings = new BookingService(scheduling, quotes, now, () => randomUUID());

  const paymentService = deps.stripe
    ? new PaymentService(prisma, deps.stripe, now)
    : null;
  const webhookSecret = deps.stripeWebhookSecret ?? process.env.STRIPE_WEBHOOK_SECRET;

  const app = express();
  const hard = deps.hardening ?? {};

  // Behind a proxy, x-forwarded-* is how we learn the real scheme and client.
  if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
  app.disable('x-powered-by');

  if (hard.enabled) {
    if (hard.log !== null) app.use(requestLogger(hard.log ?? undefined));
    app.use(securityHeaders({ hsts: hard.hsts }));
    app.use(requireHttps(hard.requireHttps ?? false));
    if (hard.rateLimit !== false) app.use(rateLimit(new EdgeRateLimiter()));
  }

  // Liveness must never touch the database: restarting the app because
  // Postgres blipped turns a blip into an outage.
  app.get('/healthz', livenessHandler());
  app.get(
    '/readyz',
    readinessHandler(
      { ping: async () => void (await prisma.$queryRaw`SELECT 1`) },
      hard.isShuttingDown ?? (() => false),
    ),
  );

  // The webhook needs the RAW body: signature verification is over exact
  // bytes, and JSON round-tripping would change them.
  app.use('/api/v1/stripe/webhook', express.raw({ type: '*/*' }));
  app.use(express.json());
  app.use(cookieParser());

  app.use((req, _res, next) => {
    req.requestId = randomUUID();
    const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
    sessions
      .get(token)
      .then((session) => {
        if (session) {
          req.customerId = session.customerId;
          req.sessionId = token;
        }
        next();
      })
      .catch(next);
  });

  /** Identity is server-derived. Any customerId in the body is ignored. */
  function requireCustomer(req: Request): string {
    if (!req.customerId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Verify your phone number to continue.');
    }
    return req.customerId;
  }

  const wrap =
    (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) => {
      fn(req, res).catch(next);
    };

  /* ---------------- auth ---------------- */

  app.post(
    '/api/v1/auth/phone/send',
    wrap(async (req, res) => {
      const { phone } = phoneSchema.parse(req.body);
      const ip = req.ip ?? 'unknown';
      const out = await identity.startVerification(phone, ip);
      // Identical shape whether or not this number is known to us.
      res.json({ sent: true, message: out.message, maskedPhone: out.masked });
    }),
  );

  app.post(
    '/api/v1/auth/phone/verify',
    wrap(async (req, res) => {
      const { phone, code } = verifySchema.parse(req.body);
      const session = await identity.completeVerification(phone, code);
      const created = await sessions.create(session.customerId, {
        userAgent: req.header('user-agent') ?? undefined,
        ip: req.ip ?? undefined,
      });
      res.cookie(SESSION_COOKIE, created.token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        expires: created.expiresAt,
      });
      const profile = await customers.findByPhone(session.phoneE164);
      res.json({
        customer: {
          id: session.customerId,
          firstName: profile?.firstName ?? null,
          email: profile?.email ?? null,
          isReturningCustomer: !session.isNewCustomer,
        },
      });
    }),
  );

  app.post(
    '/api/v1/auth/logout',
    wrap(async (req, res) => {
      await sessions.destroy(req.sessionId);
      res.clearCookie(SESSION_COOKIE, { path: '/' });
      res.json({ ok: true });
    }),
  );

  /* ---------------- customer ---------------- */

  app.get(
    '/api/v1/customer/me',
    wrap(async (req, res) => {
      const customerId = requireCustomer(req);
      const c = await prisma.customer.findUniqueOrThrow({
        where: { id: customerId },
        include: { phones: true },
      });
      res.json({
        customer: {
          id: c.id,
          firstName: c.firstName,
          lastName: c.lastName,
          email: c.email,
          verifiedPhone: c.phones[0]?.phoneE164 ?? null,
          isReturningCustomer: c.lastServiceOptionId !== null,
        },
      });
    }),
  );

  app.get(
    '/api/v1/customer/addresses',
    wrap(async (req, res) => {
      const customerId = requireCustomer(req);
      // Scoped by session customer — there is no path to another customer's rows.
      const rows = await prisma.customerAddress.findMany({ where: { customerId } });
      res.json({ addresses: rows });
    }),
  );

  /**
   * Returning-customer context: profile, saved places, and a REUSABLE
   * BOOKING TEMPLATE.
   *
   * The template is an explicit allowlist, not a dump of the last booking.
   * Deliberately excluded: entry instructions, door codes, buzzer numbers,
   * internal/staff notes, previous hold and payment state, assigned staff,
   * and prior price snapshots. Those are either stale, private to that
   * visit, or staff-only — a door code from six months ago should not be
   * silently reused, and pricing must always come from a fresh quote.
   *
   * Session-owned: identity comes from the cookie, so there is no path by
   * which one customer requests another's previous setup.
   */
  app.get(
    '/api/v1/customer/context',
    wrap(async (req, res) => {
      const customerId = requireCustomer(req);

      const c = await prisma.customer.findUniqueOrThrow({
        where: { id: customerId },
        include: { phones: true, addresses: { orderBy: { isDefault: 'desc' } } },
      });

      const lastBooking = await prisma.booking.findFirst({
        where: { customerId, status: { notIn: ['CANCELLED', 'NO_SHOW'] } },
        orderBy: { createdAt: 'desc' },
        include: { service: true, address: true, quote: true },
      });

      // Only offer to reuse an address the customer still has saved.
      const addressStillSaved =
        lastBooking && c.addresses.some((a) => a.id === lastBooking.addressId);

      const bookingTemplate =
        lastBooking && lastBooking.service.active && lastBooking.service.publiclyBookable
          ? {
              serviceOptionId: lastBooking.serviceOptionId,
              serviceName: lastBooking.service.nameEn,
              serviceNameFr: lastBooking.service.nameFr,
              requiredStaffCount: lastBooking.service.requiredStaffCount,
              appointmentDurationMinutes: lastBooking.service.appointmentDurationMinutes,
              productSupplyMode: lastBooking.service.productSupplyMode,
              allowedFrequencies: lastBooking.service.allowedFrequencies,
              frequency: lastBooking.quote.frequency,
              addressId: addressStillSaved ? lastBooking.addressId : null,
              addressSummary: addressStillSaved ? lastBooking.address.formattedAddress : null,
              lastBookedAt: lastBooking.createdAt,
            }
          : null;

      res.json({
        customer: {
          id: c.id,
          firstName: c.firstName,
          lastName: c.lastName,
          email: c.email,
          verifiedPhone: c.phones[0]?.phoneE164 ?? null,
          isReturningCustomer: lastBooking !== null,
        },
        addresses: c.addresses.map((a) => ({
          id: a.id,
          label: a.label,
          formattedAddress: a.formattedAddress,
          city: a.city,
          postalCode: a.postalCode,
          unit: a.unit,
          isDefault: a.isDefault,
        })),
        bookingTemplate,
        // legacy alias for the current UI
        usualClean: bookingTemplate,
      });
    }),
  );

  app.get(
    '/api/v1/customer/bookings',
    wrap(async (req, res) => {
      const customerId = requireCustomer(req);
      const rows = await prisma.booking.findMany({
        where: { customerId },
        orderBy: { startAt: 'desc' },
        include: { staff: true },
      });
      res.json({ bookings: rows.map(publicBooking) });
    }),
  );

  /**
   * Everything the account area needs: upcoming and past bookings, saved
   * places, recurring plans, and saved payment methods. All session-scoped,
   * so there is no path to another customer's record.
   */
  app.get(
    '/api/v1/account/overview',
    wrap(async (req, res) => {
      const customerId = requireCustomer(req);
      const at = now();

      const [customer, bookings, addresses, series, methods] = await Promise.all([
        prisma.customer.findUniqueOrThrow({
          where: { id: customerId },
          include: { phones: true },
        }),
        prisma.booking.findMany({
          where: { customerId },
          orderBy: { startAt: 'desc' },
          take: 40,
          include: { service: true, address: true, payments: true, staff: true },
        }),
        prisma.customerAddress.findMany({
          where: { customerId },
          orderBy: { isDefault: 'desc' },
        }),
        prisma.recurrenceSeries.findMany({
          where: { customerId, status: { in: ['ACTIVE', 'PAUSED'] } },
          include: { service: true, address: true },
        }),
        prisma.paymentMethodReference.findMany({ where: { customerId } }),
      ]);

      const CANCELLABLE = ['CONFIRMED', 'ASSIGNED', 'PENDING_PAYMENT'];
      const shape = (b: (typeof bookings)[number]) => {
        const hoursAway = (b.startAt.getTime() - at.getTime()) / 3600000;
        const paid = b.payments.some((p) => p.status === 'SUCCEEDED');
        return {
          id: b.id,
          bookingNumber: b.bookingNumber,
          startAt: b.startAt.toISOString(),
          endAt: b.endAt.toISOString(),
          status: b.status,
          serviceName: b.service.nameEn,
          serviceNameFr: b.service.nameFr,
          serviceOptionId: b.serviceOptionId,
          requiredStaffCount: b.service.requiredStaffCount,
          crewAssigned: b.staff.length,
          addressSummary: b.address.formattedAddress,
          grandTotalCents: b.grandTotalCents,
          paymentStatus: paid ? 'PAID' : 'NOT_COLLECTED',
          // The 24-hour policy is enforced server-side; the flag only tells
          // the UI whether to offer the action at all.
          canCancel: CANCELLABLE.includes(b.status) && hoursAway >= 24,
          canReschedule: CANCELLABLE.includes(b.status) && hoursAway >= 24,
          withinCutoff: hoursAway < 24 && hoursAway > 0,
        };
      };

      res.json({
        customer: {
          id: customer.id,
          firstName: customer.firstName,
          lastName: customer.lastName,
          email: customer.email,
          verifiedPhone: customer.phones[0]?.phoneE164 ?? null,
        },
        upcoming: bookings.filter((b) => b.startAt >= at && b.status !== 'CANCELLED').reverse().map(shape),
        past: bookings.filter((b) => b.startAt < at || b.status === 'CANCELLED').map(shape),
        addresses: addresses.map((a) => ({
          id: a.id,
          label: a.label,
          formattedAddress: a.formattedAddress,
          unit: a.unit,
          isDefault: a.isDefault,
        })),
        plans: series.map((p) => ({
          id: p.id,
          frequency: p.frequency,
          serviceName: p.service.nameEn,
          addressSummary: p.address.formattedAddress,
          status: p.status,
          startAt: p.startAt.toISOString(),
          canPause: p.status === 'ACTIVE',
          canResume: p.status === 'PAUSED',
        })),
        // Display crumbs only — never a PAN.
        paymentMethods: methods.map((m) => ({
          id: m.id,
          brand: m.brand,
          last4: m.last4,
          expMonth: m.expMonth,
          expYear: m.expYear,
          isDefault: m.isDefault,
        })),
      });
    }),
  );

  /** Cancel. The 24-hour policy is enforced here, not in the browser. */
  app.post(
    '/api/v1/account/bookings/:id/cancel',
    wrap(async (req, res) => {
      const customerId = requireCustomer(req);
      const booking = await prisma.booking.findUnique({ where: { id: String(req.params.id) } });
      if (!booking || booking.customerId !== customerId) {
        throw new ApiError(404, 'BOOKING_NOT_FOUND', 'We could not find that booking.');
      }
      if (booking.status === 'CANCELLED') {
        res.json({ status: 'CANCELLED', alreadyCancelled: true });
        return;
      }
      const hoursAway = (booking.startAt.getTime() - now().getTime()) / 3600000;
      if (hoursAway < 24) {
        throw new ApiError(
          409,
          'CANCELLATION_WINDOW_CLOSED',
          'Cleanings can be changed up to 24 hours before. Please call us.',
        );
      }
      await prisma.$transaction(async (tx) => {
        await tx.booking.update({
          where: { id: booking.id },
          data: { status: 'CANCELLED' },
        });
        await tx.bookingStatusHistory.create({
          data: {
            bookingId: booking.id,
            status: 'CANCELLED',
            actor: `CUSTOMER:${customerId}`,
            reason: (req.body as { reason?: string })?.reason ?? null,
          },
        });
        // A cancelled booking must give the welcome offer back.
        const claim = await tx.promotionClaim.findFirst({
          where: { bookingId: booking.id, status: { in: ['RESERVED', 'REDEEMED'] } },
        });
        if (claim) {
          await tx.promotionClaim.update({
            where: { id: claim.id },
            data: { status: 'RELEASED', releasedAt: now(), releaseReason: 'BOOKING_CANCELLED' },
          });
        }
      });
      res.json({ status: 'CANCELLED' });
    }),
  );

  /**
   * Reschedule. Re-runs the same capacity check as a new booking, so a
   * customer can never move onto a slot we cannot staff.
   */
  app.post(
    '/api/v1/account/bookings/:id/reschedule',
    wrap(async (req, res) => {
      const customerId = requireCustomer(req);
      const { startAt } = req.body as { startAt?: string };
      if (!startAt) throw new ApiError(400, 'VALIDATION_ERROR', 'A new time is required.');

      const booking = await prisma.booking.findUnique({
        where: { id: String(req.params.id) },
        include: { staff: true },
      });
      if (!booking || booking.customerId !== customerId) {
        throw new ApiError(404, 'BOOKING_NOT_FOUND', 'We could not find that booking.');
      }
      const hoursAway = (booking.startAt.getTime() - now().getTime()) / 3600000;
      if (hoursAway < 24) {
        throw new ApiError(
          409,
          'CANCELLATION_WINDOW_CLOSED',
          'Cleanings can be changed up to 24 hours before. Please call us.',
        );
      }
      const service = SERVICES.find((s) => s.id === booking.serviceOptionId);
      if (!service || service.appointmentDurationMinutes === null) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'That service cannot be rescheduled online.');
      }

      const newStart = new Date(startAt);
      const newEnd = new Date(newStart.getTime() + service.appointmentDurationMinutes * 60000);

      await scheduling.withCapacityLock({ startUtc: newStart, endUtc: newEnd }, async () => {
        const staff = await scheduling.listStaff();
        const busy = (await scheduling.listBusy({ startUtc: newStart, endUtc: newEnd }))
          // The booking's own current assignment must not block its move.
          .filter((b) => !(b.kind === 'BOOKING' && booking.staff.some((a) => a.staffId === b.staffId)
            && b.startUtc.getTime() === booking.startAt.getTime()));

        const check = verifySlotStillOpen(service, newStart, staff, busy, now());
        if (!check.ok) {
          throw new ApiError(409, 'SLOT_UNAVAILABLE', 'That time is no longer free.');
        }

        await prisma.$transaction(async (tx) => {
          await tx.booking.update({
            where: { id: booking.id },
            data: { startAt: newStart, endAt: newEnd, status: 'CONFIRMED' },
          });
          await tx.bookingStaff.deleteMany({ where: { bookingId: booking.id } });
          await tx.bookingStaff.createMany({
            data: check.staffIds.map((staffId) => ({ bookingId: booking.id, staffId })),
          });
          await tx.bookingStatusHistory.create({
            data: {
              bookingId: booking.id,
              status: 'RESCHEDULED',
              actor: `CUSTOMER:${customerId}`,
              reason: `Moved to ${newStart.toISOString()}`,
            },
          });
        });
      });

      res.json({ rescheduled: true, startAt: newStart.toISOString(), endAt: newEnd.toISOString() });
    }),
  );

  /** Upcoming dates for a plan, so the customer can see their rhythm. */
  app.get(
    '/api/v1/account/plans/:id/upcoming',
    wrap(async (req, res) => {
      const customerId = requireCustomer(req);
      const series = await prisma.recurrenceSeries.findUnique({ where: { id: String(req.params.id) } });
      if (!series || series.customerId !== customerId) {
        throw new ApiError(404, 'NOT_FOUND', 'We could not find that plan.');
      }
      const dates = await new RecurrenceService(prisma, now).upcomingDates(String(req.params.id), 6);
      res.json({ upcoming: dates.map((x) => x.toISOString()) });
    }),
  );

  /** Pause, resume or cancel a recurring plan. */
  app.post(
    '/api/v1/account/plans/:id/status',
    wrap(async (req, res) => {
      const customerId = requireCustomer(req);
      const status = String((req.body as { status?: string }).status ?? '');
      if (!['ACTIVE', 'PAUSED', 'CANCELLED'].includes(status)) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown plan status.');
      }
      try {
        const updated = await new RecurrenceService(prisma, now).setStatus(
          String(req.params.id),
          status as 'ACTIVE' | 'PAUSED' | 'CANCELLED',
          customerId,
        );
        res.json({ status: updated.status });
      } catch {
        throw new ApiError(404, 'NOT_FOUND', 'We could not find that plan.');
      }
    }),
  );

  /** Skip a single visit without breaking the rhythm. */
  app.post(
    '/api/v1/account/plans/:id/skip',
    wrap(async (req, res) => {
      const customerId = requireCustomer(req);
      const dateKey = String((req.body as { date?: string }).date ?? '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'Use date=YYYY-MM-DD.');
      }
      try {
        res.json(
          await new RecurrenceService(prisma, now).skipOccurrence(
            String(req.params.id),
            dateKey,
            customerId,
          ),
        );
      } catch {
        throw new ApiError(404, 'NOT_FOUND', 'We could not find that plan.');
      }
    }),
  );

  app.post(
    '/api/v1/account/addresses/:id/default',
    wrap(async (req, res) => {
      const customerId = requireCustomer(req);
      const addr = await prisma.customerAddress.findUnique({ where: { id: String(req.params.id) } });
      if (!addr || addr.customerId !== customerId) {
        throw new ApiError(404, 'NOT_FOUND', 'We could not find that address.');
      }
      await prisma.$transaction([
        prisma.customerAddress.updateMany({ where: { customerId }, data: { isDefault: false } }),
        prisma.customerAddress.update({ where: { id: addr.id }, data: { isDefault: true } }),
      ]);
      res.json({ ok: true });
    }),
  );

  app.delete(
    '/api/v1/account/addresses/:id',
    wrap(async (req, res) => {
      const customerId = requireCustomer(req);
      const addr = await prisma.customerAddress.findUnique({ where: { id: String(req.params.id) } });
      if (!addr || addr.customerId !== customerId) {
        res.json({ ok: true }); // idempotent
        return;
      }
      const inUse = await prisma.booking.count({
        where: { addressId: addr.id, startAt: { gte: now() }, status: { notIn: ['CANCELLED'] } },
      });
      if (inUse > 0) {
        throw new ApiError(
          409,
          'ADDRESS_IN_USE',
          'This address has an upcoming cleaning. Cancel or move it first.',
        );
      }
      await prisma.customerAddress.delete({ where: { id: addr.id } });
      res.json({ ok: true });
    }),
  );

  app.patch(
    '/api/v1/account/profile',
    wrap(async (req, res) => {
      const customerId = requireCustomer(req);
      const body = req.body as { firstName?: string; lastName?: string; email?: string };
      if (body.email !== undefined && !/^\S+@\S+\.\S{2,}$/.test(body.email)) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'Enter a valid email address.');
      }
      const updated = await prisma.customer.update({
        where: { id: customerId },
        data: {
          firstName: body.firstName?.trim() || undefined,
          lastName: body.lastName?.trim() || undefined,
          email: body.email?.trim() || undefined,
        },
      });
      res.json({ firstName: updated.firstName, lastName: updated.lastName, email: updated.email });
    }),
  );

  /* ---------------- services ---------------- */

  app.get(
    '/api/v1/services',
    wrap(async (_req, res) => {
      // Internal migration-review notes are never exposed publicly.
      res.json({
        services: SERVICES.filter((s) => s.active && s.publiclyBookable).map((s) => ({
          id: s.id,
          slug: s.slug,
          categoryId: s.categoryId,
          name: s.name,
          pricingMode: s.pricingMode,
          durationMode: s.durationMode,
          basePriceCents: s.basePriceCents,
          appointmentDurationMinutes: s.appointmentDurationMinutes,
          requiredStaffCount: s.requiredStaffCount,
          labourMinutes: s.labourMinutes,
          allowedFrequencies: s.allowedFrequencies,
          productSupplyMode: s.productSupplyMode,
        })),
      });
    }),
  );

  /* ---------------- quotes ---------------- */

  app.post(
    '/api/v1/quotes',
    wrap(async (req, res) => {
      const input = quoteSchema.parse(req.body);
      const service = SERVICES.find((s) => s.id === input.serviceOptionId);
      if (!service) throw new ApiError(404, 'VALIDATION_ERROR', 'Unknown service.');

      // Authoritative distance: derived server-side from the saved address,
      // never from anything the browser sends. distanceKm in the payload is
      // only honoured when no address is supplied (legacy/dev path).
      let distanceKm = input.distanceKm ?? 0;
      if (input.addressId) {
        const addr = await prisma.customerAddress.findUnique({
          where: { id: input.addressId },
        });
        if (!addr || (req.customerId && addr.customerId !== req.customerId)) {
          throw new ApiError(404, 'VALIDATION_ERROR', 'Unknown address.');
        }
        if (deps.places && addr.placeId) {
          const route = await deps.places.computeRoute(origin, { placeId: addr.placeId });
          distanceKm = route.distanceKm;
        }
      }

      let quote;
      try {
        quote = createQuote({
          serviceOptionId: input.serviceOptionId,
          frequency: input.frequency as CleaningFrequency,
          productSupplyOption: input.productSupplyOption as ProductSupplyType | undefined,
          transport: { distanceKm },
          addOns: input.addOns,
          eligibility: GUEST,
        });
      } catch (e) {
        throw new ApiError(400, 'VALIDATION_ERROR', (e as Error).message);
      }

      const persisted = await prisma.quote.create({
        data: {
          customerId: req.customerId ?? null,
          serviceOptionId: input.serviceOptionId,
          frequency: input.frequency,
          baseServiceCents: quote.firstVisit?.baseServiceCents ?? 0,
          frequencyDiscountCents: 0,
          promotionDiscountCents: 0,
          subtotalCents: quote.subtotalBeforeTaxCents,
          gstCents: quote.taxLines[0]?.amountCents ?? 0,
          qstCents: quote.taxLines[1]?.amountCents ?? 0,
          taxTotalCents: quote.taxTotalCents,
          grandTotalCents: quote.grandTotalCents,
          gstRateMicroPercent: 5_000_000,
          qstRateMicroPercent: 9_975_000,
          pricingVersion: quote.pricingVersion ?? '1',
          warningCodes: quote.warningCodes ?? [],
          winningDiscountSource: quote.firstVisit?.appliedDiscount?.source ?? null,
          // Everything needed to rebuild this quote faithfully at
          // revalidation time — selections only, never money.
          requestSnapshot: {
            productSupplyOption: input.productSupplyOption ?? null,
            addressId: input.addressId ?? null,
            distanceKm,
            addOns: input.addOns ?? [],
          } as never,
          firstVisit: (quote.firstVisit ?? null) as never,
          subsequentVisitPreview: (quote.subsequentVisitPricingPreview ?? null) as never,
          priceSnapshot: JSON.parse(JSON.stringify(quote)),
          expiresAt: quote.expiresAt,
          lines: {
            create: quote.lines.map((l, i) => ({
              type: l.type,
              description: l.description,
              quantity: l.quantity ?? 1,
              unitAmountCents: l.unitAmountCents ?? l.subtotalCents,
              subtotalCents: l.subtotalCents,
              taxable: l.taxable ?? true,
              sortOrder: i,
            })),
          },
        },
      });

      res.json({ quote: { ...quote, id: persisted.id } });
    }),
  );

  app.get(
    '/api/v1/quotes/:id',
    wrap(async (req, res) => {
      const q = await prisma.quote.findUnique({
        where: { id: String(req.params.id) },
        include: { lines: true },
      });
      if (!q) throw new ApiError(404, 'QUOTE_NOT_FOUND', 'We could not find that price.');
      if (q.customerId && q.customerId !== req.customerId) {
        throw new ApiError(404, 'QUOTE_NOT_FOUND', 'We could not find that price.');
      }
      res.json({ quote: q });
    }),
  );

  /* ---------------- availability ---------------- */

  app.get(
    '/api/v1/availability',
    wrap(async (req, res) => {
      const serviceOptionId = String(req.query.serviceOptionId ?? '');
      const date = String(req.query.date ?? '');
      const service = SERVICES.find((s) => s.id === serviceOptionId);
      if (!service) throw new ApiError(404, 'VALIDATION_ERROR', 'Unknown service.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'Use date=YYYY-MM-DD.');
      }

      const [y, m, d] = date.split('-').map(Number);
      const dayStart = localToUtc(y!, m!, d!, 0);
      const dayEnd = localToUtc(y!, m!, d!, 24 * 60);
      const staff = await scheduling.listStaff();
      const busy = await scheduling.listBusy({ startUtc: dayStart, endUtc: dayEnd });

      let slots;
      try {
        slots = findAvailableSlots({
          service,
          dateKey: date,
          staff,
          busy,
          now: now(),
          preferredStaffId: null,
        });
      } catch (e) {
        throw new ApiError(400, 'VALIDATION_ERROR', (e as Error).message);
      }

      // Staff identities are internal; the customer gets times only.
      res.json({
        date,
        slots: slots.map((s) => ({
          startAt: s.startUtc.toISOString(),
          endAt: s.endUtc.toISOString(),
          preferredStaffAvailable: s.preferredStaffAvailable,
        })),
      });
    }),
  );

  /* ---------------- holds ---------------- */

  app.post(
    '/api/v1/booking-holds',
    wrap(async (req, res) => {
      const customerId = requireCustomer(req);
      const input = holdSchema.parse(req.body);
      const key = req.header('Idempotency-Key');

      let recordId: string | null = null;
      if (key) {
        const begun = await idempotency.begin('booking-holds', customerId, key, req.body);
        if (begun.kind === 'REPLAY') {
          res.status(begun.result.status).json(begun.result.body);
          return;
        }
        if (begun.kind === 'IN_PROGRESS') {
          throw new ApiError(409, 'IDEMPOTENCY_IN_PROGRESS', 'That request is still running.');
        }
        recordId = begun.recordId;
      }

      const quote = await prisma.quote.findUnique({ where: { id: input.quoteId } });
      if (!quote) throw new ApiError(404, 'QUOTE_NOT_FOUND', 'We could not find that price.');
      if (quote.customerId && quote.customerId !== customerId) {
        throw new ApiError(404, 'QUOTE_NOT_FOUND', 'We could not find that price.');
      }
      const service = SERVICES.find((s) => s.id === quote.serviceOptionId);
      if (!service) throw new ApiError(404, 'VALIDATION_ERROR', 'Unknown service.');

      const hold = await bookings.holdSlot({
        service,
        startUtc: new Date(input.startAt),
        customerId,
      });
      await prisma.bookingHold.update({
        where: { id: hold.id },
        data: { quoteId: quote.id },
      });

      const body = {
        hold: {
          id: hold.id,
          startAt: hold.startUtc.toISOString(),
          endAt: hold.endUtc.toISOString(),
          expiresAt: hold.expiresAt.toISOString(),
        },
      };
      if (recordId) await idempotency.complete(recordId, 201, body);
      res.status(201).json(body);
    }),
  );

  app.get(
    '/api/v1/booking-holds/:id',
    wrap(async (req, res) => {
      const customerId = requireCustomer(req);
      const h = await prisma.bookingHold.findUnique({ where: { id: String(req.params.id) } });
      if (!h || h.customerId !== customerId) {
        throw new ApiError(404, 'HOLD_NOT_FOUND', 'That reservation has gone.');
      }
      res.json({ hold: h });
    }),
  );

  app.delete(
    '/api/v1/booking-holds/:id',
    wrap(async (req, res) => {
      const customerId = requireCustomer(req);
      const h = await prisma.bookingHold.findUnique({ where: { id: String(req.params.id) } });
      if (!h || h.customerId !== customerId) {
        // Idempotent: releasing an already-released hold is a success.
        res.json({ ok: true });
        return;
      }
      await prisma.bookingHold.update({
        where: { id: h.id },
        data: { status: 'CANCELLED' },
      });
      res.json({ ok: true });
    }),
  );

  /* ---------------- bookings ---------------- */

  app.post(
    '/api/v1/bookings',
    wrap(async (req, res) => {
      const customerId = requireCustomer(req);
      const input = bookingSchema.parse(req.body);
      const key = req.header('Idempotency-Key');

      let recordId: string | null = null;
      if (key) {
        const begun = await idempotency.begin('bookings', customerId, key, req.body);
        if (begun.kind === 'REPLAY') {
          res.status(begun.result.status).json(begun.result.body);
          return;
        }
        if (begun.kind === 'IN_PROGRESS') {
          throw new ApiError(409, 'IDEMPOTENCY_IN_PROGRESS', 'That request is still running.');
        }
        recordId = begun.recordId;
      }

      const hold = await prisma.bookingHold.findUnique({ where: { id: input.holdId } });
      if (!hold) throw new ApiError(404, 'HOLD_NOT_FOUND', 'That reservation has gone.');
      const service = SERVICES.find((s) => s.id === hold.serviceOptionId);
      if (!service) throw new ApiError(404, 'VALIDATION_ERROR', 'Unknown service.');

      const address = await prisma.customerAddress.findUnique({
        where: { id: input.addressId },
      });
      if (!address || address.customerId !== customerId) {
        throw new ApiError(404, 'VALIDATION_ERROR', 'Unknown address.');
      }

      let booking;
      try {
        booking = await bookings.confirmBooking({
          holdId: input.holdId,
          quoteId: input.quoteId,
          customerId, // from session, never from body
          addressId: input.addressId,
          service,
        });
      } catch (e) {
        // Free the key so a genuine retry can run.
        if (recordId) await idempotency.abandon(recordId);
        throw e;
      }

      const body = { booking: publicBooking(booking) };
      if (recordId) await idempotency.complete(recordId, 201, body);
      res.status(201).json(body);
    }),
  );

  app.get(
    '/api/v1/bookings/:id',
    wrap(async (req, res) => {
      const customerId = requireCustomer(req);
      const b = await prisma.booking.findUnique({
        where: { id: String(req.params.id) },
        include: { staff: true },
      });
      if (!b || b.customerId !== customerId) {
        throw new ApiError(404, 'BOOKING_NOT_FOUND', 'We could not find that booking.');
      }
      res.json({ booking: publicBooking(b) });
    }),
  );

  /* ---------------- address ---------------- */

  const tokens = new SessionTokenManager();
  const origin = deps.origin ?? { latitude: 45.4419, longitude: -73.6764 };

  function requirePlaces(): PlacesProvider {
    if (!deps.places) {
      throw new ApiError(
        503,
        'INTEGRATION_NOT_CONFIGURED',
        'Address lookup is not configured. Add GOOGLE_MAPS_API_KEY.',
      );
    }
    return deps.places;
  }

  app.get(
    '/api/v1/address/autocomplete',
    wrap(async (req, res) => {
      const provider = requirePlaces();
      const input = String(req.query.q ?? '').trim();
      const sessionId = String(req.query.sessionId ?? '') || req.requestId;
      if (input.length < 3) {
        res.json({ sessionId, suggestions: [] });
        return;
      }
      // One token per search session; Google groups the keystrokes with the
      // eventual Place Details call.
      const token = tokens.acquire(sessionId);
      const suggestions = await provider.autocomplete(input, token);
      res.json({ sessionId, suggestions });
    }),
  );

  app.post(
    '/api/v1/address/select',
    wrap(async (req, res) => {
      const customerId = requireCustomer(req);
      const provider = requirePlaces();
      const { placeId, sessionId, unit, label } = req.body as {
        placeId?: string;
        sessionId?: string;
        unit?: string;
        label?: string;
      };
      if (!placeId) throw new ApiError(400, 'VALIDATION_ERROR', 'placeId is required.');

      const sid = sessionId ?? req.requestId;
      const token = tokens.acquire(sid);
      const address = await provider.details(placeId, token);
      // Place Details ends the session; the next search must use a new token.
      tokens.retire(sid);

      const saved = await prisma.customerAddress.create({
        data: {
          customerId,
          label: label ?? null,
          formattedAddress: address.formattedAddress,
          streetNumber: address.streetNumber,
          route: address.route,
          unit: unit ?? null,
          city: address.city,
          province: address.province,
          postalCode: address.postalCode,
          country: address.country,
          placeId: address.placeId,
          latitude: address.latitude,
          longitude: address.longitude,
        },
      });

      // Distance is computed here, on the server, from the business origin.
      // The browser never sees the origin and never supplies a distance.
      const route = await provider.computeRoute(origin, { placeId });

      res.json({
        address: {
          id: saved.id,
          formattedAddress: saved.formattedAddress,
          city: saved.city,
          postalCode: saved.postalCode,
          unit: saved.unit,
        },
        travel: {
          distanceKm: Math.round(route.distanceKm * 10) / 10,
          durationMinutes: Math.round(route.durationSeconds / 60),
        },
      });
    }),
  );

  /* ---------------- payments ---------------- */

  function requirePayments(): PaymentService {
    if (!paymentService) {
      throw new ApiError(
        503,
        'INTEGRATION_NOT_CONFIGURED',
        'Payments are not configured. Add STRIPE_SECRET_KEY.',
      );
    }
    return paymentService;
  }

  const revalidator = new QuoteRevalidator(prisma, now);

  /**
   * Client-safe payment configuration. Publishable key only — the secret key
   * and webhook secret never leave the server.
   *
   * Optionally scoped to a booking so the client learns the authoritative
   * amount due today rather than guessing from the quote.
   */
  app.get(
    '/api/v1/payment-config',
    wrap(async (req, res) => {
      const cfg = await prisma.businessConfiguration.findUnique({ where: { id: 'default' } });
      const body: Record<string, unknown> = {
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? null,
        currency: 'CAD',
        country: 'CA',
        configured: Boolean(paymentService),
        recurringPaymentTiming: cfg?.recurringPaymentTiming ?? '24_HOURS_BEFORE',
        defaultPaymentPolicy: cfg?.defaultPaymentPolicy ?? 'PAY_LATER',
      };

      const bookingId = req.query.bookingId ? String(req.query.bookingId) : null;
      if (bookingId && req.customerId) {
        const b = await prisma.booking.findUnique({
          where: { id: bookingId },
          include: { service: true },
        });
        if (b && b.customerId === req.customerId) {
          const policy = b.service.paymentPolicy;
          body.paymentPolicy = policy;
          body.amountDueNowCents = amountDueNowCents(policy, b.grandTotalCents);
          body.bookingTotalCents = b.grandTotalCents;
          body.remainingBalanceCents =
            b.grandTotalCents - (body.amountDueNowCents as number);
          body.recurringPaymentRequired = policy === 'CARD_ON_FILE';
        }
      }
      res.json(body);
    }),
  );

  /**
   * Re-check a quote against the verified customer's real eligibility.
   *
   * Called BEFORE any Stripe object is created. If the welcome offer turned
   * out to be already used, we return the new quote and refuse to continue
   * until the customer has seen and accepted it.
   */
  app.post(
    '/api/v1/quotes/:id/revalidate',
    wrap(async (req, res) => {
      const customerId = requireCustomer(req);
      const quote = await prisma.quote.findUnique({ where: { id: String(req.params.id) } });
      if (!quote || (quote.customerId && quote.customerId !== customerId)) {
        throw new ApiError(404, 'QUOTE_NOT_FOUND', 'We could not find that price.');
      }

      const result = await revalidator.revalidate(String(req.params.id), customerId);
      if (result.status === 'VALID') {
        res.json({ status: 'VALID', quoteId: result.quoteId, grandTotalCents: result.grandTotalCents });
        return;
      }

      const lines = await prisma.quoteLine.findMany({
        where: { quoteId: result.quoteId },
        orderBy: { sortOrder: 'asc' },
      });
      res.status(409).json({
        error: {
          code: 'QUOTE_REPRICE_REQUIRED',
          message: REPRICE_COPY[result.reason!].en,
          requestId: req.requestId,
        },
        reprice: {
          reason: result.reason,
          copy: REPRICE_COPY[result.reason!],
          previousQuoteId: result.previous!.quoteId,
          previousTotalCents: result.previous!.grandTotalCents,
          newQuoteId: result.quoteId,
          newTotalCents: result.grandTotalCents,
          differenceCents: result.differenceCents,
          lines: lines.map((l) => ({
            type: l.type,
            description: l.description,
            subtotalCents: l.subtotalCents,
          })),
        },
      });
    }),
  );

  app.post(
    '/api/v1/payments/payment-intent',
    wrap(async (req, res) => {
      const customerId = requireCustomer(req);
      const svc = requirePayments();
      const bookingId = String((req.body as { bookingId?: string }).bookingId ?? '');
      if (!bookingId) throw new ApiError(400, 'VALIDATION_ERROR', 'bookingId is required.');

      // Eligibility is settled BEFORE Stripe is touched. If the price moved,
      // no PaymentIntent is created and the customer must accept the new
      // total first.
      const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
      if (booking && booking.customerId === customerId) {
        const check = await revalidator.revalidate(booking.quoteId, customerId);
        if (check.status === 'REPRICE_REQUIRED') {
          throw new ApiError(
            409,
            'QUOTE_REPRICE_REQUIRED',
            REPRICE_COPY[check.reason!].en,
          );
        }
      }

      // Any amount in the body is ignored: the server reads the persisted
      // booking total, which is itself a frozen quote snapshot.
      const out = await svc.createPaymentIntentForBooking({
        bookingId,
        customerId,
        idempotencyKey: req.header('Idempotency-Key') ?? undefined,
      });

      res.json({
        amountDueNowCents: out.amountDueNowCents,
        policy: out.policy,
        clientSecret: out.clientSecret ?? null,
        paymentId: out.payment?.id ?? null,
        bookingTotalCents: out.bookingTotalCents ?? null,
        remainingBalanceCents: out.remainingBalanceCents ?? null,
        message: out.message ?? null,
      });
    }),
  );

  app.post(
    '/api/v1/payments/setup-intent',
    wrap(async (req, res) => {
      const customerId = requireCustomer(req);
      const svc = requirePayments();
      const out = await svc.createSetupIntent(
        customerId,
        req.header('Idempotency-Key') ?? undefined,
      );
      res.json({ clientSecret: out.clientSecret, paymentId: out.payment.id });
    }),
  );

  app.get(
    '/api/v1/payments/:id',
    wrap(async (req, res) => {
      const customerId = requireCustomer(req);
      const p = await prisma.payment.findUnique({ where: { id: String(req.params.id) } });
      if (!p || p.customerId !== customerId) {
        throw new ApiError(404, 'PAYMENT_NOT_FOUND', 'We could not find that payment.');
      }
      res.json({
        payment: {
          id: p.id,
          status: p.status,
          amountCents: p.amountCents,
          currency: p.currency,
          requiresAction: p.requiresAction,
          paidAt: p.paidAt,
          // failureCode is safe to surface; internal risk data is not.
          failureCode: p.failureCode,
        },
      });
    }),
  );

  app.post(
    '/api/v1/stripe/webhook',
    wrap(async (req, res) => {
      const svc = requirePayments();
      if (!webhookSecret) {
        throw new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', 'Webhook secret is not set.');
      }
      const signature = req.header('stripe-signature');
      if (!signature) throw new ApiError(400, 'WEBHOOK_BAD_SIGNATURE', 'Missing signature.');

      const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body);
      let event;
      try {
        event = deps.stripe!.verifyWebhook(raw, signature, webhookSecret);
      } catch {
        // Never reveal why verification failed.
        throw new ApiError(400, 'WEBHOOK_BAD_SIGNATURE', 'Signature verification failed.');
      }

      const result = await svc.handleWebhookEvent(event);
      res.json({ received: true, processed: result.processed });
    }),
  );

  /* ---------------- public health, reviews, callback ---------------- */

  app.get(
    '/api/v1/health',
    wrap(async (_req, res) => {
      // Reachability only. No versions, no config, no secrets.
      res.json({ ok: true });
    }),
  );

  /**
   * Publicly advertisable welcome offers, read from the promotion engine.
   * The brand board shows "up to $20 off"; this returns whatever is actually
   * seeded and active, so the marketing can never drift from the rules.
   */
  app.get(
    '/api/v1/promotions/public',
    wrap(async (_req, res) => {
      const promos = await prisma.promotion.findMany({
        where: { active: true, family: 'NEW_CUSTOMER', ownerReviewRequired: false },
        orderBy: { amountCents: 'desc' },
      });
      res.json({
        newCustomer: promos.map((p) => ({
          code: p.code,
          label: p.label,
          amountCents: p.amountCents,
          categoryId: p.categoryId,
        })),
        maxAmountCents: promos[0]?.amountCents ?? null,
      });
    }),
  );

  app.get(
    '/api/v1/reviews/summary',
    wrap(async (_req, res) => {
      res.json(await new ReviewService(prisma, now).summary());
    }),
  );

  app.get(
    '/api/v1/reviews',
    wrap(async (req, res) => {
      const limit = Math.min(Number(req.query.limit ?? 10), 50);
      res.json({ reviews: await new ReviewService(prisma, now).listPublished({ limit }) });
    }),
  );

  app.post(
    '/api/v1/callbacks',
    wrap(async (req, res) => {
      const body = req.body as { phoneE164?: string; reason?: string };
      if (!body.phoneE164) throw new ApiError(400, 'VALIDATION_ERROR', 'A phone number is required.');
      const svc = new CallbackService(prisma, null, now);
      const out = await svc.request({
        phoneE164: normalizePhone(body.phoneE164),
        customerId: req.customerId ?? null,
        reason: body.reason,
        source: 'BOOKING_FLOW',
      });
      res.status(201).json({ callbackId: out.callback.id, status: out.callback.status });
    }),
  );

  /* ---------------- integrations ---------------- */

  app.get(
    '/api/v1/integrations/status',
    wrap(async (_req, res) => {
      res.json({ integrations: integrationStatus(process.env) });
    }),
  );

  /* ---------------- operations (admin + crew) ----------------
   * Staff routes live in createOpsApi. They were previously only mounted
   * in tests, which meant /admin and /crew had a UI and no working API.
   */
  app.use(createOpsApi({ prisma, voice: deps.voice ?? null, now }));

  /* ---------------- errors ---------------- */

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const requestId = req.requestId;
    if (err instanceof RosterError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, requestId } });
      return;
    }
    if (err instanceof AuthError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, requestId } });
      return;
    }
    if (err instanceof PlacesError) {
      const status = err.code === 'INTEGRATION_NOT_CONFIGURED' ? 503 : 502;
      res.status(status).json({ error: { code: err.code, message: err.message, requestId } });
      return;
    }
    if (err instanceof PaymentError) {
      const status =
        err.code === 'IDEMPOTENCY_CONFLICT' ? 409 : err.code.includes('NOT_FOUND') ? 404 : 400;
      res.status(status).json({ error: { code: err.code, message: err.message, requestId } });
      return;
    }
    if (err instanceof StripeError) {
      res.status(502).json({
        error: { code: 'PAYMENT_PROVIDER_ERROR', message: 'Payment could not be processed.', requestId },
      });
      return;
    }
    if (err instanceof IdempotencyConflict) {
      res
        .status(409)
        .json({ error: { code: 'IDEMPOTENCY_CONFLICT', message: err.message, requestId } });
      return;
    }
    if (err instanceof ApiError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, requestId } });
      return;
    }
    if (err instanceof z.ZodError) {
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Check the highlighted fields.', requestId },
      });
      return;
    }
    if (err instanceof IdentityError) {
      const status = err.code.includes('LIMIT') || err.code === 'OTP_COOLDOWN' ? 429 : 400;
      res.status(status).json({ error: { code: err.code, message: err.message, requestId } });
      return;
    }
    if (err instanceof BookingError) {
      const status =
        err.code === 'SLOT_UNAVAILABLE' ? 409 : err.code.includes('NOT_FOUND') ? 404 : 400;
      res.status(status).json({ error: { code: err.code, message: err.message, requestId } });
      return;
    }
    if (process.env.NODE_ENV !== 'production') {
      console.error('[api 500]', req.method, req.path, err);
    }
    // Never leak a stack trace to a customer.
    res
      .status(500)
      .json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.', requestId } });
  });

  return app;
}

interface BookingLike {
  id: string;
  bookingNumber: string;
  startAt?: Date;
  endAt?: Date;
  startUtc?: Date;
  endUtc?: Date;
  status: string;
  grandTotalCents: number;
  staff?: { staffId: string }[];
  staffIds?: string[];
}

function publicBooking(b: BookingLike) {
  return {
    id: b.id,
    bookingNumber: b.bookingNumber,
    startAt: (b.startAt ?? b.startUtc)?.toISOString(),
    endAt: (b.endAt ?? b.endUtc)?.toISOString(),
    status: b.status,
    grandTotalCents: b.grandTotalCents,
    // PAY_LATER is the seeded default: a booking exists, no money moved.
    paymentStatus: 'NOT_COLLECTED',
    paymentPolicy: 'PAY_LATER',
    crewSize: b.staff?.length ?? b.staffIds?.length ?? 0,
  };
}
