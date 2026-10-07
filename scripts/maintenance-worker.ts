/**
 * Maintenance worker.
 *
 * Retries failed notifications, warns about expiring cards, and prunes stale
 * rows. Everything here is idempotent and safe to run repeatedly.
 *
 *   npm run worker:maintenance      # daily
 */
import { readFileSync, existsSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import {
  NotificationService,
  TwilioSmsProvider,
  HttpEmailProvider,
} from '../src/notifications/notification-service.js';
import { CardExpiryService } from '../src/payments/dunning-service.js';

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

const prisma = new PrismaClient({ datasources: { db: { url } } });
const notifications = new NotificationService(prisma, {
  SMS: new TwilioSmsProvider(),
  EMAIL: new HttpEmailProvider(),
});

try {
  const retry = await notifications.retryFailed();
  const expiry = await new CardExpiryService(prisma, notifications).warnExpiring();

  // Expired sessions and idempotency records are not worth keeping.
  const sessions = await prisma.customerSession.deleteMany({
    where: { expiresAt: { lt: new Date(Date.now() - 7 * 86400000) } },
  });
  const staffSessions = await prisma.staffSession.deleteMany({
    where: { expiresAt: { lt: new Date(Date.now() - 7 * 86400000) } },
  });
  const googleAuthTransactions = await prisma.googleAuthTransaction.deleteMany({
    where: { expiresAt: { lt: new Date(Date.now() - 7 * 86400000) } },
  });
  const idem = await prisma.idempotencyRecord.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });

  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'maintenance_run',
      notificationsResent: retry.resent,
      notificationsAbandoned: retry.abandoned,
      cardWarnings: expiry.warned,
      prunedSessions: sessions.count + staffSessions.count,
      prunedGoogleAuthTransactions: googleAuthTransactions.count,
      prunedIdempotency: idem.count,
    }),
  );
} catch (e) {
  console.error(JSON.stringify({ level: 'error', msg: 'maintenance_failed', error: String(e) }));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
