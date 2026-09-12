import { createHash, createHmac } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

/**
 * Off-host backup storage over the S3 API.
 *
 * Vendor-neutral by design. The owner has not chosen a provider, and this
 * should not force that decision: AWS S3, Cloudflare R2, Backblaze B2,
 * DigitalOcean Spaces and MinIO all speak the same API. Only the endpoint
 * changes.
 *
 * Signature Version 4 is implemented here rather than pulling in the AWS SDK,
 * which is a very large dependency for two operations. All the cryptography
 * is Node's `crypto` — this is the signing protocol, not a cipher.
 */

export interface S3Config {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Custom endpoint for non-AWS providers. */
  endpoint?: string;
  /** Required by MinIO and some others. */
  forcePathStyle?: boolean;
  prefix?: string;
}

export class StorageError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export function loadS3Config(env: Record<string, string | undefined> = process.env): S3Config | null {
  const bucket = env.BACKUP_S3_BUCKET;
  const accessKeyId = env.BACKUP_S3_ACCESS_KEY_ID;
  const secretAccessKey = env.BACKUP_S3_SECRET_ACCESS_KEY;
  if (!bucket || !accessKeyId || !secretAccessKey) return null;

  return {
    bucket,
    region: env.BACKUP_S3_REGION ?? 'us-east-1',
    accessKeyId,
    secretAccessKey,
    endpoint: env.BACKUP_S3_ENDPOINT,
    // MinIO and several others need path-style addressing.
    forcePathStyle: env.BACKUP_S3_FORCE_PATH_STYLE === 'true',
    prefix: env.BACKUP_S3_PREFIX ?? 'r2nette',
  };
}

/* ------------------------------------------------------------------ */
/* SigV4                                                               */
/* ------------------------------------------------------------------ */

const sha256Hex = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();

function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request');
}

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

/** Build a signed S3 request. Exposed so the signing can be tested directly. */
export function signRequest(
  config: S3Config,
  method: string,
  key: string,
  payload: Buffer | null,
  at: Date = new Date(),
): SignedRequest {
  const amzDate = at.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const service = 's3';

  const base = config.endpoint
    ? config.endpoint.replace(/\/$/, '')
    : `https://s3.${config.region}.amazonaws.com`;
  const host = new URL(base).host;

  // Path-style puts the bucket in the path; virtual-hosted puts it in the host.
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  const path =
    config.forcePathStyle || config.endpoint
      ? `/${config.bucket}/${encodedKey}`
      : `/${encodedKey}`;
  const url =
    config.forcePathStyle || config.endpoint
      ? `${base}${path}`
      : `https://${config.bucket}.s3.${config.region}.amazonaws.com/${encodedKey}`;

  const payloadHash = payload ? sha256Hex(payload) : sha256Hex('');
  const signedHost = config.endpoint || config.forcePathStyle ? host : new URL(url).host;

  const headers: Record<string, string> = {
    host: signedHost,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (payload) headers['content-length'] = String(payload.length);

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h]}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');

  const canonicalRequest = [
    method,
    config.forcePathStyle || config.endpoint ? path : `/${encodedKey}`,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${config.region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signature = createHmac(
    'sha256',
    signingKey(config.secretAccessKey, dateStamp, config.region, service),
  )
    .update(stringToSign)
    .digest('hex');

  headers.Authorization =
    `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { url, headers };
}

/* ------------------------------------------------------------------ */
/* client                                                              */
/* ------------------------------------------------------------------ */

export interface ObjectInfo {
  key: string;
  size: number;
  etag?: string;
}

export class S3Storage {
  constructor(private readonly config: S3Config) {}

  /**
   * Deterministic, browsable key. Dated folders make lifecycle rules and
   * manual inspection straightforward.
   */
  objectKey(environment: string, filename: string, at: Date = new Date()): string {
    const y = at.getUTCFullYear();
    const m = String(at.getUTCMonth() + 1).padStart(2, '0');
    const d = String(at.getUTCDate()).padStart(2, '0');
    const prefix = this.config.prefix ?? 'r2nette';
    return `${prefix}/${environment}/database/${y}/${m}/${d}/${filename}`;
  }

  async putFile(key: string, filePath: string): Promise<{ key: string; size: number; sha256: string }> {
    const body = readFileSync(filePath);
    const sha256 = createHash('sha256').update(body).digest('hex');
    const { url, headers } = signRequest(this.config, 'PUT', key, body);

    // Not signed (S3 does not require it), but real gateways and proxies
    // expect a content type on a binary upload.
    const res = await fetch(url, {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      body: new Uint8Array(body),
    });
    if (!res.ok) {
      throw new StorageError(`Upload failed with ${res.status}.`, 'UPLOAD_FAILED');
    }
    return { key, size: statSync(filePath).size, sha256 };
  }

  /**
   * Confirm the object is really there and the right size.
   *
   * A PUT that returned 200 is not proof: proxies, quota errors and
   * misconfigured buckets can all swallow a body.
   */
  async head(key: string): Promise<ObjectInfo | null> {
    const { url, headers } = signRequest(this.config, 'HEAD', key, null);
    const res = await fetch(url, { method: 'HEAD', headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new StorageError(`HEAD failed with ${res.status}.`, 'HEAD_FAILED');
    return {
      key,
      size: Number(res.headers.get('content-length') ?? 0),
      etag: res.headers.get('etag') ?? undefined,
    };
  }

  async getBuffer(key: string): Promise<Buffer> {
    const { url, headers } = signRequest(this.config, 'GET', key, null);
    const res = await fetch(url, { method: 'GET', headers });
    if (!res.ok) throw new StorageError(`Download failed with ${res.status}.`, 'DOWNLOAD_FAILED');
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const { url, headers } = signRequest(this.config, 'DELETE', key, null);
    const res = await fetch(url, { method: 'DELETE', headers });
    if (!res.ok && res.status !== 404) {
      throw new StorageError(`Delete failed with ${res.status}.`, 'DELETE_FAILED');
    }
  }

  /**
   * Upload, then verify.
   *
   * Only after a successful HEAD showing the right size is the backup
   * considered stored off-host.
   */
  async putAndVerify(key: string, filePath: string) {
    const put = await this.putFile(key, filePath);
    const info = await this.head(key);
    if (!info) {
      throw new StorageError('Upload reported success but the object is not there.', 'VERIFY_MISSING');
    }
    if (info.size !== put.size) {
      throw new StorageError(
        `Stored size ${info.size} does not match ${put.size}.`,
        'VERIFY_SIZE_MISMATCH',
      );
    }
    return { ...put, verified: true as const };
  }
}
