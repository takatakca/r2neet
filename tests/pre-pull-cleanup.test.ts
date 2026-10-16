import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const roots: string[] = [];
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

const repo = 'ghcr.io/takatakca/r2neet';
const sha = (s: string) => s.repeat(40);
function fixtures(current: string | null, previous?: string) {
  const root = mkdtempSync(join(tmpdir(), 'r2nette-clean-'));
  roots.push(root);
  const state = join(root, 'state');
  const bin = join(root, 'bin');
  mkdirSync(state);
  mkdirSync(bin);
  if (current) writeFileSync(join(state, 'current-image-ref'), current + '\n');
  if (previous) writeFileSync(join(state, 'previous-image-ref'), previous + '\n');
  const docker = join(bin, 'docker');
  writeFileSync(docker, `#!/usr/bin/env bash
if [[ "$1" = image && "$2" = ls ]]; then
  printf '%s\\n' "$MOCK_IMAGE_LIST"
elif [[ "$1" = image && "$2" = rm ]]; then
  printf '%s\\n' "$3" >> "$MOCK_REMOVED"
else
  exit 32
fi
`);
  chmodSync(docker, 0o755);
  const removed = join(root, 'removed');
  return { state, bin, removed };
}

function cleanup(f: ReturnType<typeof fixtures>, target: string, images: string) {
  return execFileSync('bash', [
    resolve('scripts/deploy/pre-pull-cleanup.sh'),
    'takatakca', 'r2neet', target, f.state,
  ], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${f.bin}:${process.env.PATH ?? ''}`, MOCK_IMAGE_LIST: images, MOCK_REMOVED: f.removed },
  });
}
function removed(f: ReturnType<typeof fixtures>): string[] {
  try { return readFileSync(f.removed, 'utf8').trim().split('\n'); } catch { return []; }
}

describe('safe scoped pre-pull disk cleanup', () => {
  it('keeps the current, rollback and target images; ignores all other apps and untagged refs', () => {
    const current = `${repo}:${sha('a')}`;
    const previous = `${repo}:${sha('b')}`;
    const target = `${repo}:${sha('c')}`;
    const old = `${repo}:${sha('d')}`;
    const f = fixtures(current, previous);
    cleanup(f, target, [current, previous, target, old, 'ghcr.io/takatakca/other:' + sha('f'), 'r2nette:<none>'].join('\n'));
    expect(removed(f)).toEqual([old]);
  });

  it('refuses cleanup when the current release has no verified ref', () => {
    const f = fixtures(null);
    expect(cleanup(f, `${repo}:${sha('a')}`, `${repo}:${sha('b')}`)).toMatch(/skipping/);
    expect(removed(f)).toEqual([]);
  });

  it('refuses an invalid or cross-tenant previous-image-ref', () => {
    const f = fixtures(`${repo}:${sha('a')}`, `ghcr.io/takatakca/other:${sha('b')}`);
    expect(() => cleanup(f, `${repo}:${sha('c')}`, `${repo}:${sha('d')}`)).toThrow();
    expect(removed(f)).toEqual([]);
  });
});
