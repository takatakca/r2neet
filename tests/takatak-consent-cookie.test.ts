// Claude (Anthropic) · 2026-11-11 — the hub token held between "code verified"
// and "Autoriser" lives encrypted in a short-lived cookie.
import { describe, it, expect } from 'vitest';
import { generateEncryptionKey } from '../src/auth/encryption.js';
import { TTL_MS } from '../src/api/takatak-shared.js';
import {
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
    expect(decodeConsent(raw, now + 60_000, env)).toEqual(handoff);
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
