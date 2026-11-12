import { PrismaClient } from '@prisma/client';
import { createApi } from './app.js';
import { SupabasePhoneAuthProvider } from '../identity/identity.js';
import { LiveStripeProvider } from '../payments/stripe-provider.js';
import { GooglePlacesProvider } from '../integrations/places.js';
import { resolveDatabase } from '../db/safety.js';
import { integrationStatus } from '../data/repositories.js';
import { validateProductionConfig, installGracefulShutdown, notFoundHandler } from './hardening.js';

/**
 * Development/production entrypoint.
 *
 * Every integration is optional. A missing credential produces a
 * NOT_CONFIGURED route, never a fake success.
 */
const db = resolveDatabase(process.env);
const prisma = new PrismaClient();

const stripe = new LiveStripeProvider();
const places = new GooglePlacesProvider();

let shuttingDown = false;

const app = createApi({
  prisma,
  hardening: {
    enabled: true,
    hsts: process.env.NODE_ENV === 'production',
    requireHttps: process.env.REQUIRE_HTTPS !== 'false' && process.env.NODE_ENV === 'production',
    rateLimit: process.env.RATE_LIMIT !== 'false',
    isShuttingDown: () => shuttingDown,
  },
  verification: new SupabasePhoneAuthProvider(),
  phoneLogin: process.env.R2NETTE_PHONE_LOGIN === 'true',
  stripe: stripe.configured ? stripe : undefined,
  places: places.configured ? places : undefined,
  origin:
    process.env.BUSINESS_ORIGIN_LAT && process.env.BUSINESS_ORIGIN_LNG
      ? {
          latitude: Number(process.env.BUSINESS_ORIGIN_LAT),
          longitude: Number(process.env.BUSINESS_ORIGIN_LNG),
        }
      : undefined,
});

// Serve the BUILT frontend. Never raw source, never a loose HTML file.
// Clean paths match vite.config.ts. The dev server rewrites them; production
// has to do the same or /login, /verify and /signup 404 after the image boots.
import express from 'express';
import path from 'node:path';
const dist = path.resolve('dist');
const pages: Record<string, string> = {
  '/book': 'index.html',
  '/auth': 'email.html',
  '/login': 'email.html',
  '/verify': 'verify.html',
  '/signup': 'email.html',
  '/account': 'account.html',
  '/admin': 'admin.html',
  '/crew': 'crew.html',
  '/phone-login': 'auth.html',
  '/profile': 'signup.html',
  '/commercial': 'commercial.html',
  '/payment': 'payment.html',
  '/terms': 'terms.html',
  '/privacy': 'privacy.html',
};
// Phone sign-in is off (owner order 2026-11-12): its pages go to the email and
// Google sign-in instead of a dead end.
const phoneLoginPages = new Set(['/phone-login', '/verify', '/profile']);
for (const [route, file] of Object.entries(pages)) {
  app.get(route, (_req, res) => {
    // "/auth" used to be the Account menu link and showed the sign-in page even to a
    // signed-in customer. The menu now goes to /account; old links and bookmarks follow it.
    if (route === '/auth') {
      res.redirect(302, '/account');
      return;
    }
    if (process.env.R2NETTE_PHONE_LOGIN !== 'true' && phoneLoginPages.has(route)) {
      res.redirect(302, '/login');
      return;
    }
    res.sendFile(path.join(dist, file));
  });
}
app.use(express.static(dist));
app.use(notFoundHandler());

const problems = validateProductionConfig(process.env);
for (const p of problems) {
  console.error(`[config ${p.severity}] ${p.message}`);
}
if (problems.some((p) => p.severity === 'FATAL')) {
  console.error('Refusing to start in an unsafe configuration.');
  process.exit(1);
}

const host = process.env.HOST ?? '0.0.0.0';
const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, host, () => {
  console.log(`R2NETTE API on ${host}:${port} — database ${db.describe} (${db.environment})`);
  for (const i of integrationStatus(process.env)) {
    console.log(`  ${i.status === 'CONNECTED' ? '✓' : '·'} ${i.label}: ${i.status}`);
  }
});

const shutdown = installGracefulShutdown({
  server,
  onDrain: async () => {
    await prisma.$disconnect();
  },
});
shuttingDown = false;
setInterval(() => {
  shuttingDown = shutdown.isShuttingDown();
}, 500).unref();
