import { randomBytes, createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';

/**
 * Durable session and idempotency stores.
 *
 * Both were in-process. That is survivable for browsing; it is not survivable
 * once real money is involved. A restart mid-checkout would drop the session
 * and the idempotency record while a Stripe charge stayed very real.
 */

const SESSION_TTL_MS = 60 * 60 * 1000;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Sessions in PostgreSQL.
 *
 * The cookie carries a 32-byte random token. Only its SHA-256 hash is stored,
 * so a database dump does not hand an attacker live sessions — the same
 * reasoning as never storing a password.
 */
export class PrismaSessionStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(
    customerId: string,
    meta: { userAgent?: string; ip?: string } = {},
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('base64url');
    const at = this.now();
    const expiresAt = new Date(at.getTime() + SESSION_TTL_MS);

    await this.prisma.customerSession.create({
      data: {
        sessionTokenHash: sha256(token),
        customerId,
        phoneVerifiedAt: at,
        createdAt: at,
        lastSeenAt: at,
        expiresAt,
        userAgentHash: meta.userAgent ? sha256(meta.userAgent) : null,
        ipHash: meta.ip ? sha256(meta.ip) : null,
      },
    });

    return { token, expiresAt };
  }

  /** Resolve a cookie token to a customer, or null. */
  async get(token: string | undefined): Promise<{ customerId: string } | null> {
    if (!token) return null;
    const row = await this.prisma.customerSession.findUnique({
      where: { sessionTokenHash: sha256(token) },
    });
    if (!row) return null;
    if (row.revokedAt !== null) return null;
    if (row.expiresAt <= this.now()) return null;

    // Best-effort activity tracking; never block the request on it.
    void this.prisma.customerSession
      .update({ where: { id: row.id }, data: { lastSeenAt: this.now() } })
      .catch(() => undefined);

    return { customerId: row.customerId };
  }

  async destroy(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.prisma.customerSession.updateMany({
      where: { sessionTokenHash: sha256(token), revokedAt: null },
      data: { revokedAt: this.now() },
    });
  }

  async purgeExpired(): Promise<number> {
    const res = await this.prisma.customerSession.deleteMany({
      where: { expiresAt: { lt: new Date(this.now().getTime() - 7 * 24 * 3600 * 1000) } },
    });
    return res.count;
  }
}

/* ------------------------------------------------------------------ */

export class IdempotencyConflict extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';
}

export interface IdempotentResult {
  status: number;
  body: unknown;
}

function fingerprint(body: unknown): string {
  return sha256(JSON.stringify(body ?? {}));
}

/**
 * Idempotency in PostgreSQL.
 *
 * `begin` INSERTs an IN_PROGRESS row first and lets the unique constraint on
 * (scope, actorId, key) decide the winner. That ordering matters: a
 * check-then-insert would let two concurrent retries both pass the check and
 * both create a booking. Here the loser gets P2002 and waits for the winner's
 * result instead of executing the command a second time.
 */
export class PrismaIdempotencyStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async begin(
    scope: string,
    actorId: string,
    key: string,
    body: unknown,
  ): Promise<
    | { kind: 'PROCEED'; recordId: string }
    | { kind: 'REPLAY'; result: IdempotentResult }
    | { kind: 'IN_PROGRESS' }
  > {
    const hash = fingerprint(body);
    const at = this.now();

    try {
      const created = await this.prisma.idempotencyRecord.create({
        data: {
          scope,
          actorId,
          key,
          requestHash: hash,
          status: 'IN_PROGRESS',
          createdAt: at,
          expiresAt: new Date(at.getTime() + IDEMPOTENCY_TTL_MS),
        },
      });
      return { kind: 'PROCEED', recordId: created.id };
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') throw e;
    }

    const existing = await this.prisma.idempotencyRecord.findUnique({
      where: { scope_actorId_key: { scope, actorId, key } },
    });
    if (!existing) return { kind: 'IN_PROGRESS' };

    // Same key, different request: a retry that changed its mind is a bug.
    if (existing.requestHash !== hash) {
      throw new IdempotencyConflict(
        'This Idempotency-Key was already used with a different request.',
      );
    }
    if (existing.status === 'COMPLETED' && existing.responseStatus !== null) {
      return {
        kind: 'REPLAY',
        result: { status: existing.responseStatus, body: existing.responseBody },
      };
    }
    return { kind: 'IN_PROGRESS' };
  }

  async complete(recordId: string, status: number, body: unknown): Promise<void> {
    await this.prisma.idempotencyRecord.update({
      where: { id: recordId },
      data: {
        status: 'COMPLETED',
        responseStatus: status,
        responseBody: body as Prisma.InputJsonValue,
        completedAt: this.now(),
      },
    });
  }

  /** Free the key so a genuine retry can run after a failure. */
  async abandon(recordId: string): Promise<void> {
    await this.prisma.idempotencyRecord
      .delete({ where: { id: recordId } })
      .catch(() => undefined);
  }

  async purgeExpired(): Promise<number> {
    const res = await this.prisma.idempotencyRecord.deleteMany({
      where: { expiresAt: { lt: this.now() } },
    });
    return res.count;
  }
}
