import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_SINGLE_PUT_BYTES, S3Storage, signRequest } from '../src/workers/object-storage.js';

const config = {
  bucket: 'r2nette',
  region: 'us-east-1',
  accessKeyId: 'test-key',
  secretAccessKey: 'test-secret',
};

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(contents: Uint8Array) {
  const dir = mkdtempSync(join(tmpdir(), 'r2nette-stream-put-'));
  dirs.push(dir);
  const file = join(dir, 'backup.dump');
  writeFileSync(file, contents);
  return file;
}

describe('S3 streaming upload and signed payload integrity', () => {
  it('signs the same digest and length for streamed files as for buffers', () => {
    const body = Buffer.from('dump contents');
    const digest = { sha256: createHash('sha256').update(body).digest('hex'), size: body.length };
    const now = new Date('2026-10-16T12:00:00Z');
    expect(signRequest(config, 'PUT', 'a.dump', digest, now)).toEqual(
      signRequest(config, 'PUT', 'a.dump', body, now),
    );
  });

  it('streams the upload without materializing the whole dump as a Buffer', async () => {
    const source = new Uint8Array(256 * 1024);
    for (let i = 0; i < source.length; i++) source[i] = i % 251;
    const file = fixture(source);
    const observed: string[] = [];

    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit & { duplex?: string }) => {
      expect(options.duplex).toBe('half');
      expect(options.body).toBeInstanceOf(ReadableStream);
      const bytes = new Uint8Array(await new Response(options.body).arrayBuffer());
      expect(bytes).toEqual(source);
      const headers = options.headers as Record<string, string>;
      expect(headers['content-length']).toBe(String(source.length));
      expect(headers['x-amz-content-sha256']).toBe(createHash('sha256').update(source).digest('hex'));
      observed.push(String(options.method));
      return new Response(null, { status: 200 });
    }));
    const put = await new S3Storage(config).putFile('production/db.dump', file);
    expect(put).toEqual({
      key: 'production/db.dump',
      size: source.length,
      sha256: createHash('sha256').update(source).digest('hex'),
    });
    expect(observed).toEqual(['PUT']);
  });

  it('fails closed on a remote upload failure without claiming success', async () => {
    const file = fixture(Buffer.from('dump'));
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
      await new Response(options.body).arrayBuffer();
      return new Response(null, { status: 503 });
    }));
    await expect(new S3Storage(config).putFile('a.dump', file)).rejects.toMatchObject({
      code: 'UPLOAD_FAILED',
    });
  });

  it('rejects oversized single PUT uploads before contacting S3', async () => {
    const file = fixture(Buffer.from('x'));
    truncateSync(file, MAX_SINGLE_PUT_BYTES + 1); // sparse file; no large allocation
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(new S3Storage(config).putFile('a.dump', file)).rejects.toMatchObject({
      code: 'UPLOAD_TOO_LARGE',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
