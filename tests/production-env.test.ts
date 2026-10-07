import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  composePublishesDatabase,
  unexpectedHostPorts,
  validateProductionEnvironment,
} from '../scripts/deploy/validate-production-env.js';

const SHA = 'a'.repeat(40);
const KEY = 'aB3dE7gH9kLmN2pQrStUvWxYz0123456789abcd';
const DATABASE = 'postgresql://app-user:app-password-value@postgres:5432/r2nette';

function productionEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    NODE_ENV: 'production',
    TRUST_PROXY: 'true',
    REQUIRE_HTTPS: 'true',
    DATABASE_URL: DATABASE,
    PRISMA_DATABASE_URL: DATABASE,
    POSTGRES_USER: 'app-user',
    POSTGRES_PASSWORD: 'app-password-value',
    POSTGRES_DB: 'r2nette',
    PUBLIC_URL: 'https://book.example.test',
    PRODUCTION_DOMAIN: 'book.example.test',
    ACME_EMAIL: 'ops@example.test',
    FIELD_ENCRYPTION_KEY: KEY,
    TAKATAK_SUPABASE_URL: 'https://project.supabase.co',
    TAKATAK_SUPABASE_ANON_KEY: 'anon-key',
    R2NETTE_IMAGE: `ghcr.io/takatakca/r2neet:${SHA}`,
    ...overrides,
  };
}

const compose = readFileSync('docker-compose.production.yml', 'utf8');

function fatals(env: Record<string, string | undefined>, source = compose) {
  return validateProductionEnvironment(env, source).filter((issue) => issue.severity === 'FATAL');
}

describe('production environment gate', () => {
  it('accepts a complete production environment and the production compose file', () => {
    const issues = validateProductionEnvironment(productionEnv(), compose);
    expect(issues.filter((issue) => issue.severity === 'FATAL')).toEqual([]);
    expect(issues.some((issue) => issue.severity === 'WARN' && /Twilio Voice/.test(issue.message))).toBe(
      true,
    );
    expect(issues.some((issue) => issue.severity === 'WARN' && /Stripe is not configured/.test(issue.message))).toBe(
      true,
    );
  });

  it('does not print secret values when a rule fails', () => {
    const stripe = `sk_live_${'Z'.repeat(24)}`;
    const token = 'leftover-admin-token-value';
    const issues = validateProductionEnvironment(
      productionEnv({
        ADMIN_TOKEN: token,
        STRIPE_SECRET_KEY: stripe,
        FIELD_ENCRYPTION_KEY: 'short-key',
        POSTGRES_PASSWORD: 'password',
      }),
      compose,
    );
    const text = issues.map((issue) => issue.message).join('\n');
    expect(text).not.toContain(stripe);
    expect(text).not.toContain(token);
    expect(text).not.toContain('app-password-value');
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(DATABASE);
  });

  it('rejects a shared admin token, a test database, a weak encryption key, and a stripe key without a webhook secret', () => {
    expect(fatals(productionEnv({ ADMIN_TOKEN: 'leftover' })).some((issue) => /ADMIN_TOKEN/.test(issue.message))).toBe(
      true,
    );
    expect(
      fatals(productionEnv({ TEST_DATABASE_URL: DATABASE })).some((issue) =>
        /TEST_DATABASE_URL equals DATABASE_URL/.test(issue.message),
      ),
    ).toBe(true);
    expect(fatals(productionEnv({ DATABASE_URL: undefined })).some((issue) => /DATABASE_URL is missing/.test(issue.message))).toBe(
      true,
    );
    expect(
      fatals(
        productionEnv({
          DATABASE_URL: 'postgresql://app-user:app-password-value@postgres:5432/r2nette_test',
          PRISMA_DATABASE_URL: 'postgresql://app-user:app-password-value@postgres:5432/r2nette_test',
        }),
      ).some((issue) => /disposable database name/.test(issue.message)),
    ).toBe(true);
    expect(fatals(productionEnv({ FIELD_ENCRYPTION_KEY: 'short-key' })).some((issue) => /too weak/.test(issue.message))).toBe(
      true,
    );
    expect(
      fatals(productionEnv({ STRIPE_SECRET_KEY: 'sk_live_example' })).some((issue) =>
        /STRIPE_WEBHOOK_SECRET/.test(issue.message),
      ),
    ).toBe(true);
  });

  it('requires TAKATAK Supabase Auth and rejects an insecure project URL', () => {
    expect(
      fatals(productionEnv({ TAKATAK_SUPABASE_URL: undefined })).some((issue) =>
        /TAKATAK_SUPABASE_URL is missing/.test(issue.message),
      ),
    ).toBe(true);
    expect(
      fatals(productionEnv({ TAKATAK_SUPABASE_URL: 'http://project.supabase.co' })).some((issue) =>
        /valid HTTPS URL/.test(issue.message),
      ),
    ).toBe(true);
    expect(
      fatals(productionEnv({ TAKATAK_SUPABASE_ANON_KEY: undefined })).some((issue) =>
        /TAKATAK_SUPABASE_ANON_KEY is missing/.test(issue.message),
      ),
    ).toBe(true);
  });

  it('rejects published database ports and any host port other than 80 or 443', () => {
    const unsafe = `
services:
  postgres:
    image: postgres:16-alpine
    ports:
      - "5432:5432"
  caddy:
    ports:
      - "80:80"
      - "3000:3000"
`;
    expect(composePublishesDatabase(unsafe)).toBe(true);
    expect(unexpectedHostPorts(unsafe)).toEqual(['5432', '3000']);
    const issues = fatals(productionEnv(), unsafe);
    expect(issues.some((issue) => /PostgreSQL is published/.test(issue.message))).toBe(true);
    expect(issues.some((issue) => /80 and 443 only/.test(issue.message))).toBe(true);
  });

  it('keeps the production compose file from publishing the database', () => {
    expect(composePublishesDatabase(compose)).toBe(false);
    expect(unexpectedHostPorts(compose)).toEqual([]);
    expect(compose).not.toMatch(/^\s*-\s*["']?\d+:5432/m);
  });

  it('keeps the registration migration applicable on vanilla PostgreSQL', () => {
    const sql = readFileSync(
      'prisma/migrations/20260916231000_add_customer_registration_fields/migration.sql',
      'utf8',
    );
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain("EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE \"RegistrationSession\" FROM anon'");
    expect(sql).toContain("EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE \"RegistrationSession\" FROM authenticated'");
    expect(sql).not.toMatch(/REVOKE ALL PRIVILEGES ON TABLE "RegistrationSession"\s+FROM anon, authenticated/);
  });

  it('starts the server without requiring a .env file to exist', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: { start: string } };
    expect(pkg.scripts.start).toContain('--env-file-if-exists=.env');
    expect(pkg.scripts.start).not.toContain('--env-file=.env');
  });
});
