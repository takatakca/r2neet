/**
 * General scheduler loop.
 *
 * Everything that is not money: creating future visits, retrying
 * notifications, warning about expiring cards, and the morning digest.
 */
import { readFileSync, existsSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { Scheduler } from '../src/workers/scheduler.js';
import { RecurrenceService } from '../src/booking/recurrence-service.js';
import {
  NotificationService,
  TwilioSmsProvider,
  HttpEmailProvider,
} from '../src/notifications/notification-service.js';
import { CardExpiryService } from '../src/payments/dunning-service.js';
import { CallbackService, TwilioVoiceProvider } from '../src/callbacks/callback-service.js';
import { WorkerHealthService, AlertService, WebhookAlertSink } from '../src/workers/health.js';
import { workerExpectations } from '../src/workers/expectations.js';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '');
  }
}
const url = process.env.PRISMA_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) { console.error('Set PRISMA_DATABASE_URL.'); process.exit(1); }

const prisma = new PrismaClient({ datasources: { db: { url } } });
const notifications = new NotificationService(prisma, {
  SMS: new TwilioSmsProvider(),
  EMAIL: new HttpEmailProvider(),
});
const recurrence = new RecurrenceService(prisma);
const expiry = new CardExpiryService(prisma, notifications);
const voice = new TwilioVoiceProvider();
const callbacks = new CallbackService(prisma, voice.configured ? voice : null);

const health = new WorkerHealthService(prisma, workerExpectations());
const alerts = new AlertService(prisma, new WebhookAlertSink());

const scheduler = new Scheduler(
  [
    {
      // Watches every other worker and raises/clears alerts. Deduplicated,
      // so a worker down for an hour produces one alert, not sixty.
      name: 'health-check',
      everySeconds: 60,
      run: async () => {
        const all = await health.health();
        const alertable = await health.alertable();
        await alerts.reconcileWorkers(all, alertable);
        return {
          healthy: all.filter((w) => w.status === 'HEALTHY').length,
          neverSucceeded: all.filter((w) => w.status === 'NEVER_SUCCEEDED').length,
          overdue: all.filter((w) => w.status === 'OVERDUE' || w.status === 'FAILING').length,
        };
      },
    },
    {
      // A callback promised "in about 5 minutes" cannot wait for a cron.
      name: 'callbacks',
      everySeconds: 60,
      expectedWithinSeconds: 600,
      run: async () => {
        const claimed = await callbacks.claimNext(`sched-${process.pid}`);
        if (!claimed) return { claimed: 0 };
        const res = await callbacks.dialStaffFirst(claimed.id);
        return { claimed: 1, dialed: res.dialed };
      },
    },
    {
      name: 'notifications-retry',
      everySeconds: 300,
      expectedWithinSeconds: 1800,
      run: async () => notifications.retryFailed(),
    },
    {
      // Idempotent, so frequent runs are harmless and a missed hour is
      // caught by the next one.
      name: 'recurrence',
      everySeconds: 3600,
      expectedWithinSeconds: 14400,
      run: async () => {
        const results = await recurrence.materialiseAll();
        return {
          plans: results.length,
          created: results.reduce((n, r) => n + r.created, 0),
          noCapacity: results.reduce((n, r) => n + r.noCapacity, 0),
        };
      },
    },
    {
      name: 'card-expiry',
      dailyLocalAt: '09:00',
      expectedWithinSeconds: 172800,
      run: async () => expiry.warnExpiring(),
    },
    {
      // Local wall-clock, so it does not drift an hour at each DST change.
      name: 'operations-digest',
      dailyLocalAt: '07:00',
      expectedWithinSeconds: 172800,
      run: async () => {
        const at = new Date();
        const [bookings, unassigned, dunning, callbacksWaiting, failedNotifications] =
          await Promise.all([
            prisma.booking.count({
              where: { startAt: { gte: at, lt: new Date(at.getTime() + 86400000) }, status: { notIn: ['CANCELLED'] } },
            }),
            prisma.booking.count({ where: { startAt: { gte: at }, staff: { none: {} }, status: { notIn: ['CANCELLED'] } } }),
            prisma.dunningCase.count({ where: { status: 'OPEN' } }),
            prisma.callbackRequest.count({ where: { status: { in: ['REQUESTED', 'QUEUED'] } } }),
            prisma.notification.count({ where: { status: 'FAILED' } }),
          ]);
        // Recorded as a run detail; the admin dashboard shows the same
        // figures. No email is claimed unless a provider is configured.
        return { bookings, unassigned, dunning, callbacksWaiting, failedNotifications };
      },
    },
  ],
  undefined,
  undefined,
  prisma,
);

await scheduler.loop(30);
await prisma.$disconnect();
