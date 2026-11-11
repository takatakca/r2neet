// Claude (Anthropic) · 2026-11-10 — "Continuer avec TAKATAK"
//
// Flow: R2NETTE /api/v1/auth/takatak/start → TAKATAK sign-in / sign-up and
// consent → /api/v1/auth/takatak/callback → R2NETTE session. TAKATAK keeps the
// master account; R2NETTE keeps a copy of the customer (email, name and any
// phone TAKATAK has already verified) and queues the usual profile event back
// to TAKATAK.
//
// Account safety mirrors email-first.ts: a TAKATAK account is matched by its
// TAKATAK user id, or by a phone both systems already verified through TAKATAK.
// A historic R2NETTE profile that merely lists the same email is never taken
// over; its owner signs in with their existing method and links TAKATAK from
// there (intent=link).
import { Router, type Request, type Response } from 'express';
import { Prisma, type PrismaClient } from '@prisma/client';
import { SESSION_COOKIE } from './app.js';
import { PrismaSessionStore } from '../db/durable-stores.js';
import { enqueueCustomerProfile } from '../integrations/takatak-sync.js';
import type { TakatakIdentity, TakatakOAuthProvider } from '../identity/takatak-oauth.js';
import {
  CALLBACK_PATH,
  DEFAULT_RETURN,
  Stop,
  TAKATAK_OAUTH_COOKIE,
  backToLogin,
  challengeOf,
  clearPending,
  newPending,
  publicOrigin,
  readPending,
  safeReturn,
  sameSecret,
  writePending,
  type Pending,
} from './takatak-shared.js';

export { TAKATAK_OAUTH_COOKIE };
const TERMS_VERSION = '2026-10-29';
const PRIVACY_VERSION = '2026-10-29';

function splitName(name: string | null): { firstName: string | null; lastName: string | null } {
  const parts = (name ?? '').split(/\s+/).filter(Boolean);
  const firstName = parts.shift()?.slice(0, 80) ?? null;
  const lastName = parts.join(' ').slice(0, 80) || null;
  return { firstName, lastName };
}

export function takatakOAuthRoutes(
  prisma: PrismaClient,
  provider: TakatakOAuthProvider,
  options: { publicUrl?: string; now: () => Date },
) {
  const router = Router();
  const { now } = options;
  const sessions = new PrismaSessionStore(prisma, now);
  const secure = process.env.NODE_ENV === 'production';

  router.use('/auth/takatak', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  const origin = () => publicOrigin(options.publicUrl);

  router.get('/auth/takatak/config', (_req, res) => {
    res.json({ configured: provider.configured && origin() !== null });
  });

  router.get('/account/takatak', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!req.customerId) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Sign in to continue.' } });
      return;
    }
    const customer = await prisma.customer.findUnique({ where: { id: req.customerId }, select: { emailAuthSubject: true } });
    res.json({ linked: Boolean(customer?.emailAuthSubject), configured: provider.configured && origin() !== null });
  });

  router.get('/auth/takatak/start', async (req: Request, res: Response) => {
    const base = origin();
    const returnTo = base ? safeReturn(req.query.returnTo, base) : DEFAULT_RETURN;
    const linking = req.query.intent === 'link';
    if (!base || !provider.configured) {
      backToLogin(res, 'unavailable', returnTo, linking ? '/account' : '/login');
      return;
    }
    if (linking && !req.customerId) {
      backToLogin(res, 'signin-first', '/account');
      return;
    }
    const pending: Pending = newPending({
      returnTo: linking ? safeReturn(req.query.returnTo ?? '/account', base) : returnTo,
      locale: req.query.locale === 'en' ? 'en' : 'fr',
      terms: req.query.terms === '1',
      link: linking ? req.customerId! : null,
      now: now().getTime(),
    });
    try {
      const authorizeUrl = await provider.authorizationUrl({
        redirectUri: `${base}${CALLBACK_PATH}`,
        challenge: challengeOf(pending.verifier),
        state: pending.state,
        locale: pending.locale,
      });
      writePending(res, pending, secure);
      res.redirect(303, authorizeUrl);
    } catch {
      backToLogin(res, 'unavailable', returnTo, linking ? '/account' : '/login');
    }
  });

  async function resolveCustomer(
    identity: TakatakIdentity,
    pending: Pending,
    at: Date,
  ): Promise<{ id: string; created: boolean }> {
    return prisma.$transaction(async (tx) => {
      const owner = await tx.customer.findUnique({ where: { emailAuthSubject: identity.subject }, select: { id: true } });

      if (pending.link) {
        if (owner && owner.id !== pending.link) throw new Stop('already-linked');
        if (!owner) {
          const target = await tx.customer.findUnique({ where: { id: pending.link }, select: { emailAuthSubject: true } });
          if (!target) throw new Stop('error');
          if (target.emailAuthSubject) throw new Stop('other-account');
          const claimed = await tx.customer.updateMany({
            where: { id: pending.link, emailAuthSubject: null },
            data: { emailAuthSubject: identity.subject },
          });
          if (claimed.count !== 1) throw new Stop('error');
          await enqueueCustomerProfile(tx, pending.link, 'PROFILE_UPDATED', at);
        }
        return { id: pending.link, created: false };
      }

      if (owner) {
        await fillMissing(tx, owner.id, identity, at);
        return { id: owner.id, created: false };
      }

      // Same phone already proven on R2NETTE through TAKATAK phone sign-in.
      if (identity.phoneVerified && identity.phone) {
        const phone = await tx.customerPhone.findUnique({
          where: { phoneE164: identity.phone },
          select: { customerId: true, verifiedAt: true, customer: { select: { emailAuthSubject: true } } },
        });
        if (phone?.verifiedAt) {
          if (phone.customer.emailAuthSubject) throw new Stop('link-required');
          const claimed = await tx.customer.updateMany({
            where: { id: phone.customerId, emailAuthSubject: null },
            data: { emailAuthSubject: identity.subject },
          });
          if (claimed.count !== 1) throw new Stop('error');
          await fillMissing(tx, phone.customerId, identity, at, true);
          return { id: phone.customerId, created: false };
        }
      }

      if (!identity.email || !identity.emailVerified) throw new Stop('email-required');
      // A historic profile email is not proof of a linked login identity.
      if (await tx.customer.findUnique({ where: { email: identity.email }, select: { id: true } })) {
        throw new Stop('link-required');
      }
      if (!pending.terms) throw new Stop('terms');

      const customer = await tx.customer.create({
        data: {
          email: identity.email,
          emailAuthSubject: identity.subject,
          emailVerifiedAt: at,
          ...splitName(identity.name),
          preferredLocale: pending.locale,
          registrationCompletedAt: at,
          termsAcceptedAt: at,
          termsVersion: TERMS_VERSION,
          privacyAcceptedAt: at,
          privacyVersion: PRIVACY_VERSION,
          marketingConsent: false,
        },
        select: { id: true },
      });
      if (identity.phoneVerified && identity.phone) {
        const taken = await tx.customerPhone.findUnique({ where: { phoneE164: identity.phone }, select: { id: true } });
        if (!taken) {
          await tx.customerPhone.create({
            data: { customerId: customer.id, phoneE164: identity.phone, verifiedAt: at, isPrimary: true },
          });
        }
      }
      await enqueueCustomerProfile(tx, customer.id, 'CUSTOMER_REGISTERED', at);
      return { id: customer.id, created: true };
    });
  }

  /** Copy TAKATAK details into empty R2NETTE fields; never overwrite what the customer entered. */
  async function fillMissing(
    tx: Prisma.TransactionClient,
    customerId: string,
    identity: TakatakIdentity,
    at: Date,
    alwaysSync = false,
  ) {
    const current = await tx.customer.findUnique({
      where: { id: customerId },
      select: { email: true, firstName: true, lastName: true },
    });
    if (!current) throw new Stop('error');
    const data: Prisma.CustomerUpdateInput = {};
    if (!current.email && identity.email && identity.emailVerified) {
      const used = await tx.customer.findUnique({ where: { email: identity.email }, select: { id: true } });
      if (!used) {
        data.email = identity.email;
        data.emailVerifiedAt = at;
      }
    }
    if (!current.firstName && !current.lastName && identity.name) Object.assign(data, splitName(identity.name));
    if (Object.keys(data).length) await tx.customer.update({ where: { id: customerId }, data });
    if (alwaysSync || Object.keys(data).length) await enqueueCustomerProfile(tx, customerId, 'PROFILE_UPDATED', at);
  }

  router.get('/auth/takatak/callback', async (req: Request, res: Response) => {
    const at = now();
    const pending = readPending(req.cookies?.[TAKATAK_OAUTH_COOKIE], at.getTime());
    clearPending(res);
    const failPath = pending?.link ? '/account' : '/login';
    const returnTo = pending?.returnTo ?? DEFAULT_RETURN;
    const base = origin();
    const code = typeof req.query.code === 'string' && req.query.code.length <= 2048 ? req.query.code : null;
    const state = typeof req.query.state === 'string' ? req.query.state : null;

    if (!base) {
      backToLogin(res, 'unavailable', returnTo, failPath);
      return;
    }
    if (!pending || !state || !sameSecret(state, pending.state)) {
      backToLogin(res, 'expired', returnTo, failPath);
      return;
    }
    if (req.query.error) {
      backToLogin(res, 'cancelled', returnTo, failPath);
      return;
    }
    if (!code) {
      backToLogin(res, 'expired', returnTo, failPath);
      return;
    }
    // A link started by one R2NETTE session must finish in that same session.
    if (pending.link && req.customerId !== pending.link) {
      backToLogin(res, 'signin-first', '/account', '/account');
      return;
    }

    try {
      const identity = await provider.exchangeCode({
        code,
        verifier: pending.verifier,
        redirectUri: `${base}${CALLBACK_PATH}`,
      });
      const customer = await resolveCustomer(identity, pending, at);
      if (!pending.link) {
        const session = await sessions.create(
          customer.id,
          { ip: req.ip, userAgent: req.get('user-agent') ?? undefined },
          identity.emailVerified ? 'EMAIL' : 'PHONE',
        );
        res.cookie(SESSION_COOKIE, session.token, { httpOnly: true, secure, sameSite: 'lax', path: '/', expires: session.expiresAt });
      }
      const target = new URL(pending.link ? '/account' : pending.returnTo, base);
      if (pending.link) target.searchParams.set('takatak', 'linked');
      res.redirect(303, target.pathname + target.search + target.hash);
    } catch (error) {
      if (error instanceof Stop) {
        backToLogin(res, error.reason, returnTo, error.reason === 'terms' || error.reason === 'email-required' ? '/signup' : failPath);
      } else if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        backToLogin(res, 'link-required', returnTo, failPath);
      } else {
        backToLogin(res, 'error', returnTo, failPath);
      }
    }
  });

  return router;
}
