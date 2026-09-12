import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238), implemented directly.
 *
 * No dependency: the algorithm is thirty lines, and an auth primitive with a
 * supply chain is a poor trade. Compatible with Google Authenticator, Authy,
 * 1Password and anything else that speaks otpauth://.
 */

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Accept one step either side, for clock drift on the phone. */
export const TOTP_WINDOW = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160 bits, the RFC 4226 recommendation. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function currentStep(at: Date = new Date()): number {
  return Math.floor(at.getTime() / 1000 / TOTP_STEP_SECONDS);
}

/** The 6-digit code for a given time step. */
export function totpForStep(secret: string, step: number): string {
  const key = base32Decode(secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));

  const digest = createHmac('sha1', key).update(counter).digest();
  // Dynamic truncation, RFC 4226 §5.4.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

export interface VerifyResult {
  valid: boolean;
  /** The step that matched, so the caller can reject a replay of it. */
  step?: number;
}

/**
 * Verify a code across the drift window.
 *
 * Returns the matching step so the caller can refuse to accept the same code
 * twice — otherwise a code shoulder-surfed or captured in transit stays usable
 * for the rest of its 30-second life.
 */
export function verifyTotp(
  secret: string,
  code: string,
  opts: { at?: Date; window?: number; lastUsedStep?: number | null } = {},
): VerifyResult {
  const cleaned = code.replace(/\D/g, '');
  if (cleaned.length !== TOTP_DIGITS) return { valid: false };

  const now = currentStep(opts.at ?? new Date());
  const window = opts.window ?? TOTP_WINDOW;

  for (let offset = -window; offset <= window; offset++) {
    const step = now + offset;
    if (opts.lastUsedStep != null && step <= opts.lastUsedStep) continue;

    const expected = totpForStep(secret, step);
    const a = Buffer.from(expected);
    const b = Buffer.from(cleaned);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      return { valid: true, step };
    }
  }
  return { valid: false };
}

/** otpauth:// URI for the QR code. */
export function otpauthUri(secret: string, account: string, issuer = 'R2NETTE'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/* ------------------------------------------------------------------ */
/* recovery codes                                                      */
/* ------------------------------------------------------------------ */

export const RECOVERY_CODE_COUNT = 8;

/**
 * Single-use codes for when the phone is lost.
 *
 * Without these, losing a phone means losing the business account. Grouped
 * and unambiguous — no characters that can be confused when read aloud.
 */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = randomBytes(10);
    let code = '';
    for (let j = 0; j < 10; j++) code += alphabet[bytes[j]! % alphabet.length];
    codes.push(`${code.slice(0, 5)}-${code.slice(5)}`);
  }
  return codes;
}

export const hashRecoveryCode = (code: string): string =>
  createHash('sha256').update(code.toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');

/**
 * Consume a recovery code.
 *
 * Returns the remaining hashes so the caller persists the reduced set — a
 * used code must never work twice.
 */
export function consumeRecoveryCode(
  hashes: string[],
  submitted: string,
): { valid: boolean; remaining: string[] } {
  const target = hashRecoveryCode(submitted);
  const idx = hashes.indexOf(target);
  if (idx === -1) return { valid: false, remaining: hashes };
  return { valid: true, remaining: hashes.filter((_, i) => i !== idx) };
}
