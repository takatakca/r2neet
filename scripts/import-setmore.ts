/**
 * Import a Setmore export.
 *
 *   npm run migrate:setmore -- --customers customers.csv --appointments appts.csv
 *   npm run migrate:setmore -- --customers customers.csv --appointments appts.csv --apply
 *
 * Dry run unless --apply. Safe to re-run: every record carries a
 * deterministic external id, so a half-finished import is resumed, not
 * duplicated.
 */
import { readFileSync, existsSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import {
  SetmoreImporter,
  parseCsv,
  mapCustomerColumns,
  mapAppointmentColumns,
} from '../src/migration/setmore-import.js';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '');
  }
}

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const customersFile = arg('customers');
const appointmentsFile = arg('appointments');
const apply = process.argv.includes('--apply');
const importPast = process.argv.includes('--include-past');

if (!customersFile) {
  console.error('Usage: --customers <file.csv> [--appointments <file.csv>] [--apply]');
  process.exit(1);
}
const url = process.env.PRISMA_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('Set PRISMA_DATABASE_URL (or DATABASE_URL).');
  process.exit(1);
}

const customers = parseCsv(readFileSync(customersFile, 'utf8')).map(mapCustomerColumns);
const appointments = appointmentsFile
  ? parseCsv(readFileSync(appointmentsFile, 'utf8')).map(mapAppointmentColumns)
  : [];

const prisma = new PrismaClient({ datasources: { db: { url } } });

try {
  console.log(apply ? '\nMode: APPLY\n' : '\nMode: DRY RUN (pass --apply to write)\n');
  const report = await new SetmoreImporter(prisma).run(
    { customers, appointments },
    { dryRun: !apply, importPast },
  );

  const pct = (n: number, total: number) => (total ? ` (${Math.round((n / total) * 100)}%)` : '');

  console.log('Customers');
  console.log(`  read       ${report.customers.total}`);
  console.log(`  importable ${report.customers.imported}${pct(report.customers.imported, report.customers.total)}`);
  console.log(`  already    ${report.customers.duplicates}`);
  console.log(`  rejected   ${report.customers.rejected}`);

  console.log('\nAppointments');
  console.log(`  read       ${report.appointments.total}`);
  console.log(`  importable ${report.appointments.imported}${pct(report.appointments.imported, report.appointments.total)}`);
  console.log(`  already    ${report.appointments.duplicates}`);
  console.log(`  past       ${report.appointments.past} (history, not scheduled)`);
  console.log(`  rejected   ${report.appointments.rejected}`);

  if (report.unmappedServices.length) {
    console.log('\nServices that need a decision before these can be imported:');
    for (const s of report.unmappedServices) {
      console.log(`  ${String(s.count).padStart(4)} × ${s.name}`);
    }
    console.log('  Add the crew size and duration to the name in the export, e.g.');
    console.log('  "Basic Cleaning" -> "Basic Cleaning - 2 Cleaners 3 Hours".');
  }

  const errors = report.issues.filter((i) => i.severity === 'ERROR');
  if (errors.length) {
    console.log(`\nRejected rows (${errors.length}):`);
    // Row numbers and reasons only — never the personal data itself.
    for (const e of errors.slice(0, 25)) {
      console.log(`  row ${String(e.row).padStart(4)}  ${e.field.padEnd(12)} ${e.message}`);
    }
    if (errors.length > 25) console.log(`  … and ${errors.length - 25} more`);
  }

  if (!apply) {
    console.log('\nNothing was written. Re-run with --apply once the rejections above are acceptable.');
  } else {
    console.log('\nImport complete. Imported bookings are UNASSIGNED — open /admin#dispatch to crew them.');
  }
} catch (e) {
  console.error('Import failed:', (e as Error).message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
