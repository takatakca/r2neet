/**
 * Billing worker.
 *
 * Schedules charges for visits entering the payment window, then charges
 * whatever is claimable. Safe to run on a schedule and safe to run twice —
 * attempts are unique per booking and workers take a database lease.
 *
 *   npm run worker:billing
 *
 * Suggested cadence: every 15 minutes. The charge window is hours wide, so
 * precision is not the point; not missing a visit is.
 */
import { readFileSync, existsSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { BillingScheduler } from '../src/payments/billing-scheduler.js';
import { PaymentService } from '../src/payments/payment-service.js';
import { LiveStripeProvider } from '../src/payments/stripe-provider.js';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '');
  }
}

const url = process.env.PRISMA_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('Set PRISMA_DATABASE_URL (or DATABASE_URL).');
  process.exit(1);
}

const stripe = new LiveStripeProvider();
if (!stripe.configured) {
  // Never pretend to bill. Exit cleanly so a scheduler does not alarm.
  console.log(JSON.stringify({ level: 'warn', msg: 'billing_skipped', reason: 'STRIPE_NOT_CONFIGURED' }));
  process.exit(0);
}

const prisma = new PrismaClient({ datasources: { db: { url } } });
const billing = new BillingScheduler(prisma, new PaymentService(prisma, stripe));

try {
  const res = await billing.run(`billing-${process.pid}`);
  console.log(
    JSON.stringify({
      level: res.hardFailed > 0 ? 'warn' : 'info',
      msg: 'billing_run',
      scheduled: res.scheduled,
      charged: res.charged,
      softFailed: res.softFailed,
      hardFailed: res.hardFailed,
    }),
  );
  // Failures a person has to act on, one line each.
  for (const o of res.outcomes.filter((x) => x.outcome === 'HARD_FAILED' || x.outcome === 'NO_PAYMENT_METHOD')) {
    console.log(
      JSON.stringify({ level: 'warn', msg: 'billing_needs_attention', bookingId: o.bookingId, code: o.code }),
    );
  }
} catch (e) {
  console.error(JSON.stringify({ level: 'error', msg: 'billing_failed', error: String(e) }));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
