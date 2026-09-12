/**
 * Recurrence worker.
 *
 * Materialises upcoming visits for every active plan. Safe to run on a
 * schedule and safe to run twice — generation is idempotent and guarded by a
 * per-slot advisory lock.
 *
 *   npm run worker:recurrence
 *
 * Suggested cadence: hourly. More often is harmless; less often risks a plan
 * whose next visit falls inside the booking lead time.
 */
import { readFileSync, existsSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { RecurrenceService } from '../src/booking/recurrence-service.js';

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
const service = new RecurrenceService(prisma);

try {
  const results = await service.materialiseAll();
  const created = results.reduce((n, r) => n + r.created, 0);
  const noCapacity = results.reduce((n, r) => n + r.noCapacity, 0);

  console.log(
    JSON.stringify({
      level: noCapacity > 0 ? 'warn' : 'info',
      msg: 'recurrence_run',
      plans: results.length,
      created,
      noCapacity,
    }),
  );

  // Unstaffable visits are an operational problem, not a silent no-op.
  for (const r of results) {
    for (const o of r.outcomes.filter((x) => x.outcome === 'NO_CAPACITY')) {
      console.log(
        JSON.stringify({ level: 'warn', msg: 'recurrence_no_capacity', seriesId: r.seriesId, at: o.at }),
      );
    }
  }
} catch (e) {
  console.error(JSON.stringify({ level: 'error', msg: 'recurrence_failed', error: String(e) }));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
