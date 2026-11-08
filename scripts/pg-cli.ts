import { execFileSync } from 'node:child_process';

/**
 * Keep database passwords out of pg_dump process arguments. PostgreSQL CLI
 * accepts PGPASSWORD via the child environment; its argv only needs a URI
 * with the password removed. Preserve its host, database and TLS options.
 * The caller MUST NEVER print this returned environment object.
 */
export function pgCommandConnection(
  connectionString: string,
  parentEnv: NodeJS.ProcessEnv = process.env,
): { url: string; env: NodeJS.ProcessEnv } {
  const parsed = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('Expected a PostgreSQL connection URL.');
  }
  const password = decodeURIComponent(parsed.password);
  parsed.password = '';
  return {
    url: parsed.toString(),
    env: password ? { ...parentEnv, PGPASSWORD: password } : { ...parentEnv },
  };
}

/**
 * Run a PostgreSQL client without putting the password on argv, and without
 * repeating the connection string if the command fails. execFileSync's own
 * error includes every argument.
 */
export function runPgCommand(
  bin: string,
  args: string[],
  connectionString: string,
  exec: typeof execFileSync = execFileSync,
): void {
  const { url, env } = pgCommandConnection(connectionString);
  const argv = args.map((arg) => (arg === '{url}' ? url : arg));
  try {
    exec(bin, argv, { env, stdio: ['ignore', 'inherit', 'inherit'] });
  } catch {
    throw new Error(`${bin} failed`);
  }
}
