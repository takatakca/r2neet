import { describe, expect, it } from 'vitest';
import { pgCommandConnection } from '../scripts/pg-cli.js';

describe('PostgreSQL subprocess credentials', () => {
  it('does not pass a URI password on the child argv', () => {
    const original = 'postgresql://backup:p%40ss%3Aword@r2nette-db:5432/r2nette?sslmode=require';
    const result = pgCommandConnection(original, { PATH: '/bin' });
    expect(result.url).not.toContain('p%40ss');
    expect(result.url).not.toContain('p@ss');
    expect(result.url).toContain('r2nette-db:5432/r2nette?sslmode=require');
    expect(result.env.PGPASSWORD).toBe('p@ss:word');
    expect(result.env.PATH).toBe('/bin');
  });

  it('does not mutate the parent environment', () => {
    const parent = { PATH: '/bin' };
    const result = pgCommandConnection('postgres://app:secret@db:5432/r2nette', parent);
    expect(parent).toEqual({ PATH: '/bin' });
    expect(result.env.PGPASSWORD).toBe('secret');
  });

  it('accepts passwordless trusted database connections', () => {
    const result = pgCommandConnection('postgresql://app@localhost:5432/r2nette', {});
    expect(result.url).toContain('app@localhost');
    expect(result.env.PGPASSWORD).toBeUndefined();
  });

  it('rejects non-PostgreSQL URIs', () => {
    expect(() => pgCommandConnection('https://db.example.test', {})).toThrow(/PostgreSQL/);
  });
});
