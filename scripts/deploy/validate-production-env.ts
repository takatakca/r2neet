/**
 * Production environment gate.
 *
 * Prints variable names and the rule that failed. Never prints a value.
 * The application still has its own startup checks. This gate is what the
 * deploy runs before containers are replaced.
 */
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export interface ProductionIssue {
  severity: 'FATAL' | 'WARN';
  message: string;
}

const DISPOSABLE_DATABASE =
  /(^|[_-])(test|tests|testing|ci|scratch|tmp|temp|shadow)([_-]|$)/i;

const WEAK_VALUES = new Set([
  'password',
  'changeme',
  'change-me',
  'replace-me',
  'placeholder',
  'example',
  'secret',
  'postgres',
  'r2nette',
]);

function weakPassword(value: string, user: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 16) return true;
  if (user && trimmed === user) return true;
  if (new Set(trimmed).size < 6) return true;
  return WEAK_VALUES.has(trimmed.toLowerCase());
}

function weakEncryptionKey(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 32) return true;
  if (new Set(trimmed).size < 8) return true;
  return WEAK_VALUES.has(trimmed.toLowerCase());
}

function blank(value: string | undefined): boolean {
  return value === undefined || value.trim() === '';
}

function present(env: Record<string, string | undefined>, name: string): boolean {
  return !blank(env[name]);
}

function missingNames(
  env: Record<string, string | undefined>,
  names: readonly string[],
): string[] {
  return names.filter((name) => !present(env, name));
}

function postgresTarget(url: string): { host: string; database: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) return null;
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!parsed.hostname || !database) return null;
  return { host: parsed.hostname, database };
}

export function publishedHostPorts(compose: string): string[] {
  const ports: string[] = [];
  for (const raw of compose.split(/\r?\n/)) {
    if (/^\s*#/.test(raw)) continue;
    const match = /^\s*-\s*["']?(\d{1,5}):(\d{1,5})(?:\/(?:tcp|udp))?["']?\s*$/.exec(raw);
    if (match?.[1]) ports.push(match[1]);
  }
  return ports;
}

/** True when PostgreSQL is given a host port or any ports key. */
export function composePublishesDatabase(compose: string): boolean {
  let service = '';
  for (const raw of compose.split(/\r?\n/)) {
    if (/^\s*#/.test(raw)) continue;
    const named = /^ {2}([A-Za-z0-9_-]+):\s*(?:#.*)?$/.exec(raw);
    if (named?.[1]) {
      service = named[1];
      continue;
    }
    if (/^\S/.test(raw)) service = '';
    if (service === 'postgres' && /^ {4}ports:\s*$/.test(raw)) return true;
  }
  return publishedHostPorts(compose).includes('5432');
}

export function unexpectedHostPorts(compose: string): string[] {
  return publishedHostPorts(compose).filter((port) => port !== '80' && port !== '443');
}

function warnIfOptional(
  issues: ProductionIssue[],
  env: Record<string, string | undefined>,
  label: string,
  names: readonly string[],
): void {
  const missing = missingNames(env, names);
  if (missing.length === 0) return;
  const state = missing.length === names.length ? 'not configured' : 'only partly configured';
  issues.push({
    severity: 'WARN',
    message: `${label} is ${state} (missing ${missing.join(', ')}). The app keeps running without it.`,
  });
}

export function validateProductionEnvironment(
  env: Record<string, string | undefined>,
  composeSource?: string,
): ProductionIssue[] {
  const issues: ProductionIssue[] = [];

  if (env.NODE_ENV !== 'production') {
    issues.push({ severity: 'FATAL', message: 'NODE_ENV must be production.' });
  }
  if (present(env, 'ADMIN_TOKEN')) {
    issues.push({
      severity: 'FATAL',
      message: 'ADMIN_TOKEN is set. Remove it. Staff sign-in is per person.',
    });
  }
  if (env.TRUST_PROXY !== 'true') {
    issues.push({ severity: 'FATAL', message: 'TRUST_PROXY must be true behind the proxy.' });
  }
  if (env.REQUIRE_HTTPS === 'false') {
    issues.push({ severity: 'FATAL', message: 'REQUIRE_HTTPS must not be false.' });
  }

  if (!present(env, 'DATABASE_URL')) {
    issues.push({ severity: 'FATAL', message: 'DATABASE_URL is missing.' });
  } else {
    const target = postgresTarget(env.DATABASE_URL!.trim());
    if (!target) {
      issues.push({ severity: 'FATAL', message: 'DATABASE_URL is not a postgres URL.' });
    } else if (DISPOSABLE_DATABASE.test(target.database)) {
      issues.push({
        severity: 'FATAL',
        message: 'DATABASE_URL uses a disposable database name.',
      });
    }
  }

  if (!present(env, 'PRISMA_DATABASE_URL')) {
    issues.push({ severity: 'FATAL', message: 'PRISMA_DATABASE_URL is missing.' });
  } else if (
    present(env, 'DATABASE_URL') &&
    env.PRISMA_DATABASE_URL!.trim() !== env.DATABASE_URL!.trim()
  ) {
    issues.push({
      severity: 'FATAL',
      message: 'PRISMA_DATABASE_URL does not match DATABASE_URL.',
    });
  }

  if (present(env, 'TEST_DATABASE_URL') && present(env, 'DATABASE_URL')) {
    if (env.TEST_DATABASE_URL!.trim() === env.DATABASE_URL!.trim()) {
      issues.push({
        severity: 'FATAL',
        message: 'TEST_DATABASE_URL equals DATABASE_URL.',
      });
    } else {
      issues.push({
        severity: 'WARN',
        message: 'TEST_DATABASE_URL is set in production. Remove it from the server environment.',
      });
    }
  }

  for (const name of ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB'] as const) {
    if (!present(env, name)) {
      issues.push({ severity: 'FATAL', message: `${name} is missing.` });
    }
  }
  if (present(env, 'POSTGRES_PASSWORD') && weakPassword(env.POSTGRES_PASSWORD!, env.POSTGRES_USER?.trim() ?? '')) {
    issues.push({
      severity: 'FATAL',
      message: 'POSTGRES_PASSWORD is missing or too weak.',
    });
  }
  if (present(env, 'POSTGRES_DB') && DISPOSABLE_DATABASE.test(env.POSTGRES_DB!.trim())) {
    issues.push({
      severity: 'FATAL',
      message: 'POSTGRES_DB uses a disposable database name.',
    });
  }

  if (!present(env, 'PUBLIC_URL')) {
    issues.push({ severity: 'FATAL', message: 'PUBLIC_URL is missing.' });
  } else {
    let parsed: URL | null = null;
    try {
      parsed = new URL(env.PUBLIC_URL!.trim());
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
      issues.push({
        severity: 'FATAL',
        message: 'PUBLIC_URL must be an https URL without embedded credentials.',
      });
    } else if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      issues.push({
        severity: 'FATAL',
        message: 'PUBLIC_URL must use the production domain.',
      });
    }
  }

  if (!present(env, 'PRODUCTION_DOMAIN') || !present(env, 'ACME_EMAIL')) {
    const missing = missingNames(env, ['PRODUCTION_DOMAIN', 'ACME_EMAIL']);
    issues.push({
      severity: 'FATAL',
      message: `The proxy cannot request a certificate (missing ${missing.join(', ')}).`,
    });
  }

  if (!present(env, 'FIELD_ENCRYPTION_KEY')) {
    issues.push({ severity: 'FATAL', message: 'FIELD_ENCRYPTION_KEY is missing.' });
  } else if (weakEncryptionKey(env.FIELD_ENCRYPTION_KEY!)) {
    issues.push({
      severity: 'FATAL',
      message: 'FIELD_ENCRYPTION_KEY is too weak.',
    });
  }

  if (present(env, 'STRIPE_SECRET_KEY') && !present(env, 'STRIPE_WEBHOOK_SECRET')) {
    issues.push({
      severity: 'FATAL',
      message: 'STRIPE_SECRET_KEY is set without STRIPE_WEBHOOK_SECRET.',
    });
  }
  if (present(env, 'STRIPE_SECRET_KEY') && env.STRIPE_SECRET_KEY!.trim().startsWith('sk_test_')) {
    issues.push({
      severity: 'WARN',
      message: 'STRIPE_SECRET_KEY is a test key. Live charges will not be taken.',
    });
  }

  warnIfOptional(issues, env, 'Twilio Verify', [
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_VERIFY_SERVICE_SID',
  ]);
  warnIfOptional(issues, env, 'Twilio Voice', [
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_VOICE_NUMBER',
  ]);
  warnIfOptional(issues, env, 'Twilio SMS', [
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_SMS_NUMBER',
  ]);
  if (!present(env, 'STRIPE_SECRET_KEY')) {
    issues.push({
      severity: 'WARN',
      message: 'Stripe is not configured (missing STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET). Card payment stays unavailable.',
    });
  } else {
    warnIfOptional(issues, env, 'Stripe', ['STRIPE_PUBLISHABLE_KEY', 'STRIPE_WEBHOOK_SECRET']);
  }
  warnIfOptional(issues, env, 'Google Maps', ['GOOGLE_MAPS_API_KEY']);
  warnIfOptional(issues, env, 'Dispatch origin', ['BUSINESS_ORIGIN_LAT', 'BUSINESS_ORIGIN_LNG']);
  warnIfOptional(issues, env, 'Off-host backup', [
    'BACKUP_S3_BUCKET',
    'BACKUP_S3_REGION',
    'BACKUP_S3_ACCESS_KEY_ID',
    'BACKUP_S3_SECRET_ACCESS_KEY',
  ]);
  warnIfOptional(issues, env, 'Alert webhook', ['ALERT_WEBHOOK_URL', 'ALERT_WEBHOOK_SECRET']);

  if (!present(env, 'R2NETTE_IMAGE') || !/:([0-9a-f]{40})$/.test(env.R2NETTE_IMAGE!.trim())) {
    issues.push({
      severity: 'FATAL',
      message: 'R2NETTE_IMAGE must be a registry image tagged with a full git commit SHA.',
    });
  }

  if (composeSource !== undefined) {
    if (composePublishesDatabase(composeSource)) {
      issues.push({
        severity: 'FATAL',
        message: 'PostgreSQL is published on a host port. Remove it. Only 80 and 443 may be published.',
      });
    }
    const extra = unexpectedHostPorts(composeSource);
    if (extra.length > 0) {
      issues.push({
        severity: 'FATAL',
        message: `Published host ports must be 80 and 443 only (found ${extra.join(', ')}).`,
      });
    }
  }

  return issues;
}

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const name = match[1]!;
    if (process.env[name] !== undefined) continue;
    let value = match[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[name] = value;
  }
}

function main(): void {
  const composePath = process.argv[2] ?? 'docker-compose.production.yml';
  loadEnvFile('.env');
  const composeSource = existsSync(composePath) ? readFileSync(composePath, 'utf8') : '';
  if (!composeSource) {
    console.error(`[FATAL] Compose file is missing: ${composePath}`);
    process.exit(1);
  }
  const issues = validateProductionEnvironment(process.env, composeSource);
  for (const issue of issues) {
    console.error(`[${issue.severity}] ${issue.message}`);
  }
  if (issues.some((issue) => issue.severity === 'FATAL')) {
    console.error('Refusing to start production with an unsafe configuration.');
    process.exit(1);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
