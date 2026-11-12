// Claude (Anthropic) · 2026-11-11 — the hub token held between "code verified"
// and "Autoriser" lives encrypted in a short-lived cookie.
import { describe, it, expect } from 'vitest';
import { generateEncryptionKey } from '../src/auth/encryption.js';
import { TTL_MS } from '../src/api/takatak-shared.js';
import {
  MAX_CONSENT_COOKIE_BYTES,
  consentCookieBytes,
  TAKATAK_CONSENT_COOKIE,
  decodeConsent,
  encodeConsent,
  type ConsentHandoff,
} from '../src/api/takatak-consent-cookie.js';

const env = { FIELD_ENCRYPTION_KEY: generateEncryptionKey() };
const now = Date.parse('2026-11-11T09:00:00Z');
const handoff: ConsentHandoff = {
  authorizationId: 'abcdefghijklmnopqrstuvwxyz234567',
  accessToken: 'at-secret-token',
  subject: 'takatak-user-1',
  email: 'marie@example.ca',
  createdAt: now,
};

describe('TAKATAK consent cookie', () => {
  it('is named for its purpose', () => {
    expect(TAKATAK_CONSENT_COOKIE).toBe('r2n_takatak_consent');
  });

  it('round-trips a handoff and never stores the token in clear', () => {
    const raw = encodeConsent(handoff, env);
    expect(raw).not.toContain('at-secret-token');
    expect(Buffer.from(raw, 'base64url').toString('utf8')).not.toContain('at-secret-token');
    // Every field is inside the authenticated ciphertext, so none can be edited.
    expect(raw).not.toContain(handoff.subject);
    expect(raw).not.toContain(handoff.authorizationId);
    expect(raw).not.toContain('marie@example.ca');
    expect(decodeConsent(raw, now + 60_000, env)).toEqual({ ...handoff, approvedRedirect: null });
  });

  it('keeps the address the hub issued for an earlier approval, encrypted, and returns it', () => {
    const approvedRedirect = 'https://r2nette.ca/api/v1/auth/takatak/callback?code=hub-code-123&state=abc';
    const raw = encodeConsent({ ...handoff, approvedRedirect }, env);
    expect(raw).not.toContain('hub-code-123');
    expect(decodeConsent(raw, now + 1_000, env)).toEqual({ ...handoff, approvedRedirect });
    // An oversized or non-text value is dropped, never trusted.
    const long = encodeConsent({ ...handoff, approvedRedirect: 'https://r2nette.ca/' + 'a'.repeat(2_100) }, env);
    expect(decodeConsent(long, now + 1_000, env)?.approvedRedirect).toBeNull();
  });

  it('still fits a browser cookie with a typical hub token and the earlier-approval address', () => {
    const approvedRedirect = 'https://r2nette.ca/api/v1/auth/takatak/callback?code=' + 'c'.repeat(60) + '&state=' + 's'.repeat(43);
    const raw = encodeConsent({ ...handoff, accessToken: 'x'.repeat(1_500), approvedRedirect }, env);
    expect(consentCookieBytes(raw)).toBeLessThan(MAX_CONSENT_COOKIE_BYTES);
  });

  it('encodes once, so a 2.4 KB token still fits a browser cookie', () => {
    const raw = encodeConsent({ ...handoff, accessToken: 'x'.repeat(2_400) }, env);
    expect(TAKATAK_CONSENT_COOKIE.length + 1 + encodeURIComponent(raw).length).toBeLessThan(4_000);
  });

  it('rejects a cookie whose ciphertext was tampered with', () => {
    const raw = encodeConsent(handoff, env);
    const parts = raw.split(':');
    const body = Buffer.from(parts[4]!, 'base64url');
    body[0] = body[0]! ^ 1;
    parts[4] = body.toString('base64url');
    expect(decodeConsent(parts.join(':'), now, env)).toBeNull();
  });

  it('rejects a stale, malformed, or foreign-key cookie', () => {
    const raw = encodeConsent(handoff, env);
    expect(decodeConsent(raw, now + TTL_MS + 1, env)).toBeNull();
    expect(decodeConsent(raw, now - 120_000, env)).toBeNull();
    expect(decodeConsent('garbage', now, env)).toBeNull();
    expect(decodeConsent(undefined, now, env)).toBeNull();
    expect(decodeConsent(Buffer.from(JSON.stringify({ v: 2 })).toString('base64url'), now, env)).toBeNull();
    expect(decodeConsent(raw, now, { FIELD_ENCRYPTION_KEY: generateEncryptionKey() })).toBeNull();
  });

  it('refuses to encode without an encryption key', () => {
    expect(() => encodeConsent(handoff, {})).toThrow(/FIELD_ENCRYPTION_KEY/);
  });
});
