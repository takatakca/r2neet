// Claude (Anthropic) · 2026-11-11 — consent handoff for the sign-in on r2nette.ca.
//
// Between "the hub verified this person" and "they tapped Autoriser", this
// server must keep the person's TAKATAK access token. It is held for at most
// TTL_MS, encrypted with the server's field-encryption keyring, in an httpOnly
// cookie scoped to the TAKATAK auth routes, and discarded after the decision.
import type { Response } from 'express';
import { decryptSecret, encryptSecret } from '../auth/encryption.js';
import { COOKIE_PATH, TTL_MS } from './takatak-shared.js';

export const TAKATAK_CONSENT_COOKIE = 'r2n_takatak_consent';

export interface ConsentHandoff {
  authorizationId: string;
  accessToken: string;
  /** TAKATAK user id the token belongs to; the consent details must name it. */
  subject: string;
  createdAt: number;
}

type Env = Record<string, string | undefined>;

/**
 * Browsers silently drop a cookie whose name and value exceed 4096 bytes, so
 * the handoff is refused well before that instead of looping on "expired".
 */
export const MAX_CONSENT_COOKIE_BYTES = 3_900;

/**
 * The whole handoff `{ v, id, subject, token, createdAt }` is encrypted once
 * (AES-GCM, `encryptSecret` format), so every field is authenticated and the
 * value is encoded a single time.
 */
export function encodeConsent(handoff: ConsentHandoff, env: Env = process.env): string {
  const payload = {
    v: 2,
    id: handoff.authorizationId,
    subject: handoff.subject,
    token: handoff.accessToken,
    createdAt: handoff.createdAt,
  };
  return encryptSecret(JSON.stringify(payload), env);
}

/** Cookie bytes as the browser counts them (name, `=`, encoded value). */
export function consentCookieBytes(value: string): number {
  return TAKATAK_CONSENT_COOKIE.length + 1 + encodeURIComponent(value).length;
}

export function decodeConsent(raw: unknown, now: number, env: Env = process.env): ConsentHandoff | null {
  if (typeof raw !== 'string' || !raw || raw.length > 8192) return null;
  try {
    const p = JSON.parse(decryptSecret(raw, env)) as Record<string, unknown>;
    if (
      p.v !== 2 ||
      typeof p.id !== 'string' || !p.id ||
      typeof p.subject !== 'string' || !p.subject ||
      typeof p.token !== 'string' || !p.token ||
      typeof p.createdAt !== 'number' ||
      p.createdAt > now + 60_000 ||
      now - p.createdAt > TTL_MS
    ) {
      return null;
    }
    return { authorizationId: p.id, accessToken: p.token, subject: p.subject, createdAt: p.createdAt };
  } catch {
    return null;
  }
}

/** Returns false, setting nothing, when the handoff is too large for a cookie. */
export function writeConsentCookie(res: Response, handoff: ConsentHandoff, secure: boolean, env: Env = process.env): boolean {
  const value = encodeConsent(handoff, env);
  if (consentCookieBytes(value) > MAX_CONSENT_COOKIE_BYTES) return false;
  res.cookie(TAKATAK_CONSENT_COOKIE, value, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: COOKIE_PATH,
    maxAge: TTL_MS,
  });
  return true;
}

export function clearConsentCookie(res: Response): void {
  res.clearCookie(TAKATAK_CONSENT_COOKIE, { path: COOKIE_PATH });
}
