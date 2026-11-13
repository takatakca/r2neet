// Claude (Anthropic) · 2026-11-13 — the one password rule, shared by the server and the login page.
//
// The password itself lives in the TAKATAK hub (Supabase Auth), which refuses anything weaker than
// this (observed 2026-11-12). Checking the same rule here lets us explain every problem in plain words
// before a call is made. Nothing here stores, logs or sends a password anywhere.

export const PASSWORD_MIN_LENGTH = 12;
/** bcrypt, which the hub uses, only reads the first 72 bytes: longer input is refused instead of silently cut. */
export const PASSWORD_MAX_BYTES = 72;
/** Shortest email name that is worth refusing inside a password ("al@x.ca" would block too much). */
const EMAIL_NAME_MIN = 4;

export type PasswordProblem = 'length' | 'lower' | 'upper' | 'digit' | 'symbol' | 'too-long' | 'email';

/** The symbols the hub counts (letters with accents are not symbols). */
const SYMBOLS = '!@#$%^&*()_+-=[]{};\'\\:"|<>?,./`~';

function bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function hasSymbol(password: string): boolean {
  for (const ch of password) if (SYMBOLS.includes(ch)) return true;
  return false;
}

/** Empty list means acceptable. The password is read exactly as typed: no trimming, no normalising. */
export function passwordProblems(password: string, email?: string | null): PasswordProblem[] {
  const problems: PasswordProblem[] = [];
  if ([...password].length < PASSWORD_MIN_LENGTH) problems.push('length');
  if (!/\p{Ll}/u.test(password)) problems.push('lower');
  if (!/\p{Lu}/u.test(password)) problems.push('upper');
  if (!/[0-9]/.test(password)) problems.push('digit');
  if (!hasSymbol(password)) problems.push('symbol');
  if (bytes(password) > PASSWORD_MAX_BYTES) problems.push('too-long');
  const name = email?.split('@')[0]?.trim().toLowerCase();
  if (name && name.length >= EMAIL_NAME_MIN && password.toLowerCase().includes(name)) problems.push('email');
  return problems;
}

// Characters that are hard to mix up when read aloud or copied by hand (no I l 1 O o 0).
const LOWER = 'abcdefghijkmnpqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const PICK_SYMBOLS = '!@#$%^&*-_=+?';
const SUGGEST_MIN = PASSWORD_MIN_LENGTH;
const SUGGEST_MAX = 64; // ASCII only, so 64 characters is 64 bytes.

/** Uniform random index below `max` (rejection sampling, so no modulo bias). */
function randomBelow(max: number): number {
  const limit = Math.floor(0x100000000 / max) * max;
  const buffer = new Uint32Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(buffer);
    const value = buffer[0] as number;
    if (value < limit) return value % max;
  }
}

function pick(set: string): string {
  return set[randomBelow(set.length)] as string;
}

/** A strong password that always passes `passwordProblems`. Browser and Node both provide `crypto`. */
export function suggestPassword(length = 16): string {
  const size = Math.min(SUGGEST_MAX, Math.max(SUGGEST_MIN, Math.floor(length)));
  const all = LOWER + UPPER + DIGITS + PICK_SYMBOLS;
  const chars = [pick(LOWER), pick(UPPER), pick(DIGITS), pick(PICK_SYMBOLS)];
  while (chars.length < size) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomBelow(i + 1);
    [chars[i], chars[j]] = [chars[j] as string, chars[i] as string];
  }
  return chars.join('');
}
