/**
 * Sync the service catalogue into the database (categories, services,
 * add-ons, taxes, transport rule, promotions, business defaults).
 *
 * Runs on every production deploy, right after `prisma migrate deploy`.
 * Quotes, holds and bookings reference ServiceOption rows by foreign key, so
 * an empty catalogue makes every quote fail with Quote_serviceOptionId_fkey
 * (seen on r2nette.ca on 2026-11-10: POST /api/v1/quotes answered 500).
 *
 * The seed is upsert-only and never deletes, so running it on each deploy is
 * safe. This file exists because `prisma/seed.ts` only runs itself when
 * argv[1] contains "seed", which is false under vite-node, so the old
 * `npm run db:seed` silently did nothing.
 */
import { PrismaClient } from '@prisma/client';
import { seed } from '../prisma/seed.js';
import { resolveDatabase } from '../src/db/safety.js';

const db = resolveDatabase(process.env);
const prisma = new PrismaClient();
try {
  const result = await seed(prisma);
  console.log(JSON.stringify({ msg: 'catalogue synced', target: db.describe, environment: db.environment, ...result }));
} catch (error) {
  console.error('Catalogue sync failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
