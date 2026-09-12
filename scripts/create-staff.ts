/**
 * Create a staff login.
 *
 *   npm run staff:create -- --email you@r2nette.ca --name "Your Name" --role OWNER
 *
 * The password comes from STAFF_PASSWORD or is generated. It is printed ONCE
 * and never stored in plaintext — there is no recovery, only a reset.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { StaffAuthService, passwordProblems, type StaffRole } from '../src/auth/staff-auth.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Readable but high-entropy: words plus digits beat an unmemorable blob. */
function suggestPassword(): string {
  const words = ['Maple', 'River', 'Heron', 'Pine', 'Falcon', 'Ridge', 'Harbour', 'Sable', 'Cedar', 'Aurora'];
  const pick = () => words[randomBytes(1)[0]! % words.length]!;
  return `${pick()}${pick()}${(randomBytes(2).readUInt16BE(0) % 90) + 10}${pick()}`;
}

const email = arg('email');
const name = arg('name');
const role = (arg('role') ?? 'OWNER').toUpperCase() as StaffRole;
const staffId = arg('staffId') ?? null;

if (!email || !name) {
  console.error('Usage: --email <email> --name "<name>" [--role OWNER|DISPATCHER|CLEANER] [--staffId <id>]');
  process.exit(1);
}
if (!['OWNER', 'DISPATCHER', 'CLEANER'].includes(role)) {
  console.error(`Unknown role ${role}. Use OWNER, DISPATCHER or CLEANER.`);
  process.exit(1);
}
if (role === 'CLEANER' && !staffId) {
  console.error('A CLEANER login needs --staffId so it can be scoped to their own jobs.');
  process.exit(1);
}

const password = process.env.STAFF_PASSWORD ?? suggestPassword();
const problems = passwordProblems(password);
if (problems.length) {
  console.error('Password rejected:', problems.join(' '));
  process.exit(1);
}

// Load .env if present, so the CLI works the same way the server does.
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '');
  }
}

// Accept either variable so the script works in dev and in test.
const url = process.env.PRISMA_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('Set PRISMA_DATABASE_URL (or DATABASE_URL) before creating an account.');
  process.exit(1);
}
const prisma = new PrismaClient({ datasources: { db: { url } } });
const auth = new StaffAuthService(prisma);

try {
  const user = await auth.createUser({
    email,
    password,
    displayName: name,
    role,
    staffId,
    mustChangePassword: true,
  });
  console.log(`\nCreated ${user.role} account for ${user.email}`);
  console.log(`Password: ${password}`);
  console.log('\nShown once. Sign in at /admin and change it immediately.\n');
} catch (e) {
  const msg = String((e as Error).message ?? e);
  const line = msg.split('\n').find((l) => /Unique|Invalid|constraint|reach/i.test(l)) ?? msg.slice(0, 200);
  console.error('Could not create account:', line.trim());
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
