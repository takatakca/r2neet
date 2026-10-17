import { describe, expect, it } from 'vitest';
import {
  IdentityError,
  SupabasePhoneAuthProvider,
} from '../src/identity/identity.js';

const CONFIG = {
  TAKATAK_SUPABASE_URL: 'https://project.supabase.co/',
  TAKATAK_SUPABASE_ANON_KEY: 'public-anon-key',
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function providerWith(
  reply: (url: string, init: RequestInit) => Promise<Response>,
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const request = init ?? {};
    calls.push({ url, init: request });
    return reply(url, request);
  }) as typeof fetch;
  return {
    calls,
    provider: new SupabasePhoneAuthProvider(CONFIG, fetcher),
  };
}

describe('TAKATAK Supabase phone auth provider', () => {
  it('requires a valid HTTPS project URL and anon key', () => {
    expect(new SupabasePhoneAuthProvider({}).configured).toBe(false);
    expect(
      new SupabasePhoneAuthProvider({
        ...CONFIG,
        TAKATAK_SUPABASE_URL: 'http://project.supabase.co',
      }).configured,
    ).toBe(false);
    expect(
      new SupabasePhoneAuthProvider({
        ...CONFIG,
        TAKATAK_SUPABASE_URL: 'http://localhost:54321',
      }).configured,
    ).toBe(true);
  });

  it('requests phone OTP through TAKATAK Auth without exposing account existence', async () => {
    const { calls, provider } = providerWith(async () => response({}));

    await expect(provider.start('+15148252825')).resolves.toEqual({
      status: 'PENDING',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://project.supabase.co/auth/v1/otp');
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.apikey).toBe('public-anon-key');
    expect(headers.Authorization).toBe(['Bearer ', 'public-anon-key'].join(''));
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      phone: '+15148252825',
      create_user: true,
      // Same tag the other TAKATAK tenant applications send; applied by
      // TAKATAK only when the identity is first created.
      data: { source_application: 'R2NETTE' },
    });
  });

  it('logs the GoTrue error code of a refused SMS without the phone number', async () => {
    const lines: Array<Record<string, unknown>> = [];
    const fetcher = (async () =>
      response(
        {
          code: 422,
          error_code: 'phone_provider_disabled',
          msg: 'Unsupported phone provider',
        },
        422,
      )) as typeof fetch;
    const provider = new SupabasePhoneAuthProvider(CONFIG, fetcher, (line) => {
      lines.push(line);
    });

    await expect(provider.start('+15148252825')).rejects.toMatchObject({
      code: 'VERIFY_PROVIDER_UNAVAILABLE',
      message: 'TAKATAK could not send a verification code.',
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'warn',
      msg: 'takatak_otp_send_failed',
      status: 422,
      errorCode: 'phone_provider_disabled',
      detail: 'Unsupported phone provider',
    });
    expect(JSON.stringify(lines[0])).not.toContain('5148252825');
  });

  it('treats a GoTrue SMS rate-limit error code as the local OTP limit', async () => {
    const { provider } = providerWith(async () =>
      response(
        { error_code: 'over_sms_send_rate_limit', msg: 'SMS rate limit exceeded' },
        400,
      ),
    );

    await expect(provider.start('+15148252825')).rejects.toMatchObject({
      code: 'OTP_PROVIDER_LIMIT',
    });
  });

  describe('live configuration probe', () => {
    const settings = (overrides: Record<string, unknown>) =>
      response({
        external: { google: true, phone: true },
        disable_signup: false,
        phone_autoconfirm: false,
        sms_provider: 'twilio',
        ...overrides,
      });

    it('reports NOT_CONFIGURED without keys and never calls the network', async () => {
      const calls: string[] = [];
      const fetcher = (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return response({});
      }) as typeof fetch;

      const result = await new SupabasePhoneAuthProvider({}, fetcher).diagnose();

      expect(result.status).toBe('NOT_CONFIGURED');
      expect(calls).toEqual([]);
    });

    it('asks the project settings endpoint with the anon key only', async () => {
      const { calls, provider } = providerWith(async () => settings({}));

      const result = await provider.diagnose();

      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe('https://project.supabase.co/auth/v1/settings');
      expect(calls[0]!.init.method).toBe('GET');
      expect((calls[0]!.init.headers as Record<string, string>).apikey).toBe(
        'public-anon-key',
      );
      expect(result).toEqual({
        status: 'READY',
        detail: expect.stringContaining('twilio'),
        smsProvider: 'twilio',
      });
      expect(result.detail).not.toContain('public-anon-key');
    });

    it('flags phone sign-in switched off on the TAKATAK project', async () => {
      const { provider } = providerWith(async () =>
        settings({ external: { google: true, phone: false }, sms_provider: '' }),
      );

      const result = await provider.diagnose();

      expect(result.status).toBe('PHONE_DISABLED');
      expect(result.smsProvider).toBeNull();
      expect(result.detail).toMatch(/Phone sign-in is switched off/);
    });

    it('flags phone auto-confirm, which means no SMS is ever sent', async () => {
      const { provider } = providerWith(async () =>
        settings({ phone_autoconfirm: true }),
      );

      await expect(provider.diagnose()).resolves.toMatchObject({
        status: 'PHONE_DISABLED',
        detail: expect.stringContaining('auto-confirm'),
      });
    });

    it('explains a rejected key and a dead project instead of throwing', async () => {
      const rejected = providerWith(async () => response({ message: 'Invalid API key' }, 401));
      await expect(rejected.provider.diagnose()).resolves.toMatchObject({
        status: 'UNREACHABLE',
        detail: expect.stringContaining('TAKATAK_SUPABASE_ANON_KEY'),
      });

      const dead = providerWith(async () => {
        throw new TypeError('fetch failed');
      });
      await expect(dead.provider.diagnose()).resolves.toMatchObject({
        status: 'UNREACHABLE',
      });
    });
  });

  it('accepts only a confirmed Supabase identity for the exact requested phone', async () => {
    const { provider } = providerWith(async () =>
      response({
        user: {
          id: 'supabase-user-id',
          phone: '+15148252825',
          phone_confirmed_at: '2026-10-07T00:00:00.000Z',
        },
      }),
    );

    await expect(provider.check('+15148252825', '123456')).resolves.toEqual({
      status: 'APPROVED',
    });
  });

  it('rejects unconfirmed, mismatched, or malformed user identities', async () => {
    const cases = [
      { id: 'id', phone: '+15148252825' },
      {
        id: 'id',
        phone: '+15145551234',
        phone_confirmed_at: '2026-10-07T00:00:00.000Z',
      },
      {
        phone: '+15148252825',
        phone_confirmed_at: '2026-10-07T00:00:00.000Z',
      },
    ];

    for (const user of cases) {
      const { provider } = providerWith(async () => response({ user }));
      await expect(provider.check('+15148252825', '123456')).resolves.toEqual({
        status: 'DENIED',
      });
    }
  });

  it('fails closed and does not return upstream error details', async () => {
    const { provider } = providerWith(async () =>
      response({ message: 'private upstream diagnostic' }, 503),
    );

    await expect(provider.start('+15148252825')).rejects.toMatchObject({
      code: 'VERIFY_PROVIDER_UNAVAILABLE',
      message: 'TAKATAK could not send a verification code.',
    });
    await expect(provider.check('+15148252825', '123456')).rejects.toBeInstanceOf(
      IdentityError,
    );
  });

  it('maps Supabase rate limits to the local OTP limit response', async () => {
    const { provider } = providerWith(async () =>
      response({ message: 'rate limit' }, 429),
    );

    await expect(provider.start('+15148252825')).rejects.toMatchObject({
      code: 'OTP_PROVIDER_LIMIT',
    });
  });
});
