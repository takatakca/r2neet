/**
 * Re-encrypt every encrypted field under the current key.
 *
 *   FIELD_ENCRYPTION_KEY=<new> \
 *   FIELD_ENCRYPTION_KEYS_RETIRED=<old> \
 *   npm run security:rotate-key -- --apply
 *
 * Without --apply this is a dry run. Rotation is safe to interrupt and
 * re-run: rows already on the current key are skipped.
 *
 * Retire the old key from the environment only once this reports
 * `remaining: 0`.
 */
import { readFileSync, existsSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import {
  decryptSecret,
  encryptSecret,
  isEncrypted,
  isCurrentKey,
  loadKeyring,
  keyFingerprint,
} from '../src/auth/encryption.js';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '');
  }
}

const apply = process.argv.includes('--apply');
const url = process.env.PRISMA_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('Set PRISMA_DATABASE_URL (or DATABASE_URL).');
  process.exit(1);
}
if (!loadKeyring()) {
  console.error('FIELD_ENCRYPTION_KEY is not set. Nothing to rotate to.');
  process.exit(1);
}

console.log(`Current key: ${keyFingerprint()}`);
console.log(apply ? 'Mode: APPLY\n' : 'Mode: DRY RUN (pass --apply to write)\n');

const prisma = new PrismaClient({ datasources: { db: { url } } });

let found = 0;
let alreadyCurrent = 0;
let plaintext = 0;
let reencrypted = 0;
let failed = 0;

try {
  const users = await prisma.staffUser.findMany({
    where: { totpSecret: { not: null } },
    select: { id: true, email: true, totpSecret: true },
  });

  for (const u of users) {
    found++;
    const value = u.totpSecret!;

    if (isEncrypted(value) && isCurrentKey(value)) {
      alreadyCurrent++;
      continue;
    }
    if (!isEncrypted(value)) plaintext++;

    try {
      // Reads via the keyring, so a retired key still opens the old row.
      const secret = isEncrypted(value) ? decryptSecret(value) : value;
      if (apply) {
        await prisma.staffUser.update({
          where: { id: u.id },
          data: { totpSecret: encryptSecret(secret) },
        });
      }
      reencrypted++;
    } catch (e) {
      failed++;
      // Never print the value, only which account needs attention.
      console.error(`  FAILED ${u.email}: ${(e as Error).message}`);
    }
  }

  const remaining = apply ? failed : found - alreadyCurrent;
  console.log(
    JSON.stringify({
      msg: 'key_rotation',
      mode: apply ? 'apply' : 'dry_run',
      found,
      alreadyCurrent,
      plaintextFound: plaintext,
      reencrypted,
      failed,
      remaining,
    }),
  );

  if (failed > 0) {
    console.error('\nSome rows could not be re-encrypted. Do NOT retire the old key yet.');
    process.exitCode = 1;
  } else if (apply) {
    console.log('\nAll rows are on the current key. The old key can now be retired.');
  }
} finally {
  await prisma.$disconnect();
}
