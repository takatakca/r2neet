import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import {
  generateTotpSecret,
  verifyTotp,
  otpauthUri,
  generateRecoveryCodes,
  hashRecoveryCode,
  consumeRecoveryCode,
} from './totp.js';
import { encryptSecret, readPossiblyEncrypted, encryptionConfigured } from './encryption.js';
import type { PrismaClient } from '@prisma/client';

/**
 * Staff authentication.
 *
 * Replaces the shared `ADMIN_TOKEN`. A single shared secret cannot be revoked
 * per person, cannot distinguish a dispatcher from a cleaner, and leaves no
 * usable audit trail — every action looks identical.
 *
 * Passwords use scrypt with a per-user random salt. Comparison is
 * timing-safe. The cookie carries a random token; only its SHA-256 is stored,
 * so a database dump does not grant operator access.
 */

/** promisify picks the 3-arg overload; we need the options form. */
const scryptAsync = (
  password: string,
  salt: string,
  keylen: number,
  options: { N: number },
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derived) =>
      err ? reject(err) : resolve(derived),
    );
  });

const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = 16384; // N
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // one shift
/** Long enough to open an authenticator app, short enough to be useless later. */
const TOTP_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_FAILED = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

export type StaffRole = 'OWNER' | 'DISPATCHER' | 'CLEANER';

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 401,
  ) {
    super(message);
  }
}

/* ------------------------------------------------------------------ */
/* password hashing                                                    */
/* ------------------------------------------------------------------ */

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derived = await scryptAsync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_COST });
  return `scrypt$${SCRYPT_COST}$${salt}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const cost = Number(parts[1]);
  const salt = parts[2]!;
  const expected = Buffer.from(parts[3]!, 'hex');
  const derived = await scryptAsync(password, salt, expected.length, { N: cost });
  // Timing-safe, so a wrong password cannot be narrowed down by response time.
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** Minimum bar for an operator password. Not advice — enforced. */
export function passwordProblems(password: string): string[] {
  const out: string[] = [];
  if (password.length < 12) out.push('Use at least 12 characters.');
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password)) out.push('Mix upper and lower case.');
  if (!/\d/.test(password)) out.push('Include a number.');
  const common = ['password', '12345678', 'r2nette', 'qwerty', 'letmein', 'admin'];
  if (common.some((c) => password.toLowerCase().includes(c))) {
    out.push('Avoid common words like "password" or the business name.');
  }
  return out;
}

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

/* ------------------------------------------------------------------ */
/* permissions                                                         */
/* ------------------------------------------------------------------ */

export type Permission =
  | 'dashboard.view'
  | 'dispatch.view'
  | 'dispatch.assign'
  | 'callbacks.view'
  | 'callbacks.act'
  | 'reviews.view'
  | 'reviews.moderate'
  | 'integrations.view'
  | 'cutover.view'
  | 'staff.manage'
  | 'crew.ownJobs';

/**
 * Roles are explicit allowlists, not a numeric level. A cleaner is not a
 * "weaker admin" — they have a different, narrow job.
 */
const ROLE_PERMISSIONS: Record<StaffRole, Permission[]> = {
  OWNER: [
    'dashboard.view',
    'dispatch.view',
    'dispatch.assign',
    'callbacks.view',
    'callbacks.act',
    'reviews.view',
    'reviews.moderate',
    'integrations.view',
    'cutover.view',
    'staff.manage',
    'crew.ownJobs',
  ],
  DISPATCHER: [
    'dashboard.view',
    'dispatch.view',
    'dispatch.assign',
    'callbacks.view',
    'callbacks.act',
    'reviews.view',
    'crew.ownJobs',
  ],
  // A cleaner sees their own jobs and nothing else.
  CLEANER: ['crew.ownJobs'],
};

export function can(role: StaffRole, permission: Permission): boolean {
  return (ROLE_PERMISSIONS[role] ?? []).includes(permission);
}

export function permissionsFor(role: StaffRole): Permission[] {
  return [...(ROLE_PERMISSIONS[role] ?? [])];
}

/* ------------------------------------------------------------------ */
/* service                                                             */
/* ------------------------------------------------------------------ */

/**
 * A password-verified login that still needs a second factor.
 *
 * This is deliberately NOT a session: nothing signed by this token can reach
 * an operations route. It is short-lived and single-purpose.
 */
export interface PendingTwoFactor {
  challengeToken: string;
  expiresAt: Date;
  displayName: string;
}

export type LoginOutcome =
  | { status: 'AUTHENTICATED'; token: string; expiresAt: Date; principal: StaffPrincipal }
  | { status: 'TOTP_REQUIRED'; challenge: PendingTwoFactor };

export interface StaffPrincipal {
  userId: string;
  email: string;
  displayName: string;
  role: StaffRole;
  /** Set for CLEANER logins; scopes them to one schedulable Staff row. */
  staffId: string | null;
  mustChangePassword: boolean;
}

/** Roles for which the owner should require a second factor. */
export function twoFactorRecommended(role: StaffRole): boolean {
  return role === 'OWNER';
}

export class StaffAuthService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createUser(input: {
    email: string;
    password: string;
    displayName: string;
    role: StaffRole;
    staffId?: string | null;
    mustChangePassword?: boolean;
  }) {
    const problems = passwordProblems(input.password);
    if (problems.length) throw new AuthError(problems.join(' '), 'WEAK_PASSWORD', 400);
    return this.prisma.staffUser.create({
      data: {
        email: input.email.toLowerCase().trim(),
        passwordHash: await hashPassword(input.password),
        displayName: input.displayName,
        role: input.role,
        staffId: input.staffId ?? null,
        mustChangePassword: input.mustChangePassword ?? true,
      },
    });
  }

  /**
   * Sign in.
   *
   * A wrong email and a wrong password produce the same error and take a
   * comparable amount of time, so the endpoint cannot be used to discover
   * which staff emails exist.
   */
  async login(
    email: string,
    password: string,
    meta: { ip?: string; userAgent?: string } = {},
  ): Promise<LoginOutcome> {
    const at = this.now();
    const user = await this.prisma.staffUser.findUnique({
      where: { email: email.toLowerCase().trim() },
    });

    if (!user || !user.active) {
      // Burn comparable time so a missing account is not faster to reject.
      await hashPassword(password);
      throw new AuthError('Email or password is incorrect.', 'INVALID_CREDENTIALS');
    }

    if (user.lockedUntil && user.lockedUntil > at) {
      const mins = Math.ceil((user.lockedUntil.getTime() - at.getTime()) / 60000);
      throw new AuthError(
        `Too many attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`,
        'ACCOUNT_LOCKED',
        429,
      );
    }

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      const failed = user.failedAttempts + 1;
      await this.prisma.staffUser.update({
        where: { id: user.id },
        data: {
          failedAttempts: failed,
          lockedUntil: failed >= MAX_FAILED ? new Date(at.getTime() + LOCKOUT_MS) : null,
        },
      });
      await this.audit('STAFF_LOGIN_FAILED', user.id, { email: user.email });
      throw new AuthError('Email or password is incorrect.', 'INVALID_CREDENTIALS');
    }

    // Second factor: the password alone must not produce a session.
    if (user.totpEnabledAt) {
      const challengeToken = randomBytes(32).toString('base64url');
      const challengeExpiry = new Date(at.getTime() + TOTP_CHALLENGE_TTL_MS);
      await this.prisma.$transaction([
        this.prisma.staffUser.update({
          where: { id: user.id },
          data: { failedAttempts: 0, lockedUntil: null },
        }),
        // Stored as a session row, but expiring in minutes and marked
        // pending, so `resolve()` refuses it until the code is verified.
        this.prisma.staffSession.create({
          data: {
            staffUserId: user.id,
            sessionTokenHash: sha256(`pending:${challengeToken}`),
            createdAt: at,
            lastSeenAt: at,
            expiresAt: challengeExpiry,
            ipHash: meta.ip ? sha256(meta.ip) : null,
            userAgentHash: meta.userAgent ? sha256(meta.userAgent) : null,
          },
        }),
      ]);
      await this.audit('STAFF_LOGIN_TOTP_CHALLENGED', user.id, {});
      return {
        status: 'TOTP_REQUIRED',
        challenge: {
          challengeToken,
          expiresAt: challengeExpiry,
          displayName: user.displayName,
        },
      };
    }

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(at.getTime() + SESSION_TTL_MS);

    await this.prisma.$transaction([
      this.prisma.staffUser.update({
        where: { id: user.id },
        data: { failedAttempts: 0, lockedUntil: null, lastLoginAt: at },
      }),
      this.prisma.staffSession.create({
        data: {
          staffUserId: user.id,
          sessionTokenHash: sha256(token),
          createdAt: at,
          lastSeenAt: at,
          expiresAt,
          ipHash: meta.ip ? sha256(meta.ip) : null,
          userAgentHash: meta.userAgent ? sha256(meta.userAgent) : null,
        },
      }),
    ]);

    await this.audit('STAFF_LOGIN', user.id, { role: user.role });

    return {
      status: 'AUTHENTICATED',
      token,
      expiresAt,
      principal: {
        userId: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role as StaffRole,
        staffId: user.staffId,
        mustChangePassword: user.mustChangePassword,
      },
    };
  }

  /**
   * Complete a two-factor login.
   *
   * Accepts either a TOTP code or a recovery code. Only here is a real
   * session issued.
   */
  async completeTwoFactor(
    challengeToken: string,
    code: string,
    meta: { ip?: string; userAgent?: string } = {},
  ): Promise<{ token: string; expiresAt: Date; principal: StaffPrincipal }> {
    const at = this.now();
    const pending = await this.prisma.staffSession.findUnique({
      where: { sessionTokenHash: sha256(`pending:${challengeToken}`) },
      include: { user: true },
    });
    if (!pending || pending.revokedAt || pending.expiresAt <= at) {
      throw new AuthError('That sign-in attempt expired. Start again.', 'CHALLENGE_EXPIRED');
    }

    const user = pending.user;
    if (!user.active || !user.totpSecret) {
      throw new AuthError('Two-factor is not set up for this account.', 'TOTP_NOT_ENROLLED', 400);
    }
    if (user.lockedUntil && user.lockedUntil > at) {
      throw new AuthError('Too many attempts. Try again shortly.', 'ACCOUNT_LOCKED', 429);
    }

    const cleaned = code.trim();
    let ok = false;
    let usedStep: number | null = null;
    let remainingRecovery: string[] | null = null;

    if (/^\d{6}$/.test(cleaned.replace(/\s/g, ''))) {
      const res = verifyTotp(readPossiblyEncrypted(user.totpSecret), cleaned, {
        at,
        lastUsedStep: user.lastTotpStep === null ? null : Number(user.lastTotpStep),
      });
      ok = res.valid;
      usedStep = res.step ?? null;
    } else {
      // A recovery code, used once and then gone.
      const consumed = consumeRecoveryCode(user.recoveryCodeHashes, cleaned);
      ok = consumed.valid;
      if (ok) remainingRecovery = consumed.remaining;
    }

    if (!ok) {
      const failed = user.failedAttempts + 1;
      await this.prisma.staffUser.update({
        where: { id: user.id },
        data: {
          failedAttempts: failed,
          lockedUntil: failed >= MAX_FAILED ? new Date(at.getTime() + LOCKOUT_MS) : null,
        },
      });
      await this.audit('STAFF_TOTP_FAILED', user.id, {});
      throw new AuthError('That code is not right.', 'INVALID_TOTP');
    }

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(at.getTime() + SESSION_TTL_MS);

    await this.prisma.$transaction([
      // The challenge is spent, whatever happens next.
      this.prisma.staffSession.update({
        where: { id: pending.id },
        data: { revokedAt: at },
      }),
      this.prisma.staffUser.update({
        where: { id: user.id },
        data: {
          failedAttempts: 0,
          lockedUntil: null,
          lastLoginAt: at,
          // Replay protection: this step can never be accepted again.
          lastTotpStep: usedStep === null ? user.lastTotpStep : BigInt(usedStep),
          ...(remainingRecovery ? { recoveryCodeHashes: remainingRecovery } : {}),
        },
      }),
      this.prisma.staffSession.create({
        data: {
          staffUserId: user.id,
          sessionTokenHash: sha256(token),
          createdAt: at,
          lastSeenAt: at,
          expiresAt,
          ipHash: meta.ip ? sha256(meta.ip) : null,
          userAgentHash: meta.userAgent ? sha256(meta.userAgent) : null,
        },
      }),
    ]);

    await this.audit(remainingRecovery ? 'STAFF_LOGIN_RECOVERY_CODE' : 'STAFF_LOGIN_TOTP', user.id, {
      recoveryCodesRemaining: remainingRecovery?.length,
    });

    return {
      token,
      expiresAt,
      principal: {
        userId: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role as StaffRole,
        staffId: user.staffId,
        mustChangePassword: user.mustChangePassword,
      },
    };
  }

  /* ---------------- enrolment ---------------- */

  /**
   * Begin enrolment. The secret is stored but NOT active until a code is
   * confirmed, so a half-finished setup cannot lock anyone out.
   */
  async beginTotpEnrolment(userId: string) {
    const user = await this.prisma.staffUser.findUniqueOrThrow({ where: { id: userId } });
    if (user.totpEnabledAt) {
      throw new AuthError('Two-factor is already on for this account.', 'ALREADY_ENROLLED', 400);
    }
    const secret = generateTotpSecret();
    // Encrypted at rest: we need the plaintext to verify codes, so it cannot
    // be hashed, but a database dump alone must not let anyone generate valid
    // codes for this account.
    await this.prisma.staffUser.update({
      where: { id: userId },
      data: { totpSecret: encryptionConfigured() ? encryptSecret(secret) : secret },
    });
    // Returned exactly once, during enrolment.
    return { secret, otpauthUri: otpauthUri(secret, user.email) };
  }

  /** Confirm enrolment with a live code, and issue recovery codes once. */
  async confirmTotpEnrolment(userId: string, code: string) {
    const at = this.now();
    const user = await this.prisma.staffUser.findUniqueOrThrow({ where: { id: userId } });
    if (!user.totpSecret) {
      throw new AuthError('Start two-factor setup first.', 'TOTP_NOT_STARTED', 400);
    }
    const res = verifyTotp(readPossiblyEncrypted(user.totpSecret), code, { at });
    if (!res.valid) {
      throw new AuthError('That code is not right. Check your authenticator app.', 'INVALID_TOTP', 400);
    }

    const recoveryCodes = generateRecoveryCodes();
    await this.prisma.staffUser.update({
      where: { id: userId },
      data: {
        totpEnabledAt: at,
        lastTotpStep: res.step === undefined ? null : BigInt(res.step),
        recoveryCodeHashes: recoveryCodes.map(hashRecoveryCode),
      },
    });
    await this.audit('STAFF_TOTP_ENABLED', userId, {});
    // Shown once. We keep only hashes.
    return { recoveryCodes };
  }

  /** Turn it off. Requires the password, so a hijacked session cannot. */
  async disableTotp(userId: string, password: string) {
    const user = await this.prisma.staffUser.findUniqueOrThrow({ where: { id: userId } });
    if (!(await verifyPassword(password, user.passwordHash))) {
      throw new AuthError('Your password is incorrect.', 'INVALID_CREDENTIALS', 400);
    }
    await this.prisma.staffUser.update({
      where: { id: userId },
      data: {
        totpSecret: null,
        totpEnabledAt: null,
        recoveryCodeHashes: [],
        lastTotpStep: null,
      },
    });
    await this.audit('STAFF_TOTP_DISABLED', userId, {});
  }

  async regenerateRecoveryCodes(userId: string, password: string) {
    const user = await this.prisma.staffUser.findUniqueOrThrow({ where: { id: userId } });
    if (!(await verifyPassword(password, user.passwordHash))) {
      throw new AuthError('Your password is incorrect.', 'INVALID_CREDENTIALS', 400);
    }
    const codes = generateRecoveryCodes();
    await this.prisma.staffUser.update({
      where: { id: userId },
      data: { recoveryCodeHashes: codes.map(hashRecoveryCode) },
    });
    await this.audit('STAFF_RECOVERY_CODES_REGENERATED', userId, {});
    return { recoveryCodes: codes };
  }

  async resolve(token: string | undefined): Promise<StaffPrincipal | null> {
    if (!token) return null;
    const session = await this.prisma.staffSession.findUnique({
      where: { sessionTokenHash: sha256(token) },
      include: { user: true },
    });
    if (!session || session.revokedAt || session.expiresAt <= this.now()) return null;
    if (!session.user.active) return null;
    // A pending two-factor challenge is stored in the same table but is not a
    // session. It is looked up under a different hash, so a challenge token
    // presented as a cookie simply does not resolve.

    void this.prisma.staffSession
      .update({ where: { id: session.id }, data: { lastSeenAt: this.now() } })
      .catch(() => undefined);

    return {
      userId: session.user.id,
      email: session.user.email,
      displayName: session.user.displayName,
      role: session.user.role as StaffRole,
      staffId: session.user.staffId,
      mustChangePassword: session.user.mustChangePassword,
    };
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.prisma.staffSession.updateMany({
      where: { sessionTokenHash: sha256(token), revokedAt: null },
      data: { revokedAt: this.now() },
    });
  }

  /** Changing a password kills every other session for that operator. */
  async changePassword(userId: string, current: string, next: string, keepToken?: string) {
    const user = await this.prisma.staffUser.findUniqueOrThrow({ where: { id: userId } });
    if (!(await verifyPassword(current, user.passwordHash))) {
      throw new AuthError('Your current password is incorrect.', 'INVALID_CREDENTIALS', 400);
    }
    const problems = passwordProblems(next);
    if (problems.length) throw new AuthError(problems.join(' '), 'WEAK_PASSWORD', 400);
    if (await verifyPassword(next, user.passwordHash)) {
      throw new AuthError('Choose a password you have not used here before.', 'PASSWORD_REUSED', 400);
    }

    await this.prisma.staffUser.update({
      where: { id: userId },
      data: {
        passwordHash: await hashPassword(next),
        mustChangePassword: false,
        passwordChangedAt: this.now(),
      },
    });
    await this.prisma.staffSession.updateMany({
      where: {
        staffUserId: userId,
        revokedAt: null,
        ...(keepToken ? { sessionTokenHash: { not: sha256(keepToken) } } : {}),
      },
      data: { revokedAt: this.now() },
    });
    await this.audit('STAFF_PASSWORD_CHANGED', userId, {});
  }

  async revokeAllSessions(userId: string): Promise<void> {
    await this.prisma.staffSession.updateMany({
      where: { staffUserId: userId, revokedAt: null },
      data: { revokedAt: this.now() },
    });
  }

  /** Every privileged action is attributable to a person, not a token. */
  async audit(action: string, actorId: string | null, metadata: Record<string, unknown>) {
    await this.prisma.auditLog
      .create({
        data: {
          action,
          entityType: 'StaffUser',
          entityId: actorId,
          actorType: 'STAFF',
          actorId,
          metadata: metadata as never,
        },
      })
      .catch(() => undefined);
  }
}
