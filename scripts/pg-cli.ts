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
