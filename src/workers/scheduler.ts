import type { PrismaClient } from '@prisma/client';

/**
 * The scheduler.
 *
 * Until now every worker existed as a command a person had to remember to
 * run. That is not a system — it is a checklist. This runs them.
 *
 * Two scheduling shapes:
 *
 *  - **interval**: every N seconds. For work whose timing only needs to be
 *    "soon enough" — notification retries, billing sweeps.
 *  - **dailyLocal**: at a wall-clock time in America/Toronto. For work a
 *    human expects at a particular hour, like the morning digest. Computed
 *    against local time so it does not drift an hour twice a year.
 */

export const TIMEZONE = 'America/Toronto';

export interface JobDefinition {
  name: string;
  /** Run every N seconds. */
  everySeconds?: number;
  /** Or run once a day at this local wall-clock time, "HH:MM". */
  dailyLocalAt?: string;
  run: () => Promise<Record<string, unknown> | void>;
  /** Alert when no successful run within this window. */
  expectedWithinSeconds?: number;
}

export interface JobRun {
  name: string;
  startedAt: Date;
  finishedAt: Date;
  status: 'SUCCESS' | 'FAILED';
  durationMs: number;
  detail?: Record<string, unknown>;
  error?: string;
}

const localParts = (at: Date) => {
  const p: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at)) {
    if (part.type !== 'literal') p[part.type] = part.value;
  }
  return {
    dateKey: `${p.year}-${p.month}-${p.day}`,
    minuteOfDay: Number(p.hour === '24' ? '0' : p.hour) * 60 + Number(p.minute),
  };
};

/**
 * Should a daily job run now?
 *
 * Compares local wall-clock minutes, and remembers the last local date it
 * ran, so it fires once per calendar day regardless of DST. On the spring
 * day the target minute exists later than usual; on the fall day it exists
 * twice — the date guard stops the second firing.
 */
export function dailyJobDue(
  dailyLocalAt: string,
  now: Date,
  lastRunDateKey: string | null,
): boolean {
  const [h, m] = dailyLocalAt.split(':').map(Number);
  const target = (h ?? 0) * 60 + (m ?? 0);
  const { dateKey, minuteOfDay } = localParts(now);
  if (lastRunDateKey === dateKey) return false;
  return minuteOfDay >= target;
}

export function localDateKey(at: Date): string {
  return localParts(at).dateKey;
}

/* ------------------------------------------------------------------ */

export class Scheduler {
  private readonly lastRunAt = new Map<string, number>();
  private readonly lastDailyDate = new Map<string, string>();
  private readonly running = new Set<string>();
  private readonly history: JobRun[] = [];
  private stopped = false;

  constructor(
    private readonly jobs: JobDefinition[],
    private readonly log: (line: Record<string, unknown>) => void = (l) =>
      console.log(JSON.stringify(l)),
    private readonly now: () => Date = () => new Date(),
    private readonly prisma?: PrismaClient,
  ) {}

  /** One pass. Exposed so tests can drive time without sleeping. */
  async tick(): Promise<JobRun[]> {
    const at = this.now();
    const ran: JobRun[] = [];

    for (const job of this.jobs) {
      if (this.stopped) break;
      // Overlap guard: a slow run must not be started again on the next tick.
      if (this.running.has(job.name)) {
        this.log({ level: 'warn', msg: 'job_still_running', job: job.name });
        continue;
      }

      let due = false;
      if (job.everySeconds) {
        const last = this.lastRunAt.get(job.name) ?? 0;
        due = at.getTime() - last >= job.everySeconds * 1000;
      } else if (job.dailyLocalAt) {
        due = dailyJobDue(job.dailyLocalAt, at, this.lastDailyDate.get(job.name) ?? null);
      }
      if (!due) continue;

      const run = await this.execute(job, at);
      ran.push(run);
    }
    return ran;
  }

  private async execute(job: JobDefinition, at: Date): Promise<JobRun> {
    this.running.add(job.name);
    const started = this.now();
    try {
      const detail = (await job.run()) ?? undefined;
      const finished = this.now();
      const run: JobRun = {
        name: job.name,
        startedAt: started,
        finishedAt: finished,
        status: 'SUCCESS',
        durationMs: finished.getTime() - started.getTime(),
        detail: detail as Record<string, unknown> | undefined,
      };
      this.record(job, at, run);
      return run;
    } catch (e) {
      const finished = this.now();
      const run: JobRun = {
        name: job.name,
        startedAt: started,
        finishedAt: finished,
        status: 'FAILED',
        durationMs: finished.getTime() - started.getTime(),
        error: String((e as Error).message ?? e),
      };
      this.record(job, at, run);
      return run;
    } finally {
      this.running.delete(job.name);
    }
  }

  private record(job: JobDefinition, at: Date, run: JobRun): void {
    // A failed run still counts as "attempted", so a persistently broken job
    // does not spin. Overdue detection uses successes only.
    this.lastRunAt.set(job.name, at.getTime());
    if (job.dailyLocalAt && run.status === 'SUCCESS') {
      this.lastDailyDate.set(job.name, localDateKey(at));
    }
    this.history.unshift(run);
    if (this.history.length > 200) this.history.pop();

    this.log({
      level: run.status === 'SUCCESS' ? 'info' : 'error',
      msg: 'job_run',
      job: run.name,
      status: run.status,
      durationMs: run.durationMs,
      ...(run.detail ?? {}),
      ...(run.error ? { error: run.error } : {}),
    });

    void this.persist(run);
  }

  /** Best-effort telemetry. Losing a row must never break the job. */
  private async persist(run: JobRun): Promise<void> {
    if (!this.prisma) return;
    try {
      await this.prisma.workerRun.create({
        data: {
          worker: run.name,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          status: run.status,
          durationMs: run.durationMs,
          detail: (run.detail ?? {}) as never,
          error: run.error ?? null,
        },
      });
    } catch {
      /* telemetry is not worth failing a job over */
    }
  }

  /** Jobs with no successful run inside their expected window. */
  overdue(): { name: string; lastSuccessAt: Date | null; expectedWithinSeconds: number }[] {
    const at = this.now().getTime();
    const out = [];
    for (const job of this.jobs) {
      if (!job.expectedWithinSeconds) continue;
      const lastSuccess = this.history.find((h) => h.name === job.name && h.status === 'SUCCESS');
      const age = lastSuccess ? at - lastSuccess.finishedAt.getTime() : Infinity;
      if (age > job.expectedWithinSeconds * 1000) {
        out.push({
          name: job.name,
          lastSuccessAt: lastSuccess?.finishedAt ?? null,
          expectedWithinSeconds: job.expectedWithinSeconds,
        });
      }
    }
    return out;
  }

  recentRuns(limit = 50): JobRun[] {
    return this.history.slice(0, limit);
  }

  stop(): void {
    this.stopped = true;
  }

  /** Run until stopped. SIGTERM lets the in-flight job finish. */
  async loop(tickSeconds = 30): Promise<void> {
    const shutdown = () => {
      this.log({ level: 'info', msg: 'scheduler_stopping' });
      this.stop();
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    this.log({
      level: 'info',
      msg: 'scheduler_started',
      jobs: this.jobs.map((j) => j.name),
      timezone: TIMEZONE,
    });

    while (!this.stopped) {
      try {
        await this.tick();
      } catch (e) {
        this.log({ level: 'error', msg: 'scheduler_tick_failed', error: String(e) });
      }
      await new Promise((r) => setTimeout(r, tickSeconds * 1000));
    }
    this.log({ level: 'info', msg: 'scheduler_stopped' });
  }
}
