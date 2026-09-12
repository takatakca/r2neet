/**
 * Billing loop.
 *
 * Runs continuously so "24 hours before service" actually means that. A
 * once-daily cron would smear charges across a whole day.
 *
 * Deliberately its own process: sharing with notification retries means a
 * notification bug can delay a charge, and restarting to fix notifications
 * interrupts billing.
 */
import { readFileSync, existsSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { Scheduler } from '../src/workers/scheduler.js';
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
if (!url) { console.error('Set PRISMA_DATABASE_URL.'); process.exit(1); }

const prisma = new PrismaClient({ datasources: { db: { url } } });
const stripe = new LiveStripeProvider();

if (!stripe.configured) {
  // Idle rather than exit: the container should not crash-loop, and the
  // moment credentials appear a restart picks them up.
  console.log(JSON.stringify({ level: 'warn', msg: 'billing_idle', reason: 'STRIPE_NOT_CONFIGURED' }));
}

const billing = new BillingScheduler(prisma, new PaymentService(prisma, stripe));

const scheduler = new Scheduler(
  [
    {
      name: 'billing',
      everySeconds: 300, // every 5 minutes
      expectedWithinSeconds: 1800,
      run: async () => {
        if (!stripe.configured) return { skipped: 'STRIPE_NOT_CONFIGURED' };
        const r = await billing.run(`billing-${process.pid}`);
        return { scheduled: r.scheduled, charged: r.charged, softFailed: r.softFailed, hardFailed: r.hardFailed };
      },
    },
  ],
  undefined,
  undefined,
  prisma,
);

await scheduler.loop(60);
await prisma.$disconnect();
