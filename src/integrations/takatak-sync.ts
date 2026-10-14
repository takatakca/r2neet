import { createHash, createHmac } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';

export type R2NetteProfileEventType =
  | 'CUSTOMER_REGISTERED'
  | 'PROFILE_UPDATED'
  | 'ADDRESS_UPDATED'
  | 'ACCOUNT_STATUS_UPDATED';

export type TakatakPaymentStatus =
  | 'PENDING'
  | 'PAID'
  | 'FAILED'
  | 'REFUNDED'
  | 'PARTIALLY_REFUNDED';

type Db = PrismaClient | Prisma.TransactionClient;
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface TakatakSyncConfig {
  enabled: boolean;
  configured: boolean;
  url: string | null;
  clientId: string | null;
  secret: string | null;
}

export function loadTakatakSyncConfig(
  env: Record<string, string | undefined> = process.env,
): TakatakSyncConfig {
  const enabled = env.TAKATAK_R2NETTE_SYNC_ENABLED === 'true';
  const url = env.TAKATAK_R2NETTE_SYNC_URL?.trim() || null;
  const clientId = env.TAKATAK_R2NETTE_SYNC_CLIENT_ID?.trim() || null;
  const secret = env.TAKATAK_R2NETTE_SYNC_WEBHOOK_SECRET?.trim() || null;
  return {
    enabled,
    configured: enabled && Boolean(url && clientId && secret),
    url,
    clientId,
    secret,
  };
}

function safeSyncUrl(value: string): URL {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password) {
    throw new Error('TAKATAK_R2NETTE_SYNC_URL must be HTTPS (localhost HTTP is allowed for tests).');
  }
  return url;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function eventId(prefix: string, externalUserId: string, body: unknown): string {
  return `r2nette:${prefix}:${externalUserId}:${fingerprint(body).slice(0, 32)}`;
}

function iso(value: Date | null | undefined): string | undefined {
  return value ? value.toISOString() : undefined;
}

export interface ProfileSnapshot {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  preferredLocale: string;
  registrationCompletedAt: Date | null;
  termsAcceptedAt: Date | null;
  privacyAcceptedAt: Date | null;
  marketingConsent: boolean;
  marketingConsentUpdatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  phones: Array<{
    phoneE164: string;
    verifiedAt: Date | null;
    isPrimary: boolean;
  }>;
  addresses: Array<{
    id: string;
    formattedAddress: string;
    streetNumber: string | null;
    route: string | null;
    unit: string | null;
    city: string;
    province: string;
    postalCode: string;
    country: string;
  }>;
}

function consentRecords(snapshot: ProfileSnapshot) {
  const records: Array<{
    type: string;
    status: 'GRANTED' | 'DENIED' | 'REVOKED';
    recordedAt: string;
  }> = [];

  if (snapshot.termsAcceptedAt) {
    records.push({
      type: 'TERMS',
      status: 'GRANTED',
      recordedAt: snapshot.termsAcceptedAt.toISOString(),
    });
  }
  if (snapshot.privacyAcceptedAt) {
    records.push({
      type: 'PRIVACY',
      status: 'GRANTED',
      recordedAt: snapshot.privacyAcceptedAt.toISOString(),
    });
  }
  records.push({
    type: 'MARKETING',
    status: snapshot.marketingConsent ? 'GRANTED' : 'DENIED',
    recordedAt: (
      snapshot.marketingConsentUpdatedAt ??
      snapshot.registrationCompletedAt ??
      snapshot.updatedAt
    ).toISOString(),
  });
  return records;
}

export function buildProfileEvent(
  snapshot: ProfileSnapshot,
  eventType: R2NetteProfileEventType,
  occurredAt: Date = snapshot.updatedAt,
) {
  const primary =
    snapshot.phones.find((phone) => phone.isPrimary) ??
    snapshot.phones[0] ??
    null;

  const core = {
    eventType,
    sourceApplication: 'R2NETTE' as const,
    externalUserId: snapshot.id,
    collectedFields: {
      ...(snapshot.firstName ? { firstName: snapshot.firstName } : {}),
      ...(snapshot.lastName ? { lastName: snapshot.lastName } : {}),
      ...(snapshot.email ? { email: snapshot.email } : {}),
      ...(primary ? { phone: primary.phoneE164 } : {}),
      locale: snapshot.preferredLocale === 'fr' ? ('fr' as const) : ('en' as const),
      accountStatus: snapshot.registrationCompletedAt ? 'ACTIVE' : 'INCOMPLETE',
      registeredAt: iso(snapshot.registrationCompletedAt) ?? snapshot.createdAt.toISOString(),
      updatedAt: snapshot.updatedAt.toISOString(),
      addresses: snapshot.addresses.map((address) => ({
        id: address.id,
        type: 'CLEANING_SERVICE',
        line1:
          [address.streetNumber, address.route].filter(Boolean).join(' ').trim() ||
          address.formattedAddress,
        ...(address.unit ? { line2: address.unit } : {}),
        city: address.city,
        province: address.province,
        postalCode: address.postalCode,
        country: address.country,
        active: true,
      })),
    },
    verifiedFields: primary?.verifiedAt ? (['phone'] as const) : ([] as const),
    consentRecords: consentRecords(snapshot),
    occurredAt: occurredAt.toISOString(),
  };

  return {
    eventId: eventId(eventType.toLowerCase(), snapshot.id, core),
    ...core,
  };
}

export function mapTakatakPaymentStatus(status: string): TakatakPaymentStatus {
  switch (status) {
    case 'SUCCEEDED':
      return 'PAID';
    case 'FAILED':
    case 'CANCELLED':
      return 'FAILED';
    case 'REFUNDED':
      return 'REFUNDED';
    case 'PARTIALLY_REFUNDED':
      return 'PARTIALLY_REFUNDED';
    default:
      return 'PENDING';
  }
}

export interface PaymentSnapshot {
  id: string;
  customerId: string;
  amountCents: number;
  refundedAmountCents: number;
  currency: string;
  status: string;
  stripeCustomerId: string | null;
  paidAt: Date | null;
  failedAt: Date | null;
  updatedAt: Date;
  booking: { bookingNumber: string } | null;
}

export function buildPaymentEvent(
  snapshot: PaymentSnapshot,
  occurredAt: Date = snapshot.updatedAt,
) {
  if (!snapshot.booking) return null;
  const status = mapTakatakPaymentStatus(snapshot.status);
  const core = {
    eventType: 'PAYMENT_SUMMARY_UPDATED' as const,
    sourceApplication: 'R2NETTE' as const,
    externalUserId: snapshot.customerId,
    payment: {
      bookingNumber: snapshot.booking.bookingNumber,
      status,
      amount: snapshot.amountCents,
      ...(snapshot.refundedAmountCents > 0
        ? { refundedAmount: snapshot.refundedAmountCents }
        : {}),
      currency: snapshot.currency.toUpperCase(),
      transactionDate: (
        snapshot.paidAt ??
        snapshot.failedAt ??
        snapshot.updatedAt
      ).toISOString(),
      ...(snapshot.stripeCustomerId
        ? { stripeCustomerReference: snapshot.stripeCustomerId }
        : {}),
    },
    occurredAt: occurredAt.toISOString(),
  };
  return {
    eventId: eventId('payment', snapshot.customerId, {
      paymentId: snapshot.id,
      ...core,
    }),
    ...core,
  };
}

async function loadProfile(db: Db, customerId: string): Promise<ProfileSnapshot> {
  return db.customer.findUniqueOrThrow({
    where: { id: customerId },
    include: {
      phones: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] },
      addresses: { orderBy: { createdAt: 'asc' } },
    },
  });
}

export async function enqueueCustomerProfile(
  db: Db,
  customerId: string,
  eventType: R2NetteProfileEventType,
  occurredAt?: Date,
) {
  const snapshot = await loadProfile(db, customerId);
  const payload = buildProfileEvent(snapshot, eventType, occurredAt ?? snapshot.updatedAt);
  return db.takatakSyncEvent.upsert({
    where: { id: payload.eventId },
    create: {
      id: payload.eventId,
      eventType,
      externalUserId: customerId,
      priority: 10,
      payload: payload as unknown as Prisma.InputJsonValue,
    },
    update: {
      payload: payload as unknown as Prisma.InputJsonValue,
    },
  });
}

export async function enqueuePaymentSummary(
  db: Db,
  paymentId: string,
  occurredAt?: Date,
) {
  const payment = await db.payment.findUniqueOrThrow({
    where: { id: paymentId },
    include: {
      booking: { select: { bookingNumber: true } },
    },
  });

  // TAKATAK intentionally rejects payment summaries for unknown profiles.
  // Queue a current profile snapshot first; priority guarantees it is delivered
  // before the payment event even if this is the first integration touchpoint.
  await enqueueCustomerProfile(
    db,
    payment.customerId,
    'PROFILE_UPDATED',
    occurredAt ?? payment.updatedAt,
  );

  const payload = buildPaymentEvent(payment, occurredAt ?? payment.updatedAt);
  if (!payload) return null;

  return db.takatakSyncEvent.upsert({
    where: { id: payload.eventId },
    create: {
      id: payload.eventId,
      eventType: payload.eventType,
      externalUserId: payment.customerId,
      priority: 20,
      payload: payload as unknown as Prisma.InputJsonValue,
    },
    update: {
      payload: payload as unknown as Prisma.InputJsonValue,
    },
  });
}

export function signTakatakRequest(
  secret: string,
  timestamp: string,
  eventIdValue: string,
  rawBody: string,
): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.${eventIdValue}.${rawBody}`, 'utf8')
    .digest('hex');
}

const BACKOFF_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
] as const;
const MAX_ATTEMPTS = 12;
const LEASE_MS = 2 * 60_000;

function retryAt(attempts: number, now: Date): Date {
  const delay = BACKOFF_MS[Math.min(Math.max(attempts - 1, 0), BACKOFF_MS.length - 1)]!;
  return new Date(now.getTime() + delay);
}

function remoteError(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === 'string') return parsed.error.slice(0, 300);
  } catch {
    // The remote body is intentionally not persisted verbatim.
  }
  return 'Remote synchronization request failed.';
}

export class TakatakSyncDispatcher {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly env: Record<string, string | undefined> = process.env,
    private readonly now: () => Date = () => new Date(),
    private readonly fetcher: FetchLike = fetch,
  ) {}

  private config() {
    const config = loadTakatakSyncConfig(this.env);
    if (!config.enabled) return config;
    if (!config.configured || !config.url || !config.clientId || !config.secret) {
      throw new Error(
        'TAKATAK R2NETTE sync is enabled but URL, client id, or webhook secret is missing.',
      );
    }
    safeSyncUrl(config.url);
    return config;
  }

  private async claim(workerId: string) {
    const at = this.now();
    for (let tries = 0; tries < 5; tries += 1) {
      const candidate = await this.prisma.takatakSyncEvent.findFirst({
        where: {
          status: { in: ['PENDING', 'RETRY'] },
          nextAttemptAt: { lte: at },
          OR: [{ claimedUntil: null }, { claimedUntil: { lt: at } }],
        },
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      });
      if (!candidate) return null;

      const claimed = await this.prisma.takatakSyncEvent.updateMany({
        where: {
          id: candidate.id,
          status: { in: ['PENDING', 'RETRY'] },
          OR: [{ claimedUntil: null }, { claimedUntil: { lt: at } }],
        },
        data: {
          claimedBy: workerId,
          claimedUntil: new Date(at.getTime() + LEASE_MS),
        },
      });
      if (claimed.count === 1) {
        return this.prisma.takatakSyncEvent.findUniqueOrThrow({
          where: { id: candidate.id },
        });
      }
    }
    return null;
  }

  private async finishRetry(
    id: string,
    attempts: number,
    httpStatus: number | null,
    error: string,
  ) {
    const at = this.now();
    const dead = attempts >= MAX_ATTEMPTS;
    await this.prisma.takatakSyncEvent.update({
      where: { id },
      data: {
        status: dead ? 'DEAD' : 'RETRY',
        attempts,
        lastAttemptAt: at,
        lastHttpStatus: httpStatus,
        lastError: error.slice(0, 500),
        nextAttemptAt: dead ? at : retryAt(attempts, at),
        claimedBy: null,
        claimedUntil: null,
      },
    });
    return dead;
  }

  async runBatch(workerId = `takatak-${process.pid}`, limit = 25) {
    const config = this.config();
    if (!config.enabled) {
      return { skipped: 'DISABLED', delivered: 0, retried: 0, dead: 0 };
    }

    let delivered = 0;
    let retried = 0;
    let dead = 0;

    for (let index = 0; index < limit; index += 1) {
      const row = await this.claim(workerId);
      if (!row) break;

      const rawBody = JSON.stringify(row.payload);
      const timestamp = Math.floor(this.now().getTime() / 1000).toString();
      const signature = signTakatakRequest(
        config.secret!,
        timestamp,
        row.id,
        rawBody,
      );
      const attempts = row.attempts + 1;

      try {
        const response = await this.fetcher(config.url!, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-integration-id': config.clientId!,
            'x-event-id': row.id,
            'x-timestamp': timestamp,
            'x-signature': `sha256=${signature}`,
          },
          body: rawBody,
          signal: AbortSignal.timeout(10_000),
        });
        const text = await response.text();

        if (response.ok) {
          await this.prisma.takatakSyncEvent.update({
            where: { id: row.id },
            data: {
              status: 'DELIVERED',
              attempts,
              lastAttemptAt: this.now(),
              deliveredAt: this.now(),
              lastHttpStatus: response.status,
              lastError: null,
              claimedBy: null,
              claimedUntil: null,
            },
          });
          delivered += 1;
          continue;
        }

        const retryable =
          response.status === 408 ||
          response.status === 425 ||
          response.status === 429 ||
          response.status >= 500 ||
          (response.status === 409 && row.eventType === 'PAYMENT_SUMMARY_UPDATED');

        if (retryable) {
          const becameDead = await this.finishRetry(
            row.id,
            attempts,
            response.status,
            remoteError(text),
          );
          becameDead ? (dead += 1) : (retried += 1);
        } else {
          await this.prisma.takatakSyncEvent.update({
            where: { id: row.id },
            data: {
              status: 'DEAD',
              attempts,
              lastAttemptAt: this.now(),
              lastHttpStatus: response.status,
              lastError: remoteError(text),
              claimedBy: null,
              claimedUntil: null,
            },
          });
          dead += 1;
        }
      } catch (error) {
        const becameDead = await this.finishRetry(
          row.id,
          attempts,
          null,
          error instanceof Error ? error.message : 'Network error',
        );
        becameDead ? (dead += 1) : (retried += 1);
      }
    }

    return { delivered, retried, dead };
  }
}
