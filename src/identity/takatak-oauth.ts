// Claude (Anthropic) · 2026-11-10 — "Continuer avec TAKATAK"
//
// TAKATAK is the central identity for every site in the group. R2NETTE is a
// public OAuth 2.1 client of the TAKATAK Supabase project: the browser goes to
// TAKATAK, the customer signs in or creates a TAKATAK account there, and
// TAKATAK sends back a one-time code. This server exchanges the code (PKCE,
// no client secret) and reads the customer's identity from TAKATAK's UserInfo
// endpoint. The browser never sees a TAKATAK token.
import { IdentityError } from './identity.js';

export interface TakatakIdentity {
  /** TAKATAK user id. Same id space as Customer.emailAuthSubject. */
  subject: string;
  email: string | null;
  emailVerified: boolean;
  phone: string | null;
  phoneVerified: boolean;
  name: string | null;
}

export interface TakatakOAuthProvider {
  readonly configured: boolean;
  authorizationUrl(input: { redirectUri: string; challenge: string; state: string; locale: 'fr' | 'en' }): Promise<string>;
  exchangeCode(input: { code: string; verifier: string; redirectUri: string }): Promise<TakatakIdentity>;
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
}

const SCOPE = 'openid email profile phone';
const E164 = /^\+[1-9]\d{6,14}$/;
const text = (v: unknown, max = 254): string | null =>
  typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null;

export class SupabaseTakatakOAuthProvider implements TakatakOAuthProvider {
  private readonly issuer?: string;
  private readonly clientId?: string;
  private readonly anonKey?: string;
  private discovery?: { value: Discovery; at: number };

  constructor(
    env: Record<string, string | undefined> = process.env,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    const url = env.TAKATAK_SUPABASE_URL?.trim().replace(/\/+$/, '');
    this.issuer = url ? `${url}/auth/v1` : undefined;
    this.clientId = env.TAKATAK_OAUTH_CLIENT_ID?.trim() || undefined;
    this.anonKey = env.TAKATAK_SUPABASE_ANON_KEY?.trim() || undefined;
  }

  get configured(): boolean {
    if (!this.issuer || !this.clientId) return false;
    try {
      return new URL(this.issuer).protocol === 'https:';
    } catch {
      return false;
    }
  }

  private unavailable(): never {
    throw new IdentityError('TAKATAK sign-in is temporarily unavailable.', 'TAKATAK_AUTH_UNAVAILABLE');
  }

  /** Endpoints must stay on the TAKATAK issuer host. */
  private sameHost(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.host === new URL(this.issuer!).host ? url.toString() : null;
    } catch {
      return null;
    }
  }

  private async endpoints(): Promise<Discovery> {
    if (!this.configured) {
      throw new IdentityError('TAKATAK sign-in is not configured.', 'TAKATAK_AUTH_NOT_CONFIGURED');
    }
    if (this.discovery && Date.now() - this.discovery.at < 3_600_000) return this.discovery.value;
    const fallback: Discovery = {
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      userinfo_endpoint: `${this.issuer}/oauth/userinfo`,
    };
    let value = fallback;
    try {
      const res = await this.fetcher(`${this.issuer}/.well-known/openid-configuration`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        const doc = (await res.json()) as Record<string, unknown>;
        value = {
          authorization_endpoint: this.sameHost(doc.authorization_endpoint) ?? fallback.authorization_endpoint,
          token_endpoint: this.sameHost(doc.token_endpoint) ?? fallback.token_endpoint,
          userinfo_endpoint: this.sameHost(doc.userinfo_endpoint) ?? fallback.userinfo_endpoint,
        };
      }
    } catch {
      // The conventional Supabase paths are used when discovery is unreachable.
    }
    this.discovery = { value, at: Date.now() };
    return value;
  }

  async authorizationUrl(input: { redirectUri: string; challenge: string; state: string; locale: 'fr' | 'en' }): Promise<string> {
    const { authorization_endpoint } = await this.endpoints();
    const url = new URL(authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.clientId!);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('scope', SCOPE);
    url.searchParams.set('code_challenge', input.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', input.state);
    url.searchParams.set('ui_locales', input.locale);
    return url.toString();
  }

  async exchangeCode(input: { code: string; verifier: string; redirectUri: string }): Promise<TakatakIdentity> {
    const { token_endpoint, userinfo_endpoint } = await this.endpoints();
    const keyHeaders: Record<string, string> = this.anonKey ? { apikey: this.anonKey } : {};

    let tokenResponse: Response;
    try {
      tokenResponse = await this.fetcher(token_endpoint, {
        method: 'POST',
        headers: { ...keyHeaders, 'Content-Type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: input.code,
          client_id: this.clientId!,
          redirect_uri: input.redirectUri,
          code_verifier: input.verifier,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      this.unavailable();
    }
    if (!tokenResponse.ok) {
      throw new IdentityError('TAKATAK refused this sign-in. Please start again.', 'TAKATAK_CODE_INVALID');
    }
    const tokens = (await tokenResponse.json().catch(() => null)) as { access_token?: unknown } | null;
    const accessToken = text(tokens?.access_token, 8192);
    if (!accessToken) this.unavailable();

    let userResponse: Response;
    try {
      userResponse = await this.fetcher(userinfo_endpoint, {
        headers: { ...keyHeaders, Authorization: `Bearer ${accessToken}`, accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      this.unavailable();
    }
    if (!userResponse.ok) this.unavailable();
    const claims = (await userResponse.json().catch(() => null)) as Record<string, unknown> | null;
    const subject = text(claims?.sub, 128);
    if (!claims || !subject) this.unavailable();

    const email = text(claims.email)?.toLowerCase() ?? null;
    const phoneRaw = text(claims.phone_number, 32);
    const phone = phoneRaw ? (phoneRaw.startsWith('+') ? phoneRaw : `+${phoneRaw}`) : null;
    return {
      subject,
      email,
      emailVerified: Boolean(email) && claims.email_verified === true,
      phone: phone && E164.test(phone) ? phone : null,
      phoneVerified: Boolean(phone && E164.test(phone)) && claims.phone_number_verified === true,
      name: text(claims.name, 160),
    };
  }
}
