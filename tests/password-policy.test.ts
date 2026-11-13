// Claude (Anthropic) · 2026-11-13 — one password rule for the server and the page.
// The hub (Supabase Auth) decides what it accepts; these tests pin the same rule here
// so a customer never meets an unexplained hub error.
import { describe, it, expect } from 'vitest';
import {
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
  passwordProblems,
  suggestPassword,
} from '../src/shared/password-policy.js';

describe('passwordProblems', () => {
  it('accepts a password that meets every rule', () => {
    expect(passwordProblems('Abcdef1!ghijk')).toEqual([]);
  });

  it('asks for 12 characters', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    expect(passwordProblems('Short1A!')).toEqual(['length']);
    expect(passwordProblems('Abcdefg1!hij')).toEqual([]);
    expect(passwordProblems('Abcdefg1!hi')).toEqual(['length']);
  });

  it('names each missing character class on its own', () => {
    expect(passwordProblems('ABCDEFGH1!JKL')).toEqual(['lower']);
    expect(passwordProblems('abcdefgh1!jkl')).toEqual(['upper']);
    expect(passwordProblems('Abcdefgh!!jkl')).toEqual(['digit']);
    expect(passwordProblems('Abcdefgh1ijkl')).toEqual(['symbol']);
  });

  it('counts accented and non-Latin letters as letters, not as symbols', () => {
    // é is not one of the hub symbols, so a password that only has é as "special" still needs a symbol.
    expect(passwordProblems('Éclairage12345')).toEqual(['symbol']);
  });

  it('reports every problem for an empty password', () => {
    expect(passwordProblems('')).toEqual(['length', 'lower', 'upper', 'digit', 'symbol']);
  });

  it('refuses more than 72 bytes even when it is under 72 characters', () => {
    const accents = 'é'.repeat(40) + 'Aa1!'; // 44 characters, 84 bytes
    expect([...accents].length).toBeLessThan(PASSWORD_MAX_BYTES);
    expect(passwordProblems(accents)).toContain('too-long');
    expect(passwordProblems('Aa1!' + 'x'.repeat(68))).toEqual([]); // exactly 72 bytes
    expect(passwordProblems('Aa1!' + 'x'.repeat(69))).toEqual(['too-long']);
  });

  it('does not trim: spaces at the ends count and are kept', () => {
    expect(passwordProblems('  Abcdef1!gh  ')).toEqual([]);
    expect(passwordProblems('            ')).toEqual(['lower', 'upper', 'digit', 'symbol']);
  });

  it('refuses a password that contains the email name', () => {
    expect(passwordProblems('Melissa-2026!xyz', 'melissa@example.com')).toEqual(['email']);
    expect(passwordProblems('MELISSA-2026!xyz', 'Melissa@example.com')).toEqual(['email']);
    expect(passwordProblems('Qwerty-2026!xyz', 'melissa@example.com')).toEqual([]);
  });

  it('ignores very short email names so "al@x.ca" does not block half the alphabet', () => {
    expect(passwordProblems('Alpha-2026!xyzw', 'al@example.com')).toEqual([]);
    expect(passwordProblems('Alpha-2026!xyzw', null)).toEqual([]);
    expect(passwordProblems('Alpha-2026!xyzw', undefined)).toEqual([]);
  });
});

describe('suggestPassword', () => {
  it('always returns a password that passes the rule', () => {
    for (let i = 0; i < 300; i += 1) {
      const p = suggestPassword();
      expect(p).toHaveLength(16);
      expect(passwordProblems(p)).toEqual([]);
    }
  });

  it('honours a longer length and never exceeds the byte limit', () => {
    const p = suggestPassword(24);
    expect(p).toHaveLength(24);
    expect(passwordProblems(p)).toEqual([]);
    expect(new TextEncoder().encode(suggestPassword(60)).length).toBeLessThanOrEqual(PASSWORD_MAX_BYTES);
  });

  it('is different every time and avoids look-alike characters', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) seen.add(suggestPassword());
    expect(seen.size).toBe(50);
    expect([...seen].join('')).not.toMatch(/[Il1O0]/);
  });
});
