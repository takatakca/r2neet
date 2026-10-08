import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  buildCsp,
  securityHeaders,
  requireHttps,
  RateLimiter,
  rateLimit,
  classifyRoute,
  RATE_RULES,
  redact,
  requestLogger,
  livenessHandler,
  readinessHandler,
  validateProductionConfig,
  type LogLine,
} from '../src/api/hardening.js';
import type { PrismaClient } from '@prisma/client';
import { createApi } from '../src/api/app.js';
import { FakeVerificationProvider } from '../src/identity/identity.js';

describe('content security policy', () => {
  const csp = buildCsp();

  it('never allows inline or eval script', () => {
    const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src'))!;
    expect(scriptSrc).not.toMatch(/unsafe-inline/);
    expect(scriptSrc).not.toMatch(/unsafe-eval/);
  });

  it('allows Stripe.js, because checkout genuinely needs it', () => {
    expect(csp).toMatch(/script-src[^;]*js\.stripe\.com/);
    expect(csp).toMatch(/connect-src[^;]*api\.stripe\.com/);
    expect(csp).toMatch(/frame-src[^;]*js\.stripe\.com/);
  });

  it('blocks framing and plugins outright', () => {
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(csp).toMatch(/object-src 'none'/);
  });

  it('allows inline style only, since the pages ship one style block', () => {
    const styleSrc = csp.split(';').find((d) => d.trim().startsWith('style-src'))!;
    expect(styleSrc).toMatch(/unsafe-inline/);
  });
});

describe('security headers', () => {
  function app(opts = {}) {
    const a = express();
    a.use(securityHeaders(opts));
    a.get('/x', (_r, res) => res.json({ ok: true }));
    return a;
  }

  it('sets the headers that stop clickjacking and sniffing', async () => {
    const res = await request(app()).get('/x');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['content-security-policy']).toBeTruthy();
  });

  it('denies camera, microphone and location', async () => {
    const res = await request(app()).get('/x');
    const pp = res.headers['permissions-policy']!;
    expect(pp).toMatch(/camera=\(\)/);
    expect(pp).toMatch(/microphone=\(\)/);
    expect(pp).toMatch(/geolocation=\(\)/);
  });

  it('never advertises the stack', async () => {
    const res = await request(app()).get('/x');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('sends HSTS only when asked', async () => {
    expect((await request(app()).get('/x')).headers['strict-transport-security']).toBeUndefined();
    const withHsts = await request(app({ hsts: true })).get('/x');
    expect(withHsts.headers['strict-transport-security']).toMatch(/max-age=31536000/);
  });
});

describe('https enforcement', () => {
  function app(enabled: boolean) {
    const a = express();
    a.set('trust proxy', 1);
    a.use(requireHttps(enabled));
    a.get('/x', (_r, res) => res.json({ ok: true }));
    a.post('/x', (_r, res) => res.json({ ok: true }));
    return a;
  }

  it('redirects an insecure GET permanently', async () => {
    const res = await request(app(true)).get('/x').set('x-forwarded-proto', 'http');
    expect(res.status).toBe(308);
    expect(res.headers.location).toMatch(/^https:\/\//);
  });

  it('refuses an insecure POST rather than redirecting and losing the body', async () => {
    const res = await request(app(true)).post('/x').set('x-forwarded-proto', 'http').send({ a: 1 });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('HTTPS_REQUIRED');
  });

  it('passes through when the proxy reports https', async () => {
    const res = await request(app(true)).get('/x').set('x-forwarded-proto', 'https');
    expect(res.status).toBe(200);
  });

  it('does nothing when disabled, so local development works', async () => {
    expect((await request(app(false)).get('/x')).status).toBe(200);
  });
});

describe('rate limiting', () => {
  it('gives expensive routes their own budget', () => {
    expect(classifyRoute('/api/v1/auth/phone/send', 'POST')).toBe('otp');
    expect(classifyRoute('/api/v1/staff/login', 'POST')).toBe('auth');
    expect(classifyRoute('/api/v1/payments/payment-intent', 'POST')).toBe('payment');
    expect(classifyRoute('/api/v1/bookings', 'POST')).toBe('booking');
    expect(classifyRoute('/api/v1/services', 'GET')).toBe('read');
    // Reading a booking is cheap; creating one is not.
    expect(classifyRoute('/api/v1/bookings/abc', 'GET')).toBe('read');
  });

  it('is much stricter on SMS than on page reads', () => {
    expect(RATE_RULES.otp!.max).toBeLessThan(RATE_RULES.read!.max);
    expect(RATE_RULES.auth!.max).toBeLessThan(RATE_RULES.read!.max);
  });

  it('allows up to the limit then refuses with Retry-After', () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    const rule = { windowMs: 1000, max: 3 };
    for (let i = 0; i < 3; i++) expect(limiter.check('k', rule).allowed).toBe(true);
    const blocked = limiter.check('k', rule);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it('recovers once the window passes', () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    const rule = { windowMs: 1000, max: 2 };
    limiter.check('k', rule);
    limiter.check('k', rule);
    expect(limiter.check('k', rule).allowed).toBe(false);
    now = 1500;
    expect(limiter.check('k', rule).allowed).toBe(true);
  });

  it('keeps clients independent', () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    const rule = { windowMs: 1000, max: 1 };
    expect(limiter.check('a', rule).allowed).toBe(true);
    expect(limiter.check('b', rule).allowed).toBe(true);
    expect(limiter.check('a', rule).allowed).toBe(false);
  });

  it('prunes idle buckets so memory does not grow forever', () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    for (let i = 0; i < 50; i++) limiter.check(`k${i}`, { windowMs: 1000, max: 5 });
    expect(limiter.size).toBe(50);
    now = 10_000_000;
    limiter.prune();
    expect(limiter.size).toBe(0);
  });

  it('returns 429 with a helpful message, not a lecture on the policy', async () => {
    let now = 0;
    const a = express();
    a.use(rateLimit(new RateLimiter(() => now)));
    a.post('/api/v1/staff/login', (_r, res) => res.json({ ok: true }));

    for (let i = 0; i < RATE_RULES.auth!.max; i++) {
      await request(a).post('/api/v1/staff/login');
    }
    const res = await request(a).post('/api/v1/staff/login');
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(res.headers['retry-after']).toBeTruthy();
    // Never disclose the exact budget.
    expect(JSON.stringify(res.body)).not.toMatch(/\b20\b/);
  });

  it('never rate limits the Stripe webhook', async () => {
    let now = 0;
    const a = express();
    a.use(rateLimit(new RateLimiter(() => now)));
    a.post('/api/v1/stripe/webhook', (_r, res) => res.json({ ok: true }));
    for (let i = 0; i < 100; i++) {
      const res = await request(a).post('/api/v1/stripe/webhook');
      expect(res.status).toBe(200);
    }
  });
});

describe('log redaction', () => {
  it('[INV-DATA-02] removes passwords, codes and tokens at any depth', () => {
    const out = redact({
      email: 'pascal@example.com',
      password: 'MapleRiver47Sky',
      nested: { code: '123456', clientSecret: 'pi_x_secret_y' },
      list: [{ token: 'abc' }],
    }) as Record<string, unknown>;

    const s = JSON.stringify(out);
    expect(s).not.toMatch(/MapleRiver47Sky/);
    expect(s).not.toMatch(/123456/);
    expect(s).not.toMatch(/pi_x_secret_y/);
    expect(s).not.toMatch(/pascal@example\.com/);
    expect(s).toMatch(/\[redacted\]/);
  });

  it('strips anything shaped like a card or a phone from free text', () => {
    const out = redact({ note: 'call 514-825-2825 card 4242424242424242' }) as { note: string };
    expect(out.note).not.toMatch(/4242424242424242/);
    expect(out.note).not.toMatch(/825-2825/);
  });

  it('leaves harmless values alone', () => {
    const out = redact({ bookingNumber: 'R2N-2026-000041', totalCents: 25869 }) as Record<string, unknown>;
    expect(out.bookingNumber).toBe('R2N-2026-000041');
    expect(out.totalCents).toBe(25869);
  });

  it('does not recurse forever on a cyclic-ish shape', () => {
    const deep: Record<string, unknown> = {};
    let cur = deep;
    for (let i = 0; i < 30; i++) {
      cur.next = {};
      cur = cur.next as Record<string, unknown>;
    }
    expect(() => redact(deep)).not.toThrow();
  });
});

describe('request logging', () => {
  it('emits one structured line with a request id, and echoes it', async () => {
    const lines: LogLine[] = [];
    const a = express();
    a.use(requestLogger((l) => lines.push(l)));
    a.get('/api/v1/services', (_r, res) => res.json({ ok: true }));

    const res = await request(a).get('/api/v1/services').query({ secret: 'shouldnotappear' });

    expect(res.headers['x-request-id']).toBeTruthy();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.status).toBe(200);
    expect(lines[0]!.path).toBe('/api/v1/services');
    // Query strings can carry identifiers; only the path is logged.
    expect(JSON.stringify(lines[0])).not.toMatch(/shouldnotappear/);
  });

  it('marks 5xx as error and 4xx as warn', async () => {
    const lines: LogLine[] = [];
    const a = express();
    a.use(requestLogger((l) => lines.push(l)));
    a.get('/bad', (_r, res) => res.status(400).json({}));
    a.get('/broken', (_r, res) => res.status(500).json({}));
    await request(a).get('/bad');
    await request(a).get('/broken');
    expect(lines[0]!.level).toBe('warn');
    expect(lines[1]!.level).toBe('error');
  });

  it('honours an inbound request id so a trace survives across services', async () => {
    const lines: LogLine[] = [];
    const a = express();
    a.use(requestLogger((l) => lines.push(l)));
    a.get('/x', (_r, res) => res.json({}));
    await request(a).get('/x').set('x-request-id', 'trace-abc');
    expect(lines[0]!.requestId).toBe('trace-abc');
  });
});

describe('health checks', () => {
  it('liveness answers without touching the database', async () => {
    const a = express();
    a.get('/healthz', livenessHandler());
    const res = await request(a).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('alive');
  });

  it('readiness fails when the database is unreachable', async () => {
    const a = express();
    a.get('/readyz', readinessHandler({ ping: async () => { throw new Error('down'); } }, () => false));
    const res = await request(a).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body.reason).toBe('database');
  });

  it('readiness reports draining during shutdown, so traffic stops arriving', async () => {
    const a = express();
    a.get('/readyz', readinessHandler({ ping: async () => undefined }, () => true));
    const res = await request(a).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('draining');
  });

  it('readiness passes when everything is up', async () => {
    const a = express();
    a.get('/readyz', readinessHandler({ ping: async () => undefined }, () => false));
    expect((await request(a).get('/readyz')).body.status).toBe('ready');
  });
});

describe('production config validation', () => {
  it('says nothing outside production', () => {
    expect(validateProductionConfig({ NODE_ENV: 'development' })).toEqual([]);
  });

  it('refuses to start if a shared admin token is still set', () => {
    const problems = validateProductionConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://u@db/live',
      ADMIN_TOKEN: 'leftover',
      TRUST_PROXY: 'true',
    });
    expect(problems.some((p) => p.severity === 'FATAL' && /ADMIN_TOKEN/.test(p.message))).toBe(true);
  });

  it('requires the HTTPS TAKATAK Supabase project and anon key in production', () => {
    const missing = validateProductionConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://u@db/live',
      TRUST_PROXY: 'true',
    });
    expect(missing.some((p) => p.severity === 'FATAL' && /TAKATAK_SUPABASE_URL/.test(p.message))).toBe(true);
    expect(missing.some((p) => p.severity === 'FATAL' && /TAKATAK_SUPABASE_ANON_KEY/.test(p.message))).toBe(true);

    const insecure = validateProductionConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://u@db/live',
      TAKATAK_SUPABASE_URL: 'http://project.supabase.co',
      TAKATAK_SUPABASE_ANON_KEY: 'anon-key',
      TRUST_PROXY: 'true',
    });
    expect(insecure.some((p) => p.severity === 'FATAL' && /HTTPS URL/.test(p.message))).toBe(true);
  });

  it('refuses if the test database points at production', () => {
    const same = 'postgresql://u@db/live';
    const problems = validateProductionConfig({
      NODE_ENV: 'production',
      DATABASE_URL: same,
      TEST_DATABASE_URL: same,
      TRUST_PROXY: 'true',
    });
    expect(problems.some((p) => p.severity === 'FATAL')).toBe(true);
  });

  it('refuses a Stripe key with no webhook secret, since payments could never confirm', () => {
    const problems = validateProductionConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://u@db/live',
      STRIPE_SECRET_KEY: 'sk_live_x',
      TRUST_PROXY: 'true',
    });
    expect(problems.some((p) => p.severity === 'FATAL' && /WEBHOOK/.test(p.message))).toBe(true);
  });

  it('warns about Stripe test mode in production without blocking startup', () => {
    const problems = validateProductionConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://u@db/live',
      TAKATAK_SUPABASE_URL: 'https://project.supabase.co',
      TAKATAK_SUPABASE_ANON_KEY: 'anon-key',
      STRIPE_SECRET_KEY: 'sk_test_x',
      STRIPE_WEBHOOK_SECRET: 'whsec_x',
      TRUST_PROXY: 'true',
    });
    expect(problems.some((p) => p.severity === 'WARN' && /TEST mode/.test(p.message))).toBe(true);
    expect(problems.some((p) => p.severity === 'FATAL')).toBe(false);
  });

  it('warns when two-factor secrets would be stored unencrypted', () => {
    const problems = validateProductionConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://u@db/live',
      TAKATAK_SUPABASE_URL: 'https://project.supabase.co',
      TAKATAK_SUPABASE_ANON_KEY: 'anon-key',
      STRIPE_SECRET_KEY: 'sk_live_x',
      STRIPE_WEBHOOK_SECRET: 'whsec_x',
      TRUST_PROXY: 'true',
    });
    expect(problems.some((p) => p.severity === 'WARN' && /FIELD_ENCRYPTION_KEY/.test(p.message))).toBe(true);
    // A warning, not a blocker: the app still runs, secrets are just plain.
    expect(problems.some((p) => p.severity === 'FATAL')).toBe(false);
  });

  it('passes a fully configured production environment', () => {
    const problems = validateProductionConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://u@db/live',
      TAKATAK_SUPABASE_URL: 'https://project.supabase.co',
      TAKATAK_SUPABASE_ANON_KEY: 'anon-key',
      STRIPE_SECRET_KEY: 'sk_live_x',
      STRIPE_WEBHOOK_SECRET: 'whsec_x',
      TRUST_PROXY: 'true',
      FIELD_ENCRYPTION_KEY: 'a'.repeat(43),
    });
    expect(problems).toEqual([]);
  });
});

describe('health probes behind the HTTPS redirect', () => {
  // Docker's HEALTHCHECK, the compose healthcheck and the deploy script all
  // probe http://127.0.0.1:3000 from inside the container. If the redirect
  // caught them, the container could never become healthy.
  function hardenedApp() {
    const prisma = { $queryRaw: async () => [{ ok: 1 }] } as unknown as PrismaClient;
    return createApi({
      prisma,
      verification: new FakeVerificationProvider('123456'),
      hardening: { enabled: true, requireHttps: true, rateLimit: true, log: null },
    });
  }

  it('answers liveness and readiness over plain http', async () => {
    const a = hardenedApp();
    const live = await request(a).get('/healthz');
    expect(live.status).toBe(200);
    expect(live.body.status).toBe('alive');
    const ready = await request(a).get('/readyz');
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe('ready');
  });

  it('still redirects every other insecure GET', async () => {
    const res = await request(hardenedApp()).get('/api/v1/catalogue').set('x-forwarded-proto', 'http');
    expect(res.status).toBe(308);
    expect(res.headers.location).toMatch(/^https:\/\//);
  });
});
