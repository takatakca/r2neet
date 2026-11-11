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

/** base64url JSON `{ v, id, subject, token, createdAt }`; `token` is ciphertext. */
export function encodeConsent(handoff: ConsentHandoff, env: Env = process.env): string {
  const payload = {
    v: 1,
    id: handoff.authorizationId,
    subject: handoff.subject,
    token: encryptSecret(handoff.accessToken, env),
    createdAt: handoff.createdAt,
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeConsent(raw: unknown, now: number, env: Env = process.env): ConsentHandoff | null {
  if (typeof raw !== 'string' || !raw || raw.length > 8192) return null;
  try {
    const p = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (
      p.v !== 1 ||
      typeof p.id !== 'string' || !p.id ||
      typeof p.subject !== 'string' || !p.subject ||
      typeof p.token !== 'string' || !p.token ||
      typeof p.createdAt !== 'number' ||
      p.createdAt > now + 60_000 ||
      now - p.createdAt > TTL_MS
    ) {
      return null;
    }
    const accessToken = decryptSecret(p.token, env);
    if (!accessToken) return null;
    return { authorizationId: p.id, accessToken, subject: p.subject, createdAt: p.createdAt };
  } catch {
    return null;
  }
}

export function writeConsentCookie(res: Response, handoff: ConsentHandoff, secure: boolean, env: Env = process.env): void {
  res.cookie(TAKATAK_CONSENT_COOKIE, encodeConsent(handoff, env), {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: COOKIE_PATH,
    maxAge: TTL_MS,
  });
}

export function clearConsentCookie(res: Response): void {
  res.clearCookie(TAKATAK_CONSENT_COOKIE, { path: COOKIE_PATH });
}
