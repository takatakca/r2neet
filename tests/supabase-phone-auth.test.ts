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
