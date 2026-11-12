// Claude (Anthropic) · 2026-11-12 — a return address must be a single-slash path on this site.
// "https://this.site//evil.example" passes an origin comparison but, as a path, is "//evil.example":
// a browser told to go there leaves for another site (open redirect, found by the PR #62 security review).
import { describe, it, expect } from 'vitest';
import { sameSitePath } from '../web/src/lib/safe-path.js';
import { safeReturn, DEFAULT_RETURN } from '../src/api/takatak-shared.js';

const ORIGIN = 'https://r2nette.ca';

const forged = [
  'https://r2nette.ca//evil.example',
  'https://r2nette.ca//evil.example/path?x=1#y',
  'https://r2nette.ca/\\evil.example',
  'https://r2nette.ca/\t/evil.example',
  '//evil.example',
  '/\\evil.example',
  '/\t/evil.example',
  'https://evil.example/account',
  'http://r2nette.ca/account', // another scheme is another origin
  'javascript:alert(1)',
  'data:text/html,hi',
];
const fine: Array<[string, string]> = [
  ['/account', '/account'],
  ['/#book', '/#book'],
  ['/commercial#enquiry', '/commercial#enquiry'],
  ['https://r2nette.ca/account?tab=past', '/account?tab=past'],
  ['/%2Fevil.example', '/%2Fevil.example'], // encoded slash stays a path on this site
];

describe('sameSitePath (the login page)', () => {
  it.each(forged)('refuses %j', (value) => {
    expect(sameSitePath(value, ORIGIN)).toBeNull();
  });
  it.each(fine)('keeps %j as %j', (value, expected) => {
    expect(sameSitePath(value, ORIGIN)).toBe(expected);
  });
});

describe('safeReturn (the server, after the code)', () => {
  it.each(forged)('falls back to the default for %j', (value) => {
    expect(safeReturn(value, ORIGIN)).toBe(DEFAULT_RETURN);
  });
  it.each(fine.filter(([v]) => !/^\/(login|signup|auth)/.test(v)))('keeps %j', (value, expected) => {
    expect(safeReturn(value, ORIGIN)).toBe(expected);
  });
  it('still refuses API routes and the sign-in pages', () => {
    for (const v of ['/api/v1/customer/me', '/login', '/signup?x=1', '/auth']) expect(safeReturn(v, ORIGIN)).toBe(DEFAULT_RETURN);
  });
});
