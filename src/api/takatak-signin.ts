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
import { requestedScopeText, type HubSession, type TakatakOAuthProvider } from '../identity/takatak-oauth.js';
import { passwordProblems } from '../shared/password-policy.js';
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
  type Intent,
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
const intentSchema = z.enum(['signin', 'signup', 'reset']);
const verifySchema = z
  .object({
    email,
    code: z.string().regex(/^\d{6,10}$/),
    locale: z.enum(['en', 'fr']),
    terms: z.boolean(),
    returnTo: z.string().max(2048).optional(),
    // 'signup' and 'reset' stop at the password step; the default is the plain sign-in.
    intent: intentSchema.default('signin'),
  })
  .strict();
// Passwords are read exactly as typed (no trim). The cap only keeps a hostile body small.
const passwordText = z.string().min(1).max(256);
const setPasswordSchema = z.object({ password: passwordText, confirm: z.string().max(256) }).strict();
const loginSchema = z
  .object({
    email,
    password: passwordText,
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
/**
 * Password sign-in attempts per address: 5 in 15 minutes, then 429 until the window passes. An attempt is
 * counted before the hub is asked (parallel guesses cannot all slip through) and given back when the hub
 * could not judge it (its own limit, an outage). A good password clears the count.
 */
const PASSWORD_ATTEMPTS = 5;
const PASSWORD_WINDOW_MS = 15 * 60_000;

class AttemptWindow {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly limit: number, private readonly windowMs: number, private readonly clock: () => number) {}
  private recent(key: string): number[] {
    const cutoff = this.clock() - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length) this.hits.set(key, recent);
    else this.hits.delete(key);
    return recent;
  }
  /** Reserve one attempt, or refuse when the window is full. */
  take(key: string): void {
    const recent = this.recent(key);
    if (recent.length >= this.limit) throw new IdentityError('Too many attempts. Try again in a few minutes.', 'PASSWORD_LOGIN_LIMIT');
    recent.push(this.clock());
    this.hits.set(key, recent);
    if (this.hits.size > 5_000) for (const k of [...this.hits.keys()]) this.recent(k);
  }
  /** Give back the latest attempt (the hub never judged it). */
  giveBack(key: string): void {
    const recent = this.recent(key);
    recent.pop();
    if (recent.length) this.hits.set(key, recent);
    else this.hits.delete(key);
  }
  clear(key: string): void {
    this.hits.delete(key);
  }
}
const encodePending = (p: Pending) => Buffer.from(JSON.stringify(p)).toString('base64url');

/** Hub failures keep their code; the HTTP status follows the spec. */
function toApiError(error: unknown): unknown {
  if (!(error instanceof IdentityError)) return error;
  const { code } = error;
  const status =
    code === 'EMAIL_CODE_INVALID' || code === 'GOOGLE_AUTH_DENIED' || code === 'INVALID_CREDENTIALS' ? 401
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
  const passwordAttempts = new AttemptWindow(PASSWORD_ATTEMPTS, PASSWORD_WINDOW_MS, () => now().getTime());
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
   * Open the R2NETTE authorization for this hub session and hand the page the
   * consent card (cookie set). When the hub already holds the person's approval
   * the card is shown all the same; the finishing address waits in the cookie.
   */
  async function beginConsent(
    res: Response,
    session: HubSession,
    input: { returnTo: string; locale: 'fr' | 'en'; terms: boolean },
    base: string,
  ): Promise<{ consent: true }> {
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
    // The hub may already hold this person's approval and answer with the finishing
    // address at once. The card is still shown: every sign-in ends with "Autoriser
    // l’accès", then the customer is taken back to where they were.
    let approvedRedirect: string | null = null;
    if (view.kind === 'approved') {
      approvedRedirect = acceptRedirect(view.redirectUrl, base, pending);
      if (!approvedRedirect) {
        await provider.revokeSession(session.accessToken);
        throw new ApiError(502, 'CONSENT_INVALID', 'TAKATAK answered with an unexpected address.');
      }
    }
    if (!writeConsentCookie(res, { authorizationId, accessToken: session.accessToken, subject: session.subject, email: session.email, createdAt: at, approvedRedirect }, secure)) {
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
    // The card comes after the password: never before it.
    if (handoff.stage === 'password') throw new ApiError(409, 'PASSWORD_REQUIRED', 'Choose your password first.');
    return { handoff, pending };
  }

  /** The handoff of a customer who still has to choose a password. */
  function readPasswordStage(req: Request) {
    const at = now().getTime();
    const handoff = decodeConsent(req.cookies?.[TAKATAK_CONSENT_COOKIE], at);
    const pending = readPending(req.cookies?.[TAKATAK_OAUTH_COOKIE], at);
    if (!handoff || handoff.stage !== 'password' || !pending) throw new ApiError(410, 'CONSENT_EXPIRED', 'This sign-in expired. Start again.');
    return { handoff, pending };
  }

  /**
   * Sign-up and forgotten-password stop here after the code or Google: the hub session waits
   * (encrypted, 10 minutes) for the password to be chosen. No authorization exists yet.
   */
  async function startPasswordStep(
    res: Response,
    session: HubSession,
    input: { returnTo: string; locale: 'fr' | 'en'; terms: boolean; intent: Intent },
  ): Promise<void> {
    if (!encryptionConfigured()) {
      throw new ApiError(503, 'TAKATAK_AUTH_UNAVAILABLE', 'TAKATAK sign-in is not available right now.');
    }
    const at = now().getTime();
    writePending(res, newPending({ returnTo: input.returnTo, locale: input.locale, terms: input.terms, link: null, intent: input.intent, now: at }), secure);
    if (!writeConsentCookie(res, { authorizationId: '', accessToken: session.accessToken, subject: session.subject, email: session.email, createdAt: at, stage: 'password' }, secure)) {
      console.error('[takatak-signin] hub session too large for the consent cookie; sign-in refused');
      await provider.revokeSession(session.accessToken);
      throw new ApiError(503, 'TAKATAK_AUTH_UNAVAILABLE', 'TAKATAK sign-in is not available right now.');
    }
  }

  /* ---------------- email code ---------------- */

  router.post('/auth/takatak/email/send', run(async (req, res) => {
    const input = sendSchema.parse(req.body);
    const base = requireBase();
    const key = hash(input.email);
    const ip = req.ip ?? 'unknown';
    limiter.assertCanSend(key, ip);
    // Reserve the quota before awaiting the network to bound concurrent sends.
    limiter.recordSend(key, ip);
    // The brand marker for the hub's email template: this site's own (allow-listed) address.
    await provider.sendEmailCode(input.email, { redirectTo: `${base}${GOOGLE_CALLBACK_PATH}` });
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
    const where = { returnTo: safeReturn(input.returnTo, base), locale: input.locale, terms: input.terms };
    if (input.intent !== 'signin') {
      await startPasswordStep(res, session, { ...where, intent: input.intent });
      res.json({ password: true, email: session.email });
      return;
    }
    res.json(await beginConsent(res, session, where, base));
  }));

  /* ---------------- password ---------------- */

  router.get('/auth/takatak/password/status', run(async (req, res) => {
    requireBase();
    consentPerIp.take(ipOf(req));
    const { handoff, pending } = readPasswordStage(req);
    // The intent tells the page whether to word the step as "create" or as "choose a new" password.
    res.json({ email: handoff.email, intent: pending.intent });
  }));

  router.post('/auth/takatak/password/set', run(async (req, res) => {
    const { password, confirm } = setPasswordSchema.parse(req.body);
    const base = requireBase();
    consentPerIp.take(ipOf(req));
    const { handoff, pending } = readPasswordStage(req);
    // Nothing is spent on a mistake: the step stays open so the form can be corrected and sent again.
    if (password !== confirm) throw new ApiError(400, 'PASSWORD_MISMATCH', 'The two passwords are not the same.');
    if (passwordProblems(password, handoff.email).length) throw new ApiError(400, 'WEAK_PASSWORD', 'Choose a stronger password.');
    try {
      await provider.setPassword(handoff.accessToken, password);
    } catch (error) {
      // The hub already has exactly this password (a retry after a hiccup, or the old one retyped): done.
      if (!(error instanceof IdentityError && error.code === 'PASSWORD_UNCHANGED')) throw error;
    }
    const session: HubSession = { accessToken: handoff.accessToken, subject: handoff.subject, email: handoff.email, phone: null };
    res.json(await beginConsent(res, session, { returnTo: pending.returnTo, locale: pending.locale, terms: pending.terms }, base));
  }));

  router.post('/auth/takatak/password/login', run(async (req, res) => {
    const input = loginSchema.parse(req.body);
    const base = requireBase();
    const key = hash(input.email);
    checksPerIp.take(ipOf(req));
    passwordAttempts.take(key);
    let session: HubSession;
    try {
      session = await provider.signInWithPassword(input.email, input.password);
    } catch (error) {
      // Only a verdict on the password counts; a hub limit or outage says nothing about it.
      if (!(error instanceof IdentityError && error.code === 'INVALID_CREDENTIALS')) passwordAttempts.giveBack(key);
      throw error;
    }
    passwordAttempts.clear(key);
    res.json(await beginConsent(res, session, { returnTo: safeReturn(input.returnTo, base), locale: input.locale, terms: input.terms }, base));
  }));

  /* ---------------- consent screen ---------------- */

  router.get('/auth/takatak/consent', run(async (req, res) => {
    const base = requireBase();
    consentPerIp.take(ipOf(req));
    const { handoff, pending } = readHandoff(req);
    // The page may switch language on the consent screen; the wording follows.
    const locale = req.query.locale === 'en' ? 'en' : req.query.locale === 'fr' ? 'fr' : pending.locale;
    if (handoff.approvedRedirect) {
      // The hub already approved this request earlier: it has no details to give, so the
      // card is filled from what this site asked for and from the verified account.
      res.json({
        app: 'R2NETTE',
        returnAddress: `${base}${CALLBACK_PATH}`,
        account: handoff.email ?? (locale === 'fr' ? 'Compte TAKATAK connecté' : 'Signed-in TAKATAK account'),
        scopes: requestedScopeText(locale),
        needsTerms: await needsTerms(handoff, pending),
      });
      return;
    }
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
      // Earlier approval: Autoriser uses the address the hub already issued; Refuser ends
      // the sign-in the same way a refusal at the hub does (the callback reads `error`).
      const url = handoff.approvedRedirect
        ? decision === 'approve'
          ? handoff.approvedRedirect
          : `${base}${CALLBACK_PATH}?error=access_denied&state=${encodeURIComponent(pending.state)}`
        : await provider.decideConsent({ authorizationId: handoff.authorizationId, accessToken: handoff.accessToken, decision });
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
      intent: req.query.intent === 'signup' ? 'signup' : req.query.intent === 'reset' ? 'reset' : 'signin',
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
      const where = { returnTo: pending.returnTo, locale: pending.locale, terms: pending.terms };
      const signingIn = pending.intent === 'signin';
      if (signingIn) await beginConsent(res, session, where, base);
      else await startPasswordStep(res, session, { ...where, intent: pending.intent });
      // Sign-up goes to the password step; a plain Google sign-in goes straight to the card.
      const query = new URLSearchParams(signingIn ? { consent: '1' } : { step: 'password' });
      if (pending.returnTo !== DEFAULT_RETURN) query.set('returnTo', pending.returnTo);
      res.redirect(303, `/login?${query.toString()}`);
    } catch {
      backToLogin(res, 'error', returnTo);
    }
  });

  return router;
}
