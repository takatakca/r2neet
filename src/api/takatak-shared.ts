// Claude (Anthropic) · 2026-11-11 — helpers shared by the TAKATAK sign-in
// routers (takatak-oauth.ts: button/link flow and callback; takatak-signin.ts:
// email code, Google and the consent screen shown on r2nette.ca).
//
// The "pending" cookie carries the OAuth state and PKCE verifier between the
// moment an authorization starts and the moment TAKATAK's code comes back to
// /api/v1/auth/takatak/callback. Whoever starts the authorization writes it;
// the callback alone reads it.
import type { Response } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const TAKATAK_OAUTH_COOKIE = 'r2n_takatak_oauth';
export const COOKIE_PATH = '/api/v1/auth/takatak';
export const CALLBACK_PATH = '/api/v1/auth/takatak/callback';
export const TTL_MS = 10 * 60_000;
export const DEFAULT_RETURN = '/#book';

export interface Pending {
  v: 1;
  state: string;
  verifier: string;
  returnTo: string;
  locale: 'fr' | 'en';
  terms: boolean;
  /** Signed-in R2NETTE customer who asked to link TAKATAK. */
  link: string | null;
  createdAt: number;
}

/** A redirect back to the sign-in page with a reason the page can explain. */
export class Stop extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

const sha = (s: string) => createHash('sha256').update(s).digest();

export function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(sha(a), sha(b));
}

export function challengeOf(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function newPending(input: {
  returnTo: string;
  locale: 'fr' | 'en';
  terms: boolean;
  link: string | null;
  now: number;
}): Pending {
  return {
    v: 1,
    state: randomBytes(32).toString('base64url'),
    verifier: randomBytes(32).toString('base64url'),
    returnTo: input.returnTo,
    locale: input.locale,
    terms: input.terms,
    link: input.link,
    createdAt: input.now,
  };
}

export function readPending(raw: unknown, now: number): Pending | null {
  if (typeof raw !== 'string' || raw.length > 4096) return null;
  try {
    const p = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<Pending>;
    if (
      p.v !== 1 ||
      typeof p.state !== 'string' || p.state.length < 32 ||
      typeof p.verifier !== 'string' || p.verifier.length < 43 ||
      typeof p.returnTo !== 'string' ||
      (p.locale !== 'fr' && p.locale !== 'en') ||
      typeof p.terms !== 'boolean' ||
      (p.link !== null && typeof p.link !== 'string') ||
      typeof p.createdAt !== 'number' ||
      p.createdAt > now + 60_000 ||
      now - p.createdAt > TTL_MS
    ) {
      return null;
    }
    return p as Pending;
  } catch {
    return null;
  }
}

export function writePending(res: Response, pending: Pending, secure: boolean): void {
  res.cookie(TAKATAK_OAUTH_COOKIE, Buffer.from(JSON.stringify(pending)).toString('base64url'), {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: COOKIE_PATH,
    maxAge: TTL_MS,
  });
}

export function clearPending(res: Response): void {
  res.clearCookie(TAKATAK_OAUTH_COOKIE, { path: COOKIE_PATH });
}

/** The canonical https origin, or null when PUBLIC_URL is unusable. */
export function publicOrigin(publicUrl: string | undefined): string | null {
  if (!publicUrl) return null;
  try {
    const url = new URL(publicUrl);
    const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
    if (!url.hostname || url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !local)) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function safeReturn(value: unknown, base: string): string {
  if (typeof value !== 'string' || !value || value.length > 2048) return DEFAULT_RETURN;
  try {
    const url = new URL(value, base);
    if (url.origin !== base) return DEFAULT_RETURN;
    // Never bounce back into an API route or the sign-in pages themselves.
    if (url.pathname.startsWith('/api/') || /^\/(login|signup|auth)(\/|$)/.test(url.pathname)) return DEFAULT_RETURN;
    return url.pathname + url.search + url.hash;
  } catch {
    return DEFAULT_RETURN;
  }
}

export function backToLogin(res: Response, reason: string, returnTo = DEFAULT_RETURN, path = '/login'): void {
  const query = new URLSearchParams({ takatak: reason });
  if (returnTo !== DEFAULT_RETURN && path !== '/account') query.set('returnTo', returnTo);
  res.redirect(303, `${path}?${query.toString()}`);
}
