import type { PrismaClient } from '@prisma/client';
import { NotificationService } from '../notifications/notification-service.js';

/**
 * Dunning: the human side of a failed payment.
 *
 * A failed charge is not a technical event to be retried until it works. It is
 * a customer whose card stopped working, who is still expecting a cleaning,
 * and who needs a person to reach them.
 *
 * Cases are keyed by CUSTOMER, not by attempt: three failed visits for one
 * person is one conversation, not three tickets.
 */

export type DunningStatus = 'OPEN' | 'CONTACTED' | 'RESOLVED' | 'WRITTEN_OFF';

export interface DunningSummary {
  open: number;
  contacted: number;
  totalOwedCents: number;
}

export class DunningService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly notifications?: NotificationService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Fold a hard failure into the customer's case.
   *
   * Reopening a RESOLVED case is deliberate: a card that failed again after
   * being fixed is new information, not a duplicate.
   */
  async recordFailure(input: {
    customerId: string;
    amountCents: number;
    reason: string;
  }) {
    const at = this.now();
    const existing = await this.prisma.dunningCase.findUnique({
      where: { customerId: input.customerId },
    });

    if (!existing) {
      return this.prisma.dunningCase.create({
        data: {
          customerId: input.customerId,
          status: 'OPEN',
          reason: input.reason,
          failedCount: 1,
          totalOwedCents: input.amountCents,
          firstFailedAt: at,
          lastFailedAt: at,
        },
      });
    }

    const reopening = existing.status === 'RESOLVED' || existing.status === 'WRITTEN_OFF';
    return this.prisma.dunningCase.update({
      where: { id: existing.id },
      data: {
        status: reopening ? 'OPEN' : existing.status,
        reason: input.reason,
        failedCount: { increment: 1 },
        totalOwedCents: reopening ? input.amountCents : existing.totalOwedCents + input.amountCents,
        lastFailedAt: at,
        resolvedAt: reopening ? null : existing.resolvedAt,
      },
    });
  }

  /**
   * A successful payment closes the case.
   *
   * Called from the webhook path, so a customer who quietly fixes their own
   * card never gets chased.
   */
  async resolveForCustomer(customerId: string) {
    const existing = await this.prisma.dunningCase.findUnique({ where: { customerId } });
    if (!existing || existing.status === 'RESOLVED') return existing;
    return this.prisma.dunningCase.update({
      where: { id: existing.id },
      data: { status: 'RESOLVED', resolvedAt: this.now(), totalOwedCents: 0 },
    });
  }

  async setStatus(id: string, status: DunningStatus, actor: string, notes?: string) {
    return this.prisma.dunningCase.update({
      where: { id },
      data: {
        status,
        assignedTo: actor,
        notes: notes ?? undefined,
        contactedAt: status === 'CONTACTED' ? this.now() : undefined,
        resolvedAt: status === 'RESOLVED' ? this.now() : undefined,
      },
    });
  }

  /** The work queue, with enough context to act without opening each one. */
  async list(status: DunningStatus[] = ['OPEN', 'CONTACTED']) {
    const cases = await this.prisma.dunningCase.findMany({
      where: { status: { in: status } },
      orderBy: [{ status: 'asc' }, { lastFailedAt: 'desc' }],
      take: 100,
    });

    const out = [];
    for (const c of cases) {
      const customer = await this.prisma.customer.findUnique({
        where: { id: c.customerId },
        include: { phones: true },
      });
      // Upcoming cleanings are the urgency signal: a failed card matters far
      // more when someone is booked in two days.
      const upcoming = await this.prisma.booking.count({
        where: {
          customerId: c.customerId,
          startAt: { gte: this.now() },
          status: { notIn: ['CANCELLED'] },
        },
      });
      out.push({
        id: c.id,
        customerId: c.customerId,
        customerName: customer?.firstName ?? 'Customer',
        phone: customer?.phones[0]?.phoneE164 ?? null,
        status: c.status,
        reason: c.reason,
        failedCount: c.failedCount,
        totalOwedCents: c.totalOwedCents,
        lastFailedAt: c.lastFailedAt.toISOString(),
        daysOpen: Math.floor((this.now().getTime() - c.firstFailedAt.getTime()) / 86400000),
        upcomingBookings: upcoming,
        notes: c.notes,
      });
    }
    return out;
  }

  async summary(): Promise<DunningSummary> {
    const cases = await this.prisma.dunningCase.findMany({
      where: { status: { in: ['OPEN', 'CONTACTED'] } },
    });
    return {
      open: cases.filter((c) => c.status === 'OPEN').length,
      contacted: cases.filter((c) => c.status === 'CONTACTED').length,
      totalOwedCents: cases.reduce((n, c) => n + c.totalOwedCents, 0),
    };
  }
}

/* ------------------------------------------------------------------ */
/* card expiry                                                         */
/* ------------------------------------------------------------------ */

/**
 * Warn before a saved card expires.
 *
 * A card that expires between visits turns a working recurring plan into a
 * failed charge and an awkward phone call. Warning early costs nothing.
 */
export class CardExpiryService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly notifications: NotificationService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Cards expiring at the end of this month or next. */
  async findExpiring(): Promise<
    { customerId: string; last4: string | null; expMonth: number; expYear: number }[]
  > {
    const at = this.now();
    const thisMonth = at.getUTCMonth() + 1;
    const thisYear = at.getUTCFullYear();
    const nextMonth = thisMonth === 12 ? 1 : thisMonth + 1;
    const nextYear = thisMonth === 12 ? thisYear + 1 : thisYear;

    const methods = await this.prisma.paymentMethodReference.findMany({
      where: { isDefault: true, expMonth: { not: null }, expYear: { not: null } },
    });

    return methods
      .filter(
        (m) =>
          (m.expYear === thisYear && m.expMonth === thisMonth) ||
          (m.expYear === nextYear && m.expMonth === nextMonth) ||
          // Already expired and still on file.
          m.expYear! < thisYear ||
          (m.expYear === thisYear && m.expMonth! < thisMonth),
      )
      .map((m) => ({
        customerId: m.customerId,
        last4: m.last4,
        expMonth: m.expMonth!,
        expYear: m.expYear!,
      }));
  }

  /**
   * Warn each affected customer once per card per month.
   *
   * Only customers with an upcoming cleaning are contacted — telling a dormant
   * customer their card expired is noise, not service.
   */
  async warnExpiring(): Promise<{ warned: number; skipped: number }> {
    const at = this.now();
    const expiring = await this.findExpiring();
    let warned = 0;
    let skipped = 0;

    for (const card of expiring) {
      const upcoming = await this.prisma.booking.count({
        where: {
          customerId: card.customerId,
          startAt: { gte: at },
          status: { notIn: ['CANCELLED'] },
        },
      });
      if (upcoming === 0) {
        skipped++;
        continue;
      }

      const customer = await this.prisma.customer.findUnique({
        where: { id: card.customerId },
        include: { phones: true },
      });
      const recipient = customer?.email ?? customer?.phones[0]?.phoneE164;
      if (!recipient) {
        skipped++;
        continue;
      }

      const res = await this.notifications.notify({
        template: 'CARD_EXPIRING',
        channel: customer?.email ? 'EMAIL' : 'SMS',
        recipient,
        customerId: card.customerId,
        // One warning per card per month, enforced by the database.
        dedupeKey: `CARD_EXPIRING:${card.customerId}:${card.expYear}-${card.expMonth}:${at.getUTCFullYear()}-${at.getUTCMonth() + 1}`,
      });
      if (res.sent) warned++;
      else skipped++;
    }
    return { warned, skipped };
  }
}
