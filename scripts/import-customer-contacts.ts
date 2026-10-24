/** Private-file import. Dry-run needs no database; --apply writes CRM evidence only. */
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { importContactBatch, inventoryBatches } from '../src/migration/customer-contacts.js';

async function main() {
  const at = process.argv.indexOf('--file');
  const file = at >= 0 ? process.argv[at + 1] : undefined;
  if (!file) throw new Error('Usage: --file /private/inventory.json [--apply]');
  const batches = inventoryBatches(JSON.parse(readFileSync(file, 'utf8')));
  const contacts = new Set(batches.flatMap((b) => b.contacts.map((c) => c.email))).size;
  const sources = batches.reduce((n, b) => n + b.contacts.reduce((m, c) => m + c.sources.length, 0), 0);
  console.log(JSON.stringify({ mode: process.argv.includes('--apply') ? 'APPLY' : 'DRY_RUN', contacts, sources, batches: batches.length }));
  if (process.argv.includes('--apply')) {
    const url = process.env.PRISMA_DATABASE_URL || process.env.DATABASE_URL;
    if (!url) throw new Error('Database configuration is required for --apply.');
    const prisma = new PrismaClient({ datasources: { db: { url } } });
    try {
      for (const batch of batches) await importContactBatch(prisma, batch);
      console.log('Contact evidence import completed. No login accounts or newsletter subscriptions created.');
    } finally { await prisma.$disconnect(); }
  }
}

void main().catch(() => {
  console.error('Contact import failed. Check the private file format and database configuration; no input values are logged.');
  process.exitCode = 1;
});
