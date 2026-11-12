// Claude (Anthropic) · 2026-11-11 — sign in on r2nette.ca without visiting takatak.ca.
//
// Email: the page asks this server for a code; the TAKATAK hub emails it; the
// page sends the code back; this server verifies it with the hub and receives
// the person's hub session. Google: the hub's Google round-trip comes back to
// this server with a code, exchanged (PKCE) for the same kind of session.
// Then, in both cases, this server opens the R2NETTE authorization in the hub,
// shows its details to the page (the "Autoriser l’accès" screen), and records
// the person's decision with the hub. The hub answers with R2NETTE's own
// callback address, which the browser then visits: the existing
// /api/v1/auth/takatak/callback finishes the sign-in exactly as it does for
// the link flow. The hub token never reaches the browser in clear text.
import { Router, type NextFunction, type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ApiError } from './app.js';
import { encryptionConfigured } from '../auth/encryption.js';
import { IdentityError, RateLimiter } from '../identity/identity.js';
import type { HubSession, TakatakOAuthProvider } from '../identity/takatak-oauth.js';
import {
  CALLBACK_PATH,
  DEFAULT_RETURN,
  TAKATAK_OAUTH_COOKIE,
  TTL_MS,
  backToLogin,
  challengeOf,
  newPending,
  publicOrigin,
  readPending,
  safeReturn,
  sameSecret,
  writePending,
  type Pending,
} from './takatak-shared.js';
import {
  TAKATAK_CONSENT_COOKIE,
  clearConsentCookie,
  decodeConsent,
  writeConsentCookie,
} from './takatak-consent-cookie.js';

export const TAKATAK_GOOGLE_COOKIE = 'r2n_takatak_google';
const GOOGLE_PATH = '/api/v1/auth/takatak/google';
const GOOGLE_CALLBACK_PATH = '/api/v1/auth/takatak/google/callback';

const email = z.string().trim().email().max(254).transform((s) => s.toLowerCase());
const sendSchema = z.object({ email }).strict();
const verifySchema = z
  .object({
    email,
    code: z.string().regex(/^\d{6,10}$/),
    locale: z.enum(['en', 'fr']),
    terms: z.boolean(),
    returnTo: z.string().max(2048).optional(),
  })
  .strict();
const decisionSchema = z.object({ decision: z.enum(['approve', 'deny']), terms: z.boolean().optional() }).strict();

const hash = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Every hub call leaves from this one server, so the hub's own per-IP limits
 * apply to all customers together. Per-visitor ceilings here keep one client
 * (cycling through email addresses) from spending that shared budget.
 */
const CHECKS_PER_IP_PER_HOUR = 30;
const CONSENT_CALLS_PER_IP_PER_HOUR = 60;

class SlidingWindow {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly limit: number, private readonly clock: () => number) {}
  take(key: string): void {
    const at = this.clock();
    const recent = (this.hits.get(key) ?? []).filter((t) => t > at - 3_600_000);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      throw new IdentityError('Too many attempts. Try again later.', 'SIGNIN_IP_LIMIT');
    }
    recent.push(at);
    this.hits.set(key, recent);
  }
}
const encodePending = (p: Pending) => Buffer.from(JSON.stringify(p)).toString('base64url');

/** Hub failures keep their code; the HTTP status follows the spec. */
function toApiError(error: unknown): unknown {
  if (!(error instanceof IdentityError)) return error;
  const { code } = error;
  const status =
    code === 'EMAIL_CODE_INVALID' || code === 'GOOGLE_AUTH_DENIED' ? 401
      : code === 'CONSENT_EXPIRED' ? 410
      : code === 'CONSENT_INVALID' ? 502
        : code.includes('LIMIT') || code === 'OTP_COOLDOWN' ? 429
          : code.includes('UNAVAILABLE') || code.includes('NOT_CONFIGURED') ? 503
            : 400;
  return new ApiError(status, code, error.message);
}

export function takatakSignInRoutes(
  prisma: PrismaClient,
  provider: TakatakOAuthProvider,
  options: { publicUrl?: string; now: () => Date },
) {
  const router = Router();
  const { now } = options;
  const secure = process.env.NODE_ENV === 'production';
  const limiter = new RateLimiter(undefined, () => now().getTime());
  const checksPerIp = new SlidingWindow(CHECKS_PER_IP_PER_HOUR, () => now().getTime());
  const consentPerIp = new SlidingWindow(CONSENT_CALLS_PER_IP_PER_HOUR, () => now().getTime());
  const ipOf = (req: Request) => req.ip ?? 'unknown';

  router.use('/auth/takatak', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  type Handler = (req: Request, res: Response) => Promise<void>;
  const run = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && (req.get('sec-fetch-site') === 'cross-site' || !req.is('application/json'))) {
      next(new ApiError(403, 'REQUEST_REJECTED', 'Use the form on this website.'));
      return;
    }
    fn(req, res).catch((error) => next(toApiError(error)));
  };

  function requireBase(): string {
    const base = publicOrigin(options.publicUrl);
    if (!base || !provider.configured) {
      throw new ApiError(503, 'TAKATAK_AUTH_UNAVAILABLE', 'TAKATAK sign-in is not available right now.');
    }
    return base;
  }

  /** Only our own callback, carrying the state this sign-in started with. */
  function acceptRedirect(url: string, base: string, pending: Pending): string | null {
    try {
      const target = new URL(url);
      if (target.origin + target.pathname !== base + CALLBACK_PATH) return null;
      const state = target.searchParams.get('state');
      if (!state || !sameSecret(state, pending.state)) return null;
      return target.toString();
    } catch {
      return null;
    }
  }

  /**
   * Open the R2NETTE authorization for this hub session and either hand the
   * page the consent details (cookie set) or, when the hub already holds the
   * person's approval, the address that finishes the sign-in.
   */
  async function beginConsent(
    res: Response,
    session: HubSession,
    input: { returnTo: string; locale: 'fr' | 'en'; terms: boolean },
    base: string,
  ): Promise<{ consent: true } | { next: string }> {
    if (!encryptionConfigured()) {
      throw new ApiError(503, 'TAKATAK_AUTH_UNAVAILABLE', 'TAKATAK sign-in is not available right now.');
    }
    const at = now().getTime();
    const pending = newPending({ returnTo: input.returnTo, locale: input.locale, terms: input.terms, link: null, now: at });
    const authorizationId = await provider.beginAuthorization({
      redirectUri: `${base}${CALLBACK_PATH}`,
      challenge: challengeOf(pending.verifier),
      state: pending.state,
      locale: input.locale,
    });
    const view = await provider.authorizationDetails({
      authorizationId,
      accessToken: session.accessToken,
      subject: session.subject,
      locale: input.locale,
    });
    writePending(res, pending, secure);
    if (view.kind === 'approved') {
      const next = acceptRedirect(view.redirectUrl, base, pending);
      await provider.revokeSession(session.accessToken);
      if (!next) throw new ApiError(502, 'CONSENT_INVALID', 'TAKATAK answered with an unexpected address.');
      return { next };
    }
    if (!writeConsentCookie(res, { authorizationId, accessToken: session.accessToken, subject: session.subject, email: session.email, createdAt: at }, secure)) {
      console.error('[takatak-signin] hub session too large for the consent cookie; sign-in refused');
      await provider.revokeSession(session.accessToken);
      throw new ApiError(503, 'TAKATAK_AUTH_UNAVAILABLE', 'TAKATAK sign-in is not available right now.');
    }
    return { consent: true };
  }

  /**
   * A first-time customer has to accept the terms before an account is made.
   * Ask on the consent card, where the person is, instead of failing after
   * the code and Autoriser. Known customers (same TAKATAK id, or the same
   * address) already accepted them.
   */
  async function needsTerms(handoff: { subject: string; email: string | null }, pending: Pending): Promise<boolean> {
    if (pending.terms) return false;
    const known = await prisma.customer.findFirst({
      where: { OR: [{ emailAuthSubject: handoff.subject }, { googleAuthSubject: handoff.subject }, ...(handoff.email ? [{ email: handoff.email }] : [])] },
      select: { id: true },
    });
    return !known;
  }

  function readHandoff(req: Request) {
    const at = now().getTime();
    const handoff = decodeConsent(req.cookies?.[TAKATAK_CONSENT_COOKIE], at);
    const pending = readPending(req.cookies?.[TAKATAK_OAUTH_COOKIE], at);
    if (!handoff || !pending) throw new ApiError(410, 'CONSENT_EXPIRED', 'This sign-in expired. Start again.');
    return { handoff, pending };
  }

  /* ---------------- email code ---------------- */

  router.post('/auth/takatak/email/send', run(async (req, res) => {
    const input = sendSchema.parse(req.body);
    requireBase();
    const key = hash(input.email);
    const ip = req.ip ?? 'unknown';
    limiter.assertCanSend(key, ip);
    // Reserve the quota before awaiting the network to bound concurrent sends.
    limiter.recordSend(key, ip);
    await provider.sendEmailCode(input.email);
    // The same answer whether or not the hub knows this address.
    res.json({ sent: true });
  }));

  router.post('/auth/takatak/email/verify', run(async (req, res) => {
    const input = verifySchema.parse(req.body);
    const base = requireBase();
    const key = hash(input.email);
    checksPerIp.take(ipOf(req));
    limiter.assertCanCheck(key);
    // Count every attempt, including malformed hub replies and failures.
    limiter.recordFailedCheck(key);
    const session = await provider.verifyEmailCode(input.email, input.code);
    const result = await beginConsent(res, session, {
      returnTo: safeReturn(input.returnTo, base),
      locale: input.locale,
      terms: input.terms,
    }, base);
    res.json(result);
  }));

  /* ---------------- consent screen ---------------- */

  router.get('/auth/takatak/consent', run(async (req, res) => {
    const base = requireBase();
    consentPerIp.take(ipOf(req));
    const { handoff, pending } = readHandoff(req);
    // The page may switch language on the consent screen; the wording follows.
    const locale = req.query.locale === 'en' ? 'en' : req.query.locale === 'fr' ? 'fr' : pending.locale;
    const view = await provider.authorizationDetails({
      authorizationId: handoff.authorizationId,
      accessToken: handoff.accessToken,
      subject: handoff.subject,
      locale,
    });
    if (view.kind === 'approved') {
      clearConsentCookie(res);
      const next = acceptRedirect(view.redirectUrl, base, pending);
      await provider.revokeSession(handoff.accessToken);
      if (!next) throw new ApiError(502, 'CONSENT_INVALID', 'TAKATAK answered with an unexpected address.');
      res.json({ next });
      return;
    }
    const { appName, returnAddress, account, scopes } = view.details;
    res.json({ app: appName, returnAddress, account, scopes, needsTerms: await needsTerms(handoff, pending) });
  }));

  router.post('/auth/takatak/consent', run(async (req, res) => {
    const { decision, terms } = decisionSchema.parse(req.body);
    const base = requireBase();
    consentPerIp.take(ipOf(req));
    const { handoff, pending: stored } = readHandoff(req);
    let pending = stored;
    if (decision === 'approve') {
      if (terms === true && !pending.terms) {
        pending = { ...pending, terms: true };
        // The callback reads the terms from this cookie when it creates the account.
        writePending(res, pending, secure);
      } else if (await needsTerms(handoff, pending)) {
        // Nothing is spent: the handoff stays so the card can be ticked and sent again.
        throw new ApiError(400, 'TERMS_REQUIRED', 'Accept the terms to create your account.');
      }
    }
    // One decision per handoff: the cookie goes whatever the hub answers.
    clearConsentCookie(res);
    try {
      const url = await provider.decideConsent({ authorizationId: handoff.authorizationId, accessToken: handoff.accessToken, decision });
      const next = acceptRedirect(url, base, pending);
      if (!next) throw new ApiError(502, 'CONSENT_INVALID', 'TAKATAK answered with an unexpected address.');
      res.json({ next });
    } finally {
      await provider.revokeSession(handoff.accessToken);
    }
  }));

  /* ---------------- Google ---------------- */

  router.get('/auth/takatak/google/start', (req: Request, res: Response) => {
    const base = publicOrigin(options.publicUrl);
    const returnTo = base ? safeReturn(req.query.returnTo, base) : DEFAULT_RETURN;
    if (!base || !provider.configured || !provider.googleConfigured) {
      backToLogin(res, 'unavailable', returnTo);
      return;
    }
    const pending = newPending({
      returnTo,
      locale: req.query.locale === 'en' ? 'en' : 'fr',
      terms: req.query.terms === '1',
      link: null,
      now: now().getTime(),
    });
    try {
      const url = provider.googleAuthorizationUrl({
        redirectUri: `${base}${GOOGLE_CALLBACK_PATH}`,
        challenge: challengeOf(pending.verifier),
      });
      res.cookie(TAKATAK_GOOGLE_COOKIE, encodePending(pending), { httpOnly: true, secure, sameSite: 'lax', path: GOOGLE_PATH, maxAge: TTL_MS });
      res.redirect(303, url);
    } catch {
      backToLogin(res, 'unavailable', returnTo);
    }
  });

  router.get('/auth/takatak/google/callback', async (req: Request, res: Response) => {
    const at = now().getTime();
    const pending = readPending(req.cookies?.[TAKATAK_GOOGLE_COOKIE], at);
    res.clearCookie(TAKATAK_GOOGLE_COOKIE, { path: GOOGLE_PATH });
    const base = publicOrigin(options.publicUrl);
    const returnTo = pending?.returnTo ?? DEFAULT_RETURN;
    if (!base || !provider.configured) {
      backToLogin(res, 'unavailable', returnTo);
      return;
    }
    // The hub returns only `code` (or `error`): it keeps its own state for
    // Google. This browser's fresh cookie plus PKCE bind the code to it: a
    // code from anyone else's flow cannot be exchanged with this verifier.
    if (!pending) {
      backToLogin(res, 'expired', returnTo);
      return;
    }
    if (req.query.error) {
      backToLogin(res, 'cancelled', returnTo);
      return;
    }
    const code = typeof req.query.code === 'string' && req.query.code.length <= 2048 ? req.query.code : null;
    if (!code) {
      backToLogin(res, 'expired', returnTo);
      return;
    }
    try {
      const session = await provider.exchangeGoogleCode({ code, verifier: pending.verifier });
      const result = await beginConsent(res, session, { returnTo: pending.returnTo, locale: pending.locale, terms: pending.terms }, base);
      if ('next' in result) {
        res.redirect(303, result.next);
        return;
      }
      const query = new URLSearchParams({ consent: '1' });
      if (pending.returnTo !== DEFAULT_RETURN) query.set('returnTo', pending.returnTo);
      res.redirect(303, `/login?${query.toString()}`);
    } catch {
      backToLogin(res, 'error', returnTo);
    }
  });

  return router;
}
