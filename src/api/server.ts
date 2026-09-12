import { PrismaClient } from '@prisma/client';
import { createApi } from './app.js';
import { TwilioVerifyProvider } from '../identity/identity.js';
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
  verification: new TwilioVerifyProvider(),
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
import express from 'express';
import path from 'node:path';
const dist = path.resolve('dist');
app.get('/book', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
app.get('/account', (_req, res) => res.sendFile(path.join(dist, 'account.html')));
app.get('/admin', (_req, res) => res.sendFile(path.join(dist, 'admin.html')));
app.get('/crew', (_req, res) => res.sendFile(path.join(dist, 'crew.html')));
app.use(express.static(dist));

const problems = validateProductionConfig(process.env);
for (const p of problems) {
  console.error(`[config ${p.severity}] ${p.message}`);
}
if (problems.some((p) => p.severity === 'FATAL')) {
  console.error('Refusing to start in an unsafe configuration.');
  process.exit(1);
}

const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, () => {
  console.log(`R2NETTE API on :${port} — database ${db.describe} (${db.environment})`);
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
