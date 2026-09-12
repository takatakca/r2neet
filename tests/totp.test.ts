import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { PrismaClient } from '@prisma/client';
import { createOpsApi, STAFF_COOKIE } from '../src/api/ops.js';
import { StaffAuthService } from '../src/auth/staff-auth.js';
import {
  base32Encode,
  base32Decode,
  generateTotpSecret,
  totpForStep,
  verifyTotp,
  currentStep,
  otpauthUri,
  generateRecoveryCodes,
  hashRecoveryCode,
  consumeRecoveryCode,
  TOTP_STEP_SECONDS,
} from '../src/auth/totp.js';
import { FakeVoiceProvider } from '../src/callbacks/callback-service.js';
import { assertDestructiveAllowed } from '../src/db/safety.js';
import { seed } from '../prisma/seed.js';

const URL = process.env.TEST_DATABASE_URL;
const d = URL ? describe : describe.skip;

describe('base32', () => {
  it('round-trips', () => {
    const buf = Buffer.from('R2NETTE secret bytes');
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
  });

  it('matches known RFC 4648 vectors', () => {
    expect(base32Encode(Buffer.from('f'))).toBe('MY');
    expect(base32Encode(Buffer.from('fo'))).toBe('MZXQ');
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
  });

  it('ignores spacing and case, as apps display secrets grouped', () => {
    const secret = generateTotpSecret();
    const spaced = secret.toLowerCase().replace(/(.{4})/g, '$1 ');
    expect(base32Decode(spaced).equals(base32Decode(secret))).toBe(true);
  });
});

describe('TOTP algorithm', () => {
  /** RFC 6238 test vector: ASCII "12345678901234567890" as base32. */
  const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

  it('matches the RFC 6238 reference values', () => {
    // T=59 -> step 1, T=1111111109 -> step 37037036
    expect(totpForStep(RFC_SECRET, 1)).toBe('287082');
    expect(totpForStep(RFC_SECRET, 37037036)).toBe('081804');
  });

  it('produces a different code each step', () => {
    const secret = generateTotpSecret();
    const a = totpForStep(secret, 100);
    const b = totpForStep(secret, 101);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^\d{6}$/);
  });

  it('accepts the current code', () => {
    const secret = generateTotpSecret();
    const at = new Date();
    const code = totpForStep(secret, currentStep(at));
    expect(verifyTotp(secret, code, { at }).valid).toBe(true);
  });

  it('tolerates one step of clock drift either way', () => {
    const secret = generateTotpSecret();
    const at = new Date();
    const step = currentStep(at);
    expect(verifyTotp(secret, totpForStep(secret, step - 1), { at }).valid).toBe(true);
    expect(verifyTotp(secret, totpForStep(secret, step + 1), { at }).valid).toBe(true);
  });

  it('rejects a code from further away', () => {
    const secret = generateTotpSecret();
    const at = new Date();
    const step = currentStep(at);
    expect(verifyTotp(secret, totpForStep(secret, step - 5), { at }).valid).toBe(false);
  });

  it('rejects a code from a different secret', () => {
    const at = new Date();
    const code = totpForStep(generateTotpSecret(), currentStep(at));
    expect(verifyTotp(generateTotpSecret(), code, { at }).valid).toBe(false);
  });

  it('[INV-AUTH-02] REPLAY: the same code cannot be used twice', () => {
    const secret = generateTotpSecret();
    const at = new Date();
    const step = currentStep(at);
    const code = totpForStep(secret, step);

    const first = verifyTotp(secret, code, { at });
    expect(first.valid).toBe(true);
    expect(first.step).toBe(step);

    // A shoulder-surfed code stays valid for 30 seconds unless we refuse it.
    const replay = verifyTotp(secret, code, { at, lastUsedStep: first.step });
    expect(replay.valid).toBe(false);
  });

  it('still accepts the NEXT code after one is used', () => {
    const secret = generateTotpSecret();
    const at = new Date();
    const step = currentStep(at);
    const later = new Date(at.getTime() + TOTP_STEP_SECONDS * 1000);
    expect(verifyTotp(secret, totpForStep(secret, step + 1), { at: later, lastUsedStep: step }).valid).toBe(true);
  });

  it('rejects malformed input without throwing', () => {
    const secret = generateTotpSecret();
    for (const bad of ['', '12345', '1234567', 'abcdef', '   ']) {
      expect(verifyTotp(secret, bad).valid, bad).toBe(false);
    }
  });

  it('builds an otpauth URI an authenticator app can read', () => {
    const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'owner@r2nette.ca');
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toMatch(/issuer=R2NETTE/);
    expect(uri).toMatch(/digits=6/);
    expect(uri).toMatch(/period=30/);
  });
});

describe('recovery codes', () => {
  it('generates unambiguous codes', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(8);
    for (const c of codes) {
      expect(c).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
      // No characters that get misread when read over the phone.
      expect(c).not.toMatch(/[IO01]/);
    }
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('accepts a code once, then never again', () => {
    const codes = generateRecoveryCodes();
    const hashes = codes.map(hashRecoveryCode);

    const first = consumeRecoveryCode(hashes, codes[0]!);
    expect(first.valid).toBe(true);
    expect(first.remaining).toHaveLength(7);

    const second = consumeRecoveryCode(first.remaining, codes[0]!);
    expect(second.valid).toBe(false);
  });

  it('ignores formatting, since people retype these', () => {
    const codes = generateRecoveryCodes();
    const hashes = codes.map(hashRecoveryCode);
    const messy = codes[0]!.toLowerCase().replace('-', ' ');
    expect(consumeRecoveryCode(hashes, messy).valid).toBe(true);
  });

  it('rejects an unknown code', () => {
    const hashes = generateRecoveryCodes().map(hashRecoveryCode);
    expect(consumeRecoveryCode(hashes, 'AAAAA-BBBBB').valid).toBe(false);
  });
});

d('two-factor sign-in', () => {
  let prisma: PrismaClient;
  let auth: StaffAuthService;
  let app: express.Express;

  const OWNER = { email: 'owner@r2nette.ca', password: 'MapleRiver47Sky' };
  const DISPATCH = { email: 'dispatch@r2nette.ca', password: 'BlueHeron92Trail' };

  beforeAll(async () => {
    assertDestructiveAllowed(process.env);
    prisma = new PrismaClient({ datasources: { db: { url: URL } } });
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.staffSession.deleteMany();
    await prisma.staffUser.deleteMany();
    await prisma.auditLog.deleteMany();
    await seed(prisma);
    auth = new StaffAuthService(prisma);
    await auth.createUser({ ...OWNER, displayName: 'Owner', role: 'OWNER', mustChangePassword: false });
    await auth.createUser({ ...DISPATCH, displayName: 'Dispatch', role: 'DISPATCHER', mustChangePassword: false });
    app = express();
    app.use(createOpsApi({ prisma, voice: new FakeVoiceProvider() }));
  });

  async function enrol(email: string) {
    const user = await prisma.staffUser.findUniqueOrThrow({ where: { email } });
    const { secret } = await auth.beginTotpEnrolment(user.id);
    const { recoveryCodes } = await auth.confirmTotpEnrolment(
      user.id,
      totpForStep(secret, currentStep()),
    );
    return { secret, recoveryCodes };
  }

  it('signs in normally when two-factor is off', async () => {
    const res = await request(app).post('/api/v1/staff/login').send(OWNER);
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('OWNER');
    expect(res.headers['set-cookie']).toBeTruthy();
  });

  it('enrolment is not active until a code is confirmed', async () => {
    const user = await prisma.staffUser.findUniqueOrThrow({ where: { email: OWNER.email } });
    await auth.beginTotpEnrolment(user.id);

    // Secret exists, but a half-finished setup must not gate sign-in.
    const res = await request(app).post('/api/v1/staff/login').send(OWNER);
    expect(res.body.twoFactorRequired).toBeUndefined();
    expect(res.headers['set-cookie']).toBeTruthy();
  });

  it('[INV-AUTH-01] THE PASSWORD ALONE ISSUES NO SESSION once enrolled', async () => {
    await enrol(OWNER.email);
    const res = await request(app).post('/api/v1/staff/login').send(OWNER);

    expect(res.status).toBe(200);
    expect(res.body.twoFactorRequired).toBe(true);
    expect(res.body.challengeToken).toBeTruthy();
    // The critical assertion: no cookie, so nothing can reach an admin route.
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.body.permissions).toBeUndefined();
  });

  it('a challenge token presented as a session cookie does not work', async () => {
    await enrol(OWNER.email);
    const login = await request(app).post('/api/v1/staff/login').send(OWNER);
    const forged = `${STAFF_COOKIE}=${login.body.challengeToken}`;

    const res = await request(app).get('/api/v1/admin/dashboard').set('Cookie', forged);
    expect(res.status).toBe(401);
  });

  it('completes sign-in with a valid code', async () => {
    const { secret } = await enrol(OWNER.email);
    const login = await request(app).post('/api/v1/staff/login').send(OWNER);

    // The enrolment consumed the current step, so use the next one.
    const at = new Date(Date.now() + TOTP_STEP_SECONDS * 1000);
    const res = await request(app)
      .post('/api/v1/staff/login/totp')
      .send({ challengeToken: login.body.challengeToken, code: totpForStep(secret, currentStep(at)) });

    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('OWNER');
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
    expect(cookie).toMatch(/HttpOnly/i);

    const dash = await request(app).get('/api/v1/admin/dashboard').set('Cookie', cookie);
    expect(dash.status).toBe(200);
  });

  it('rejects a wrong code and issues nothing', async () => {
    await enrol(OWNER.email);
    const login = await request(app).post('/api/v1/staff/login').send(OWNER);
    const res = await request(app)
      .post('/api/v1/staff/login/totp')
      .send({ challengeToken: login.body.challengeToken, code: '000000' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOTP');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('a spent challenge cannot be reused', async () => {
    const { secret } = await enrol(OWNER.email);
    const login = await request(app).post('/api/v1/staff/login').send(OWNER);
    const at = new Date(Date.now() + TOTP_STEP_SECONDS * 1000);

    const first = await request(app)
      .post('/api/v1/staff/login/totp')
      .send({ challengeToken: login.body.challengeToken, code: totpForStep(secret, currentStep(at)) });
    expect(first.status).toBe(200);

    const replay = await request(app)
      .post('/api/v1/staff/login/totp')
      .send({
        challengeToken: login.body.challengeToken,
        code: totpForStep(secret, currentStep(new Date(at.getTime() + TOTP_STEP_SECONDS * 1000))),
      });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('CHALLENGE_EXPIRED');
  });

  it('a recovery code works once, then is spent', async () => {
    const { recoveryCodes } = await enrol(OWNER.email);
    const login = await request(app).post('/api/v1/staff/login').send(OWNER);

    const res = await request(app)
      .post('/api/v1/staff/login/totp')
      .send({ challengeToken: login.body.challengeToken, code: recoveryCodes[0] });
    expect(res.status).toBe(200);

    const user = await prisma.staffUser.findUniqueOrThrow({ where: { email: OWNER.email } });
    expect(user.recoveryCodeHashes).toHaveLength(7);

    const again = await request(app).post('/api/v1/staff/login').send(OWNER);
    const reuse = await request(app)
      .post('/api/v1/staff/login/totp')
      .send({ challengeToken: again.body.challengeToken, code: recoveryCodes[0] });
    expect(reuse.status).toBe(401);
  });

  it('never returns or stores a recovery code in plaintext', async () => {
    const { recoveryCodes } = await enrol(OWNER.email);
    const user = await prisma.staffUser.findUniqueOrThrow({ where: { email: OWNER.email } });
    // lastTotpStep is a BigInt, which JSON.stringify refuses.
    const dump = JSON.stringify(user, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
    for (const c of recoveryCodes) expect(dump).not.toContain(c);
    expect(user.recoveryCodeHashes[0]).toHaveLength(64);
  });

  it('reports two-factor status, and recommends it for owners', async () => {
    const login = await request(app).post('/api/v1/staff/login').send(OWNER);
    const cookie = (login.headers['set-cookie'] as unknown as string[])[0]!;
    const me = await request(app).get('/api/v1/staff/me').set('Cookie', cookie);
    expect(me.body.user.twoFactorEnabled).toBe(false);
    expect(me.body.user.twoFactorRecommended).toBe(true);

    const disp = await request(app).post('/api/v1/staff/login').send(DISPATCH);
    const dcookie = (disp.headers['set-cookie'] as unknown as string[])[0]!;
    const dme = await request(app).get('/api/v1/staff/me').set('Cookie', dcookie);
    expect(dme.body.user.twoFactorRecommended).toBe(false);
  });

  it('disabling requires the password, so a hijacked session cannot', async () => {
    const { secret } = await enrol(OWNER.email);
    const login = await request(app).post('/api/v1/staff/login').send(OWNER);
    const at = new Date(Date.now() + TOTP_STEP_SECONDS * 1000);
    const done = await request(app)
      .post('/api/v1/staff/login/totp')
      .send({ challengeToken: login.body.challengeToken, code: totpForStep(secret, currentStep(at)) });
    const cookie = (done.headers['set-cookie'] as unknown as string[])[0]!;

    const wrong = await request(app)
      .post('/api/v1/staff/totp/disable')
      .set('Cookie', cookie)
      .send({ password: 'not-the-password' });
    expect(wrong.status).toBe(400);

    const user = await prisma.staffUser.findUniqueOrThrow({ where: { email: OWNER.email } });
    expect(user.totpEnabledAt).not.toBeNull(); // still on

    const ok = await request(app)
      .post('/api/v1/staff/totp/disable')
      .set('Cookie', cookie)
      .send({ password: OWNER.password });
    expect(ok.status).toBe(200);
    const after = await prisma.staffUser.findUniqueOrThrow({ where: { email: OWNER.email } });
    expect(after.totpEnabledAt).toBeNull();
    expect(after.recoveryCodeHashes).toHaveLength(0);
  });

  it('records two-factor events against the person', async () => {
    await enrol(OWNER.email);
    await request(app).post('/api/v1/staff/login').send(OWNER);
    const logs = await prisma.auditLog.findMany();
    expect(logs.some((l) => l.action === 'STAFF_TOTP_ENABLED')).toBe(true);
    expect(logs.some((l) => l.action === 'STAFF_LOGIN_TOTP_CHALLENGED')).toBe(true);
    for (const l of logs) expect(l.actorId).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ */
/* encryption at rest                                                  */
/* ------------------------------------------------------------------ */

import {
  encryptSecret,
  decryptSecret,
  isEncrypted,
  readPossiblyEncrypted,
  generateEncryptionKey,
  encryptionConfigured,
  EncryptionError,
} from '../src/auth/encryption.js';

describe('secret encryption', () => {
  const env = { FIELD_ENCRYPTION_KEY: generateEncryptionKey() };

  it('round-trips a secret', () => {
    const secret = generateTotpSecret();
    const sealed = encryptSecret(secret, env);
    expect(decryptSecret(sealed, env)).toBe(secret);
  });

  it('the ciphertext does not contain the plaintext', () => {
    const secret = generateTotpSecret();
    const sealed = encryptSecret(secret, env);
    expect(sealed).not.toContain(secret);
    // v2 carries a key id so rotation is possible without lockout.
    expect(sealed.startsWith('v2:')).toBe(true);
  });

  it('encrypts the same value differently each time', () => {
    const secret = generateTotpSecret();
    // A fresh IV per write, so identical secrets are not identifiable.
    expect(encryptSecret(secret, env)).not.toBe(encryptSecret(secret, env));
  });

  it('a wrong key fails loudly rather than returning garbage', () => {
    const sealed = encryptSecret('MYSECRET', env);
    const other = { FIELD_ENCRYPTION_KEY: generateEncryptionKey() };
    expect(() => decryptSecret(sealed, other)).toThrow(EncryptionError);
  });

  it('detects tampering', () => {
    const sealed = encryptSecret('MYSECRET', env);
    const parts = sealed.split(':');
    // Flip the ciphertext; GCM must reject it.
    const tampered = [parts[0], parts[1], parts[2], Buffer.from('evil').toString('base64url')].join(':');
    expect(() => decryptSecret(tampered, env)).toThrow(EncryptionError);
  });

  it('refuses to operate without a configured key', () => {
    expect(encryptionConfigured({})).toBe(false);
    expect(encryptionConfigured({ FIELD_ENCRYPTION_KEY: 'too-short' })).toBe(false);
    expect(() => encryptSecret('x', {})).toThrow(/not set/);
  });

  it('reads pre-encryption plaintext, so enabling it locks nobody out', () => {
    const legacy = 'JBSWY3DPEHPK3PXP';
    expect(isEncrypted(legacy)).toBe(false);
    expect(readPossiblyEncrypted(legacy, env)).toBe(legacy);
    expect(readPossiblyEncrypted(encryptSecret(legacy, env), env)).toBe(legacy);
  });
});

d('TOTP secret storage', () => {
  let prisma: PrismaClient;
  let auth: StaffAuthService;
  const KEY = generateEncryptionKey();

  beforeAll(async () => {
    assertDestructiveAllowed(process.env);
    process.env.FIELD_ENCRYPTION_KEY = KEY;
    prisma = new PrismaClient({ datasources: { db: { url: URL } } });
    await prisma.$connect();
  });
  afterAll(async () => {
    delete process.env.FIELD_ENCRYPTION_KEY;
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.staffSession.deleteMany();
    await prisma.staffUser.deleteMany();
    await seed(prisma);
    auth = new StaffAuthService(prisma);
  });

  it('[INV-AUTH-03] never writes the raw secret to the database', async () => {
    const user = await auth.createUser({
      email: 'owner@r2nette.ca',
      password: 'MapleRiver47Sky',
      displayName: 'Owner',
      role: 'OWNER',
      mustChangePassword: false,
    });
    const { secret } = await auth.beginTotpEnrolment(user.id);

    const row = await prisma.staffUser.findUniqueOrThrow({ where: { id: user.id } });
    // The critical assertion: the stored value is not the secret.
    expect(row.totpSecret).not.toBe(secret);
    expect(row.totpSecret).not.toContain(secret);
    expect(isEncrypted(row.totpSecret!)).toBe(true);
  });

  it('still verifies codes against the encrypted secret', async () => {
    const user = await auth.createUser({
      email: 'owner@r2nette.ca',
      password: 'MapleRiver47Sky',
      displayName: 'Owner',
      role: 'OWNER',
      mustChangePassword: false,
    });
    const { secret } = await auth.beginTotpEnrolment(user.id);

    const res = await auth.confirmTotpEnrolment(user.id, totpForStep(secret, currentStep()));
    expect(res.recoveryCodes).toHaveLength(8);

    const after = await prisma.staffUser.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.totpEnabledAt).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* key rotation                                                        */
/* ------------------------------------------------------------------ */

import {
  loadKeyring,
  keyId,
  ciphertextKeyId,
  isCurrentKey,
} from '../src/auth/encryption.js';

describe('key rotation', () => {
  const OLD = generateEncryptionKey();
  const NEW = generateEncryptionKey();

  it('ciphertext records which key sealed it', () => {
    const sealed = encryptSecret('SECRET', { FIELD_ENCRYPTION_KEY: OLD });
    expect(ciphertextKeyId(sealed)).toBe(keyId(OLD));
    expect(sealed.startsWith('v2:')).toBe(true);
  });

  it('a retired key still opens old rows after rotation', () => {
    const sealed = encryptSecret('SECRET', { FIELD_ENCRYPTION_KEY: OLD });
    // Rotate: NEW is current, OLD is retired but still available.
    const rotated = { FIELD_ENCRYPTION_KEY: NEW, FIELD_ENCRYPTION_KEYS_RETIRED: OLD };
    expect(decryptSecret(sealed, rotated)).toBe('SECRET');
  });

  it('a row on the old key is reported as needing re-encryption', () => {
    const sealed = encryptSecret('SECRET', { FIELD_ENCRYPTION_KEY: OLD });
    const rotated = { FIELD_ENCRYPTION_KEY: NEW, FIELD_ENCRYPTION_KEYS_RETIRED: OLD };
    expect(isCurrentKey(sealed, rotated)).toBe(false);

    const moved = encryptSecret(decryptSecret(sealed, rotated), rotated);
    expect(isCurrentKey(moved, rotated)).toBe(true);
  });

  it('fails loudly when the sealing key is missing entirely', () => {
    const sealed = encryptSecret('SECRET', { FIELD_ENCRYPTION_KEY: OLD });
    // OLD was retired from the environment before re-encryption finished.
    try {
      decryptSecret(sealed, { FIELD_ENCRYPTION_KEY: NEW });
      expect.unreachable('should not decrypt');
    } catch (e) {
      expect((e as EncryptionError).code).toBe('KEY_NOT_AVAILABLE');
      // The message names the key id so an operator can find it.
      expect((e as Error).message).toContain(keyId(OLD));
    }
  });

  it('loads retired keys from a comma-separated list', () => {
    const a = generateEncryptionKey();
    const b = generateEncryptionKey();
    const ring = loadKeyring({
      FIELD_ENCRYPTION_KEY: NEW,
      FIELD_ENCRYPTION_KEYS_RETIRED: `${a}, ${b}`,
    })!;
    expect(ring.current.id).toBe(keyId(NEW));
    expect(ring.retired.map((k) => k.id)).toEqual([keyId(a), keyId(b)]);
  });

  it('ignores blank or too-short retired entries', () => {
    const ring = loadKeyring({
      FIELD_ENCRYPTION_KEY: NEW,
      FIELD_ENCRYPTION_KEYS_RETIRED: ' , short , ',
    })!;
    expect(ring.retired).toHaveLength(0);
  });

  it('still reads v1 ciphertext written before key ids existed', () => {
    // Shape produced by the previous implementation.
    const legacy = ['v1', 'aaaa', 'bbbb', 'cccc'].join(':');
    expect(isEncrypted(legacy)).toBe(true);
    expect(ciphertextKeyId(legacy)).toBeNull();
  });
});
