/**
 * Backup loop.
 *
 * A backup that only runs when someone remembers is not a backup. This runs
 * nightly by local wall-clock time and records the outcome so a silent
 * failure becomes visible.
 */
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { Scheduler } from '../src/workers/scheduler.js';
import { keyFingerprint } from '../src/auth/encryption.js';
import { loadS3Config, S3Storage } from '../src/workers/object-storage.js';
import { AlertService, WebhookAlertSink } from '../src/workers/health.js';
import { unlinkSync } from 'node:fs';
import { requireOffHostBackup } from '../src/workers/backup-policy.js';
import { pgCommandConnection } from './pg-cli.js';
import { parseBackupKeepDays, pruneLocalBackups } from './backup-retention.js';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '');
  }
}
const url = process.env.DATABASE_URL ?? process.env.PRISMA_DATABASE_URL;
if (!url) { console.error('Set DATABASE_URL.'); process.exit(1); }

const prisma = new PrismaClient({ datasources: { db: { url } } });
const alerts = new AlertService(prisma, new WebhookAlertSink());
const s3Config = loadS3Config();
const storage = s3Config ? new S3Storage(s3Config) : null;

const scheduler = new Scheduler(
  [
    {
      name: 'backup',
      dailyLocalAt: process.env.BACKUP_AT ?? '03:00',
      // Overdue after 36 hours: one missed night is a warning, not noise.
      expectedWithinSeconds: 129600,
      run: async () => {
        const dir = process.env.BACKUP_DIR ?? 'backups';
        mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const file = `${dir}/r2nette-${stamp}.dump`;
        const connection = pgCommandConnection(url!);
        execFileSync('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--file', file, connection.url], {
          stdio: ['ignore', 'inherit', 'inherit'],
          env: connection.env,
        });

        // Apply bounded local retention *after* producing a fresh dump but
        // *before* reporting a missing/unavailable S3 destination. Otherwise
        // the failure path skips cleanup forever and fills the backup volume.
        pruneLocalBackups(dir, parseBackupKeepDays(process.env.BACKUP_KEEP_DAYS));

        // Do not report a local-only dump as a successful backup. The local
        // file is deliberately retained and the missing target is alerted.
        await requireOffHostBackup(Boolean(storage), () => alerts.raise({
          key: 'backup:off-host',
          severity: 'CRITICAL',
          category: 'BACKUP',
          title: 'Off-host backup destination missing',
          message: 'A local database dump exists but no off-host destination is configured.',
        }));

        // Off-host copy. Without this the backup dies with the machine, so
        // a local-only dump is never reported as a completed backup.
        let offHost = 'NOT_CONFIGURED';
        let sha256: string | undefined;
        let objectKey: string | undefined;

        if (storage) {
          const environment = process.env.NODE_ENV === 'production' ? 'production' : 'staging';
          objectKey = storage.objectKey(environment, file.split('/').pop()!);
          try {
            // Upload AND verify: a 200 from PUT is not proof the bytes landed.
            const put = await storage.putAndVerify(objectKey, file);
            sha256 = put.sha256;
            offHost = 'VERIFIED';
            await alerts.resolve('backup:off-host');
            unlinkSync(file); // verified off-host; the local copy is redundant
          } catch (e) {
            offHost = 'FAILED';
            await alerts.raise({
              key: 'backup:off-host',
              severity: 'CRITICAL',
              category: 'BACKUP',
              title: 'Backup was not stored off-host',
              message: `The dump succeeded but could not be uploaded: ${(e as Error).message}. The local copy has been kept.`,
              resource: objectKey,
            });
            // Deliberately fails the run so it reports FAILED, not success.
            throw e;
          }
        }

        return {
          file,
          offHost,
          objectKey,
          sha256,
          // States which key material this dump needs to be usable at all.
          requiredEncryptionKeyId: keyFingerprint() ?? 'NOT_CONFIGURED',
        };
      },
    },
  ],
  undefined,
  undefined,
  prisma,
);

await scheduler.loop(60);
await prisma.$disconnect();
