import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebhookAlertSink, type AlertPayload } from '../src/workers/health.js';

const alert: AlertPayload = {
  key: 'worker:backup',
  severity: 'CRITICAL',
  category: 'BACKUP',
  title: 'Off-host backup failed',
  message: 'The remote backup was unavailable.',
  environment: 'test',
  occurredAt: '2026-10-16T00:00:00.000Z',
};

afterEach(() => vi.unstubAllGlobals());

describe('operational alert webhook timeouts', () => {
  it('uses a bounded abort signal for a successful alert', async () => {
    const fetchStub = vi.fn(async (_url: string, options: RequestInit) => {
      expect(options.method).toBe('POST');
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.signal?.aborted).toBe(false);
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetchStub);
    const sink = new WebhookAlertSink({ ALERT_WEBHOOK_URL: 'https://alerts.example.test' });
    await expect(sink.send(alert)).resolves.toBeUndefined();
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('rejects a receiver that never responds instead of waiting indefinitely', async () => {
    const fetchStub = vi.fn((_url: string, options: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = options.signal as AbortSignal;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    );
    vi.stubGlobal('fetch', fetchStub);
    const sink = new WebhookAlertSink({ ALERT_WEBHOOK_URL: 'https://alerts.example.test' }, 15);
    await expect(sink.send(alert)).rejects.toBeTruthy();
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('rejects non-success HTTP responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
    const sink = new WebhookAlertSink({ ALERT_WEBHOOK_URL: 'https://alerts.example.test' });
    await expect(sink.send(alert)).rejects.toThrow('Alert webhook returned 503');
  });
});
