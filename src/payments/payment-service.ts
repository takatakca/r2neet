import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  StripeError,
  type StripeProvider,
  type ProviderPaymentIntent,
  type StripeWebhookEvent,
} from './stripe-provider.js';
import { PromotionClaimService } from '../promotions/claims.js';

/**
 * Payment orchestration.
 *
 * Two things this file is careful about:
 *
 * 1. The amount ALWAYS comes from the persisted Quote. Nothing the browser
 *    sends can influence it.
 *
 * 2. A retry of the same logical operation reuses the SAME Stripe idempotency
 *    key. If our process times out after Stripe already created the intent,
 *    retrying must return that intent — not make a second one. The durable
 *    record survives the restart that loses the in-flight request.
 */

export class PaymentError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export type PaymentStatus =
  | 'NOT_REQUIRED'
  | 'PENDING'
  | 'REQUIRES_PAYMENT_METHOD'
  | 'REQUIRES_ACTION'
  | 'PROCESSING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'PARTIALLY_REFUNDED'
  | 'REFUNDED';

/**
 * Stripe vocabulary -> R2NETTE vocabulary.
 *
 * Deliberately explicit rather than passing Stripe strings into business
 * logic: their state names are theirs to change.
 */
export function mapProviderStatus(s: ProviderPaymentIntent['status']): PaymentStatus {
  switch (s) {
    case 'succeeded':
      return 'SUCCEEDED';
    case 'processing':
      return 'PROCESSING';
    case 'requires_action':
    case 'requires_confirmation':
      return 'REQUIRES_ACTION';
    case 'requires_payment_method':
      return 'REQUIRES_PAYMENT_METHOD';
    case 'canceled':
      return 'CANCELLED';
    default:
      return 'PENDING';
  }
}

export interface DepositConfig {
  type: 'FIXED' | 'PERCENTAGE';
  /** cents when FIXED, micro-percent when PERCENTAGE */
  value: number;
}

/** How much is actually due right now, given the policy. */
export function amountDueNowCents(
  policy: string,
  bookingTotalCents: number,
  deposit?: DepositConfig,
): number {
  switch (policy) {
    case 'FULL_PAYMENT':
      return bookingTotalCents;
    case 'DEPOSIT': {
      if (!deposit) throw new PaymentError('Deposit is not configured.', 'DEPOSIT_NOT_CONFIGURED');
      if (deposit.type === 'FIXED') return Math.min(deposit.value, bookingTotalCents);
      const raw = Math.floor((bookingTotalCents * deposit.value) / (100 * 1_000_000));
      return Math.min(Math.max(raw, 0), bookingTotalCents);
    }
    case 'PAY_LATER':
    case 'CARD_ON_FILE':
      return 0;
    default:
      throw new PaymentError(`Unknown payment policy ${policy}.`, 'UNKNOWN_PAYMENT_POLICY');
  }
}

/** When a recurring occurrence becomes chargeable. */
export function chargeEligibleAt(startAt: Date, timing: string): Date | null {
  switch (timing) {
    case 'AT_BOOKING':
      return new Date(0);
    case '24_HOURS_BEFORE':
      return new Date(startAt.getTime() - 24 * 3600 * 1000);
    case '48_HOURS_BEFORE':
      return new Date(startAt.getTime() - 48 * 3600 * 1000);
    case 'AFTER_SERVICE':
      return startAt;
    case 'PAY_LATER':
      return null;
    default:
      throw new PaymentError(`Unknown charge timing ${timing}.`, 'UNKNOWN_CHARGE_TIMING');
  }
}

function hash(v: unknown): string {
  return createHash('sha256').update(JSON.stringify(v ?? {})).digest('hex');
}

export class PaymentService {
  private readonly claims: PromotionClaimService;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly stripe: StripeProvider,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.claims = new PromotionClaimService(prisma, now);
  }

  /* ---------------- stripe customer ---------------- */

  /**
   * At most one Stripe Customer per R2NETTE customer.
   *
   * The unique constraint on customerId makes concurrent creation safe: the
   * loser catches P2002 and reads the winner's row rather than creating a
   * duplicate on Stripe's side.
   */
  async ensureStripeCustomer(customerId: string): Promise<string> {
    const existing = await this.prisma.paymentProviderCustomer.findUnique({
      where: { customerId },
    });
    if (existing) return existing.providerCustomerId;

    // Deterministic key: a retry maps to the same Stripe customer.
    const providerCustomerId = await this.stripe.ensureCustomer(
      customerId,
      `cus:${customerId}`,
    );
    try {
      await this.prisma.paymentProviderCustomer.create({
        data: { customerId, providerCustomerId },
      });
    } catch (e) {
      // Two unique constraints can fire here: customerId (a concurrent
      // request for the same customer) and providerCustomerId (the provider
      // returned an id we already hold). Both mean "someone got there first",
      // so resolve by whichever row exists rather than failing the charge.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const byCustomer = await this.prisma.paymentProviderCustomer.findUnique({
          where: { customerId },
        });
        if (byCustomer) return byCustomer.providerCustomerId;
        const byProvider = await this.prisma.paymentProviderCustomer.findUnique({
          where: { providerCustomerId },
        });
        if (byProvider) return byProvider.providerCustomerId;
      }
      throw e;
    }
    return providerCustomerId;
  }

  /* ---------------- durable provider idempotency ---------------- */

  /**
   * Run a Stripe operation under a durable, stateful idempotency record.
   *
   * On a retryable failure the record is kept as FAILED_RETRYABLE with its
   * provider key intact, so the next attempt sends Stripe the SAME key and
   * gets back the original object instead of creating a second one.
   */
  private async withProviderIdempotency<T extends { id: string }>(
    scope: string,
    actorId: string,
    key: string,
    request: unknown,
    run: (providerKey: string) => Promise<T>,
  ): Promise<{ result: T; replayed: boolean }> {
    const requestHash = hash(request);
    const at = this.now();

    let record = await this.prisma.idempotencyRecord.findUnique({
      where: { scope_actorId_key: { scope, actorId, key } },
    });

    if (record) {
      if (record.requestHash !== requestHash) {
        throw new PaymentError(
          'This Idempotency-Key was already used with a different request.',
          'IDEMPOTENCY_CONFLICT',
        );
      }
      if (record.status === 'SUCCEEDED' && record.providerOperationId) {
        return {
          result: (record.responseBody as unknown) as T,
          replayed: true,
        };
      }
      if (record.status === 'FAILED_FINAL') {
        // A declined card is not an ambiguous timeout: replaying the same
        // key would just decline again. The customer needs a new attempt
        // with a fresh key, or a different card.
        throw new PaymentError(
          `That payment cannot be retried with the same key (${record.lastErrorCode ?? 'unknown'}). Start a new payment attempt.`,
          'PAYMENT_FAILED_FINAL',
        );
      }
      // IN_PROGRESS or FAILED_RETRYABLE: fall through and retry with the
      // SAME provider key.
    } else {
      record = await this.prisma.idempotencyRecord.create({
        data: {
          scope,
          actorId,
          key,
          requestHash,
          status: 'IN_PROGRESS',
          providerIdempotencyKey: `${scope}:${actorId}:${key}`,
          createdAt: at,
          expiresAt: new Date(at.getTime() + 24 * 3600 * 1000),
        },
      });
    }

    const providerKey = record.providerIdempotencyKey ?? `${scope}:${actorId}:${key}`;
    await this.prisma.idempotencyRecord.update({
      where: { id: record.id },
      data: { attempts: { increment: 1 }, status: 'IN_PROGRESS' },
    });

    try {
      const result = await run(providerKey);
      await this.prisma.idempotencyRecord.update({
        where: { id: record.id },
        data: {
          status: 'SUCCEEDED',
          providerOperationId: result.id,
          responseBody: result as unknown as Prisma.InputJsonValue,
          completedAt: this.now(),
        },
      });
      return { result, replayed: false };
    } catch (e) {
      const retryable = e instanceof StripeError ? e.retryable : false;
      await this.prisma.idempotencyRecord.update({
        where: { id: record.id },
        data: {
          // The record is NEVER deleted for provider operations. Deleting it
          // would let the next attempt mint a fresh Stripe key after an
          // ambiguous timeout, creating a duplicate charge.
          status: retryable ? 'FAILED_RETRYABLE' : 'FAILED_FINAL',
          lastErrorCode: e instanceof StripeError ? e.code : 'UNKNOWN',
        },
      });
      throw e;
    }
  }

  /* ---------------- payment intent ---------------- */

  async createPaymentIntentForBooking(params: {
    bookingId: string;
    customerId: string;
    idempotencyKey?: string;
    deposit?: DepositConfig;
  }) {
    const { bookingId, customerId } = params;

    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { service: true },
    });
    if (!booking || booking.customerId !== customerId) {
      throw new PaymentError('We could not find that booking.', 'BOOKING_NOT_FOUND');
    }

    const policy = booking.service.paymentPolicy;
    // Authoritative: the persisted booking total, itself a frozen quote
    // snapshot. Nothing from the request body reaches this number.
    const dueNow = amountDueNowCents(policy, booking.grandTotalCents, params.deposit);

    if (dueNow === 0) {
      return {
        payment: null,
        amountDueNowCents: 0,
        policy,
        message:
          policy === 'PAY_LATER'
            ? 'No payment is due today.'
            : 'No payment is due today; a card will be saved for future visits.',
      };
    }

    const stripeCustomerId = await this.ensureStripeCustomer(customerId);
    const key = params.idempotencyKey ?? `booking:${bookingId}`;

    const { result: intent } = await this.withProviderIdempotency(
      'payment_intent',
      customerId,
      key,
      { bookingId, amountCents: dueNow },
      (providerKey) =>
        this.stripe.createPaymentIntent({
          amountCents: dueNow,
          currency: 'cad',
          customerId: stripeCustomerId,
          idempotencyKey: providerKey,
          metadata: {
            r2netteBookingId: bookingId,
            r2netteCustomerId: customerId,
            r2netteQuoteId: booking.quoteId,
          },
        }),
    );

    const payment = await this.prisma.payment.upsert({
      where: { stripePaymentIntentId: intent.id },
      create: {
        bookingId,
        customerId,
        quoteId: booking.quoteId,
        currency: 'CAD',
        amountCents: dueNow,
        status: mapProviderStatus(intent.status),
        policy,
        stripeCustomerId,
        stripePaymentIntentId: intent.id,
        paymentMethodType: intent.paymentMethodType,
        riskLevel: intent.riskLevel,
        riskScore: intent.riskScore,
      },
      update: { status: mapProviderStatus(intent.status) },
    });

    return {
      payment,
      amountDueNowCents: dueNow,
      policy,
      clientSecret: intent.clientSecret,
      bookingTotalCents: booking.grandTotalCents,
      remainingBalanceCents: booking.grandTotalCents - dueNow,
    };
  }

  /* ---------------- setup intent ---------------- */

  async createSetupIntent(customerId: string, idempotencyKey?: string) {
    const stripeCustomerId = await this.ensureStripeCustomer(customerId);
    const key = idempotencyKey ?? `setup:${customerId}:${randomUUID()}`;

    const { result: si } = await this.withProviderIdempotency(
      'setup_intent',
      customerId,
      key,
      { customerId },
      (providerKey) =>
        this.stripe.createSetupIntent({
          customerId: stripeCustomerId,
          idempotencyKey: providerKey,
          metadata: { r2netteCustomerId: customerId },
        }),
    );

    const payment = await this.prisma.payment.create({
      data: {
        customerId,
        currency: 'CAD',
        amountCents: 0,
        status: 'NOT_REQUIRED',
        policy: 'CARD_ON_FILE',
        stripeCustomerId,
        stripeSetupIntentId: si.id,
      },
    });

    return { payment, clientSecret: si.clientSecret, setupIntentId: si.id };
  }

  /* ---------------- off-session recurring ---------------- */

  /**
   * Charge a scheduled recurring visit.
   *
   * Each occurrence is priced and charged on its own — never a fixed Stripe
   * subscription, because products, travel, add-ons and tax can all change
   * between visits.
   */
  async chargeScheduledBooking(bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { service: true, payments: true },
    });
    if (!booking) throw new PaymentError('Booking not found.', 'BOOKING_NOT_FOUND');

    if (booking.payments.some((p) => p.status === 'SUCCEEDED')) {
      return { skipped: true, reason: 'ALREADY_PAID' as const };
    }

    const config = await this.prisma.businessConfiguration.findUnique({
      where: { id: 'default' },
    });
    const timing = config?.recurringPaymentTiming ?? '24_HOURS_BEFORE';
    const eligibleAt = chargeEligibleAt(booking.startAt, timing);
    if (eligibleAt === null) return { skipped: true, reason: 'PAY_LATER' as const };
    if (this.now() < eligibleAt) return { skipped: true, reason: 'NOT_YET_DUE' as const };

    const method = await this.prisma.paymentMethodReference.findFirst({
      where: { customerId: booking.customerId, isDefault: true },
    });
    if (!method) {
      throw new PaymentError('No saved payment method.', 'NO_PAYMENT_METHOD');
    }

    const stripeCustomerId = await this.ensureStripeCustomer(booking.customerId);

    // Keyed on the booking, so a worker running twice charges once.
    const { result: intent } = await this.withProviderIdempotency(
      'offsession_charge',
      booking.customerId,
      `booking:${bookingId}`,
      { bookingId, amountCents: booking.grandTotalCents },
      (providerKey) =>
        this.stripe.createPaymentIntent({
          amountCents: booking.grandTotalCents,
          currency: 'cad',
          customerId: stripeCustomerId,
          idempotencyKey: providerKey,
          offSession: true,
          paymentMethodId: method.providerMethodId,
          metadata: { r2netteBookingId: bookingId, r2netteCustomerId: booking.customerId },
        }),
    );

    const status = mapProviderStatus(intent.status);
    const payment = await this.prisma.payment.upsert({
      where: { stripePaymentIntentId: intent.id },
      create: {
        bookingId,
        customerId: booking.customerId,
        quoteId: booking.quoteId,
        currency: 'CAD',
        amountCents: booking.grandTotalCents,
        status,
        policy: 'FULL_PAYMENT',
        offSession: true,
        requiresAction: status === 'REQUIRES_ACTION',
        stripeCustomerId,
        stripePaymentIntentId: intent.id,
        stripePaymentMethodId: method.providerMethodId,
      },
      update: { status, requiresAction: status === 'REQUIRES_ACTION' },
    });

    if (status === 'REQUIRES_ACTION') {
      await this.transitionBooking(bookingId, 'PAYMENT_ACTION_REQUIRED', 'Authentication required');
    }
    return { skipped: false, payment, status };
  }

  private async transitionBooking(bookingId: string, status: string, reason: string) {
    await this.prisma.booking.update({ where: { id: bookingId }, data: { status } });
    await this.prisma.bookingStatusHistory.create({
      data: { bookingId, status, actor: 'SYSTEM', reason },
    });
  }

  /* ---------------- webhook ---------------- */

  /**
   * Process a verified Stripe event exactly once.
   *
   * The StripeEvent primary key is the Stripe event id, so a replayed
   * delivery collides on insert and returns without touching anything.
   */
  async handleWebhookEvent(event: StripeWebhookEvent): Promise<{ processed: boolean }> {
    try {
      await this.prisma.stripeEvent.create({
        data: { id: event.id, type: event.type, status: 'PROCESSING' },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return { processed: false }; // replay
      }
      throw e;
    }

    try {
      await this.applyEvent(event);
      await this.prisma.stripeEvent.update({
        where: { id: event.id },
        data: { status: 'PROCESSED', processedAt: this.now() },
      });
      return { processed: true };
    } catch (e) {
      await this.prisma.stripeEvent.update({
        where: { id: event.id },
        data: { status: 'FAILED', error: (e as Error).message },
      });
      throw e;
    }
  }

  private async applyEvent(event: StripeWebhookEvent): Promise<void> {
    const obj = event.data.object;
    const intentId = obj.id as string | undefined;

    switch (event.type) {
      case 'payment_intent.succeeded': {
        const payment = await this.prisma.payment.findUnique({
          where: { stripePaymentIntentId: intentId },
        });
        if (!payment) return;

        await this.prisma.$transaction(async (tx) => {
          await tx.payment.update({
            where: { id: payment.id },
            data: {
              status: 'SUCCEEDED',
              paidAt: this.now(),
              requiresAction: false,
              stripePaymentMethodId: (obj.payment_method as string | null) ?? undefined,
            },
          });
          if (payment.bookingId) {
            await tx.booking.update({
              where: { id: payment.bookingId },
              data: { status: 'CONFIRMED' },
            });
            await tx.bookingStatusHistory.create({
              data: {
                bookingId: payment.bookingId,
                status: 'CONFIRMED',
                actor: 'STRIPE_WEBHOOK',
                reason: 'Payment succeeded',
              },
            });
            // Commitment point for payment-required policies: redeem the
            // reserved welcome offer, exactly once.
            const claim = await tx.promotionClaim.findFirst({
              where: { bookingId: payment.bookingId, status: 'RESERVED' },
            });
            if (claim) {
              await tx.promotionClaim.update({
                where: { id: claim.id },
                data: { status: 'REDEEMED', redeemedAt: this.now(), expiresAt: null },
              });
            }
          }
        });
        return;
      }

      case 'payment_intent.payment_failed': {
        const payment = await this.prisma.payment.findUnique({
          where: { stripePaymentIntentId: intentId },
        });
        if (!payment) return;
        const err = obj.last_payment_error as { code?: string; message?: string } | undefined;
        await this.prisma.payment.update({
          where: { id: payment.id },
          data: {
            status: 'FAILED',
            failedAt: this.now(),
            failureCode: err?.code ?? null,
            failureMessage: err?.message ?? null,
          },
        });
        // The booking is NOT confirmed, and the welcome offer goes back.
        if (payment.bookingId) {
          const claim = await this.prisma.promotionClaim.findFirst({
            where: { bookingId: payment.bookingId, status: 'RESERVED' },
          });
          if (claim) await this.claims.release(claim.id, 'PAYMENT_FAILED');
        }
        return;
      }

      case 'payment_intent.processing': {
        await this.prisma.payment.updateMany({
          where: { stripePaymentIntentId: intentId },
          data: { status: 'PROCESSING' },
        });
        return;
      }

      case 'payment_intent.canceled': {
        await this.prisma.payment.updateMany({
          where: { stripePaymentIntentId: intentId },
          data: { status: 'CANCELLED' },
        });
        return;
      }

      case 'setup_intent.succeeded': {
        const payment = await this.prisma.payment.findUnique({
          where: { stripeSetupIntentId: intentId },
        });
        if (!payment) return;
        const pm = obj.payment_method as string | null;
        if (pm) {
          // Token only. No PAN, no CVC, ever.
          await this.prisma.paymentMethodReference.upsert({
            where: { providerMethodId: pm },
            create: {
              customerId: payment.customerId,
              providerMethodId: pm,
              methodType: 'card',
              isDefault: true,
            },
            update: { isDefault: true },
          });
        }
        await this.prisma.payment.update({
          where: { id: payment.id },
          data: { status: 'SUCCEEDED', stripePaymentMethodId: pm, paidAt: this.now() },
        });
        return;
      }

      case 'setup_intent.setup_failed': {
        await this.prisma.payment.updateMany({
          where: { stripeSetupIntentId: intentId },
          data: { status: 'FAILED', failedAt: this.now() },
        });
        return;
      }

      case 'charge.refunded': {
        const pi = obj.payment_intent as string | undefined;
        if (!pi) return;
        const payment = await this.prisma.payment.findUnique({
          where: { stripePaymentIntentId: pi },
        });
        if (!payment) return;
        const refunded = Number(obj.amount_refunded ?? 0);
        await this.prisma.payment.update({
          where: { id: payment.id },
          data: {
            refundedAmountCents: refunded,
            status: refunded >= payment.amountCents ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
          },
        });
        return;
      }

      default:
        return; // unhandled types are recorded but ignored
    }
  }
}
