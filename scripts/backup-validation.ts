import { closeSync, openSync, readSync, statSync } from 'node:fs';

/** PostgreSQL custom format begins with the exact ASCII signature PGDMP. */
const CUSTOM_DUMP_MAGIC = Buffer.from('PGDMP');
const MIN_CUSTOM_DUMP_BYTES = 1024;

/**
 * Fail closed on an empty, truncated or wrong-format dump before retention
 * cleanup or sending anything to off-host storage. The dump itself remains
 * on disk for diagnostics; passing this guard does not replace a restore drill.
 */
export function validatePostgresDump(filePath: string): number {
  const bytes = statSync(filePath).size;
  if (bytes < MIN_CUSTOM_DUMP_BYTES) {
    throw new Error(`PostgreSQL dump is suspiciously small (${bytes} bytes).`);
  }
  const fd = openSync(filePath, 'r');
  const header = Buffer.alloc(CUSTOM_DUMP_MAGIC.length);
  try {
    if (readSync(fd, header, 0, header.length, 0) !== header.length ||
      !header.equals(CUSTOM_DUMP_MAGIC)) {
      throw new Error('PostgreSQL dump is missing the PGDMP custom-format header.');
    }
  } finally {
    closeSync(fd);
  }
  return bytes;
}
