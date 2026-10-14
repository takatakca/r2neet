import { existsSync, readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import {
  enqueueCustomerProfile,
  enqueuePaymentSummary,
} from '../src/integrations/takatak-sync.js';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match && !process.env[match[1]!]) {
      process.env[match[1]!] = match[2]!.trim().replace(/^["']|["']$/g, '');
    }
  }
}

const url = process.env.PRISMA_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('Set PRISMA_DATABASE_URL or DATABASE_URL.');
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url } } });
const PAGE = 100;

async function backfillCustomers() {
  let cursor: string | undefined;
  let queued = 0;

  while (true) {
    const rows = await prisma.customer.findMany({
      select: { id: true },
      orderBy: { id: 'asc' },
      take: PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      await enqueueCustomerProfile(prisma, row.id, 'PROFILE_UPDATED');
      queued += 1;
    }
    cursor = rows.at(-1)!.id;
    console.log(JSON.stringify({ phase: 'customers', queued }));
  }
  return queued;
}

async function backfillPayments() {
  let cursor: string | undefined;
  let queued = 0;

  while (true) {
    const rows = await prisma.payment.findMany({
      where: { bookingId: { not: null } },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      await enqueuePaymentSummary(prisma, row.id);
      queued += 1;
    }
    cursor = rows.at(-1)!.id;
    console.log(JSON.stringify({ phase: 'payments', queued }));
  }
  return queued;
}

try {
  const customers = await backfillCustomers();
  const payments = await backfillPayments();
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'takatak_sync_backfill_complete',
      customers,
      payments,
    }),
  );
} finally {
  await prisma.$disconnect();
}
