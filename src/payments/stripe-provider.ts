import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';

/**
 * Stripe provider boundary.
 *
 * Domain code never touches the Stripe SDK directly. That keeps the payment
 * rules testable without network calls and stops Stripe's vocabulary leaking
 * into business logic.
 */

export class StripeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    /** Retryable means "we do not know if Stripe got it" — network, 5xx, timeout. */
    readonly retryable: boolean = false,
  ) {
    super(message);
  }
}

export type ProviderIntentStatus =
  | 'requires_payment_method'
  | 'requires_confirmation'
  | 'requires_action'
  | 'processing'
  | 'succeeded'
  | 'canceled';

export interface ProviderPaymentIntent {
  id: string;
  clientSecret: string;
  status: ProviderIntentStatus;
  amountCents: number;
  currency: string;
  paymentMethodId?: string | null;
  paymentMethodType?: string | null;
  walletType?: string | null;
  riskLevel?: string | null;
  riskScore?: number | null;
  threeDSecureStatus?: string | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
}

export interface ProviderSetupIntent {
  id: string;
  clientSecret: string;
  status: 'requires_payment_method' | 'requires_action' | 'succeeded' | 'canceled';
  paymentMethodId?: string | null;
}

export interface CreatePaymentIntentInput {
  amountCents: number;
  currency: string;
  customerId: string;
  /** Reused verbatim across retries of the same logical operation. */
  idempotencyKey: string;
  offSession?: boolean;
  paymentMethodId?: string | null;
  confirm?: boolean;
  /** Safe internal identifiers only — never addresses, notes or door codes. */
  metadata?: Record<string, string>;
}

export interface StripeProvider {
  readonly name: string;
  readonly configured: boolean;
  ensureCustomer(r2netteCustomerId: string, idempotencyKey: string): Promise<string>;
  createPaymentIntent(input: CreatePaymentIntentInput): Promise<ProviderPaymentIntent>;
  retrievePaymentIntent(id: string): Promise<ProviderPaymentIntent>;
  cancelPaymentIntent(id: string): Promise<ProviderPaymentIntent>;
  createSetupIntent(input: {
    customerId: string;
    idempotencyKey: string;
    metadata?: Record<string, string>;
  }): Promise<ProviderSetupIntent>;
  createRefund(input: {
    paymentIntentId: string;
    amountCents?: number;
    idempotencyKey: string;
  }): Promise<{ id: string; status: string; amountCents: number }>;
  verifyWebhook(rawBody: string, signatureHeader: string, secret: string): StripeWebhookEvent;
}

export interface StripeWebhookEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

/* ------------------------------------------------------------------ */
/* signature verification                                              */
/* ------------------------------------------------------------------ */

/**
 * Webhook verification is delegated to the official Stripe SDK.
 *
 * This was previously a bespoke HMAC implementation. That was wrong: Stripe's
 * header format, timestamp tolerance and signature-rotation semantics are
 * theirs to change, and rolling our own crypto against a moving spec is how
 * verification silently breaks. `constructEvent` also enforces the thing that
 * matters most — verification happens against the RAW, unmodified bytes.
 *
 * The body must never be JSON-parsed before this call. Round-tripping through
 * JSON.parse/stringify reorders keys and changes whitespace, and the
 * signature then fails on a request that was perfectly valid.
 */
const verifier = new Stripe('sk_test_placeholder_for_verification_only', {
  apiVersion: undefined as never,
});

export function verifyStripeSignature(
  rawBody: string | Buffer,
  signatureHeader: string,
  secret: string,
  toleranceSeconds = 300,
): StripeWebhookEvent {
  try {
    const event = verifier.webhooks.constructEvent(
      rawBody,
      signatureHeader,
      secret,
      toleranceSeconds,
    );
    return event as unknown as StripeWebhookEvent;
  } catch (e) {
    const message = (e as Error).message ?? 'Signature verification failed.';
    const stale = /timestamp/i.test(message) || /too old/i.test(message);
    throw new StripeError(
      message,
      stale ? 'WEBHOOK_STALE' : 'WEBHOOK_BAD_SIGNATURE',
    );
  }
}

/**
 * Build a signature header for tests and local development, using the SDK's
 * own generator so the test exercises the real verification path rather than
 * a matching pair of homemade functions.
 */
export function signStripePayload(
  rawBody: string,
  secret: string,
  timestamp?: number,
): string {
  return verifier.webhooks.generateTestHeaderString({
    payload: rawBody,
    secret,
    timestamp: timestamp ?? Math.floor(Date.now() / 1000),
  });
}

/* ------------------------------------------------------------------ */
/* real provider                                                       */
/* ------------------------------------------------------------------ */

/**
 * Production implementation against Stripe's REST API.
 *
 * Every mutating call sends `Idempotency-Key`, supplied by the caller rather
 * than generated here — the caller owns the durable record that makes a retry
 * reuse the same key.
 */
export class LiveStripeProvider implements StripeProvider {
  readonly name = 'stripe';
  private readonly secret: string | undefined;
  private readonly webhookSecret: string | undefined;
  private readonly apiVersion: string;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.secret = env.STRIPE_SECRET_KEY;
    this.webhookSecret = env.STRIPE_WEBHOOK_SECRET;
    this.apiVersion = env.STRIPE_API_VERSION ?? '2024-06-20';
  }

  get configured(): boolean {
    return Boolean(this.secret);
  }

  /** Guard against a live key reaching an automated test run. */
  get isTestMode(): boolean {
    return Boolean(this.secret?.startsWith('sk_test_'));
  }

  private assertConfigured(): void {
    if (!this.configured) {
      throw new StripeError(
        'Payments are not configured. Add STRIPE_SECRET_KEY.',
        'INTEGRATION_NOT_CONFIGURED',
      );
    }
  }

  private async call<T>(
    path: string,
    body: Record<string, string>,
    idempotencyKey?: string,
    method: 'POST' | 'GET' = 'POST',
  ): Promise<T> {
    this.assertConfigured();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.secret}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': this.apiVersion,
    };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    let res: Response;
    try {
      res = await fetch(`https://api.stripe.com/v1/${path}`, {
        method,
        headers,
        body: method === 'POST' ? new URLSearchParams(body) : undefined,
      });
    } catch (e) {
      // Network failure: Stripe may or may not have processed the request.
      // Retryable, and the caller must reuse the same idempotency key.
      throw new StripeError((e as Error).message, 'STRIPE_NETWORK', true);
    }

    const json = (await res.json()) as { error?: { code?: string; message?: string } };
    if (!res.ok) {
      const retryable = res.status >= 500 || res.status === 429;
      throw new StripeError(
        json.error?.message ?? 'Stripe request failed.',
        json.error?.code ?? `STRIPE_HTTP_${res.status}`,
        retryable,
      );
    }
    return json as T;
  }

  async ensureCustomer(r2netteCustomerId: string, idempotencyKey: string): Promise<string> {
    const out = await this.call<{ id: string }>(
      'customers',
      { 'metadata[r2netteCustomerId]': r2netteCustomerId },
      idempotencyKey,
    );
    return out.id;
  }

  async createPaymentIntent(input: CreatePaymentIntentInput): Promise<ProviderPaymentIntent> {
    const body: Record<string, string> = {
      amount: String(input.amountCents),
      currency: input.currency.toLowerCase(),
      customer: input.customerId,
      // DYNAMIC 3DS: let Stripe and the issuer decide. Forcing a challenge on
      // every payment measurably hurts conversion.
      'automatic_payment_methods[enabled]': 'true',
    };
    if (input.offSession) {
      body.off_session = 'true';
      body.confirm = 'true';
    }
    if (input.paymentMethodId) body.payment_method = input.paymentMethodId;
    if (input.confirm && !input.offSession) body.confirm = 'true';
    for (const [k, v] of Object.entries(input.metadata ?? {})) body[`metadata[${k}]`] = v;

    const pi = await this.call<Record<string, unknown>>(
      'payment_intents',
      body,
      input.idempotencyKey,
    );
    return mapIntent(pi);
  }

  async retrievePaymentIntent(id: string): Promise<ProviderPaymentIntent> {
    return mapIntent(await this.call<Record<string, unknown>>(`payment_intents/${id}`, {}, undefined, 'GET'));
  }

  async cancelPaymentIntent(id: string): Promise<ProviderPaymentIntent> {
    return mapIntent(await this.call<Record<string, unknown>>(`payment_intents/${id}/cancel`, {}));
  }

  async createSetupIntent(input: {
    customerId: string;
    idempotencyKey: string;
    metadata?: Record<string, string>;
  }): Promise<ProviderSetupIntent> {
    const body: Record<string, string> = {
      customer: input.customerId,
      usage: 'off_session',
      'automatic_payment_methods[enabled]': 'true',
    };
    for (const [k, v] of Object.entries(input.metadata ?? {})) body[`metadata[${k}]`] = v;
    const si = await this.call<Record<string, unknown>>('setup_intents', body, input.idempotencyKey);
    return {
      id: String(si.id),
      clientSecret: String(si.client_secret),
      status: si.status as ProviderSetupIntent['status'],
      paymentMethodId: (si.payment_method as string | null) ?? null,
    };
  }

  async createRefund(input: {
    paymentIntentId: string;
    amountCents?: number;
    idempotencyKey: string;
  }) {
    const body: Record<string, string> = { payment_intent: input.paymentIntentId };
    if (input.amountCents !== undefined) body.amount = String(input.amountCents);
    const r = await this.call<Record<string, unknown>>('refunds', body, input.idempotencyKey);
    return { id: String(r.id), status: String(r.status), amountCents: Number(r.amount) };
  }

  verifyWebhook(rawBody: string, signatureHeader: string, secret: string): StripeWebhookEvent {
    return verifyStripeSignature(rawBody, signatureHeader, secret ?? this.webhookSecret ?? '');
  }
}

function mapIntent(pi: Record<string, unknown>): ProviderPaymentIntent {
  const charges = pi.charges as { data?: Record<string, unknown>[] } | undefined;
  const charge = charges?.data?.[0];
  const outcome = charge?.outcome as Record<string, unknown> | undefined;
  const lastError = pi.last_payment_error as Record<string, unknown> | undefined;
  return {
    id: String(pi.id),
    clientSecret: String(pi.client_secret ?? ''),
    status: pi.status as ProviderIntentStatus,
    amountCents: Number(pi.amount),
    currency: String(pi.currency),
    paymentMethodId: (pi.payment_method as string | null) ?? null,
    paymentMethodType: (charge?.payment_method_details as { type?: string } | undefined)?.type ?? null,
    riskLevel: (outcome?.risk_level as string | undefined) ?? null,
    riskScore: outcome?.risk_score !== undefined ? Number(outcome.risk_score) : null,
    lastErrorCode: (lastError?.code as string | undefined) ?? null,
    lastErrorMessage: (lastError?.message as string | undefined) ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* fake provider                                                       */
/* ------------------------------------------------------------------ */

/**
 * Deterministic provider for tests.
 *
 * Crucially it honours idempotency keys the way Stripe does: the same key
 * returns the same intent instead of creating a second one. That is what lets
 * the timeout-retry test mean something.
 */
export class FakeStripeProvider implements StripeProvider {
  readonly name = 'fake_stripe';
  readonly configured = true;

  customers = new Map<string, string>();
  intents = new Map<string, ProviderPaymentIntent>();
  setupIntents = new Map<string, ProviderSetupIntent>();
  refunds: { id: string; paymentIntentId: string; amountCents: number }[] = [];

  /** Keyed by idempotency key — mirrors Stripe's own replay behaviour. */
  private byKey = new Map<string, string>();

  /** Counts real creation attempts, so tests can assert "only one". */
  createPaymentIntentCalls = 0;
  createCustomerCalls = 0;

  /** Test controls. */
  nextStatus: ProviderIntentStatus = 'succeeded';
  failNextWith: StripeError | null = null;
  /** Simulates "Stripe processed it but we never saw the response". */
  timeoutAfterCreate = false;

  async ensureCustomer(r2netteCustomerId: string, idempotencyKey: string): Promise<string> {
    const existing = this.byKey.get(`cus:${idempotencyKey}`);
    if (existing) return existing;
    this.createCustomerCalls++;
    const id = `cus_fake_${this.customers.size + 1}`;
    this.customers.set(id, r2netteCustomerId);
    this.byKey.set(`cus:${idempotencyKey}`, id);
    return id;
  }

  async createPaymentIntent(input: CreatePaymentIntentInput): Promise<ProviderPaymentIntent> {
    const replayed = this.byKey.get(`pi:${input.idempotencyKey}`);
    if (replayed) return this.intents.get(replayed)!;

    if (this.failNextWith) {
      const err = this.failNextWith;
      this.failNextWith = null;
      throw err;
    }

    this.createPaymentIntentCalls++;
    const id = `pi_fake_${this.intents.size + 1}`;
    const intent: ProviderPaymentIntent = {
      id,
      clientSecret: `${id}_secret_${randomUUID().slice(0, 8)}`,
      status: this.nextStatus,
      amountCents: input.amountCents,
      currency: input.currency,
      paymentMethodId: input.paymentMethodId ?? null,
      paymentMethodType: 'card',
      riskLevel: 'normal',
      riskScore: 12,
      lastErrorCode: this.nextStatus === 'canceled' ? 'card_declined' : null,
    };
    this.intents.set(id, intent);
    // Registered BEFORE the simulated timeout, exactly like Stripe: the object
    // exists on their side even though our process never saw the response.
    this.byKey.set(`pi:${input.idempotencyKey}`, id);

    if (this.timeoutAfterCreate) {
      this.timeoutAfterCreate = false;
      throw new StripeError('socket hang up', 'STRIPE_NETWORK', true);
    }
    return intent;
  }

  async retrievePaymentIntent(id: string): Promise<ProviderPaymentIntent> {
    const pi = this.intents.get(id);
    if (!pi) throw new StripeError('No such payment_intent', 'resource_missing');
    return pi;
  }

  async cancelPaymentIntent(id: string): Promise<ProviderPaymentIntent> {
    const pi = await this.retrievePaymentIntent(id);
    const updated = { ...pi, status: 'canceled' as const };
    this.intents.set(id, updated);
    return updated;
  }

  async createSetupIntent(input: {
    customerId: string;
    idempotencyKey: string;
  }): Promise<ProviderSetupIntent> {
    const replayed = this.byKey.get(`si:${input.idempotencyKey}`);
    if (replayed) return this.setupIntents.get(replayed)!;
    const id = `seti_fake_${this.setupIntents.size + 1}`;
    const si: ProviderSetupIntent = {
      id,
      clientSecret: `${id}_secret`,
      status: 'succeeded',
      paymentMethodId: `pm_fake_${this.setupIntents.size + 1}`,
    };
    this.setupIntents.set(id, si);
    this.byKey.set(`si:${input.idempotencyKey}`, id);
    return si;
  }

  async createRefund(input: { paymentIntentId: string; amountCents?: number; idempotencyKey: string }) {
    const replayed = this.byKey.get(`re:${input.idempotencyKey}`);
    if (replayed) {
      const r = this.refunds.find((x) => x.id === replayed)!;
      return { id: r.id, status: 'succeeded', amountCents: r.amountCents };
    }
    const pi = await this.retrievePaymentIntent(input.paymentIntentId);
    const id = `re_fake_${this.refunds.length + 1}`;
    const amount = input.amountCents ?? pi.amountCents;
    this.refunds.push({ id, paymentIntentId: input.paymentIntentId, amountCents: amount });
    this.byKey.set(`re:${input.idempotencyKey}`, id);
    return { id, status: 'succeeded', amountCents: amount };
  }

  verifyWebhook(rawBody: string, signatureHeader: string, secret: string): StripeWebhookEvent {
    return verifyStripeSignature(rawBody, signatureHeader, secret);
  }
}
