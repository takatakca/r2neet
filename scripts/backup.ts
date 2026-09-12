/**
 * PostgreSQL backup.
 *
 *   npm run db:backup
 *
 * Writes a timestamped custom-format dump. Refuses to run against a database
 * that looks like a test scratch database, and never prints the connection
 * string.
 *
 * IMPORTANT: this dump is only half of your recovery. The other half is
 * FIELD_ENCRYPTION_KEY. A perfect restore without the key leaves every
 * two-factor account unusable.
 */
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { keyFingerprint } from '../src/auth/encryption.js';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '');
  }
}

const url = process.env.DATABASE_URL ?? process.env.PRISMA_DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL.');
  process.exit(1);
}

// Guard against backing up the wrong thing and calling it production.
const dbName = url.split('/').pop()?.split('?')[0] ?? '';
if (/test|scratch|tmp/i.test(dbName) && process.env.ALLOW_TEST_BACKUP !== 'true') {
  console.error(`Refusing: "${dbName}" looks like a test database.`);
  console.error('Set ALLOW_TEST_BACKUP=true if this is deliberate.');
  process.exit(1);
}

const dir = process.env.BACKUP_DIR ?? 'backups';
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const file = `${dir}/r2nette-${stamp}.dump`;

try {
  execFileSync('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--file', file, url], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const bytes = statSync(file).size;
  if (bytes < 1024) throw new Error(`Dump is suspiciously small (${bytes} bytes).`);

  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'backup_complete',
      file,
      bytes,
      database: dbName,
      // So a restore can confirm it has the matching key material.
      encryptionKeyFingerprint: keyFingerprint() ?? 'NOT_CONFIGURED',
    }),
  );
  console.log(
    '\nStore FIELD_ENCRYPTION_KEY separately. This dump alone cannot unlock two-factor accounts.',
  );
} catch (e) {
  console.error(JSON.stringify({ level: 'error', msg: 'backup_failed', error: String(e) }));
  process.exit(1);
}
