/**
 * R2NETTE phone identity.
 *
 * Phone is the canonical customer identity. Social login links to it later;
 * it never replaces it.
 *
 * We never store OTP codes. Twilio Verify owns code generation, expiry and
 * checking. This module owns normalization, abuse limits, and — critically —
 * the rule that NOTHING about a customer is revealed before verification.
 */

export class IdentityError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/* ------------------------------------------------------------------ */
/* E.164 normalization (Canada / NANP)                                 */
/* ------------------------------------------------------------------ */

export function normalizePhone(
  input: string,
  defaultCountry: '+1' = '+1',
): string {
  const raw = (input ?? '').trim();
  if (!raw) throw new IdentityError('Enter a phone number.', 'PHONE_EMPTY');

  const digits = raw.replace(/\D/g, '');

  let national: string;
  if (raw.startsWith('+')) {
    if (!digits.startsWith('1')) {
      throw new IdentityError(
        'We currently serve Canadian numbers only.',
        'PHONE_UNSUPPORTED_COUNTRY',
      );
    }
    national = digits.slice(1);
  } else if (digits.length === 11 && digits.startsWith('1')) {
    national = digits.slice(1);
  } else {
    national = digits;
  }

  if (national.length !== 10) {
    throw new IdentityError(
      'That phone number needs 10 digits.',
      'PHONE_INVALID_LENGTH',
    );
  }
  // NANP: area code and exchange both start 2-9
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(national)) {
    throw new IdentityError(
      'That does not look like a valid number.',
      'PHONE_INVALID_FORMAT',
    );
  }
  return `${defaultCountry}${national}`;
}

/** Display form that never exposes the full number in logs or UI. */
export function maskPhone(e164: string): string {
  const d = e164.replace(/\D/g, '');
  if (d.length < 10) return '•••';
  return `+1 ${d.slice(1, 4)} ••• ${d.slice(-4)}`;
}

/* ------------------------------------------------------------------ */
/* OTP provider boundary                                               */
/* ------------------------------------------------------------------ */

export type VerificationStatus = 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED';

export interface VerificationProvider {
  readonly name: string;
  readonly configured: boolean;
  start(phoneE164: string): Promise<{ status: VerificationStatus }>;
  check(
    phoneE164: string,
    code: string,
  ): Promise<{ status: VerificationStatus }>;
}

/**
 * Twilio Verify v2. Requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and
 * TWILIO_VERIFY_SERVICE_SID. Without them `configured` is false and the
 * application surfaces NOT_CONFIGURED rather than pretending to send.
 */
export class TwilioVerifyProvider implements VerificationProvider {
  readonly name = 'twilio_verify';
  private readonly sid: string | undefined;
  private readonly token: string | undefined;
  private readonly service: string | undefined;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.sid = env.TWILIO_ACCOUNT_SID;
    this.token = env.TWILIO_AUTH_TOKEN;
    this.service = env.TWILIO_VERIFY_SERVICE_SID;
  }

  get configured(): boolean {
    return Boolean(this.sid && this.token && this.service);
  }

  private auth(): string {
    return (
      'Basic ' + Buffer.from(`${this.sid}:${this.token}`).toString('base64')
    );
  }

  private assertConfigured(): void {
    if (!this.configured) {
      throw new IdentityError(
        'SMS verification is not configured. Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_VERIFY_SERVICE_SID.',
        'VERIFY_NOT_CONFIGURED',
      );
    }
  }

  async start(phoneE164: string): Promise<{ status: VerificationStatus }> {
    this.assertConfigured();
    const res = await fetch(
      `https://verify.twilio.com/v2/Services/${this.service}/Verifications`,
      {
        method: 'POST',
        headers: {
          Authorization: this.auth(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: phoneE164, Channel: 'sms' }),
      },
    );
    if (!res.ok)
      throw new IdentityError('Could not send the code.', 'VERIFY_SEND_FAILED');
    const json = (await res.json()) as { status: string };
    return { status: json.status.toUpperCase() as VerificationStatus };
  }

  async check(
    phoneE164: string,
    code: string,
  ): Promise<{ status: VerificationStatus }> {
    this.assertConfigured();
    const res = await fetch(
      `https://verify.twilio.com/v2/Services/${this.service}/VerificationCheck`,
      {
        method: 'POST',
        headers: {
          Authorization: this.auth(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: phoneE164, Code: code }),
      },
    );
    if (res.status === 404) return { status: 'EXPIRED' };
    if (!res.ok)
      throw new IdentityError(
        'Could not check that code.',
        'VERIFY_CHECK_FAILED',
      );
    const json = (await res.json()) as { status: string };
    return { status: json.status.toUpperCase() as VerificationStatus };
  }
}

/** Deterministic provider for tests and local development. Never used in production. */
export class FakeVerificationProvider implements VerificationProvider {
  readonly name = 'fake_verify';
  readonly configured = true;
  private readonly sent = new Map<string, string>();

  constructor(private readonly fixedCode = '123456') {}

  async start(phoneE164: string): Promise<{ status: VerificationStatus }> {
    this.sent.set(phoneE164, this.fixedCode);
    return { status: 'PENDING' };
  }

  async check(
    phoneE164: string,
    code: string,
  ): Promise<{ status: VerificationStatus }> {
    const expected = this.sent.get(phoneE164);
    if (!expected) return { status: 'EXPIRED' };
    if (expected !== code) return { status: 'DENIED' };
    this.sent.delete(phoneE164);
    return { status: 'APPROVED' };
  }
}

/* ------------------------------------------------------------------ */
/* abuse limits                                                        */
/* ------------------------------------------------------------------ */

export interface RateLimitPolicy {
  sendsPerPhonePerHour: number;
  sendsPerIpPerHour: number;
  checkAttemptsPerPhone: number;
  resendCooldownSeconds: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitPolicy = {
  sendsPerPhonePerHour: 5,
  sendsPerIpPerHour: 15,
  checkAttemptsPerPhone: 5,
  resendCooldownSeconds: 30,
};

interface Bucket {
  timestamps: number[];
  attempts: number;
}

/**
 * In-memory limiter. The interface is what matters — swap in Redis or a
 * Postgres table for multi-instance deployments without touching callers.
 */
export class RateLimiter {
  private readonly phones = new Map<string, Bucket>();
  private readonly ips = new Map<string, Bucket>();

  constructor(
    private readonly policy: RateLimitPolicy = DEFAULT_RATE_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  private bucket(map: Map<string, Bucket>, key: string): Bucket {
    let b = map.get(key);
    if (!b) {
      b = { timestamps: [], attempts: 0 };
      map.set(key, b);
    }
    const cutoff = this.now() - 3_600_000;
    b.timestamps = b.timestamps.filter((t) => t > cutoff);
    return b;
  }

  assertCanSend(phoneE164: string, ip: string): void {
    const p = this.bucket(this.phones, phoneE164);
    const i = this.bucket(this.ips, ip);

    const last = p.timestamps[p.timestamps.length - 1];
    if (
      last !== undefined &&
      this.now() - last < this.policy.resendCooldownSeconds * 1000
    ) {
      const wait = Math.ceil(
        (this.policy.resendCooldownSeconds * 1000 - (this.now() - last)) / 1000,
      );
      throw new IdentityError(
        `Wait ${wait}s before requesting another code.`,
        'OTP_COOLDOWN',
      );
    }
    if (p.timestamps.length >= this.policy.sendsPerPhonePerHour) {
      throw new IdentityError(
        'Too many codes requested. Try again later.',
        'OTP_PHONE_LIMIT',
      );
    }
    if (i.timestamps.length >= this.policy.sendsPerIpPerHour) {
      throw new IdentityError(
        'Too many codes requested. Try again later.',
        'OTP_IP_LIMIT',
      );
    }
  }

  recordSend(phoneE164: string, ip: string): void {
    this.bucket(this.phones, phoneE164).timestamps.push(this.now());
    this.bucket(this.ips, ip).timestamps.push(this.now());
    this.bucket(this.phones, phoneE164).attempts = 0;
  }

  assertCanCheck(phoneE164: string): void {
    const p = this.bucket(this.phones, phoneE164);
    if (p.attempts >= this.policy.checkAttemptsPerPhone) {
      throw new IdentityError(
        'Too many incorrect attempts. Request a new code.',
        'OTP_ATTEMPT_LIMIT',
      );
    }
  }

  recordFailedCheck(phoneE164: string): void {
    this.bucket(this.phones, phoneE164).attempts += 1;
  }

  clear(phoneE164: string): void {
    this.phones.delete(phoneE164);
  }
}

/* ------------------------------------------------------------------ */
/* customer resolution                                                 */
/* ------------------------------------------------------------------ */

export interface CustomerAddress {
  id: string;
  customerId: string;
  label: string | null;
  formattedAddress: string;
  placeId: string | null;
  city: string;
  province: string;
  postalCode: string;
  latitude: number | null;
  longitude: number | null;
  isDefault: boolean;
}

export interface CustomerProfile {
  id: string;
  phoneE164: string;
  firstName: string | null;
  email: string | null;
  preferredStaffId: string | null;
  lastServiceOptionId: string | null;
  lastProductSupply: string | null;
  lastFrequency: string | null;
  addresses: CustomerAddress[];
}

export interface CustomerRepository {
  findByPhone(phoneE164: string): Promise<CustomerProfile | null>;
  create(phoneE164: string): Promise<CustomerProfile>;
}

export interface VerifiedPhone {
  phoneE164: string;
  verifiedAt: Date;
  expiresAt: Date;
}

export interface VerifiedSession {
  phoneE164: string;
  customerId: string;
  isNewCustomer: boolean;
  verifiedAt: Date;
  expiresAt: Date;
}

export const SESSION_TTL_MINUTES = 60;

export class IdentityService {
  constructor(
    private readonly provider: VerificationProvider,
    private readonly customers: CustomerRepository,
    private readonly limiter: RateLimiter = new RateLimiter(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Send a code.
   *
   * Returns the SAME shape whether or not the number belongs to an existing
   * customer. Leaking "we know you" here would turn the endpoint into a
   * customer-enumeration oracle.
   */
  async startVerification(
    rawPhone: string,
    ip: string,
  ): Promise<{ sent: true; message: string; masked: string }> {
    const phone = normalizePhone(rawPhone);
    this.limiter.assertCanSend(phone, ip);
    await this.provider.start(phone);
    this.limiter.recordSend(phone, ip);
    return {
      sent: true,
      message: 'Enter the code we sent you.',
      masked: maskPhone(phone),
    };
  }

  /**
   * Verify an OTP without reading or creating a Customer.
   *
   * Sign-up uses this method so an abandoned registration never creates an
   * incomplete customer account.
   */
  async verifyPhone(rawPhone: string, code: string): Promise<VerifiedPhone> {
    const phone = normalizePhone(rawPhone);

    if (!/^\d{4,10}$/.test(code)) {
      throw new IdentityError('Enter the code we sent you.', 'OTP_MALFORMED');
    }

    this.limiter.assertCanCheck(phone);

    const result = await this.provider.check(phone, code);

    if (result.status !== 'APPROVED') {
      this.limiter.recordFailedCheck(phone);

      throw new IdentityError(
        result.status === 'EXPIRED'
          ? 'That code expired. Request a new one.'
          : 'That code is not right.',
        result.status === 'EXPIRED' ? 'OTP_EXPIRED' : 'OTP_DENIED',
      );
    }

    this.limiter.clear(phone);

    const at = this.now();

    return {
      phoneE164: phone,
      verifiedAt: at,
      expiresAt: new Date(at.getTime() + SESSION_TTL_MINUTES * 60_000),
    };
  }

  /**
   * Legacy customer-session helper.
   *
   * Existing callers keep their current behaviour while login and sign-up are
   * migrated to explicit flows. New sign-up code must use verifyPhone().
   */
  async completeVerification(
    rawPhone: string,
    code: string,
  ): Promise<VerifiedSession> {
    const verified = await this.verifyPhone(rawPhone, code);

    const existing = await this.customers.findByPhone(verified.phoneE164);

    const customer =
      existing ?? (await this.customers.create(verified.phoneE164));

    return {
      phoneE164: verified.phoneE164,
      customerId: customer.id,
      isNewCustomer: existing === null,
      verifiedAt: verified.verifiedAt,
      expiresAt: verified.expiresAt,
    };
  }

  /**
   * Load the profile behind a verified session.
   *
   * Takes the session, never a raw phone number, so a caller cannot look up
   * an arbitrary customer by guessing numbers.
   */
  async profileForSession(session: VerifiedSession): Promise<CustomerProfile> {
    if (session.expiresAt <= this.now()) {
      throw new IdentityError(
        'Your session expired. Verify again.',
        'SESSION_EXPIRED',
      );
    }
    const profile = await this.customers.findByPhone(session.phoneE164);
    if (!profile || profile.id !== session.customerId) {
      throw new IdentityError(
        'Session does not match a customer.',
        'SESSION_INVALID',
      );
    }
    return profile;
  }
}

/** Enforce that a customer only ever reads their own addresses. */
export function assertOwnsAddress(
  session: VerifiedSession,
  address: CustomerAddress,
): void {
  if (address.customerId !== session.customerId) {
    throw new IdentityError('Not found.', 'NOT_FOUND');
  }
}
