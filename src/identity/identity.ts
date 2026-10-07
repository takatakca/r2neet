/**
 * R2NETTE phone identity.
 *
 * Phone is the canonical customer identity. Social login links to it later;
 * it never replaces it.
 *
 * We never store OTP codes. TAKATAK Supabase Auth owns code generation, expiry
 * and checking (with Twilio configured as its SMS provider). This module owns
 * normalization, abuse limits, and the rule that NOTHING about a customer is
 * revealed before verification.
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
 * TAKATAK's Supabase Auth project is the canonical phone-identity authority.
 * Supabase sends SMS through the Twilio provider configured in its dashboard.
 * Only the project's URL and anon key are used here; service-role keys never
 * belong in this application.
 */
export class SupabasePhoneAuthProvider implements VerificationProvider {
  readonly name = 'takatak_supabase_phone';
  private readonly url: string | undefined;
  private readonly anonKey: string | undefined;

  constructor(
    env: Record<string, string | undefined> = process.env,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.url = env.TAKATAK_SUPABASE_URL?.trim().replace(/\/+$/, '');
    this.anonKey = env.TAKATAK_SUPABASE_ANON_KEY?.trim();
  }

  get configured(): boolean {
    if (!this.url || !this.anonKey) return false;
    try {
      const endpoint = new URL(this.url);
      return (
        Boolean(endpoint.hostname) &&
        (endpoint.protocol === 'https:' ||
          (endpoint.protocol === 'http:' &&
            ['localhost', '127.0.0.1'].includes(endpoint.hostname)))
      );
    } catch {
      return false;
    }
  }

  private async request(
    operation: 'otp' | 'verify',
    payload: Record<string, string | boolean>,
  ): Promise<Response> {
    if (!this.configured || !this.url || !this.anonKey) {
      throw new IdentityError(
        'TAKATAK phone authentication is not configured.',
        'VERIFY_NOT_CONFIGURED',
      );
    }

    try {
      return await this.fetcher(`${this.url}/auth/v1/${operation}`, {
        method: 'POST',
        headers: {
          apikey: this.anonKey,
          Authorization: 'Bearer ' + this.anonKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new IdentityError(
        'TAKATAK phone authentication is temporarily unavailable.',
        'VERIFY_PROVIDER_UNAVAILABLE',
      );
    }
  }

  async start(phoneE164: string): Promise<{ status: VerificationStatus }> {
    const response = await this.request('otp', {
      phone: phoneE164,
      // Keep the send response neutral for known and new customers. The
      // application creates its own customer record only after verification
      // and the registration form are complete.
      create_user: true,
    });

    if (response.status === 429) {
      throw new IdentityError(
        'Too many codes requested. Try again later.',
        'OTP_PROVIDER_LIMIT',
      );
    }
    if (!response.ok) {
      throw new IdentityError(
        'TAKATAK could not send a verification code.',
        'VERIFY_PROVIDER_UNAVAILABLE',
      );
    }
    return { status: 'PENDING' };
  }

  async check(
    phoneE164: string,
    code: string,
  ): Promise<{ status: VerificationStatus }> {
    const response = await this.request('verify', {
      phone: phoneE164,
      token: code,
      type: 'sms',
    });

    if (response.status === 429) {
      throw new IdentityError(
        'Too many verification attempts. Try again later.',
        'OTP_PROVIDER_LIMIT',
      );
    }
    if (response.status >= 500) {
      throw new IdentityError(
        'TAKATAK phone authentication is temporarily unavailable.',
        'VERIFY_PROVIDER_UNAVAILABLE',
      );
    }
    if (!response.ok) return { status: 'DENIED' };

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new IdentityError(
        'TAKATAK returned an invalid verification response.',
        'VERIFY_PROVIDER_UNAVAILABLE',
      );
    }

    if (!body || typeof body !== 'object') {
      throw new IdentityError(
        'TAKATAK returned an invalid verification response.',
        'VERIFY_PROVIDER_UNAVAILABLE',
      );
    }

    const user = (body as { user?: unknown }).user;
    if (!user || typeof user !== 'object') return { status: 'DENIED' };
    const verifiedUser = user as {
      id?: unknown;
      phone?: unknown;
      phone_confirmed_at?: unknown;
    };
    if (
      typeof verifiedUser.id !== 'string' ||
      !verifiedUser.id ||
      typeof verifiedUser.phone !== 'string' ||
      !verifiedUser.phone_confirmed_at
    ) {
      return { status: 'DENIED' };
    }

    try {
      if (normalizePhone(verifiedUser.phone) !== phoneE164) {
        return { status: 'DENIED' };
      }
    } catch {
      return { status: 'DENIED' };
    }

    return { status: 'APPROVED' };
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
