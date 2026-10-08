import { IdentityError } from './identity.js';

export interface GoogleAuthIdentity {
  subject: string;
}

export interface GoogleAuthProvider {
  readonly configured: boolean;
  authorizationUrl(
    publicUrl: string,
    codeChallenge: string,
  ): string;
  exchangeCode(code: string, codeVerifier: string): Promise<GoogleAuthIdentity>;
}

/**
 * Google OAuth through TAKATAK's Supabase Auth project. Google credentials
 * remain in Supabase; R2NETTE only uses the public anon key and a verified
 * Supabase subject.
 */
export class SupabaseGoogleAuthProvider implements GoogleAuthProvider {
  private readonly url: string | undefined;
  private readonly anonKey: string | undefined;

  constructor(
    env: Record<string, string | undefined> = process.env,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.url = env.TAKATAK_SUPABASE_URL?.trim().replace(/\/+$/, '');
    this.anonKey = env.TAKATAK_SUPABASE_ANON_KEY?.trim();
  }

  get configured(): boolean {
    if (!this.url || !this.anonKey) return false;
    try {
      const url = new URL(this.url);
      return (
        Boolean(url.hostname) &&
        (url.protocol === 'https:' ||
          (url.protocol === 'http:' &&
            ['localhost', '127.0.0.1'].includes(url.hostname)))
      );
    } catch {
      return false;
    }
  }

  authorizationUrl(
    publicUrl: string,
    codeChallenge: string,
  ): string {
    if (!this.configured || !this.url) {
      throw new IdentityError(
        'TAKATAK Google authentication is not configured.',
        'GOOGLE_AUTH_NOT_CONFIGURED',
      );
    }
    const callback = new URL('/api/v1/auth/google/callback', publicUrl);
    const authorize = new URL(`${this.url}/auth/v1/authorize`);
    authorize.searchParams.set('provider', 'google');
    authorize.searchParams.set('redirect_to', callback.toString());
    authorize.searchParams.set('code_challenge', codeChallenge);
    authorize.searchParams.set('code_challenge_method', 's256');
    return authorize.toString();
  }

  async exchangeCode(
    code: string,
    codeVerifier: string,
  ): Promise<GoogleAuthIdentity> {
    if (!this.configured || !this.url || !this.anonKey) {
      throw new IdentityError(
        'TAKATAK Google authentication is not configured.',
        'GOOGLE_AUTH_NOT_CONFIGURED',
      );
    }

    let response: Response;
    try {
      response = await this.fetcher(
        `${this.url}/auth/v1/token?grant_type=pkce`,
        {
          method: 'POST',
          headers: {
            apikey: this.anonKey,
            Authorization: 'Bearer ' + this.anonKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            auth_code: code,
            code_verifier: codeVerifier,
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch {
      throw new IdentityError(
        'TAKATAK Google authentication is temporarily unavailable.',
        'GOOGLE_AUTH_PROVIDER_UNAVAILABLE',
      );
    }

    if (response.status >= 500) {
      throw new IdentityError(
        'TAKATAK Google authentication is temporarily unavailable.',
        'GOOGLE_AUTH_PROVIDER_UNAVAILABLE',
      );
    }
    if (!response.ok) {
      throw new IdentityError(
        'Google sign-in could not be completed.',
        'GOOGLE_AUTH_DENIED',
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new IdentityError(
        'TAKATAK returned an invalid Google authentication response.',
        'GOOGLE_AUTH_PROVIDER_UNAVAILABLE',
      );
    }

    if (!body || typeof body !== 'object') {
      throw new IdentityError(
        'TAKATAK returned an invalid Google authentication response.',
        'GOOGLE_AUTH_PROVIDER_UNAVAILABLE',
      );
    }

    const user = (body as { user?: unknown }).user;
    if (!user || typeof user !== 'object') {
      throw new IdentityError(
        'Google sign-in could not be completed.',
        'GOOGLE_AUTH_DENIED',
      );
    }

    const verifiedUser = user as {
      id?: unknown;
      app_metadata?: { providers?: unknown };
      identities?: Array<{ provider?: unknown }>;
    };
    const providers = [
      ...(Array.isArray(verifiedUser.app_metadata?.providers)
        ? verifiedUser.app_metadata.providers
        : []),
      ...(Array.isArray(verifiedUser.identities)
        ? verifiedUser.identities.map((identity) => identity?.provider)
        : []),
    ];

    if (
      typeof verifiedUser.id !== 'string' ||
      !verifiedUser.id ||
      !providers.includes('google')
    ) {
      throw new IdentityError(
        'Google sign-in could not be completed.',
        'GOOGLE_AUTH_DENIED',
      );
    }

    return { subject: verifiedUser.id };
  }
}
