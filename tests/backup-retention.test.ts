import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBackupKeepDays, pruneLocalBackups } from '../scripts/backup-retention.js';

const dirs: string[] = [];
function root() {
  const dir = mkdtempSync(join(tmpdir(), 'r2nette-retention-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('local-only backup retention during off-host outages', () => {
  it('accepts a safe bounded interval, defaulting to seven days', () => {
    expect(parseBackupKeepDays(undefined)).toBe(7);
    expect(parseBackupKeepDays('14')).toBe(14);
    for (const invalid of ['0', '-1', '1.5', 'NaN', 'Infinity', '366']) {
      expect(() => parseBackupKeepDays(invalid)).toThrow(/BACKUP_KEEP_DAYS/);
    }
  });

  it('removes old dumps without deleting the newly created fallback dump', () => {
    const dir = root();
    const now = new Date('2026-10-16T12:00:00Z');
    const old = join(dir, 'r2nette-2026-10-01.dump');
    const fresh = join(dir, 'r2nette-2026-10-16.dump');
    writeFileSync(old, 'older backup');
    writeFileSync(fresh, 'fresh backup retained during S3 failure');
    utimesSync(old, new Date('2026-10-01T12:00:00Z'), new Date('2026-10-01T12:00:00Z'));
    utimesSync(fresh, now, now);

    expect(pruneLocalBackups(dir, 7, now)).toEqual(['r2nette-2026-10-01.dump']);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('ignores unrelated files and symlinks rather than pruning outside the backup folder', () => {
    const dir = root();
    const outside = root();
    const target = join(outside, 'r2nette-2026-10-01.dump');
    writeFileSync(target, 'protected');
    utimesSync(target, new Date('2026-09-01T12:00:00Z'), new Date('2026-09-01T12:00:00Z'));
    symlinkSync(target, join(dir, 'r2nette-symlink.dump'));
    writeFileSync(join(dir, 'unrelated.dump'), 'protected');
    const removed = pruneLocalBackups(dir, 7, new Date('2026-10-16T12:00:00Z'));
    expect(removed).toEqual([]);
    expect(existsSync(target)).toBe(true);
    expect(existsSync(join(dir, 'unrelated.dump'))).toBe(true);
  });

  it('rejects invalid retention before deleting any file', () => {
    const dir = root();
    const file = join(dir, 'r2nette-2026-01-01.dump');
    writeFileSync(file, 'backup');
    expect(() => pruneLocalBackups(dir, -1, new Date('2026-10-16T12:00:00Z'))).toThrow(/retention/);
    expect(existsSync(file)).toBe(true);
  });
});
