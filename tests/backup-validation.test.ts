import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePostgresDump } from '../scripts/backup-validation.js';

const dirs: string[] = [];
function sample(contents: Buffer): string {
  const directory = mkdtempSync(join(tmpdir(), 'r2nette-pgdmp-'));
  dirs.push(directory);
  const path = join(directory, 'backup.dump');
  writeFileSync(path, contents);
  return path;
}
afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('PostgreSQL custom-format dump validation', () => {
  it('accepts a nontrivial custom-format dump with its PGDMP header', () => {
    const dump = sample(Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(2048)]));
    expect(validatePostgresDump(dump)).toBe(2053);
    expect(existsSync(dump)).toBe(true);
  });

  it('rejects a zero-byte or truncated dump without deleting it', () => {
    const empty = sample(Buffer.alloc(0));
    expect(() => validatePostgresDump(empty)).toThrow(/suspiciously small/);
    expect(existsSync(empty)).toBe(true);
    const truncated = sample(Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(20)]));
    expect(() => validatePostgresDump(truncated)).toThrow(/suspiciously small/);
    expect(existsSync(truncated)).toBe(true);
  });

  it('rejects a large plain SQL file despite its size', () => {
    const sql = sample(Buffer.concat([Buffer.from('-- dump text'), Buffer.alloc(4096)]));
    expect(() => validatePostgresDump(sql)).toThrow(/missing the PGDMP/);
    expect(existsSync(sql)).toBe(true);
  });

  it('fails when a dump was not written at all', () => {
    expect(() => validatePostgresDump('/nonexistent-r2nette/backup.dump')).toThrow();
  });
});
