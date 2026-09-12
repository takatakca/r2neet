/**
 * Disaster-recovery drill.
 *
 * Earlier this existed as a throwaway script I ran once. That is exactly the
 * kind of verification that decays: it passes on the day it is written and is
 * never run again. This version is committed and runs weekly in CI.
 *
 *   npm run drill:restore
 *
 * It proves the pair, not just the dump: a restored database AND the correct
 * encryption key together let the owner sign in; the wrong key does not.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { StaffAuthService } from '../src/auth/staff-auth.js';
import { totpForStep, currentStep, TOTP_STEP_SECONDS } from '../src/auth/totp.js';
import { generateEncryptionKey, isEncrypted } from '../src/auth/encryption.js';
import { localToUtc } from '../src/scheduling/availability.js';
import { seed } from '../prisma/seed.js';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '');
  }
}

const SOURCE = process.env.TEST_DATABASE_URL;
if (!SOURCE) {
  console.error('TEST_DATABASE_URL is required. The drill never touches production.');
  process.exit(1);
}
// Belt and braces: this script creates and drops databases.
if (!/test|scratch|ci|tmp/i.test(SOURCE.split('/').pop() ?? '')) {
  console.error('Refusing: TEST_DATABASE_URL does not look like a test database.');
  process.exit(1);
}

const RESTORE_DB = 'r2nette_drill_restore';
const RESTORE_URL = SOURCE.replace(/\/[^/?]+(\?|$)/, `/${RESTORE_DB}$1`);
const KEY = generateEncryptionKey();
process.env.FIELD_ENCRYPTION_KEY = KEY;

const checks: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const wallTime = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);

const src = new PrismaClient({ datasources: { db: { url: SOURCE } } });

try {
  console.log('\nSeeding a known dataset...\n');

  await src.staffSession.deleteMany();
  await src.staffUser.deleteMany();
  await src.bookingStatusHistory.deleteMany();
  await src.bookingStaff.deleteMany();
  await src.booking.deleteMany();
  await src.quoteLine.deleteMany();
  await src.quote.deleteMany();
  await src.recurrenceSeries.deleteMany();
  await src.promotionClaim.deleteMany();
  await src.customerAddress.deleteMany();
  await src.customerPhone.deleteMany();
  await src.customer.deleteMany();
  await src.staffAvailability.deleteMany();
  await src.staff.deleteMany();
  await seed(src);

  const auth = new StaffAuthService(src);
  const owner = await auth.createUser({
    email: 'drill-owner@r2nette.ca',
    password: 'MapleRiver47Sky',
    displayName: 'Drill Owner',
    role: 'OWNER',
    mustChangePassword: false,
  });
  const { secret } = await auth.beginTotpEnrolment(owner.id);
  await auth.confirmTotpEnrolment(owner.id, totpForStep(secret, currentStep()));

  const customer = await src.customer.create({ data: { firstName: 'Marie', email: 'marie@example.com' } });
  const address = await src.customerAddress.create({
    data: {
      customerId: customer.id,
      formattedAddress: '754 Av. 36e, Lachine',
      city: 'Lachine',
      postalCode: 'H8T1B7',
      isDefault: true,
    },
  });
  const quote = await src.quote.create({
    data: {
      customerId: customer.id,
      serviceOptionId: 'svc_basic_2x3',
      frequency: 'WEEKLY',
      baseServiceCents: 20000,
      subtotalCents: 17500,
      gstCents: 875,
      qstCents: 1746,
      taxTotalCents: 2621,
      grandTotalCents: 20121,
      gstRateMicroPercent: 5_000_000,
      qstRateMicroPercent: 9_975_000,
      pricingVersion: 'drill',
      priceSnapshot: { frozen: true },
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  const startAt = localToUtc(2026, 9, 5, 10 * 60);
  const booking = await src.booking.create({
    data: {
      bookingNumber: 'R2N-2026-004242',
      customerId: customer.id,
      serviceOptionId: 'svc_basic_2x3',
      addressId: address.id,
      quoteId: quote.id,
      startAt,
      endAt: new Date(startAt.getTime() + 3 * 3600_000),
      status: 'CONFIRMED',
      grandTotalCents: 20121,
      priceSnapshot: { frozen: true },
    },
  });
  await src.recurrenceSeries.create({
    data: {
      customerId: customer.id,
      serviceOptionId: 'svc_basic_2x3',
      addressId: address.id,
      frequency: 'WEEKLY',
      recurrenceKind: 'FIXED_INTERVAL_DAYS',
      startAt,
      status: 'ACTIVE',
    },
  });
  await src.promotionClaim.create({
    data: {
      customerId: customer.id,
      promotionFamily: 'NEW_CUSTOMER',
      promotionId: 'promo_new_basic',
      amountCents: 1500,
      bookingId: booking.id,
      status: 'REDEEMED',
      redeemedAt: new Date(),
    },
  });

  const before = {
    customers: await src.customer.count(),
    bookings: await src.booking.count(),
    quotes: await src.quote.count(),
    claims: await src.promotionClaim.count(),
    series: await src.recurrenceSeries.count(),
    staffUsers: await src.staffUser.count(),
  };

  const ownerRow = await src.staffUser.findUniqueOrThrow({ where: { id: owner.id } });
  console.log('Checks:\n');
  check('Two-factor secret is encrypted at rest', isEncrypted(ownerRow.totpSecret!));

  await src.$disconnect();

  /* ---------------- backup ---------------- */

  const dir = mkdtempSync(join(tmpdir(), 'r2nette-drill-'));
  const dump = join(dir, 'drill.dump');
  execFileSync('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--file', dump, SOURCE]);
  check('Backup produced a dump', existsSync(dump));

  /* ---------------- restore ---------------- */

  const admin = SOURCE.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
  execFileSync('psql', [admin, '-c', `DROP DATABASE IF EXISTS ${RESTORE_DB}`], { stdio: 'ignore' });
  execFileSync('psql', [admin, '-c', `CREATE DATABASE ${RESTORE_DB}`], { stdio: 'ignore' });
  execFileSync('pg_restore', ['--no-owner', '--no-acl', '-d', RESTORE_URL, dump], { stdio: 'ignore' });

  const restored = new PrismaClient({ datasources: { db: { url: RESTORE_URL } } });

  const after = {
    customers: await restored.customer.count(),
    bookings: await restored.booking.count(),
    quotes: await restored.quote.count(),
    claims: await restored.promotionClaim.count(),
    series: await restored.recurrenceSeries.count(),
    staffUsers: await restored.staffUser.count(),
  };
  check('Every table restored with matching counts', JSON.stringify(before) === JSON.stringify(after));

  const rb = await restored.booking.findFirstOrThrow({ where: { bookingNumber: 'R2N-2026-004242' } });
  check('Booking number preserved', rb.bookingNumber === 'R2N-2026-004242');
  check('Frozen total preserved', rb.grandTotalCents === 20121, `${rb.grandTotalCents}`);

  const rq = await restored.quote.findFirstOrThrow();
  check('GST and QST preserved as separate lines', rq.gstCents === 875 && rq.qstCents === 1746);

  const rc = await restored.promotionClaim.findFirstOrThrow();
  check('Promotion claim still redeemed', rc.status === 'REDEEMED');

  const rs = await restored.recurrenceSeries.findFirstOrThrow();
  check('Recurring visit kept its local time', wallTime(rs.startAt) === '10:00', wallTime(rs.startAt));

  /* ---------------- the pair ---------------- */

  const restoredAuth = new StaffAuthService(restored);
  const login = await restoredAuth.login('drill-owner@r2nette.ca', 'MapleRiver47Sky');
  check('Two-factor still required after restore', login.status === 'TOTP_REQUIRED');

  if (login.status === 'TOTP_REQUIRED') {
    const at = new Date(Date.now() + TOTP_STEP_SECONDS * 1000);
    const done = await restoredAuth.completeTwoFactor(
      login.challenge.challengeToken,
      totpForStep(secret, currentStep(at)),
    );
    check('Owner signs in with the CORRECT key', done.principal.role === 'OWNER');
  }

  // The half people forget: the dump alone is not enough.
  process.env.FIELD_ENCRYPTION_KEY = generateEncryptionKey();
  const wrong = await restoredAuth.login('drill-owner@r2nette.ca', 'MapleRiver47Sky');
  let denied = false;
  if (wrong.status === 'TOTP_REQUIRED') {
    const at = new Date(Date.now() + 2 * TOTP_STEP_SECONDS * 1000);
    try {
      await restoredAuth.completeTwoFactor(
        wrong.challenge.challengeToken,
        totpForStep(secret, currentStep(at)),
      );
    } catch {
      denied = true;
    }
  }
  check('The WRONG key denies access', denied);

  await restored.$disconnect();
  execFileSync('psql', [admin, '-c', `DROP DATABASE IF EXISTS ${RESTORE_DB}`], { stdio: 'ignore' });

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.\n`);
  if (failed.length) {
    console.error('DRILL FAILED. Recovery cannot be relied on until these pass.');
    process.exitCode = 1;
  } else {
    console.log('Drill passed: the database AND the key together restore a working system.');
  }
} catch (e) {
  console.error('\nDrill errored:', (e as Error).message);
  process.exitCode = 1;
}
