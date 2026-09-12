import express, { type Request, type Response, type NextFunction } from 'express';
import type { PrismaClient } from '@prisma/client';
import { ReviewService } from '../reviews/review-service.js';
import { CallbackService, type VoiceProvider } from '../callbacks/callback-service.js';
import { integrationStatus } from '../data/repositories.js';
import { DunningService } from '../payments/dunning-service.js';
import { WorkerHealthService, AlertService } from '../workers/health.js';
import { RosterService, RosterError } from '../staff/roster-service.js';
import { CATEGORIES, SERVICES } from '../data/catalogue.js';
import { workerExpectations, offHostConfigured } from '../workers/expectations.js';
import { localToUtc } from '../scheduling/availability.js';
import cookieParser from 'cookie-parser';
import {
  StaffAuthService,
  AuthError,
  can,
  permissionsFor,
  twoFactorRecommended,
  type Permission,
  type StaffPrincipal,
} from '../auth/staff-auth.js';

/**
 * Operations API: admin dispatch and the cleaner app.
 *
 * Staff auth is a bearer token from the environment. That is deliberately
 * simple for now and clearly marked — it is not the customer session system
 * and must be replaced with real staff accounts before this is public.
 */

export const STAFF_COOKIE = 'r2n_staff';

export interface OpsDeps {
  prisma: PrismaClient;
  voice?: VoiceProvider | null;
  now?: () => Date;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      staff?: StaffPrincipal;
      staffToken?: string;
    }
  }
}

export function createOpsApi(deps: OpsDeps) {
  const { prisma } = deps;
  const now = deps.now ?? (() => new Date());
  const reviews = new ReviewService(prisma, now);
  const callbacks = new CallbackService(prisma, deps.voice ?? null, now);
  const auth = new StaffAuthService(prisma, now);

  const app = express.Router();
  app.use(express.json());
  app.use(cookieParser());

  // Resolve the staff session once per request. There is no shared token and
  // no `?token=` query parameter — those leak into logs and browser history.
  app.use((req, _res, next) => {
    const token = req.cookies?.[STAFF_COOKIE] as string | undefined;
    if (!token) return next();
    auth
      .resolve(token)
      .then((principal) => {
        if (principal) {
          req.staff = principal;
          req.staffToken = token;
        }
        next();
      })
      .catch(next);
  });

  function setStaffCookie(res: Response, token: string, expiresAt: Date): void {
    res.cookie(STAFF_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      expires: expiresAt,
    });
  }

  /** Signed in at all. */
  function requireStaff(req: Request): StaffPrincipal {
    if (!req.staff) {
      throw new AuthError('Please sign in.', 'UNAUTHORIZED', 401);
    }
    return req.staff;
  }

  /** Signed in AND permitted. Role is checked per action, not per page. */
  function requirePermission(req: Request, permission: Permission): StaffPrincipal {
    const principal = requireStaff(req);
    if (!can(principal.role, permission)) {
      throw new AuthError('You do not have access to that.', 'FORBIDDEN', 403);
    }
    return principal;
  }

  const wrap =
    (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) =>
      fn(req, res).catch(next);

  const dayBounds = (dateKey: string) => {
    const [y, m, d] = dateKey.split('-').map(Number);
    return { start: localToUtc(y!, m!, d!, 0), end: localToUtc(y!, m!, d!, 24 * 60) };
  };

  const todayKey = () =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Toronto',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now());

  /* ---------------- dashboard ---------------- */

  app.get(
    '/api/v1/admin/dashboard',
    wrap(async (req, res) => {
      requirePermission(req, 'dashboard.view');
      const key = String(req.query.date ?? todayKey());
      const { start, end } = dayBounds(key);

      const [todays, unassigned, waitingCallbacks, paymentIssues, pendingReviews, activeStaff] =
        await Promise.all([
          prisma.booking.count({
            where: { startAt: { gte: start, lt: end }, status: { notIn: ['CANCELLED'] } },
          }),
          prisma.booking.count({
            where: { startAt: { gte: start, lt: end }, staff: { none: {} } },
          }),
          prisma.callbackRequest.count({
            where: { status: { in: ['REQUESTED', 'QUEUED', 'STAFF_RINGING'] } },
          }),
          prisma.payment.count({
            where: { status: { in: ['FAILED', 'REQUIRES_ACTION'] } },
          }),
          prisma.review.count({ where: { status: 'PENDING' } }),
          prisma.staff.count({ where: { active: true } }),
        ]);

      const revenue = await prisma.booking.aggregate({
        where: { startAt: { gte: start, lt: end }, status: { notIn: ['CANCELLED'] } },
        _sum: { grandTotalCents: true },
      });

      const next = await prisma.booking.findMany({
        where: { startAt: { gte: now() }, status: { notIn: ['CANCELLED'] } },
        orderBy: { startAt: 'asc' },
        take: 6,
        include: { service: true, address: true, customer: true, staff: true },
      });

      res.json({
        date: key,
        today: {
          bookings: todays,
          cleanersActive: activeStaff,
          revenueCents: revenue._sum.grandTotalCents ?? 0,
          unassigned,
        },
        needsAttention: {
          callbacksWaiting: waitingCallbacks,
          dunningCases: await prisma.dunningCase.count({ where: { status: 'OPEN' } }),
          paymentIssues,
          reviewsPendingModeration: pendingReviews,
          unassignedJobs: unassigned,
          integrationErrors: integrationStatus(process.env).filter(
            (i) => i.status !== 'CONNECTED',
          ).length,
        },
        upcoming: next.map((b) => ({
          id: b.id,
          bookingNumber: b.bookingNumber,
          startAt: b.startAt.toISOString(),
          endAt: b.endAt.toISOString(),
          service: b.service.nameEn,
          customerName: b.customer.firstName ?? 'Customer',
          address: b.address.formattedAddress,
          crewSize: b.staff.length,
          requiredStaffCount: b.service.requiredStaffCount,
          status: b.status,
        })),
      });
    }),
  );

  /* ---------------- dispatch ---------------- */

  app.get(
    '/api/v1/admin/dispatch',
    wrap(async (req, res) => {
      requirePermission(req, 'dispatch.view');
      const key = String(req.query.date ?? todayKey());
      const { start, end } = dayBounds(key);

      const [bookings, staff, timeOff] = await Promise.all([
        prisma.booking.findMany({
          where: { startAt: { gte: start, lt: end }, status: { notIn: ['CANCELLED'] } },
          orderBy: { startAt: 'asc' },
          include: { service: true, address: true, customer: true, staff: true },
        }),
        prisma.staff.findMany({
          where: { active: true },
          include: { availability: true },
          orderBy: { displayName: 'asc' },
        }),
        prisma.staffTimeOff.findMany({ where: { startAt: { lt: end }, endAt: { gt: start } } }),
      ]);

      res.json({
        date: key,
        staff: staff.map((s) => ({
          id: s.id,
          displayName: s.displayName,
          onTimeOff: timeOff.some((t) => t.staffId === s.id),
        })),
        bookings: bookings.map((b) => ({
          id: b.id,
          bookingNumber: b.bookingNumber,
          startAt: b.startAt.toISOString(),
          endAt: b.endAt.toISOString(),
          durationMinutes: Math.round((b.endAt.getTime() - b.startAt.getTime()) / 60000),
          service: b.service.nameEn,
          requiredStaffCount: b.service.requiredStaffCount,
          assignedStaffIds: b.staff.map((a) => a.staffId),
          customerName: b.customer.firstName ?? 'Customer',
          address: b.address.formattedAddress,
          city: b.address.city,
          status: b.status,
          grandTotalCents: b.grandTotalCents,
        })),
      });
    }),
  );

  /** Assign a cleaner, refusing anything that would break capacity rules. */
  app.post(
    '/api/v1/admin/bookings/:id/assign',
    wrap(async (req, res) => {
      const actor = requirePermission(req, 'dispatch.assign');
      const bookingId = String(req.params.id);
      const staffId = String((req.body as { staffId?: string }).staffId ?? '');
      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
        include: { service: true, staff: true },
      });
      if (!booking) throw Object.assign(new Error('Booking not found.'), { status: 404 });

      // Never let a dispatcher double-book someone.
      const clash = await prisma.bookingStaff.findFirst({
        where: {
          staffId,
          booking: {
            id: { not: bookingId },
            status: { notIn: ['CANCELLED'] },
            startAt: { lt: booking.endAt },
            endAt: { gt: booking.startAt },
          },
        },
        include: { booking: true },
      });
      if (clash) {
        res.status(409).json({
          error: {
            code: 'STAFF_CONFLICT',
            message: `That cleaner is already on ${clash.booking.bookingNumber} at this time.`,
          },
        });
        return;
      }

      if (booking.staff.length >= booking.service.requiredStaffCount) {
        res.status(409).json({
          error: { code: 'CREW_FULL', message: 'This job already has a full crew.' },
        });
        return;
      }

      await prisma.bookingStaff.create({ data: { bookingId, staffId } });
      const updated = await prisma.booking.findUniqueOrThrow({
        where: { id: bookingId },
        include: { staff: true },
      });
      if (updated.staff.length >= booking.service.requiredStaffCount) {
        await prisma.booking.update({ where: { id: bookingId }, data: { status: 'ASSIGNED' } });
        await prisma.bookingStatusHistory.create({
          data: { bookingId, status: 'ASSIGNED', actor: 'DISPATCH', reason: 'Crew complete' },
        });
      }
      res.json({ assigned: true, crewSize: updated.staff.length });
    }),
  );

  app.delete(
    '/api/v1/admin/bookings/:id/assign/:staffId',
    wrap(async (req, res) => {
      requirePermission(req, 'dispatch.assign');
      await prisma.bookingStaff.deleteMany({
        where: { bookingId: String(req.params.id), staffId: String(req.params.staffId) },
      });
      res.json({ removed: true });
    }),
  );

  /* ---------------- roster ---------------- */

  const roster = new RosterService(prisma, now);

  app.get(
    '/api/v1/admin/roster',
    wrap(async (req, res) => {
      requirePermission(req, 'dispatch.view');
      const [members, coverage] = await Promise.all([roster.list(), roster.coverage()]);
      res.json({
        staff: members,
        coverage,
        services: SERVICES.filter((s) => s.active).map((s) => ({
          id: s.id,
          name: s.name.en,
          categoryId: s.categoryId,
          requiredStaffCount: s.requiredStaffCount,
        })),
        categories: CATEGORIES.map((c) => ({ id: c.id, name: c.name.en })),
      });
    }),
  );

  app.post(
    '/api/v1/admin/roster',
    wrap(async (req, res) => {
      requirePermission(req, 'staff.manage');
      const body = req.body as {
        displayName?: string;
        useDefaultWeek?: boolean;
        skills?: string[];
      };
      const created = await roster.create({
        displayName: String(body.displayName ?? ''),
        skills: body.skills,
        // Omitted means "the usual week"; an empty array is a deliberate
        // choice to create someone unbookable for now.
        ...(body.useDefaultWeek === false ? { availability: [] } : {}),
      });
      res.status(201).json({ id: created.id, displayName: created.displayName });
    }),
  );

  app.put(
    '/api/v1/admin/roster/:id/availability',
    wrap(async (req, res) => {
      requirePermission(req, 'staff.manage');
      const windows = (req.body as { availability?: never[] }).availability ?? [];
      res.json(await roster.setAvailability(String(req.params.id), windows));
    }),
  );

  app.put(
    '/api/v1/admin/roster/:id/skills',
    wrap(async (req, res) => {
      requirePermission(req, 'staff.manage');
      await roster.setSkills(String(req.params.id), (req.body as { skills?: string[] }).skills ?? []);
      res.json({ ok: true });
    }),
  );

  app.post(
    '/api/v1/admin/roster/:id/active',
    wrap(async (req, res) => {
      requirePermission(req, 'staff.manage');
      const active = Boolean((req.body as { active?: boolean }).active);
      await roster.setActive(String(req.params.id), active);
      res.json({ active });
    }),
  );

  app.post(
    '/api/v1/admin/roster/:id/time-off',
    wrap(async (req, res) => {
      requirePermission(req, 'dispatch.assign');
      const body = req.body as {
        startAt?: string;
        endAt?: string;
        from?: string;
        through?: string;
        reason?: string;
      };
      const dayKey = (v?: string) => {
        const m = /^(\d{4}-\d{2}-\d{2})/.exec((v ?? '').trim());
        return m?.[1] ?? null;
      };
      const fromKey = dayKey(body.from) ?? dayKey(body.startAt);
      const throughKey = dayKey(body.through) ?? dayKey(body.endAt);
      if (!fromKey || !throughKey) {
        throw new RosterError('A start and end are required.', 'VALIDATION_ERROR');
      }
      // Inclusive through-date in America/Toronto, so "Sept 10–12" covers
      // those three local days rather than whatever the server's clock is.
      res.json(
        await roster.addTimeOff(
          String(req.params.id),
          dayBounds(fromKey).start,
          dayBounds(throughKey).end,
          body.reason,
        ),
      );
    }),
  );

  app.delete(
    '/api/v1/admin/roster/time-off/:id',
    wrap(async (req, res) => {
      requirePermission(req, 'dispatch.assign');
      await roster.removeTimeOff(String(req.params.id));
      res.json({ ok: true });
    }),
  );

  /* ---------------- callbacks ---------------- */

  app.get(
    '/api/v1/admin/callbacks',
    wrap(async (req, res) => {
      requirePermission(req, 'callbacks.view');
      const rows = await prisma.callbackRequest.findMany({
        orderBy: { requestedAt: 'desc' },
        take: 100,
        include: { businessPhone: true },
      });
      const target = 5 * 60 * 1000;
      res.json({
        targetMinutes: 5,
        callbacks: rows.map((c) => {
          const ageMs = now().getTime() - c.requestedAt.getTime();
          const waiting = ['REQUESTED', 'QUEUED', 'STAFF_RINGING'].includes(c.status);
          return {
            id: c.id,
            phoneE164: c.phoneE164,
            status: c.status,
            reason: c.reason,
            source: c.source,
            requestedAt: c.requestedAt.toISOString(),
            ageMinutes: Math.floor(ageMs / 60000),
            overdue: waiting && ageMs > target,
            attemptCount: c.attemptCount,
            assignedLine: c.businessPhone?.displayNumber ?? null,
          };
        }),
      });
    }),
  );

  app.post(
    '/api/v1/admin/callbacks/:id/:action',
    wrap(async (req, res) => {
      requirePermission(req, 'callbacks.act');
      const id = String(req.params.id);
      const action = String(req.params.action);
      if (action === 'complete') res.json(await callbacks.complete(id));
      else if (action === 'cancel')
        res.json(await prisma.callbackRequest.update({ where: { id }, data: { status: 'CANCELLED' } }));
      else if (action === 'dial') res.json(await callbacks.dialStaffFirst(id));
      else res.status(400).json({ error: { code: 'UNKNOWN_ACTION', message: 'Unknown action.' } });
    }),
  );

  /* ---------------- billing & dunning ---------------- */

  const dunning = new DunningService(prisma, undefined, now);

  app.get(
    '/api/v1/admin/billing',
    wrap(async (req, res) => {
      requirePermission(req, 'dashboard.view');
      const [cases, summary, attempts] = await Promise.all([
        dunning.list(['OPEN', 'CONTACTED']),
        dunning.summary(),
        prisma.billingAttempt.findMany({
          where: { status: { in: ['HARD_FAILED', 'ABANDONED', 'SOFT_FAILED'] } },
          orderBy: { updatedAt: 'desc' },
          take: 50,
        }),
      ]);
      res.json({
        summary,
        cases,
        recentFailures: attempts.map((a) => ({
          id: a.id,
          bookingId: a.bookingId,
          amountCents: a.amountCents,
          status: a.status,
          attemptNumber: a.attemptNumber,
          failureCode: a.failureCode,
          nextRetryAt: a.nextRetryAt?.toISOString() ?? null,
          updatedAt: a.updatedAt.toISOString(),
        })),
      });
    }),
  );

  app.post(
    '/api/v1/admin/billing/cases/:id/:action',
    wrap(async (req, res) => {
      const actor = requirePermission(req, 'callbacks.act');
      const map: Record<string, 'CONTACTED' | 'RESOLVED' | 'WRITTEN_OFF'> = {
        contacted: 'CONTACTED',
        resolved: 'RESOLVED',
        writeoff: 'WRITTEN_OFF',
      };
      const status = map[String(req.params.action)];
      if (!status) {
        res.status(400).json({ error: { code: 'UNKNOWN_ACTION', message: 'Unknown action.' } });
        return;
      }
      const notes = (req.body as { notes?: string })?.notes;
      res.json(await dunning.setStatus(String(req.params.id), status, actor.email, notes));
    }),
  );

  /** Manually retry one failed charge, without waiting for the worker. */
  app.post(
    '/api/v1/admin/billing/attempts/:id/retry',
    wrap(async (req, res) => {
      requirePermission(req, 'callbacks.act');
      const attempt = await prisma.billingAttempt.findUnique({ where: { id: String(req.params.id) } });
      if (!attempt) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such attempt.' } });
        return;
      }
      await prisma.billingAttempt.update({
        where: { id: attempt.id },
        data: { status: 'SCHEDULED', nextRetryAt: null, claimedBy: null, claimedUntil: null },
      });
      res.json({ requeued: true });
    }),
  );

  /* ---------------- reviews ---------------- */

  app.get(
    '/api/v1/admin/reviews',
    wrap(async (req, res) => {
      requirePermission(req, 'reviews.view');
      const rows = await prisma.review.findMany({
        orderBy: { reviewDate: 'desc' },
        take: 200,
      });
      const sync = await prisma.reviewSyncState.findMany();
      res.json({
        summary: await reviews.summary(),
        syncState: sync,
        reviews: rows.map((r) => ({
          id: r.id,
          source: r.source,
          customerDisplayName: r.customerDisplayName,
          rating: r.rating,
          reviewText: r.reviewText,
          reviewDate: r.reviewDate.toISOString(),
          status: r.status,
          featured: r.featured,
        })),
      });
    }),
  );

  app.post(
    '/api/v1/admin/reviews/:id/:action',
    wrap(async (req, res) => {
      requirePermission(req, 'reviews.moderate');
      const id = String(req.params.id);
      const action = String(req.params.action);
      const map: Record<string, 'PUBLISHED' | 'HIDDEN' | 'REJECTED'> = {
        publish: 'PUBLISHED',
        hide: 'HIDDEN',
        reject: 'REJECTED',
      };
      if (action === 'feature') {
        const r = await prisma.review.findUniqueOrThrow({ where: { id } });
        res.json(
          await prisma.review.update({ where: { id }, data: { featured: !r.featured } }),
        );
        return;
      }
      const status = map[action];
      if (!status) {
        res.status(400).json({ error: { code: 'UNKNOWN_ACTION', message: 'Unknown action.' } });
        return;
      }
      res.json(await reviews.moderate(id, status, 'admin'));
    }),
  );

  /** Dry run first, always. */
  app.post(
    '/api/v1/admin/reviews/import',
    wrap(async (req, res) => {
      requirePermission(req, 'reviews.moderate');
      const body = req.body as { rows?: never[]; dryRun?: boolean };
      const report = await reviews.importLegacy(body.rows ?? [], { dryRun: body.dryRun !== false });
      res.json({ dryRun: body.dryRun !== false, report });
    }),
  );

  /* ---------------- integrations & cutover ---------------- */

  app.get(
    '/api/v1/admin/integrations',
    wrap(async (req, res) => {
      requirePermission(req, 'integrations.view');
      const sync = await prisma.reviewSyncState.findMany();
      res.json({
        integrations: integrationStatus(process.env),
        reviewSync: sync,
      });
    }),
  );

  /**
   * Setmore replacement readiness. Every row is computed from real data —
   * this is the page that tells the owner what still blocks shutdown.
   */
  /** Worker health and open operational alerts. */
  app.get(
    '/api/v1/admin/operations',
    wrap(async (req, res) => {
      requirePermission(req, 'integrations.view');
      const health = new WorkerHealthService(prisma, workerExpectations(), now);
      const alerts = new AlertService(prisma, null, now);
      const [workers, blockers, open] = await Promise.all([
        health.health(),
        health.cutoverBlockers(),
        alerts.open(),
      ]);
      res.json({
        workers,
        blockers: blockers.map((b) => b.name),
        offHostBackupConfigured: offHostConfigured(),
        alerts: open.map((a) => ({
          key: a.key,
          severity: a.severity,
          category: a.category,
          title: a.title,
          message: a.message,
          openedAt: a.openedAt.toISOString(),
          observations: a.observations,
          deliveryStatus: a.deliveryStatus,
        })),
      });
    }),
  );

  app.get(
    '/api/v1/admin/cutover',
    wrap(async (req, res) => {
      requirePermission(req, 'cutover.view');
      const [migratedCustomers, migratedBookings] = await Promise.all([
        prisma.customer.count({ where: { legacyExternalId: { not: null } } }),
        prisma.booking.count({ where: { legacyExternalId: { not: null } } }),
      ]);
      const [services, customers, futureBookings, recurring, reviewCount, staff, phones] =
        await Promise.all([
          prisma.serviceOption.count({ where: { active: true } }),
          prisma.customer.count(),
          prisma.booking.count({ where: { startAt: { gte: now() }, status: { notIn: ['CANCELLED'] } } }),
          prisma.recurrenceSeries.count({ where: { status: 'ACTIVE' } }),
          prisma.review.count({ where: { status: 'PUBLISHED' } }),
          prisma.staff.count({ where: { active: true } }),
          prisma.businessPhone.count({ where: { enabled: true } }),
        ]);
      const integrations = integrationStatus(process.env);
      const flag = (ok: boolean, blocked = false) =>
        blocked ? 'BLOCKED' : ok ? 'READY' : 'ACTION_REQUIRED';

      // A worker is READY only once it has actually succeeded here.
      const health = new WorkerHealthService(prisma, workerExpectations(), now);
      const workers = await health.health();
      const workerRows = workers.map((w) => ({
        key: `worker:${w.name}`,
        label: w.label,
        status:
          w.status === 'HEALTHY'
            ? 'READY'
            : w.status === 'NOT_CONFIGURED'
              ? 'ACTION_REQUIRED'
              : w.critical
                ? 'BLOCKED'
                : 'ACTION_REQUIRED',
        detail: w.summary,
      }));

      res.json({
        items: [
          { key: 'catalogue', label: 'Service catalogue', status: flag(services >= 11), detail: `${services} services seeded` },
          {
            key: 'staff',
            label: 'Cleaners',
            status: staff >= 2 ? 'READY' : 'ACTION_REQUIRED',
            detail:
              staff >= 2
                ? `${staff} active`
                : `${staff} active. Two-cleaner services cannot be booked with fewer than two.`,
          },
          { key: 'customers', label: 'Customers', status: flag(customers > 0), detail: `${customers} in database` },
          { key: 'bookings', label: 'Future bookings', status: flag(true), detail: `${futureBookings} upcoming` },
          { key: 'recurring', label: 'Recurring plans', status: flag(true), detail: `${recurring} active` },
          { key: 'reviews', label: 'Reviews', status: flag(reviewCount > 0), detail: `${reviewCount} published` },
          {
            key: 'setmore-data',
            label: 'Setmore customers & appointments',
            status: migratedCustomers > 0 ? 'READY' : 'ACTION_REQUIRED',
            detail:
              migratedCustomers > 0
                ? `${migratedCustomers} customers and ${migratedBookings} appointments migrated`
                : 'Not yet migrated. Run: npm run migrate:setmore',
          },
          { key: 'phones', label: 'Business phones', status: flag(phones > 0), detail: `${phones} configured` },
          ...workerRows,
          {
            key: 'backup-offhost',
            label: 'Off-host backup storage',
            status: offHostConfigured() ? 'READY' : 'ACTION_REQUIRED',
            detail: offHostConfigured()
              ? 'Configured'
              : 'Backups stay on this machine. Set BACKUP_S3_* to store them elsewhere.',
          },
          ...integrations.map((i) => ({
            key: i.key,
            label: i.label,
            status: i.status === 'CONNECTED' ? 'READY' : 'ACTION_REQUIRED',
            detail: i.status === 'CONNECTED' ? 'Connected' : `Missing: ${i.missingEnv.join(', ')}`,
          })),
        ],
      });
    }),
  );

  /* ---------------- cleaner app ---------------- */

  /**
   * A cleaner sees their own jobs and nothing else: no totals, no payment
   * state, no other cleaners' work, no admin notes.
   */
  app.get(
    '/api/v1/crew/jobs',
    wrap(async (req, res) => {
      const principal = requirePermission(req, 'crew.ownJobs');
      // A cleaner may only ever see their own jobs. The staffId comes from
      // their account, not from the query string, so `?staffId=` cannot be
      // edited to read a colleague's day.
      const staffId =
        principal.role === 'CLEANER'
          ? principal.staffId
          : String(req.query.staffId ?? principal.staffId ?? '');
      if (!staffId) {
        throw new AuthError('This account is not linked to a cleaner.', 'NO_STAFF_LINK', 400);
      }
      const key = String(req.query.date ?? todayKey());
      const { start, end } = dayBounds(key);

      const rows = await prisma.bookingStaff.findMany({
        where: {
          staffId,
          booking: { startAt: { gte: start, lt: end }, status: { notIn: ['CANCELLED'] } },
        },
        include: {
          booking: { include: { service: true, address: true, customer: true } },
        },
        orderBy: { booking: { startAt: 'asc' } },
      });

      res.json({
        date: key,
        jobs: rows.map(({ booking: b }) => ({
          id: b.id,
          bookingNumber: b.bookingNumber,
          startAt: b.startAt.toISOString(),
          endAt: b.endAt.toISOString(),
          service: b.service.nameEn,
          durationMinutes: Math.round((b.endAt.getTime() - b.startAt.getTime()) / 60000),
          crewSize: b.service.requiredStaffCount,
          customerFirstName: b.customer.firstName ?? 'Customer',
          address: b.address.formattedAddress,
          unit: b.address.unit,
          city: b.address.city,
          latitude: b.address.latitude,
          longitude: b.address.longitude,
          status: b.status,
          // No grandTotal, no payment status, no risk data.
        })),
      });
    }),
  );

  /** Cleaner status transitions, validated server-side. */
  const CREW_TRANSITIONS: Record<string, string[]> = {
    CONFIRMED: ['EN_ROUTE'],
    ASSIGNED: ['EN_ROUTE'],
    EN_ROUTE: ['ARRIVED'],
    ARRIVED: ['IN_PROGRESS'],
    IN_PROGRESS: ['COMPLETED'],
  };

  app.post(
    '/api/v1/crew/jobs/:id/status',
    wrap(async (req, res) => {
      requireStaff(req);
      const id = String(req.params.id);
      const principal = requirePermission(req, 'crew.ownJobs');
      const to = String((req.body as { status?: string }).status ?? '');
      // Identity from the session, never the body.
      const staffId = principal.staffId ?? String((req.body as { staffId?: string }).staffId ?? '');

      const assignment = await prisma.bookingStaff.findFirst({ where: { bookingId: id, staffId } });
      if (!assignment) {
        res.status(403).json({ error: { code: 'NOT_ASSIGNED', message: 'This job is not yours.' } });
        return;
      }
      const booking = await prisma.booking.findUniqueOrThrow({ where: { id } });
      const allowed = CREW_TRANSITIONS[booking.status] ?? [];
      if (!allowed.includes(to)) {
        res.status(409).json({
          error: {
            code: 'INVALID_TRANSITION',
            message: `Cannot go from ${booking.status} to ${to}.`,
          },
        });
        return;
      }
      await prisma.booking.update({ where: { id }, data: { status: to } });
      await prisma.bookingStatusHistory.create({
        data: { bookingId: id, status: to, actor: `STAFF:${staffId}` },
      });
      res.json({ status: to });
    }),
  );

  app.post(
    '/api/v1/crew/jobs/:id/issue',
    wrap(async (req, res) => {
      const principal = requirePermission(req, 'crew.ownJobs');
      const { type, note } = req.body as { type?: string; note?: string };
      const staffId = principal.staffId ?? 'unknown';
      await prisma.bookingStatusHistory.create({
        data: {
          bookingId: String(req.params.id),
          status: 'ISSUE_REPORTED',
          actor: `STAFF:${staffId}`,
          reason: type ?? 'OTHER',
          notes: note ?? null,
        },
      });
      res.json({ reported: true });
    }),
  );

  /* ---------------- auth ---------------- */

  app.post(
    '/api/v1/staff/login',
    wrap(async (req, res) => {
      const { email, password } = req.body as { email?: string; password?: string };
      if (!email || !password) {
        throw new AuthError('Enter your email and password.', 'VALIDATION_ERROR', 400);
      }
      const meta = { ip: req.ip ?? undefined, userAgent: req.header('user-agent') ?? undefined };
      const out = await auth.login(email, password, meta);

      // The password alone never sets a session cookie.
      if (out.status === 'TOTP_REQUIRED') {
        res.json({
          twoFactorRequired: true,
          challengeToken: out.challenge.challengeToken,
          displayName: out.challenge.displayName,
        });
        return;
      }

      setStaffCookie(res, out.token, out.expiresAt);
      res.json({
        user: {
          displayName: out.principal.displayName,
          role: out.principal.role,
          mustChangePassword: out.principal.mustChangePassword,
        },
        permissions: permissionsFor(out.principal.role),
      });
    }),
  );

  /** Second step. Only here is a real session issued. */
  app.post(
    '/api/v1/staff/login/totp',
    wrap(async (req, res) => {
      const { challengeToken, code } = req.body as { challengeToken?: string; code?: string };
      if (!challengeToken || !code) {
        throw new AuthError('Enter the code from your app.', 'VALIDATION_ERROR', 400);
      }
      const out = await auth.completeTwoFactor(challengeToken, code, {
        ip: req.ip ?? undefined,
        userAgent: req.header('user-agent') ?? undefined,
      });
      setStaffCookie(res, out.token, out.expiresAt);
      res.json({
        user: {
          displayName: out.principal.displayName,
          role: out.principal.role,
          mustChangePassword: out.principal.mustChangePassword,
        },
        permissions: permissionsFor(out.principal.role),
      });
    }),
  );

  /* ---------------- two-factor management ---------------- */

  app.post(
    '/api/v1/staff/totp/begin',
    wrap(async (req, res) => {
      const principal = requireStaff(req);
      res.json(await auth.beginTotpEnrolment(principal.userId));
    }),
  );

  app.post(
    '/api/v1/staff/totp/confirm',
    wrap(async (req, res) => {
      const principal = requireStaff(req);
      const code = String((req.body as { code?: string }).code ?? '');
      // Recovery codes are returned once and never again.
      res.json(await auth.confirmTotpEnrolment(principal.userId, code));
    }),
  );

  app.post(
    '/api/v1/staff/totp/disable',
    wrap(async (req, res) => {
      const principal = requireStaff(req);
      const password = String((req.body as { password?: string }).password ?? '');
      await auth.disableTotp(principal.userId, password);
      res.json({ ok: true });
    }),
  );

  app.post(
    '/api/v1/staff/totp/recovery-codes',
    wrap(async (req, res) => {
      const principal = requireStaff(req);
      const password = String((req.body as { password?: string }).password ?? '');
      res.json(await auth.regenerateRecoveryCodes(principal.userId, password));
    }),
  );

  app.post(
    '/api/v1/staff/logout',
    wrap(async (req, res) => {
      await auth.logout(req.staffToken);
      res.clearCookie(STAFF_COOKIE, { path: '/' });
      res.json({ ok: true });
    }),
  );

  app.get(
    '/api/v1/staff/me',
    wrap(async (req, res) => {
      const principal = requireStaff(req);
      const account = await prisma.staffUser.findUniqueOrThrow({
        where: { id: principal.userId },
        select: { totpEnabledAt: true, recoveryCodeHashes: true, role: true },
      });
      res.json({
        user: {
          displayName: principal.displayName,
          email: principal.email,
          role: principal.role,
          mustChangePassword: principal.mustChangePassword,
          staffId: principal.staffId,
          twoFactorEnabled: account.totpEnabledAt !== null,
          twoFactorRecommended: twoFactorRecommended(principal.role),
          recoveryCodesRemaining: account.recoveryCodeHashes.length,
        },
        permissions: permissionsFor(principal.role),
      });
    }),
  );

  app.post(
    '/api/v1/staff/password',
    wrap(async (req, res) => {
      const principal = requireStaff(req);
      const { currentPassword, newPassword } = req.body as {
        currentPassword?: string;
        newPassword?: string;
      };
      if (!currentPassword || !newPassword) {
        throw new AuthError('Enter your current and new password.', 'VALIDATION_ERROR', 400);
      }
      await auth.changePassword(principal.userId, currentPassword, newPassword, req.staffToken);
      res.json({ ok: true });
    }),
  );

  app.use((err: Error & { status?: number }, req: Request, res: Response, _n: NextFunction) => {
    if (err instanceof RosterError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    if (err instanceof AuthError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    if (process.env.NODE_ENV !== 'production') console.error('[ops]', req.path, err);
    res.status(err.status ?? 500).json({
      error: {
        code: err.status === 401 ? 'UNAUTHORIZED' : err.status === 403 ? 'FORBIDDEN' : 'INTERNAL_ERROR',
        message: err.status && err.status < 500 ? err.message : 'Something went wrong.',
      },
    });
  });

  return app;
}
