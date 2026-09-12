import { createHmac } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

/**
 * Worker health and operational alerting.
 *
 * "Never succeeded" and "overdue" both block a clean launch, but they tell an
 * operator two very different stories:
 *
 *   NEVER_SUCCEEDED — we have never proven this automation works *here*.
 *                     Usually a fresh deploy, a missing credential, or a
 *                     process that silently isn't starting.
 *   OVERDUE         — it worked before and has now stopped. Something broke.
 *
 * Collapsing them into one status sends people looking in the wrong place.
 */

export type WorkerStatus =
  | 'HEALTHY'
  | 'NEVER_SUCCEEDED'
  | 'OVERDUE'
  | 'FAILING'
  | 'NOT_CONFIGURED'
  | 'DISABLED';

export interface WorkerExpectation {
  name: string;
  label: string;
  /** No success within this window means overdue. */
  expectedWithinSeconds: number;
  /** Critical workers block cutover until they have succeeded once. */
  critical: boolean;
  /** Set when a required credential is absent; suppresses false alarms. */
  configured?: boolean;
}

export interface WorkerHealth {
  name: string;
  label: string;
  status: WorkerStatus;
  critical: boolean;
  lastSuccessAt: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  /** Human sentence an operator can act on without opening logs. */
  summary: string;
}

/**
 * Grace after boot before a never-succeeded worker is worth paging about.
 *
 * The status is visible immediately either way — the grace only suppresses
 * the alert, never the truth on screen.
 */
export const DEFAULT_STARTUP_GRACE_MINUTES = 15;

export class WorkerHealthService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly expectations: WorkerExpectation[],
    private readonly now: () => Date = () => new Date(),
    private readonly processStartedAt: Date = new Date(),
  ) {}

  private inStartupGrace(): boolean {
    const minutes = Number(process.env.WORKER_STARTUP_GRACE_MINUTES ?? DEFAULT_STARTUP_GRACE_MINUTES);
    return this.now().getTime() - this.processStartedAt.getTime() < minutes * 60_000;
  }

  async health(): Promise<WorkerHealth[]> {
    const at = this.now();
    const out: WorkerHealth[] = [];

    for (const expectation of this.expectations) {
      const [lastSuccess, lastRun] = await Promise.all([
        this.prisma.workerRun.findFirst({
          where: { worker: expectation.name, status: 'SUCCESS' },
          orderBy: { finishedAt: 'desc' },
        }),
        this.prisma.workerRun.findFirst({
          where: { worker: expectation.name },
          orderBy: { finishedAt: 'desc' },
        }),
      ]);

      // Consecutive failures since the last success, for "FAILING".
      const since = lastSuccess?.finishedAt ?? new Date(0);
      const consecutiveFailures = await this.prisma.workerRun.count({
        where: { worker: expectation.name, status: 'FAILED', finishedAt: { gt: since } },
      });

      let status: WorkerStatus;
      let summary: string;

      if (expectation.configured === false) {
        status = 'NOT_CONFIGURED';
        summary = 'Waiting on configuration. This work is not running.';
      } else if (!lastSuccess) {
        // The distinction that matters: never proven here.
        status = 'NEVER_SUCCEEDED';
        summary = lastRun
          ? `Has never completed successfully. ${consecutiveFailures} failed attempt${consecutiveFailures === 1 ? '' : 's'} so far.`
          : 'Has never run. Check that the process is started.';
      } else {
        const ageSeconds = (at.getTime() - lastSuccess.finishedAt.getTime()) / 1000;
        if (ageSeconds > expectation.expectedWithinSeconds) {
          status = consecutiveFailures > 0 ? 'FAILING' : 'OVERDUE';
          summary =
            consecutiveFailures > 0
              ? `Worked before, now failing. ${consecutiveFailures} failure${consecutiveFailures === 1 ? '' : 's'} since the last success.`
              : `Worked before, but has not run since ${lastSuccess.finishedAt.toISOString()}.`;
        } else {
          status = 'HEALTHY';
          summary = `Last succeeded ${Math.round(ageSeconds)}s ago.`;
        }
      }

      out.push({
        name: expectation.name,
        label: expectation.label,
        status,
        critical: expectation.critical,
        lastSuccessAt: lastSuccess?.finishedAt.toISOString() ?? null,
        lastRunAt: lastRun?.finishedAt.toISOString() ?? null,
        lastError: lastRun?.error ?? null,
        consecutiveFailures,
        summary,
      });
    }
    return out;
  }

  /**
   * Cutover readiness.
   *
   * A critical worker must have succeeded **at least once in this
   * environment**. Source code existing is not evidence.
   */
  async cutoverBlockers(): Promise<WorkerHealth[]> {
    return (await this.health()).filter(
      (w) => w.critical && w.status !== 'HEALTHY' && w.status !== 'NOT_CONFIGURED',
    );
  }

  /** Which problems are worth waking someone for right now. */
  async alertable(): Promise<WorkerHealth[]> {
    const health = await this.health();
    const grace = this.inStartupGrace();
    return health.filter((w) => {
      if (!w.critical || w.status === 'HEALTHY' || w.status === 'NOT_CONFIGURED') return false;
      // A fresh deploy should not page anyone; the screen still shows it.
      if (w.status === 'NEVER_SUCCEEDED' && grace) return false;
      return true;
    });
  }
}

/* ------------------------------------------------------------------ */
/* alerting                                                            */
/* ------------------------------------------------------------------ */

export type AlertSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM';

export interface AlertPayload {
  key: string;
  severity: AlertSeverity;
  category: string;
  title: string;
  message: string;
  environment: string;
  occurredAt: string;
  /** Safe reference only — never customer contact details. */
  resource?: string;
}

export interface AlertSink {
  readonly name: string;
  readonly configured: boolean;
  send(alert: AlertPayload): Promise<void>;
}

/**
 * Generic signed webhook.
 *
 * Vendor-neutral on purpose: the owner has not chosen a destination, and the
 * software should not force that decision. Anything that accepts an HTTP POST
 * works — a chat integration, a monitoring service, a small relay.
 */
export class WebhookAlertSink implements AlertSink {
  readonly name = 'webhook';
  private readonly url?: string;
  private readonly secret?: string;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.url = env.ALERT_WEBHOOK_URL;
    this.secret = env.ALERT_WEBHOOK_SECRET;
  }

  get configured(): boolean {
    return Boolean(this.url);
  }

  async send(alert: AlertPayload): Promise<void> {
    if (!this.url) throw new Error('ALERT_WEBHOOK_URL is not set.');
    const body = JSON.stringify(alert);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    // Lets the receiver verify this really came from us.
    if (this.secret) {
      headers['X-R2NETTE-Signature'] =
        'sha256=' + createHmac('sha256', this.secret).update(body).digest('hex');
    }

    const res = await fetch(this.url, { method: 'POST', headers, body });
    if (!res.ok) throw new Error(`Alert webhook returned ${res.status}`);
  }
}

export class FakeAlertSink implements AlertSink {
  readonly name = 'fake';
  readonly configured = true;
  sent: AlertPayload[] = [];
  failNext = false;

  async send(alert: AlertPayload): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('SINK_DOWN');
    }
    this.sent.push(alert);
  }
}

/**
 * Alert dispatch with deduplication.
 *
 * A worker overdue for 45 minutes with a one-minute check loop must produce
 * ONE alert, not 45. The open incident is updated instead.
 */
export class AlertService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly sink: AlertSink | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async raise(input: {
    key: string;
    severity: AlertSeverity;
    category: string;
    title: string;
    message: string;
    resource?: string;
  }): Promise<{ opened: boolean; delivered: boolean }> {
    const at = this.now();
    const existing = await this.prisma.operationalAlert.findUnique({ where: { key: input.key } });

    if (existing && existing.status === 'OPEN') {
      // Same condition, still true. Note it and stay quiet.
      await this.prisma.operationalAlert.update({
        where: { id: existing.id },
        data: { lastObservedAt: at, observations: { increment: 1 }, message: input.message },
      });
      return { opened: false, delivered: false };
    }

    // New, or reopening after a resolution — which is genuinely new news.
    const alert = existing
      ? await this.prisma.operationalAlert.update({
          where: { id: existing.id },
          data: {
            status: 'OPEN',
            severity: input.severity,
            title: input.title,
            message: input.message,
            openedAt: at,
            lastObservedAt: at,
            resolvedAt: null,
            observations: 1,
            deliveryStatus: 'PENDING',
          },
        })
      : await this.prisma.operationalAlert.create({
          data: {
            key: input.key,
            severity: input.severity,
            category: input.category,
            title: input.title,
            message: input.message,
            resource: input.resource ?? null,
            status: 'OPEN',
            openedAt: at,
            lastObservedAt: at,
            deliveryStatus: 'PENDING',
          },
        });

    const delivered = await this.deliver(alert.id, {
      key: input.key,
      severity: input.severity,
      category: input.category,
      title: input.title,
      message: input.message,
      environment: process.env.NODE_ENV ?? 'development',
      occurredAt: at.toISOString(),
      resource: input.resource,
    });

    return { opened: true, delivered };
  }

  private async deliver(alertId: string, payload: AlertPayload): Promise<boolean> {
    if (!this.sink?.configured) {
      // Recorded and visible in admin, never reported as delivered.
      await this.prisma.operationalAlert.update({
        where: { id: alertId },
        data: { deliveryStatus: 'NOT_CONFIGURED' },
      });
      return false;
    }
    try {
      await this.sink.send(payload);
      await this.prisma.operationalAlert.update({
        where: { id: alertId },
        data: { deliveryStatus: 'DELIVERED', deliveredAt: this.now() },
      });
      return true;
    } catch (e) {
      // The alert itself survives a failed send. We never raise an alert
      // about failing to send an alert — that is how paging storms start.
      await this.prisma.operationalAlert.update({
        where: { id: alertId },
        data: { deliveryStatus: 'FAILED', deliveryError: String((e as Error).message) },
      });
      return false;
    }
  }

  /** The condition cleared. Close it so the next occurrence is news again. */
  async resolve(key: string): Promise<boolean> {
    const existing = await this.prisma.operationalAlert.findUnique({ where: { key } });
    if (!existing || existing.status !== 'OPEN') return false;
    await this.prisma.operationalAlert.update({
      where: { id: existing.id },
      data: { status: 'RESOLVED', resolvedAt: this.now() },
    });
    return true;
  }

  async open() {
    return this.prisma.operationalAlert.findMany({
      where: { status: 'OPEN' },
      orderBy: [{ severity: 'asc' }, { openedAt: 'desc' }],
    });
  }

  /**
   * Turn worker health into alerts, and clear the ones that recovered.
   */
  async reconcileWorkers(health: WorkerHealth[], alertable: WorkerHealth[]): Promise<void> {
    const alertableNames = new Set(alertable.map((w) => w.name));

    for (const w of health) {
      const key = `worker:${w.name}`;
      if (alertableNames.has(w.name)) {
        await this.raise({
          key,
          severity: w.status === 'NEVER_SUCCEEDED' ? 'HIGH' : 'CRITICAL',
          category: 'WORKER',
          title:
            w.status === 'NEVER_SUCCEEDED'
              ? `${w.label} has never run successfully`
              : `${w.label} has stopped running`,
          message: w.summary,
          resource: w.name,
        });
      } else if (w.status === 'HEALTHY') {
        await this.resolve(key);
      }
    }
  }
}
