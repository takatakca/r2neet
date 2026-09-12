/**
 * Database target safety.
 *
 * The failure mode this exists to prevent: `TEST_DATABASE_URL` is unset, the
 * test runner silently falls back to `DATABASE_URL`, and the first
 * `migrate reset` destroys live R2NETTE customer data.
 *
 * So we never fall back. Resolution is explicit per environment, and
 * destructive operations additionally require the resolved URL to look like a
 * throwaway database — checked against the URL itself, not a variable name.
 */

export class DatabaseSafetyError extends Error {
  readonly code = 'DATABASE_SAFETY';
}

export interface ResolvedDatabase {
  url: string;
  /** Host:port/database with credentials stripped — safe to log. */
  describe: string;
  host: string;
  port: string;
  database: string;
  environment: 'test' | 'development' | 'production';
  destructiveAllowed: boolean;
}

function parse(url: string): { host: string; port: string; database: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new DatabaseSafetyError(`DATABASE URL is not a valid URL.`);
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) {
    throw new DatabaseSafetyError(`Expected a postgres:// URL, got ${u.protocol}`);
  }
  return {
    host: u.hostname || 'localhost',
    port: u.port || '5432',
    database: u.pathname.replace(/^\//, ''),
  };
}

/**
 * Heuristics for "this is obviously not production".
 * Deliberately conservative: anything we cannot positively identify as a
 * scratch database is treated as production.
 */
function looksDisposable(host: string, database: string): boolean {
  const localHost =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '/tmp' ||
    host.endsWith('.local') ||
    host === 'db' ||
    host === 'postgres';
  const scratchName = /(^|[_-])(test|tests|testing|ci|scratch|tmp|temp|shadow)([_-]|$)/i.test(
    database,
  );
  return localHost && scratchName;
}

/**
 * Resolve the database for the current NODE_ENV.
 *
 * There is no fallback chain. In test, only TEST_DATABASE_URL is consulted;
 * if it is missing we throw rather than reaching for DATABASE_URL.
 */
export function resolveDatabase(
  env: Record<string, string | undefined> = process.env,
): ResolvedDatabase {
  const nodeEnv = (env.NODE_ENV ?? 'development').toLowerCase();
  const environment: ResolvedDatabase['environment'] =
    nodeEnv === 'test' ? 'test' : nodeEnv === 'production' ? 'production' : 'development';

  let url: string | undefined;
  if (environment === 'test') {
    url = env.TEST_DATABASE_URL;
    if (!url || url.trim() === '') {
      throw new DatabaseSafetyError(
        'NODE_ENV=test but TEST_DATABASE_URL is not set. Refusing to fall back to DATABASE_URL — ' +
          'that fallback is how test runs destroy production data. Set TEST_DATABASE_URL explicitly.',
      );
    }
    if (env.DATABASE_URL && env.DATABASE_URL.trim() === url.trim()) {
      throw new DatabaseSafetyError(
        'TEST_DATABASE_URL is identical to DATABASE_URL. Tests must target a separate database.',
      );
    }
  } else {
    url = env.DATABASE_URL;
    if (!url || url.trim() === '') {
      throw new DatabaseSafetyError('DATABASE_URL is not set.');
    }
  }

  const { host, port, database } = parse(url);

  return {
    url,
    describe: `${host}:${port}/${database}`,
    host,
    port,
    database,
    environment,
    destructiveAllowed: environment !== 'production' && looksDisposable(host, database),
  };
}

/**
 * Gate for migrate reset, drop, truncate and integration-test setup.
 * Called before the operation runs, never after.
 */
export function assertDestructiveAllowed(
  env: Record<string, string | undefined> = process.env,
): ResolvedDatabase {
  const db = resolveDatabase(env);

  if (db.environment === 'production') {
    throw new DatabaseSafetyError(
      `Refusing a destructive operation against production (${db.describe}).`,
    );
  }
  if (!db.destructiveAllowed) {
    throw new DatabaseSafetyError(
      `Refusing a destructive operation against ${db.describe}. ` +
        'The target is not identifiable as a disposable test database: it must be on a local host ' +
        'and its name must contain test/ci/scratch/tmp/shadow. Rename the database or point ' +
        'TEST_DATABASE_URL somewhere safe.',
    );
  }
  return db;
}
