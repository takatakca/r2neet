import { describe, expect, it, vi } from 'vitest';
import { requireOffHostBackup } from '../src/workers/backup-policy.js';

describe('off-host backup completion policy', () => {
  it('continues when the destination exists', async () => {
    const report = vi.fn(async () => undefined);
    await expect(requireOffHostBackup(true, report)).resolves.toBeUndefined();
    expect(report).not.toHaveBeenCalled();
  });

  it('rejects a local-only dump and creates an alert', async () => {
    const report = vi.fn(async () => undefined);
    await expect(requireOffHostBackup(false, report)).rejects.toThrow(/local dump retained/);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('fails even when the alert sink is broken', async () => {
    const report = vi.fn(async () => { throw new Error('sink down'); });
    await expect(requireOffHostBackup(false, report)).rejects.toThrow(/Off-host backup is not configured/);
    expect(report).toHaveBeenCalledTimes(1);
  });
});
