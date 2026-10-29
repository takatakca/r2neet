// Codex — assistant OpenAI · 2026-10-29
import { Router, type Request, type Response } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ApiError, SESSION_COOKIE } from './app.js';
import { PrismaSessionStore } from '../db/durable-stores.js';
import { RateLimiter, normalizePhone, type VerificationProvider } from '../identity/identity.js';
import type { EmailAuthProvider } from '../identity/email-auth.js';

const COOKIE = 'r2n_email_challenge';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const email = z.string().trim().email().max(254).transform(s => s.toLowerCase());
const sendSchema = z.object({ email }).strict();
const verifySchema = z.object({ email, code: z.string().regex(/^\d{6,10}$/), locale: z.enum(['en', 'fr']), termsAccepted: z.literal(true) }).strict();
const phoneSchema = z.object({ phone: z.string().max(40), code: z.string().regex(/^\d{4,10}$/).optional() }).strict();

export function emailFirstRoutes(prisma: PrismaClient, provider: EmailAuthProvider, sms: VerificationProvider, now: () => Date) {
  const router = Router();
  const limiter = new RateLimiter(undefined, () => now().getTime());
  const sessions = new PrismaSessionStore(prisma, now);
  const cookie = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const, path: '/' };
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const run = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: (e?: unknown) => void) => {
    if (req.method !== 'GET' && (req.get('sec-fetch-site') === 'cross-site' || !req.is('application/json'))) {
      next(new ApiError(403, 'REQUEST_REJECTED', 'Use the form on this website.')); return;
    }
    fn(req, res).catch(e => {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        next(new ApiError(409, 'IDENTITY_ALREADY_LINKED', 'This identity is already linked. Sign in with your existing method.'));
      } else next(e);
    });
  };
  router.get('/auth/email/config', (_req, res) => { res.json({ configured: provider.configured }); });
  router.post('/auth/email/send', run(async (req, res) => {
    const input = sendSchema.parse(req.body);
    if (!provider.configured) throw new ApiError(503, 'EMAIL_AUTH_NOT_CONFIGURED', 'Email sign-in is not configured.');
    const key = hash(input.email), ip = req.ip ?? 'unknown';
    limiter.assertCanSend(key, ip);
    // Reserve the quota before awaiting the network to bound concurrent sends.
    limiter.recordSend(key, ip);
    await provider.send(input.email);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now().getTime() + 10 * 60_000);
    await prisma.emailAuthChallenge.create({ data: { email: input.email, tokenHash: hash(token), expiresAt } });
    res.cookie(COOKIE, token, { ...cookie, expires: expiresAt });
    res.json({ sent: true, expiresInSeconds: 600 });
  }));
  router.post('/auth/email/verify', run(async (req, res) => {
    const input = verifySchema.parse(req.body);
    const token = req.cookies?.[COOKIE];
    if (typeof token !== 'string') throw new ApiError(401, 'EMAIL_CHALLENGE_EXPIRED', 'Request a new email code.');
    const challenge = await prisma.emailAuthChallenge.findUnique({ where: { tokenHash: hash(token) } });
    if (!challenge || challenge.consumedAt || challenge.expiresAt <= now() || challenge.email !== input.email) {
      throw new ApiError(401, 'EMAIL_CHALLENGE_EXPIRED', 'Request a new email code.');
    }
    const key = hash(input.email);
    limiter.assertCanCheck(key);
    // Count every attempt, including malformed provider replies and failures.
    limiter.recordFailedCheck(key);
    const identity = await provider.verify(input.email, input.code);
    if (identity.email !== input.email || !identity.subject) throw new ApiError(401, 'EMAIL_CODE_INVALID', 'The code is invalid or expired.');
    const at = now();
    const customer = await prisma.$transaction(async tx => {
      const claimed = await tx.emailAuthChallenge.updateMany({ where: { id: challenge.id, consumedAt: null, expiresAt: { gt: at } }, data: { consumedAt: at } });
      if (claimed.count !== 1) throw new ApiError(401, 'EMAIL_CHALLENGE_EXPIRED', 'Request a new email code.');
      const existing = await tx.customer.findFirst({ where: { OR: [{ emailAuthSubject: identity.subject }, { email: input.email }] } });
      if (existing) {
        // A historic profile email is not proof of a linked login identity.
        if (existing.emailAuthSubject !== identity.subject || existing.email !== input.email) {
          throw new ApiError(409, 'ACCOUNT_LINK_REQUIRED', 'Use your existing sign-in method to access this account.');
        }
        return existing;
      }
      return tx.customer.create({ data: { email: input.email, emailAuthSubject: identity.subject, emailVerifiedAt: at,
        preferredLocale: input.locale, registrationCompletedAt: at, termsAcceptedAt: at, termsVersion: '2026-10-29',
        privacyAcceptedAt: at, privacyVersion: '2026-10-29', marketingConsent: false } });
    });
    const session = await sessions.create(customer.id, { ip: req.ip, userAgent: req.get('user-agent') }, 'EMAIL');
    res.cookie(SESSION_COOKIE, session.token, { ...cookie, expires: session.expiresAt });
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ authenticated: true });
  }));

  async function paidCustomer(req: Request): Promise<string> {
    if (!req.customerId) throw new ApiError(401, 'UNAUTHORIZED', 'Sign in to continue.');
    const payment = await prisma.payment.findFirst({ where: { customerId: req.customerId, status: 'SUCCEEDED', amountCents: { gt: 0 } }, select: { id: true } });
    if (!payment) throw new ApiError(403, 'FIRST_PAYMENT_REQUIRED', 'SMS verification becomes available after your first successful payment.');
    return req.customerId;
  }
  router.get('/account/phone/status', run(async (req, res) => {
    if (!req.customerId) throw new ApiError(401, 'UNAUTHORIZED', 'Sign in to continue.');
    const [phone, payment] = await Promise.all([
      prisma.customerPhone.findFirst({ where: { customerId: req.customerId, verifiedAt: { not: null } } }),
      prisma.payment.findFirst({ where: { customerId: req.customerId, status: 'SUCCEEDED', amountCents: { gt: 0 } }, select: { id: true } }),
    ]);
    res.json({ verified: Boolean(phone), eligible: Boolean(payment), configured: sms.configured });
  }));
  router.post('/account/phone/send', run(async (req, res) => {
    const customerId = await paidCustomer(req);
    const { phone } = phoneSchema.parse(req.body);
    const normalized = normalizePhone(phone);
    if (await prisma.customerPhone.findFirst({ where: { customerId, verifiedAt: { not: null } } })) throw new ApiError(409, 'PHONE_ALREADY_VERIFIED', 'Your phone is already verified.');
    const key = hash(normalized), ip = req.ip ?? 'unknown';
    limiter.assertCanSend(key, ip); limiter.recordSend(key, ip);
    const out = await sms.start(normalized);
    if (out.status !== 'PENDING') throw new ApiError(503, 'VERIFY_PROVIDER_UNAVAILABLE', 'SMS verification is unavailable.');
    res.json({ sent: true });
  }));
  router.post('/account/phone/verify', run(async (req, res) => {
    const customerId = await paidCustomer(req);
    const input = phoneSchema.parse(req.body);
    if (!input.code) throw new ApiError(400, 'VALIDATION_ERROR', 'Enter your code.');
    const phoneE164 = normalizePhone(input.phone), key = hash(phoneE164);
    limiter.assertCanCheck(key); limiter.recordFailedCheck(key);
    const proof = await sms.check(phoneE164, input.code);
    if (proof.status !== 'APPROVED') throw new ApiError(401, 'OTP_INVALID', 'The code is invalid or expired.');
    await prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`r2n-phone:${customerId}`}, 0))`;
      // Unique phone index is the final authority: never reassign another account's phone.
      const phone = await tx.customerPhone.findUnique({ where: { phoneE164 } });
      if (phone && phone.customerId !== customerId) throw new ApiError(409, 'IDENTITY_ALREADY_LINKED', 'Use your existing sign-in method.');
      const existing = await tx.customerPhone.findFirst({ where: { customerId, verifiedAt: { not: null } } });
      if (existing && existing.phoneE164 !== phoneE164) throw new ApiError(409, 'PHONE_ALREADY_VERIFIED', 'Your phone is already verified.');
      await tx.customerPhone.upsert({ where: { phoneE164 }, create: { customerId, phoneE164, verifiedAt: now() }, update: { verifiedAt: now() } });
    });
    res.json({ verified: true });
  }));
  return router;
}
