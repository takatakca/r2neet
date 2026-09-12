import { describe, it, expect } from 'vitest';
import { Scheduler, dailyJobDue, localDateKey, type JobDefinition } from '../src/workers/scheduler.js';

/** A specific UTC instant, so tests do not depend on when they run. */
const at = (iso: string) => new Date(iso);

describe('daily local-time scheduling', () => {
  it('does not fire before the target local time', () => {
    // 06:00 EDT
    expect(dailyJobDue('07:00', at('2026-07-15T10:00:00Z'), null)).toBe(false);
  });

  it('fires once the local time is reached', () => {
    // 07:00 EDT
    expect(dailyJobDue('07:00', at('2026-07-15T11:00:00Z'), null)).toBe(true);
  });

  it('fires only once per local calendar day', () => {
    const now = at('2026-07-15T12:00:00Z');
    const today = localDateKey(now);
    expect(dailyJobDue('07:00', now, null)).toBe(true);
    expect(dailyJobDue('07:00', now, today)).toBe(false);
  });

  it('fires again the next local day', () => {
    const yesterday = localDateKey(at('2026-07-14T12:00:00Z'));
    expect(dailyJobDue('07:00', at('2026-07-15T12:00:00Z'), yesterday)).toBe(true);
  });

  /**
   * DST is where naive UTC scheduling breaks: a job pinned to 11:00 UTC
   * happens at 07:00 in summer and 06:00 in winter.
   */
  it('[INV-TIME-03] holds the same LOCAL hour across the fall-back', () => {
    // 1 Nov 2026: clocks go back. 12:00 UTC is 08:00 EDT before, 07:00 EST after.
    const beforeFall = at('2026-10-30T11:30:00Z'); // 07:30 EDT
    const afterFall = at('2026-11-05T12:30:00Z'); // 07:30 EST

    // A 07:00 local job is due on both days, because both are past 07:00 local.
    expect(dailyJobDue('07:00', beforeFall, null)).toBe(true);
    expect(dailyJobDue('07:00', afterFall, null)).toBe(true);

    // And not yet due before 07:00 local on either side.
    expect(dailyJobDue('07:00', at('2026-10-30T10:30:00Z'), null)).toBe(false); // 06:30 EDT
    expect(dailyJobDue('07:00', at('2026-11-05T11:30:00Z'), null)).toBe(false); // 06:30 EST
  });

  it('holds the same LOCAL hour across the spring-forward', () => {
    const beforeSpring = at('2026-03-05T12:30:00Z'); // 07:30 EST
    const afterSpring = at('2026-03-12T11:30:00Z'); // 07:30 EDT
    expect(dailyJobDue('07:00', beforeSpring, null)).toBe(true);
    expect(dailyJobDue('07:00', afterSpring, null)).toBe(true);
    expect(dailyJobDue('07:00', at('2026-03-05T11:30:00Z'), null)).toBe(false); // 06:30 EST
    expect(dailyJobDue('07:00', at('2026-03-12T10:30:00Z'), null)).toBe(false); // 06:30 EDT
  });

  it('a UTC-pinned job would have drifted an hour', () => {
    // Demonstrates why this is computed in local time. 11:00 UTC is 07:00 in
    // summer but 06:00 in winter — an hour earlier than the owner expects.
    const summer = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Toronto',
      hour: '2-digit',
      hour12: false,
    }).format(at('2026-07-15T11:00:00Z'));
    const winter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Toronto',
      hour: '2-digit',
      hour12: false,
    }).format(at('2026-12-15T11:00:00Z'));
    expect(summer).not.toBe(winter);
  });
});

describe('scheduler', () => {
  function fixedClock(start: string) {
    let now = new Date(start).getTime();
    return {
      now: () => new Date(now),
      advance: (seconds: number) => {
        now += seconds * 1000;
      },
    };
  }

  it('runs an interval job on schedule and not before', async () => {
    const clock = fixedClock('2026-07-15T12:00:00Z');
    let runs = 0;
    const job: JobDefinition = { name: 'j', everySeconds: 60, run: async () => void runs++ };
    const s = new Scheduler([job], () => undefined, clock.now);

    await s.tick();
    expect(runs).toBe(1);

    await s.tick(); // immediately again
    expect(runs).toBe(1);

    clock.advance(61);
    await s.tick();
    expect(runs).toBe(2);
  });

  it('does not start a job that is still running', async () => {
    const clock = fixedClock('2026-07-15T12:00:00Z');
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const s = new Scheduler(
      [
        {
          name: 'slow',
          everySeconds: 1,
          run: async () => {
            started++;
            await gate;
          },
        },
      ],
      () => undefined,
      clock.now,
    );

    // Start a run and leave it hanging on the gate.
    const first = s.tick();
    await Promise.resolve();

    clock.advance(10);
    await s.tick(); // must be refused while the first is in flight
    expect(started).toBe(1);

    release();
    await first;

    clock.advance(10);
    await s.tick();
    expect(started).toBe(2);
  });

  it('a failing job does not stop the others', async () => {
    const clock = fixedClock('2026-07-15T12:00:00Z');
    let good = 0;
    const s = new Scheduler(
      [
        { name: 'bad', everySeconds: 1, run: async () => { throw new Error('boom'); } },
        { name: 'good', everySeconds: 1, run: async () => void good++ },
      ],
      () => undefined,
      clock.now,
    );
    const runs = await s.tick();
    expect(good).toBe(1);
    expect(runs.find((r) => r.name === 'bad')!.status).toBe('FAILED');
    expect(runs.find((r) => r.name === 'good')!.status).toBe('SUCCESS');
  });

  it('a failing job backs off instead of spinning', async () => {
    const clock = fixedClock('2026-07-15T12:00:00Z');
    let attempts = 0;
    const s = new Scheduler(
      [{ name: 'bad', everySeconds: 60, run: async () => { attempts++; throw new Error('boom'); } }],
      () => undefined,
      clock.now,
    );
    await s.tick();
    await s.tick();
    await s.tick();
    // Failure still counts as an attempt, so it waits its interval.
    expect(attempts).toBe(1);
  });

  it('records failure detail without losing the error', async () => {
    const clock = fixedClock('2026-07-15T12:00:00Z');
    const s = new Scheduler(
      [{ name: 'bad', everySeconds: 1, run: async () => { throw new Error('database gone'); } }],
      () => undefined,
      clock.now,
    );
    await s.tick();
    expect(s.recentRuns()[0]!.error).toContain('database gone');
  });

  it('reports a job as overdue when it has not succeeded in time', async () => {
    const clock = fixedClock('2026-07-15T12:00:00Z');
    const s = new Scheduler(
      [{ name: 'billing', everySeconds: 300, expectedWithinSeconds: 1800, run: async () => undefined }],
      () => undefined,
      clock.now,
    );

    // Never run: overdue from the start, which is the point — a worker that
    // never starts must not look healthy.
    expect(s.overdue().map((o) => o.name)).toContain('billing');

    await s.tick();
    expect(s.overdue()).toHaveLength(0);

    clock.advance(2000);
    expect(s.overdue().map((o) => o.name)).toContain('billing');
  });

  it('a failing job counts as overdue, not healthy', async () => {
    const clock = fixedClock('2026-07-15T12:00:00Z');
    const s = new Scheduler(
      [
        {
          name: 'billing',
          everySeconds: 60,
          expectedWithinSeconds: 600,
          run: async () => { throw new Error('stripe down'); },
        },
      ],
      () => undefined,
      clock.now,
    );
    await s.tick();
    // Overdue tracks SUCCESSES; an attempt that always fails is not health.
    expect(s.overdue().map((o) => o.name)).toContain('billing');
  });

  it('a daily job runs once even when ticked all day', async () => {
    const clock = fixedClock('2026-07-15T11:30:00Z'); // 07:30 EDT
    let runs = 0;
    const s = new Scheduler(
      [{ name: 'digest', dailyLocalAt: '07:00', run: async () => void runs++ }],
      () => undefined,
      clock.now,
    );
    for (let i = 0; i < 20; i++) {
      await s.tick();
      clock.advance(600);
    }
    expect(runs).toBe(1);
  });

  it('keeps a bounded history', async () => {
    const clock = fixedClock('2026-07-15T12:00:00Z');
    const s = new Scheduler(
      [{ name: 'j', everySeconds: 1, run: async () => undefined }],
      () => undefined,
      clock.now,
    );
    for (let i = 0; i < 250; i++) {
      await s.tick();
      clock.advance(2);
    }
    expect(s.recentRuns(500).length).toBeLessThanOrEqual(200);
  });

  it('stops cleanly', async () => {
    const clock = fixedClock('2026-07-15T12:00:00Z');
    let runs = 0;
    const s = new Scheduler(
      [{ name: 'j', everySeconds: 1, run: async () => void runs++ }],
      () => undefined,
      clock.now,
    );
    s.stop();
    await s.tick();
    expect(runs).toBe(0);
  });
});
