import type { PrismaClient } from '@prisma/client';
import { PaymentService, chargeEligibleAt, amountDueNowCents } from './payment-service.js';
import { DunningService } from './dunning-service.js';

/**
 * Recurring billing.
 *
 * The generator creates future visits; this charges them. Without it a weekly
 * customer is served forever and never billed.
 *
 * Design rules:
 *
 * 1. **Never charge without a booking that is actually happening.** A
 *    cancelled visit is abandoned, not retried.
 * 2. **Never charge twice.** Attempts are unique per (booking, attempt), the
 *    provider call carries a stable idempotency key, and workers take a
 *    database lease.
 * 3. **A declined card is not a failed system.** Soft declines retry on a
 *    backoff; hard declines stop immediately and hand the customer a way to
 *    fix it, because retrying a closed account just accrues fees.
 */

export const MAX_ATTEMPTS = 4;

/** Backoff between soft-decline retries. Front-loaded, then patient. */
export const RETRY_BACKOFF_HOURS = [4, 24, 72];

/**
 * Codes where retrying the same card is pointless.
 *
 * Retrying these annoys the customer, can trigger issuer blocks, and in some
 * schemes attracts fees.
 */
const HARD_DECLINE_CODES = new Set([
  'card_declined',
  'stolen_card',
  'lost_card',
  'pickup_card',
  'restricted_card',
  'invalid_account',
  'account_closed',
  'incorrect_number',
  'invalid_expiry_year',
  'expired_card',
  'authentication_required',
]);

export function isHardDecline(code: string | null | undefined): boolean {
  return code ? HARD_DECLINE_CODES.has(code) : false;
}

export type AttemptOutcome =
  | 'CHARGED'
  | 'ALREADY_PAID'
  | 'NOT_DUE'
  | 'NO_PAYMENT_METHOD'
  | 'BOOKING_CANCELLED'
  | 'SOFT_FAILED'
  | 'HARD_FAILED'
  | 'ABANDONED'
  | 'REQUIRES_ACTION';

export interface BillingRunResult {
  scheduled: number;
  charged: number;
  softFailed: number;
  hardFailed: number;
  skipped: number;
  outcomes: { bookingId: string; outcome: AttemptOutcome; code?: string }[];
}

export class BillingScheduler {
  private readonly dunning: DunningService;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly payments: PaymentService,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.dunning = new DunningService(prisma, undefined, now);
  }

  /**
   * Create a first attempt row for every booking that has become chargeable.
   *
   * Scheduling is separate from charging so the queue is inspectable: an
   * operator can see what is about to be billed before any money moves.
   */
  async scheduleDueBookings(lookaheadHours = 48): Promise<number> {
    const at = this.now();
    const config = await this.prisma.businessConfiguration.findUnique({ where: { id: 'default' } });
    const timing = config?.recurringPaymentTiming ?? '24_HOURS_BEFORE';

    const horizon = new Date(at.getTime() + lookaheadHours * 3600_000);
    const bookings = await this.prisma.booking.findMany({
      where: {
        status: { notIn: ['CANCELLED', 'NO_SHOW', 'COMPLETED'] },
        startAt: { gte: at, lte: new Date(horizon.getTime() + 72 * 3600_000) },
      },
      include: { service: true, payments: true },
    });

    let created = 0;
    for (const b of bookings) {
      // PAY_LATER never enters the billing queue at all.
      const due = amountDueNowCents(b.service.paymentPolicy, b.grandTotalCents);
      if (due <= 0) continue;
      if (b.payments.some((p) => p.status === 'SUCCEEDED')) continue;

      const eligibleAt = chargeEligibleAt(b.startAt, timing);
      if (eligibleAt === null || eligibleAt > horizon) continue;

      const existing = await this.prisma.billingAttempt.findFirst({
        where: { bookingId: b.id },
      });
      if (existing) continue;

      await this.prisma.billingAttempt.create({
        data: {
          bookingId: b.id,
          customerId: b.customerId,
          attemptNumber: 1,
          amountCents: due,
          status: 'SCHEDULED',
          scheduledFor: eligibleAt,
        },
      });
      created++;
    }
    return created;
  }

  /**
   * Claim one attempt that is due.
   *
   * `FOR UPDATE SKIP LOCKED` plus a lease means two workers on two machines
   * never charge the same visit.
   */
  async claimNext(workerId: string, leaseMs = 120_000) {
    const at = this.now();
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE "BillingAttempt"
      SET "claimedBy" = ${workerId},
          "claimedUntil" = ${new Date(at.getTime() + leaseMs)},
          "status" = 'RUNNING',
          "startedAt" = ${at},
          "updatedAt" = now()
      WHERE "id" = (
        SELECT "id" FROM "BillingAttempt"
        WHERE "status" IN ('SCHEDULED', 'SOFT_FAILED')
          AND ("scheduledFor" <= ${at})
          AND ("nextRetryAt" IS NULL OR "nextRetryAt" <= ${at})
          AND ("claimedUntil" IS NULL OR "claimedUntil" < ${at})
        ORDER BY "scheduledFor" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id"
    `;
    if (rows.length === 0) return null;
    return this.prisma.billingAttempt.findUnique({ where: { id: rows[0]!.id } });
  }

  /** Charge one claimed attempt. */
  async runAttempt(attemptId: string): Promise<{ outcome: AttemptOutcome; code?: string }> {
    const at = this.now();
    const attempt = await this.prisma.billingAttempt.findUniqueOrThrow({
      where: { id: attemptId },
    });
    const booking = await this.prisma.booking.findUnique({
      where: { id: attempt.bookingId },
      include: { payments: true },
    });

    if (!booking || booking.status === 'CANCELLED' || booking.status === 'NO_SHOW') {
      await this.finish(attemptId, 'ABANDONED', { failureCode: 'BOOKING_CANCELLED' });
      return { outcome: 'BOOKING_CANCELLED' };
    }
    if (booking.payments.some((p) => p.status === 'SUCCEEDED')) {
      await this.finish(attemptId, 'SUCCEEDED');
      return { outcome: 'ALREADY_PAID' };
    }

    const method = await this.prisma.paymentMethodReference.findFirst({
      where: { customerId: attempt.customerId, isDefault: true },
    });
    if (!method) {
      // Not a decline: nothing to charge. Surface it rather than retrying.
      await this.finish(attemptId, 'HARD_FAILED', { failureCode: 'NO_PAYMENT_METHOD' });
      return { outcome: 'NO_PAYMENT_METHOD' };
    }

    try {
      const res = await this.payments.chargeScheduledBooking(booking.id);

      if (res.skipped) {
        await this.prisma.billingAttempt.update({
          where: { id: attemptId },
          data: { status: 'SCHEDULED', claimedBy: null, claimedUntil: null },
        });
        return { outcome: 'NOT_DUE' };
      }
      if (res.status === 'REQUIRES_ACTION') {
        // The customer must authenticate; retrying off-session will only fail.
        await this.finish(attemptId, 'HARD_FAILED', { failureCode: 'authentication_required' });
        return { outcome: 'REQUIRES_ACTION', code: 'authentication_required' };
      }
      await this.finish(attemptId, 'SUCCEEDED', { paymentId: res.payment?.id ?? null });
      return { outcome: 'CHARGED' };
    } catch (e) {
      // Read the error's own fields rather than `instanceof`: under some
      // module loaders the provider class is duplicated and the check fails,
      // which would silently turn every decline into a retryable UNKNOWN.
      const err = e as { code?: string; retryable?: boolean; message?: string };
      const code = err.code ?? 'UNKNOWN';
      const message = err.message ?? String(e);

      // An explicitly non-retryable provider error is final even if its code
      // is not in the known-decline list.
      if (isHardDecline(code) || err.retryable === false) {
        await this.finish(attemptId, 'HARD_FAILED', { failureCode: code, failureMessage: message });
        return { outcome: 'HARD_FAILED', code };
      }

      const nextNumber = attempt.attemptNumber + 1;
      if (nextNumber > MAX_ATTEMPTS) {
        await this.finish(attemptId, 'ABANDONED', { failureCode: code, failureMessage: message });
        return { outcome: 'ABANDONED', code };
      }

      const backoffHours = RETRY_BACKOFF_HOURS[attempt.attemptNumber - 1] ?? 72;
      await this.prisma.billingAttempt.update({
        where: { id: attemptId },
        data: {
          status: 'SOFT_FAILED',
          attemptNumber: nextNumber,
          nextRetryAt: new Date(at.getTime() + backoffHours * 3600_000),
          failureCode: code,
          failureMessage: message,
          claimedBy: null,
          claimedUntil: null,
        },
      });
      return { outcome: 'SOFT_FAILED', code };
    }
  }

  private async finish(
    id: string,
    status: 'SUCCEEDED' | 'HARD_FAILED' | 'ABANDONED',
    extra: { failureCode?: string; failureMessage?: string; paymentId?: string | null } = {},
  ) {
    const attempt = await this.prisma.billingAttempt.findUnique({ where: { id } });

    // A failure that needs a person becomes a dunning case; a success closes
    // one, so a customer who fixes their own card is never chased.
    if (attempt) {
      if (status === 'HARD_FAILED' || status === 'ABANDONED') {
        if (extra.failureCode !== 'BOOKING_CANCELLED') {
          await this.dunning.recordFailure({
            customerId: attempt.customerId,
            amountCents: attempt.amountCents,
            reason: extra.failureCode ?? 'UNKNOWN',
          });
        }
      } else if (status === 'SUCCEEDED') {
        await this.dunning.resolveForCustomer(attempt.customerId);
      }
    }

    await this.prisma.billingAttempt.update({
      where: { id },
      data: {
        status,
        completedAt: this.now(),
        claimedBy: null,
        claimedUntil: null,
        nextRetryAt: null,
        failureCode: extra.failureCode ?? null,
        failureMessage: extra.failureMessage ?? null,
        paymentId: extra.paymentId ?? null,
      },
    });
  }

  /** One full pass: schedule what is due, then charge what is claimable. */
  async run(workerId = 'billing-worker', maxPerRun = 50): Promise<BillingRunResult> {
    const result: BillingRunResult = {
      scheduled: 0,
      charged: 0,
      softFailed: 0,
      hardFailed: 0,
      skipped: 0,
      outcomes: [],
    };

    result.scheduled = await this.scheduleDueBookings();

    for (let i = 0; i < maxPerRun; i++) {
      const attempt = await this.claimNext(workerId);
      if (!attempt) break;

      const { outcome, code } = await this.runAttempt(attempt.id);
      result.outcomes.push({ bookingId: attempt.bookingId, outcome, code });

      if (outcome === 'CHARGED' || outcome === 'ALREADY_PAID') result.charged++;
      else if (outcome === 'SOFT_FAILED') result.softFailed++;
      else if (outcome === 'HARD_FAILED' || outcome === 'REQUIRES_ACTION' || outcome === 'NO_PAYMENT_METHOD') {
        result.hardFailed++;
      } else result.skipped++;
    }

    return result;
  }

  /** Everything an operator needs to chase. */
  async needsAttention() {
    return this.prisma.billingAttempt.findMany({
      where: { status: { in: ['HARD_FAILED', 'ABANDONED'] } },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
  }
}
