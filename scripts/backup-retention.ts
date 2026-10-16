import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/** Retain 1–365 days of local fallback dumps (default 7). */
export function parseBackupKeepDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 7;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error('BACKUP_KEEP_DAYS must be a whole number between 1 and 365.');
  }
  return days;
}

/**
 * Remove only R2NETTE-generated top-level dump files older than the local
 * fallback retention window. Do not follow symlinks, recurse into arbitrary
 * directories, or touch unrelated files. Call this only after pg_dump succeeds
 * so a failed fresh dump cannot delete the last recovery artifact.
 */
export function pruneLocalBackups(
  directory: string,
  keepDays: number,
  now: Date = new Date(),
): string[] {
  if (!Number.isInteger(keepDays) || keepDays < 1 || keepDays > 365) {
    throw new Error('Invalid backup retention window.');
  }
  const cutoff = now.getTime() - keepDays * 24 * 60 * 60 * 1000;
  const removed: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^r2nette-[\w-]+\.dump$/.test(entry.name)) continue;
    const path = join(directory, entry.name);
    if (statSync(path).mtimeMs < cutoff) {
      unlinkSync(path);
      removed.push(entry.name);
    }
  }
  return removed;
}
