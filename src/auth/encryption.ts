import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHash } from 'node:crypto';

/**
 * Field encryption with a keyring.
 *
 * The earlier version supported exactly one key, which meant rotating it
 * would have made every existing 2FA account undecryptable. That is a bad
 * property for something that is now half of disaster recovery: losing or
 * changing the key locks the owner out of their own business.
 *
 * So ciphertext carries a key id. The current key encrypts new writes; any
 * retired key can still decrypt old rows until a re-encryption pass moves
 * them forward.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // GCM standard
const KEY_BYTES = 32;
const FORMAT = 'v2';

export class EncryptionError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/* ------------------------------------------------------------------ */
/* keyring                                                             */
/* ------------------------------------------------------------------ */

export interface KeyringEntry {
  /** Short, stable, non-reversible identifier stored in the ciphertext. */
  id: string;
  key: Buffer;
}

export interface Keyring {
  current: KeyringEntry;
  /** Retired keys, kept only so old rows stay readable during rotation. */
  retired: KeyringEntry[];
}

function deriveKey(passphrase: string): Buffer {
  return scryptSync(passphrase, 'r2nette:field-encryption:v1', KEY_BYTES, { N: 16384 });
}

/**
 * A key's id is derived from the passphrase, so the same key always produces
 * the same id and a row can find its key without storing anything sensitive.
 */
export function keyId(passphrase: string): string {
  return createHash('sha256').update(`keyid:${passphrase}`).digest('hex').slice(0, 8);
}

const cache = new Map<string, Buffer>();
function keyFor(passphrase: string): Buffer {
  let k = cache.get(passphrase);
  if (!k) {
    k = deriveKey(passphrase);
    cache.set(passphrase, k);
  }
  return k;
}

/**
 * Build the keyring from the environment.
 *
 * `FIELD_ENCRYPTION_KEY` encrypts new writes.
 * `FIELD_ENCRYPTION_KEYS_RETIRED` is a comma-separated list of previous keys,
 * kept only long enough to re-encrypt.
 */
export function loadKeyring(env: Record<string, string | undefined> = process.env): Keyring | null {
  const current = env.FIELD_ENCRYPTION_KEY;
  if (!current || current.length < 32) return null;

  const retired = (env.FIELD_ENCRYPTION_KEYS_RETIRED ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length >= 32)
    .map((p) => ({ id: keyId(p), key: keyFor(p) }));

  return { current: { id: keyId(current), key: keyFor(current) }, retired };
}

export function encryptionConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return loadKeyring(env) !== null;
}

function requireKeyring(env: Record<string, string | undefined>): Keyring {
  const ring = loadKeyring(env);
  if (!ring) {
    throw new EncryptionError(
      'FIELD_ENCRYPTION_KEY is not set, or is shorter than 32 characters.',
      'ENCRYPTION_NOT_CONFIGURED',
    );
  }
  return ring;
}

/* ------------------------------------------------------------------ */
/* encrypt / decrypt                                                   */
/* ------------------------------------------------------------------ */

/** `v2:keyId:iv:tag:ciphertext`, all base64url. */
export function encryptSecret(
  plaintext: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const ring = requireKeyring(env);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, ring.current.key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    FORMAT,
    ring.current.id,
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join(':');
}

/**
 * Decrypt, selecting the key by the id embedded in the ciphertext.
 *
 * A row encrypted under a retired key still opens. A row whose key is not in
 * the ring fails loudly rather than silently — the operator needs to know a
 * key is missing, not discover it when an owner cannot sign in.
 */
export function decryptSecret(
  payload: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const ring = requireKeyring(env);
  const parts = payload.split(':');

  // v1 had no key id. Try the current key for backward compatibility.
  if (parts.length === 4 && parts[0] === 'v1') {
    return openWith(ring.current.key, parts[1]!, parts[2]!, parts[3]!);
  }
  if (parts.length !== 5 || parts[0] !== FORMAT) {
    throw new EncryptionError('Encrypted value is malformed.', 'MALFORMED_CIPHERTEXT');
  }

  const id = parts[1]!;
  const entry = [ring.current, ...ring.retired].find((k) => k.id === id);
  if (!entry) {
    throw new EncryptionError(
      `This value was encrypted with a key that is not configured (${id}). ` +
        'Add it to FIELD_ENCRYPTION_KEYS_RETIRED.',
      'KEY_NOT_AVAILABLE',
    );
  }
  return openWith(entry.key, parts[2]!, parts[3]!, parts[4]!);
}

function openWith(key: Buffer, iv: string, tag: string, data: string): string {
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(data, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Wrong key, or the row was tampered with. Both are the same to us.
    throw new EncryptionError('Could not decrypt this value.', 'DECRYPTION_FAILED');
  }
}

export function isEncrypted(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false;
  const p = value.split(':');
  return (p[0] === FORMAT && p.length === 5) || (p[0] === 'v1' && p.length === 4);
}

/** The key id a row was written with, or null if it predates versioning. */
export function ciphertextKeyId(value: string): string | null {
  const p = value.split(':');
  return p[0] === FORMAT && p.length === 5 ? p[1]! : null;
}

/** True when a row is already sealed under the current key. */
export function isCurrentKey(
  value: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const ring = loadKeyring(env);
  return ring !== null && ciphertextKeyId(value) === ring.current.id;
}

/**
 * Read a field that may be plaintext from before encryption was introduced.
 *
 * Existing rows keep working; a re-encryption pass moves them forward.
 */
export function readPossiblyEncrypted(
  value: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return isEncrypted(value) ? decryptSecret(value, env) : value;
}

export function generateEncryptionKey(): string {
  return randomBytes(32).toString('base64url');
}

/** Non-reversible fingerprint, for confirming two environments agree. */
export function keyFingerprint(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const ring = loadKeyring(env);
  return ring ? ring.current.id : null;
}
