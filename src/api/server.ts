import { PrismaClient } from '@prisma/client';
import { createApi } from './app.js';
import { SupabasePhoneAuthProvider } from '../identity/identity.js';
import { LiveStripeProvider } from '../payments/stripe-provider.js';
import { GooglePlacesProvider } from '../integrations/places.js';
import { resolveDatabase } from '../db/safety.js';
import { integrationStatus } from '../data/repositories.js';
import { validateProductionConfig, installGracefulShutdown } from './hardening.js';

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
  '/auth': 'auth.html',
  '/login': 'auth.html',
  '/verify': 'verify.html',
  '/signup': 'signup.html',
  '/account': 'account.html',
  '/admin': 'admin.html',
  '/crew': 'crew.html',
};
for (const [route, file] of Object.entries(pages)) {
  app.get(route, (_req, res) => {
    res.sendFile(path.join(dist, file));
  });
}
app.use(express.static(dist));

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
