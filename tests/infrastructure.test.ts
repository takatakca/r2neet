import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  WorkerHealthService,
  AlertService,
  FakeAlertSink,
  WebhookAlertSink,
  type WorkerExpectation,
} from '../src/workers/health.js';
import { signRequest, loadS3Config, S3Storage } from '../src/workers/object-storage.js';
import { assertDestructiveAllowed } from '../src/db/safety.js';

const URL_ = process.env.TEST_DATABASE_URL;
const d = URL_ ? describe : describe.skip;

describe('S3 configuration', () => {
  it('is unconfigured without credentials', () => {
    expect(loadS3Config({})).toBeNull();
    expect(loadS3Config({ BACKUP_S3_BUCKET: 'b' })).toBeNull();
  });

  it('works with any S3-compatible provider, not just AWS', () => {
    const r2 = loadS3Config({
      BACKUP_S3_BUCKET: 'backups',
      BACKUP_S3_ACCESS_KEY_ID: 'k',
      BACKUP_S3_SECRET_ACCESS_KEY: 's',
      BACKUP_S3_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
    })!;
    expect(r2.endpoint).toContain('r2.cloudflarestorage.com');

    const minio = loadS3Config({
      BACKUP_S3_BUCKET: 'backups',
      BACKUP_S3_ACCESS_KEY_ID: 'k',
      BACKUP_S3_SECRET_ACCESS_KEY: 's',
      BACKUP_S3_ENDPOINT: 'http://minio:9000',
      BACKUP_S3_FORCE_PATH_STYLE: 'true',
    })!;
    expect(minio.forcePathStyle).toBe(true);
  });
});

describe('SigV4 signing', () => {
  const config = {
    bucket: 'r2nette-backups',
    region: 'us-east-1',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  };

  it('produces a complete authorization header', () => {
    const at = new Date('2026-08-30T12:00:00Z');
    const signed = signRequest(config, 'PUT', 'backups/test.dump', Buffer.from('data'), at);
    expect(signed.headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=/);
    expect(signed.headers.Authorization).toMatch(/SignedHeaders=/);
    expect(signed.headers.Authorization).toMatch(/Signature=[a-f0-9]{64}/);
    expect(signed.headers['x-amz-date']).toBe('20260830T120000Z');
  });

  it('never puts the secret key in the request', () => {
    const signed = signRequest(config, 'PUT', 'k', Buffer.from('d'));
    const dump = JSON.stringify(signed);
    expect(dump).not.toContain(config.secretAccessKey);
    // The access key id is public by design; the secret is not.
    expect(dump).toContain(config.accessKeyId);
  });

  it('signs the payload, so a modified body fails verification', () => {
    const at = new Date('2026-08-30T12:00:00Z');
    const a = signRequest(config, 'PUT', 'k', Buffer.from('one'), at);
    const b = signRequest(config, 'PUT', 'k', Buffer.from('two'), at);
    expect(a.headers['x-amz-content-sha256']).not.toBe(b.headers['x-amz-content-sha256']);
    expect(a.headers.Authorization).not.toBe(b.headers.Authorization);
  });

  it('uses path-style addressing for custom endpoints', () => {
    const minio = { ...config, endpoint: 'http://minio:9000', forcePathStyle: true };
    const signed = signRequest(minio, 'PUT', 'a/b.dump', Buffer.from('d'));
    expect(signed.url).toBe('http://minio:9000/r2nette-backups/a/b.dump');
  });

  it('uses virtual-hosted addressing for AWS', () => {
    const signed = signRequest(config, 'GET', 'a/b.dump', null);
    expect(signed.url).toContain('r2nette-backups.s3.us-east-1.amazonaws.com');
  });
});

describe('backup object keys', () => {
  const storage = new S3Storage({
    bucket: 'b',
    region: 'us-east-1',
    accessKeyId: 'k',
    secretAccessKey: 's',
    prefix: 'r2nette',
  });

  it('organises by environment and date', () => {
    const key = storage.objectKey('production', 'r2nette-20260830.dump', new Date('2026-08-30T07:00:00Z'));
    expect(key).toBe('r2nette/production/database/2026/08/30/r2nette-20260830.dump');
  });

  it('keeps staging and production apart', () => {
    const at = new Date('2026-08-30T07:00:00Z');
    expect(storage.objectKey('staging', 'x.dump', at)).toContain('/staging/');
    expect(storage.objectKey('production', 'x.dump', at)).toContain('/production/');
  });
});

describe('webhook alert sink', () => {
  it('is unconfigured without a URL', () => {
    expect(new WebhookAlertSink({}).configured).toBe(false);
    expect(new WebhookAlertSink({ ALERT_WEBHOOK_URL: 'https://x' }).configured).toBe(true);
  });
});

d('worker health', () => {
  let prisma: PrismaClient;

  const EXPECTATIONS: WorkerExpectation[] = [
    { name: 'billing', label: 'Billing', expectedWithinSeconds: 1800, critical: true },
    { name: 'recurrence', label: 'Recurrence', expectedWithinSeconds: 14400, critical: true },
    { name: 'digest', label: 'Digest', expectedWithinSeconds: 172800, critical: false },
  ];

  beforeAll(async () => {
    assertDestructiveAllowed(process.env);
    prisma = new PrismaClient({ datasources: { db: { url: URL_ } } });
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.workerRun.deleteMany();
    await prisma.operationalAlert.deleteMany();
  });

  const at = (iso: string) => new Date(iso);
  const NOW = at('2026-08-30T12:00:00Z');

  async function record(worker: string, status: 'SUCCESS' | 'FAILED', finishedAt: Date, error?: string) {
    await prisma.workerRun.create({
      data: {
        worker,
        startedAt: new Date(finishedAt.getTime() - 1000),
        finishedAt,
        status,
        durationMs: 1000,
        error: error ?? null,
      },
    });
  }

  it('NEVER_SUCCEEDED when a worker has never run at all', async () => {
    const svc = new WorkerHealthService(prisma, EXPECTATIONS, () => NOW);
    const health = await svc.health();
    const billing = health.find((w) => w.name === 'billing')!;

    expect(billing.status).toBe('NEVER_SUCCEEDED');
    // The distinction matters: this points at the process, not at a fault.
    expect(billing.summary).toMatch(/never run/i);
    expect(billing.lastSuccessAt).toBeNull();
  });

  it('NEVER_SUCCEEDED, with attempt count, when it has only ever failed', async () => {
    await record('billing', 'FAILED', at('2026-08-30T11:50:00Z'), 'stripe down');
    await record('billing', 'FAILED', at('2026-08-30T11:55:00Z'), 'stripe down');

    const svc = new WorkerHealthService(prisma, EXPECTATIONS, () => NOW);
    const billing = (await svc.health()).find((w) => w.name === 'billing')!;

    expect(billing.status).toBe('NEVER_SUCCEEDED');
    expect(billing.consecutiveFailures).toBe(2);
    expect(billing.summary).toMatch(/never completed successfully/i);
    expect(billing.lastError).toBe('stripe down');
  });

  it('HEALTHY after a recent success', async () => {
    await record('billing', 'SUCCESS', at('2026-08-30T11:55:00Z'));
    const svc = new WorkerHealthService(prisma, EXPECTATIONS, () => NOW);
    expect((await svc.health()).find((w) => w.name === 'billing')!.status).toBe('HEALTHY');
  });

  it('OVERDUE when it worked before and then stopped', async () => {
    // Succeeded two hours ago; expected every 30 minutes.
    await record('billing', 'SUCCESS', at('2026-08-30T10:00:00Z'));
    const svc = new WorkerHealthService(prisma, EXPECTATIONS, () => NOW);
    const billing = (await svc.health()).find((w) => w.name === 'billing')!;

    expect(billing.status).toBe('OVERDUE');
    // A different story from NEVER_SUCCEEDED: something broke.
    expect(billing.summary).toMatch(/worked before/i);
    expect(billing.lastSuccessAt).not.toBeNull();
  });

  it('FAILING when it worked before and is now erroring', async () => {
    await record('billing', 'SUCCESS', at('2026-08-30T10:00:00Z'));
    await record('billing', 'FAILED', at('2026-08-30T11:00:00Z'), 'timeout');
    await record('billing', 'FAILED', at('2026-08-30T11:30:00Z'), 'timeout');

    const svc = new WorkerHealthService(prisma, EXPECTATIONS, () => NOW);
    const billing = (await svc.health()).find((w) => w.name === 'billing')!;
    expect(billing.status).toBe('FAILING');
    expect(billing.consecutiveFailures).toBe(2);
  });

  it('NOT_CONFIGURED suppresses false alarms for absent credentials', async () => {
    const svc = new WorkerHealthService(
      prisma,
      [{ name: 'billing', label: 'Billing', expectedWithinSeconds: 1800, critical: true, configured: false }],
      () => NOW,
    );
    const billing = (await svc.health())[0]!;
    expect(billing.status).toBe('NOT_CONFIGURED');
    expect(await svc.cutoverBlockers()).toHaveLength(0);
  });

  it('blocks cutover until every critical worker has succeeded once', async () => {
    const svc = new WorkerHealthService(prisma, EXPECTATIONS, () => NOW);
    let blockers = await svc.cutoverBlockers();
    expect(blockers.map((b) => b.name).sort()).toEqual(['billing', 'recurrence']);

    await record('billing', 'SUCCESS', at('2026-08-30T11:55:00Z'));
    await record('recurrence', 'SUCCESS', at('2026-08-30T11:00:00Z'));
    blockers = await svc.cutoverBlockers();
    expect(blockers).toHaveLength(0);
  });

  it('a non-critical worker never blocks cutover', async () => {
    const svc = new WorkerHealthService(prisma, EXPECTATIONS, () => NOW);
    const blockers = await svc.cutoverBlockers();
    expect(blockers.map((b) => b.name)).not.toContain('digest');
  });

  it('startup grace suppresses the PAGE but never hides the STATUS', async () => {
    process.env.WORKER_STARTUP_GRACE_MINUTES = '15';
    const justStarted = new WorkerHealthService(prisma, EXPECTATIONS, () => NOW, NOW);

    // Visible on screen immediately...
    const health = await justStarted.health();
    expect(health.find((w) => w.name === 'billing')!.status).toBe('NEVER_SUCCEEDED');
    // ...but nobody is paged seconds after a deploy.
    expect(await justStarted.alertable()).toHaveLength(0);
    // And it still blocks the launch.
    expect(await justStarted.cutoverBlockers()).not.toHaveLength(0);

    const longRunning = new WorkerHealthService(
      prisma,
      EXPECTATIONS,
      () => NOW,
      at('2026-08-30T10:00:00Z'),
    );
    expect((await longRunning.alertable()).map((w) => w.name)).toContain('billing');
    delete process.env.WORKER_STARTUP_GRACE_MINUTES;
  });
});

d('operational alerts', () => {
  let prisma: PrismaClient;
  let sink: FakeAlertSink;
  let alerts: AlertService;

  beforeAll(async () => {
    assertDestructiveAllowed(process.env);
    prisma = new PrismaClient({ datasources: { db: { url: URL_ } } });
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.operationalAlert.deleteMany();
    sink = new FakeAlertSink();
    alerts = new AlertService(prisma, sink);
  });

  const problem = {
    key: 'worker:billing',
    severity: 'CRITICAL' as const,
    category: 'WORKER',
    title: 'Billing has stopped running',
    message: 'No successful run in 2 hours.',
  };

  it('opens an alert and delivers it once', async () => {
    const res = await alerts.raise(problem);
    expect(res.opened).toBe(true);
    expect(res.delivered).toBe(true);
    expect(sink.sent).toHaveLength(1);
  });

  it('DEDUPES: 45 checks of the same condition send one alert', async () => {
    for (let i = 0; i < 45; i++) await alerts.raise(problem);

    expect(sink.sent).toHaveLength(1);
    const rows = await prisma.operationalAlert.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.observations).toBe(45);
  });

  it('resolves when the condition clears', async () => {
    await alerts.raise(problem);
    expect(await alerts.resolve(problem.key)).toBe(true);
    const row = await prisma.operationalAlert.findUniqueOrThrow({ where: { key: problem.key } });
    expect(row.status).toBe('RESOLVED');
    expect(row.resolvedAt).not.toBeNull();
  });

  it('reopening after a resolution is news again', async () => {
    await alerts.raise(problem);
    await alerts.resolve(problem.key);
    const second = await alerts.raise(problem);

    expect(second.opened).toBe(true);
    expect(sink.sent).toHaveLength(2);
    const row = await prisma.operationalAlert.findUniqueOrThrow({ where: { key: problem.key } });
    expect(row.observations).toBe(1); // counter restarts for the new incident
  });

  it('records the alert even with no destination configured', async () => {
    const unconfigured = new AlertService(prisma, null);
    const res = await unconfigured.raise(problem);

    expect(res.opened).toBe(true);
    expect(res.delivered).toBe(false);
    const row = await prisma.operationalAlert.findUniqueOrThrow({ where: { key: problem.key } });
    expect(row.status).toBe('OPEN'); // still visible in admin
    expect(row.deliveryStatus).toBe('NOT_CONFIGURED');
  });

  it('keeps the alert when the sink itself fails', async () => {
    sink.failNext = true;
    const res = await alerts.raise(problem);

    expect(res.opened).toBe(true);
    expect(res.delivered).toBe(false);
    const row = await prisma.operationalAlert.findUniqueOrThrow({ where: { key: problem.key } });
    // The underlying problem is not lost because the notifier broke.
    expect(row.status).toBe('OPEN');
    expect(row.deliveryStatus).toBe('FAILED');
    expect(row.deliveryError).toContain('SINK_DOWN');
  });

  it('never carries customer contact details', async () => {
    await alerts.raise({ ...problem, resource: 'billing' });
    const payload = JSON.stringify(sink.sent[0]);
    expect(payload).not.toMatch(/@/);
    expect(payload).not.toMatch(/\+?1?\d{10}/);
  });

  it('turns worker health into alerts and clears recovered ones', async () => {
    const failing = [
      {
        name: 'billing',
        label: 'Billing',
        status: 'OVERDUE' as const,
        critical: true,
        lastSuccessAt: null,
        lastRunAt: null,
        lastError: null,
        consecutiveFailures: 0,
        summary: 'stopped',
      },
    ];
    await alerts.reconcileWorkers(failing, failing);
    expect((await alerts.open())).toHaveLength(1);

    const recovered = [{ ...failing[0]!, status: 'HEALTHY' as const, summary: 'fine' }];
    await alerts.reconcileWorkers(recovered, []);
    expect(await alerts.open()).toHaveLength(0);
  });

  it('distinguishes never-succeeded from stopped in the alert title', async () => {
    const never = [
      {
        name: 'billing',
        label: 'Billing',
        status: 'NEVER_SUCCEEDED' as const,
        critical: true,
        lastSuccessAt: null,
        lastRunAt: null,
        lastError: null,
        consecutiveFailures: 0,
        summary: 'never ran',
      },
    ];
    await alerts.reconcileWorkers(never, never);
    const row = (await alerts.open())[0]!;
    expect(row.title).toMatch(/never run successfully/i);
    expect(row.severity).toBe('HIGH'); // not CRITICAL: likely a fresh deploy
  });
});

describe('off-host upload verification', () => {
  /**
   * A gateway can accept a PUT, return 200, and store nothing — quota
   * errors, misconfigured buckets and proxies all do this. Trusting the
   * status code would silently lose every backup.
   */
  function lyingStorage(behaviour: 'discards' | 'truncates' | 'stores') {
    const stored = new Map<string, number>();
    const s3 = new S3Storage({
      bucket: 'b',
      region: 'us-east-1',
      accessKeyId: 'k',
      secretAccessKey: 's',
      endpoint: 'http://storage.invalid',
      forcePathStyle: true,
    });
    // Replace the network calls; the verification logic is what is under test.
    (s3 as unknown as { putFile: unknown }).putFile = async (key: string, _path: string) => {
      if (behaviour === 'stores') stored.set(key, 4096);
      if (behaviour === 'truncates') stored.set(key, 12);
      return { key, size: 4096, sha256: 'abc' };
    };
    (s3 as unknown as { head: unknown }).head = async (key: string) =>
      stored.has(key) ? { key, size: stored.get(key)! } : null;
    return s3;
  }

  it('accepts an upload that really landed at the right size', async () => {
    const res = await lyingStorage('stores').putAndVerify('backups/ok.dump', '/tmp/x');
    expect(res.verified).toBe(true);
    expect(res.size).toBe(4096);
  });

  it('[INV-DATA-03] catches a gateway that returns success and stores nothing', async () => {
    await expect(
      lyingStorage('discards').putAndVerify('backups/ghost.dump', '/tmp/x'),
    ).rejects.toThrow(/Upload reported success but the object is not there/);
  });

  it('catches a truncated upload', async () => {
    // A partial write is worse than none: it looks like a backup.
    await expect(
      lyingStorage('truncates').putAndVerify('backups/short.dump', '/tmp/x'),
    ).rejects.toThrow(/does not match/);
  });
});
