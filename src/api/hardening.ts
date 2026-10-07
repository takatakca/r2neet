import { randomUUID, createHash } from 'node:crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Server } from 'node:http';

/**
 * Production hardening.
 *
 * These are the controls that only matter once the app is reachable from the
 * internet. They are deliberately app-level: a reverse proxy should also do
 * rate limiting and TLS termination, but an app that only behaves safely
 * behind a correctly configured proxy is one misconfiguration away from
 * exposure.
 */

/* ------------------------------------------------------------------ */
/* security headers                                                    */
/* ------------------------------------------------------------------ */

export interface SecurityOptions {
  /** Send HSTS. Only meaningful over HTTPS. */
  hsts?: boolean;
  /** Extra origins the page may talk to, beyond self. */
  connectSrc?: string[];
  /** Extra script origins. Stripe.js needs js.stripe.com. */
  scriptSrc?: string[];
  frameSrc?: string[];
}

/**
 * Content Security Policy.
 *
 * `'unsafe-inline'` is present for styles only: the pages ship a single
 * inline <style> block. Scripts do NOT get it — that is the directive that
 * actually stops injected script from running, and the bundles are external
 * files precisely so it can stay strict.
 */
export function buildCsp(opts: SecurityOptions = {}): string {
  const script = ["'self'", 'https://js.stripe.com', ...(opts.scriptSrc ?? [])];
  const connect = [
    "'self'",
    'https://api.stripe.com',
    'https://places.googleapis.com',
    'https://routes.googleapis.com',
    ...(opts.connectSrc ?? []),
  ];
  const frame = ["'self'", 'https://js.stripe.com', 'https://hooks.stripe.com', ...(opts.frameSrc ?? [])];

  return [
    "default-src 'self'",
    `script-src ${script.join(' ')}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: https:",
    `connect-src ${connect.join(' ')}`,
    `frame-src ${frame.join(' ')}`,
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}

export function securityHeaders(opts: SecurityOptions = {}): RequestHandler {
  const csp = buildCsp(opts);
  return (req, res, next) => {
    res.setHeader('Content-Security-Policy', csp);
    // Clickjacking: the booking flow must never be framed by a third party.
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    // No reason for this app to touch a camera, microphone or location.
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), interest-cohort=(), payment=(self "https://js.stripe.com")',
    );
    // Never advertise the stack.
    res.removeHeader('X-Powered-By');

    if (opts.hsts) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    }
    next();
  };
}

/**
 * Redirect http -> https behind a proxy.
 *
 * Trusts `x-forwarded-proto`, which is only safe when a proxy sets it and the
 * app is not directly reachable. Express must have `trust proxy` enabled.
 */
export function requireHttps(enabled: boolean): RequestHandler {
  return (req, res, next) => {
    if (!enabled) return next();
    const proto = req.header('x-forwarded-proto') ?? req.protocol;
    if (proto === 'https') return next();
    // Never redirect a POST: the body would be dropped silently.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.status(403).json({
        error: { code: 'HTTPS_REQUIRED', message: 'This endpoint requires a secure connection.' },
      });
      return;
    }
    res.redirect(308, `https://${req.header('host')}${req.originalUrl}`);
  };
}

/* ------------------------------------------------------------------ */
/* rate limiting                                                       */
/* ------------------------------------------------------------------ */

export interface RateLimitRule {
  windowMs: number;
  max: number;
  /** Human message; never explains the limit precisely. */
  message?: string;
}

interface Bucket {
  hits: number[];
}

/**
 * Fixed-window limiter keyed by client + route class.
 *
 * In-process, so it protects a single instance. Documented as
 * defence-in-depth: the edge should also limit, but this stops a single
 * instance being trivially hammered even if the edge is misconfigured.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly now: () => number = Date.now) {}

  /** True when the request is allowed. */
  check(key: string, rule: RateLimitRule): { allowed: boolean; retryAfterSec: number } {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { hits: [] };
      this.buckets.set(key, b);
    }
    b.hits = b.hits.filter((h) => h > t - rule.windowMs);
    if (b.hits.length >= rule.max) {
      const oldest = b.hits[0]!;
      return { allowed: false, retryAfterSec: Math.ceil((oldest + rule.windowMs - t) / 1000) };
    }
    b.hits.push(t);
    return { allowed: true, retryAfterSec: 0 };
  }

  /** Periodic sweep so an idle process does not grow forever. */
  prune(maxAgeMs = 3_600_000): number {
    const cutoff = this.now() - maxAgeMs;
    let removed = 0;
    for (const [key, b] of this.buckets) {
      if (b.hits.every((h) => h < cutoff)) {
        this.buckets.delete(key);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.buckets.size;
  }
}

/**
 * Route classes. Anything that sends an SMS, moves money, or checks a
 * credential is far cheaper to abuse than a page view, so it gets its own
 * budget.
 */
export const RATE_RULES: Record<string, RateLimitRule> = {
  auth: { windowMs: 15 * 60_000, max: 20 },
  otp: { windowMs: 60 * 60_000, max: 15 },
  payment: { windowMs: 15 * 60_000, max: 30 },
  booking: { windowMs: 15 * 60_000, max: 40 },
  read: { windowMs: 60_000, max: 240 },
};

export function classifyRoute(path: string, method: string): keyof typeof RATE_RULES {
  if (path.includes('/auth/google')) return 'auth';
  if (path.includes('/auth/phone')) return 'otp';
  if (path.includes('/staff/login') || path.includes('/staff/password')) return 'auth';
  if (path.includes('/payments') || path.includes('/stripe')) return 'payment';
  if (method !== 'GET' && (path.includes('/bookings') || path.includes('/booking-holds'))) {
    return 'booking';
  }
  return 'read';
}

/** Client key: the forwarded IP when behind a proxy, hashed so logs stay clean. */
export function clientKey(req: Request): string {
  const fwd = (req.header('x-forwarded-for') ?? '').split(',')[0]?.trim();
  const ip = fwd || req.ip || 'unknown';
  return createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

export function rateLimit(limiter: RateLimiter, enabled = true): RequestHandler {
  return (req, res, next) => {
    if (!enabled) return next();
    // Stripe webhooks are signed and must never be dropped for volume.
    if (req.path.endsWith('/stripe/webhook')) return next();

    const cls = classifyRoute(req.path, req.method);
    const rule = RATE_RULES[cls]!;
    const { allowed, retryAfterSec } = limiter.check(`${cls}:${clientKey(req)}`, rule);

    if (!allowed) {
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests. Please wait a moment and try again.',
        },
      });
      return;
    }
    next();
  };
}

/* ------------------------------------------------------------------ */
/* structured logging                                                  */
/* ------------------------------------------------------------------ */

/** Fields that must never reach a log line, however they are nested. */
const REDACT = new Set([
  'password',
  'currentpassword',
  'newpassword',
  'passwordhash',
  'token',
  'sessiontoken',
  'code',
  'clientsecret',
  'client_secret',
  'authorization',
  'cookie',
  'phone',
  'phonee164',
  'email',
  'card',
  'cvc',
  'number',
]);

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT.has(k.toLowerCase()) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') {
    // Belt and braces: strip anything that looks like a card or a phone.
    return value
      .replace(/\b\d{13,19}\b/g, '[redacted]')
      .replace(/\+?1?\s*\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g, '[redacted]');
  }
  return value;
}

export interface LogLine {
  level: 'info' | 'warn' | 'error';
  msg: string;
  requestId?: string;
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  [key: string]: unknown;
}

export type LogSink = (line: LogLine) => void;

export const consoleSink: LogSink = (line) => {
  // JSON lines: greppable, and parseable by any log platform.
  console.log(JSON.stringify(line));
};

/**
 * Request logging with a stable request id.
 *
 * The id is echoed in the response header and in error bodies, so a customer
 * can quote it and operations can find the exact request.
 */
export function requestLogger(sink: LogSink = consoleSink): RequestHandler {
  return (req, res, next) => {
    const requestId = req.header('x-request-id') ?? randomUUID();
    (req as Request & { requestId: string }).requestId = requestId;
    res.setHeader('X-Request-Id', requestId);

    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      sink({
        level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
        msg: 'request',
        requestId,
        method: req.method,
        // Query strings can carry identifiers; log the path only.
        path: req.path,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 10) / 10,
        client: clientKey(req),
      });
    });
    next();
  };
}

/* ------------------------------------------------------------------ */
/* health                                                              */
/* ------------------------------------------------------------------ */

export interface HealthDeps {
  ping: () => Promise<void>;
}

/**
 * Liveness vs readiness.
 *
 * `/healthz` says the process is alive and must not touch the database — an
 * orchestrator restarting the app because Postgres blipped makes an outage
 * worse. `/readyz` says it can actually serve traffic.
 */
export function livenessHandler(): RequestHandler {
  return (_req, res) => {
    res.json({ status: 'alive', uptimeSec: Math.round(process.uptime()) });
  };
}

export function readinessHandler(deps: HealthDeps, isShuttingDown: () => boolean): RequestHandler {
  return (_req, res) => {
    if (isShuttingDown()) {
      res.status(503).json({ status: 'draining' });
      return;
    }
    deps
      .ping()
      .then(() => res.json({ status: 'ready' }))
      .catch(() => res.status(503).json({ status: 'not_ready', reason: 'database' }));
  };
}

/* ------------------------------------------------------------------ */
/* graceful shutdown                                                   */
/* ------------------------------------------------------------------ */

export interface ShutdownOptions {
  server: Server;
  /** Close pools, flush work. */
  onDrain: () => Promise<void>;
  /** Fail readiness first so load balancers stop sending traffic. */
  drainMs?: number;
  timeoutMs?: number;
  log?: LogSink;
}

/**
 * Stop accepting new work, let in-flight requests finish, then exit.
 *
 * The drain delay matters: a load balancer needs a moment to notice readiness
 * failing. Exiting immediately would drop requests that were already routed.
 */
export function installGracefulShutdown(opts: ShutdownOptions): { isShuttingDown: () => boolean } {
  const { server, onDrain, drainMs = 5000, timeoutMs = 25000, log = consoleSink } = opts;
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log({ level: 'info', msg: 'shutdown_started', signal });

    const hardExit = setTimeout(() => {
      log({ level: 'error', msg: 'shutdown_forced', signal });
      process.exit(1);
    }, timeoutMs);
    hardExit.unref();

    setTimeout(() => {
      server.close(() => {
        onDrain()
          .then(() => {
            log({ level: 'info', msg: 'shutdown_complete', signal });
            clearTimeout(hardExit);
            process.exit(0);
          })
          .catch((e) => {
            log({ level: 'error', msg: 'shutdown_drain_failed', error: String(e) });
            process.exit(1);
          });
      });
    }, drainMs).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // A crashed process must not keep serving in an unknown state.
  process.on('uncaughtException', (e) => {
    log({ level: 'error', msg: 'uncaught_exception', error: String(e?.stack ?? e) });
    shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (e) => {
    log({ level: 'error', msg: 'unhandled_rejection', error: String(e) });
  });

  return { isShuttingDown: () => shuttingDown };
}

/* ------------------------------------------------------------------ */
/* startup validation                                                  */
/* ------------------------------------------------------------------ */

export interface ConfigProblem {
  severity: 'FATAL' | 'WARN';
  message: string;
}

/**
 * Refuse to start in a state that would be unsafe in production.
 *
 * Failing loudly at boot is far better than discovering at 2am that sessions
 * were being issued without Secure cookies.
 */
export function validateProductionConfig(
  env: Record<string, string | undefined> = process.env,
): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const isProd = env.NODE_ENV === 'production';
  if (!isProd) return problems;

  if (!env.DATABASE_URL) {
    problems.push({ severity: 'FATAL', message: 'DATABASE_URL is not set.' });
  }
  if (!env.TAKATAK_SUPABASE_URL?.trim()) {
    problems.push({
      severity: 'FATAL',
      message: 'TAKATAK_SUPABASE_URL is not set; customer authentication must use TAKATAK.',
    });
  } else {
    try {
      const supabaseUrl = new URL(env.TAKATAK_SUPABASE_URL);
      if (
        supabaseUrl.protocol !== 'https:' ||
        !supabaseUrl.hostname ||
        supabaseUrl.username ||
        supabaseUrl.password ||
        supabaseUrl.search ||
        supabaseUrl.hash
      ) {
        throw new Error('invalid');
      }
    } catch {
      problems.push({
        severity: 'FATAL',
        message: 'TAKATAK_SUPABASE_URL must be a valid HTTPS URL.',
      });
    }
  }
  if (!env.TAKATAK_SUPABASE_ANON_KEY?.trim()) {
    problems.push({
      severity: 'FATAL',
      message: 'TAKATAK_SUPABASE_ANON_KEY is not set.',
    });
  }
  if (env.TEST_DATABASE_URL && env.TEST_DATABASE_URL === env.DATABASE_URL) {
    problems.push({
      severity: 'FATAL',
      message: 'TEST_DATABASE_URL equals DATABASE_URL. Tests would destroy production data.',
    });
  }
  if (env.ADMIN_TOKEN) {
    problems.push({
      severity: 'FATAL',
      message: 'ADMIN_TOKEN is set. Shared operator tokens are no longer supported; remove it.',
    });
  }
  if (env.REQUIRE_HTTPS !== 'false' && env.TRUST_PROXY !== 'true') {
    problems.push({
      severity: 'WARN',
      message: 'TRUST_PROXY is not enabled; HTTPS detection behind a proxy will not work.',
    });
  }
  if (!env.FIELD_ENCRYPTION_KEY || env.FIELD_ENCRYPTION_KEY.length < 32) {
    problems.push({
      severity: 'WARN',
      message:
        'FIELD_ENCRYPTION_KEY is not set. Two-factor secrets will be stored unencrypted.',
    });
  }
  if (env.STRIPE_SECRET_KEY?.startsWith('sk_test_')) {
    problems.push({
      severity: 'WARN',
      message: 'Stripe is in TEST mode. Real payments will not be taken.',
    });
  }
  if (!env.STRIPE_WEBHOOK_SECRET && env.STRIPE_SECRET_KEY) {
    problems.push({
      severity: 'FATAL',
      message: 'STRIPE_SECRET_KEY is set without STRIPE_WEBHOOK_SECRET. Payments could never confirm.',
    });
  }
  return problems;
}
