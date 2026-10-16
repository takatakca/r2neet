import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { S3Storage, StorageError } from '../src/workers/object-storage.js';

const config = {
  bucket: 'test-backups',
  region: 'us-east-1',
  accessKeyId: 'test-key',
  secretAccessKey: 'test-secret',
};

function fixture(data: string) {
  const dir = mkdtempSync(join(tmpdir(), 'r2nette-s3-verify-'));
  const file = join(dir, 'backup.dump');
  writeFileSync(file, data);
  return { file, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

function fakeGateway(stored: string, sizeOverride?: number, getStatus = 200) {
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
    const method = options.method ?? '';
    requests.push(method);
    if (method === 'PUT') return new Response(null, { status: 200 });
    if (method === 'HEAD') {
      return new Response(null, {
        status: 200,
        headers: { 'content-length': String(sizeOverride ?? Buffer.byteLength(stored)) },
      });
    }
    if (method === 'GET') {
      return new Response(getStatus === 200 ? new Uint8Array(Buffer.from(stored)) : null, {
        status: getStatus,
      });
    }
    throw new Error(`Unexpected method ${method}`);
  }));
  return requests;
}

afterEach(() => vi.unstubAllGlobals());

describe('S3 off-host backup end-to-end integrity', () => {
  it('verifies actual identical bytes using a streamed GET after PUT and HEAD', async () => {
    const local = fixture('valid-database-dump-content');
    try {
      const requests = fakeGateway('valid-database-dump-content');
      const result = await new S3Storage(config).putAndVerify('staging/backup.dump', local.file);
      expect(result.verified).toBe(true);
      expect(result.size).toBe(Buffer.byteLength('valid-database-dump-content'));
      expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(requests).toEqual(['PUT', 'HEAD', 'GET']);
    } finally {
      local.dispose();
    }
  });

  it('rejects an equal-length corrupted object instead of trusting HEAD', async () => {
    const local = fixture('backup-original-12345');
    try {
      const requests = fakeGateway('backup-corruptd-12345');
      await expect(new S3Storage(config).putAndVerify('a.dump', local.file)).rejects.toMatchObject({
        code: 'VERIFY_HASH_MISMATCH',
      } satisfies Partial<StorageError>);
      expect(requests).toEqual(['PUT', 'HEAD', 'GET']);
    } finally {
      local.dispose();
    }
  });

  it('rejects a wrong HEAD size without requesting a download', async () => {
    const local = fixture('backup-original-12345');
    try {
      const requests = fakeGateway('backup-original-12345', 7);
      await expect(new S3Storage(config).putAndVerify('a.dump', local.file)).rejects.toMatchObject({
        code: 'VERIFY_SIZE_MISMATCH',
      });
      expect(requests).toEqual(['PUT', 'HEAD']);
    } finally {
      local.dispose();
    }
  });

  it('rejects a truncated GET even when HEAD claims a matching size', async () => {
    const local = fixture('backup-original-12345');
    try {
      fakeGateway('backup-ori', Buffer.byteLength('backup-original-12345'));
      await expect(new S3Storage(config).putAndVerify('a.dump', local.file)).rejects.toMatchObject({
        code: 'VERIFY_SIZE_MISMATCH',
      });
    } finally {
      local.dispose();
    }
  });

  it('fails closed when the remote GET is unavailable', async () => {
    const local = fixture('backup-original-12345');
    try {
      fakeGateway('backup-original-12345', undefined, 503);
      await expect(new S3Storage(config).putAndVerify('a.dump', local.file)).rejects.toMatchObject({
        code: 'VERIFY_DOWNLOAD_FAILED',
      });
    } finally {
      local.dispose();
    }
  });
});
