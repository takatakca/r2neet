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

/** A TAKATAK user session obtained on this server (email code or Google). */
export interface HubSession {
  accessToken: string;
  /** TAKATAK user id. Same id space as Customer.emailAuthSubject. */
  subject: string;
  email: string | null;
  phone: string | null;
}

/** What the consent screen on r2nette.ca shows. */
export interface ConsentDetails {
  authorizationId: string;
  appName: string;
  returnAddress: string;
  account: string;
  scopes: string[];
}

export type AuthorizationView =
  | { kind: 'consent'; details: ConsentDetails }
  | { kind: 'approved'; redirectUrl: string };

export interface TakatakOAuthProvider {
  readonly configured: boolean;
  /** Google through the hub needs the public key on top of the client id. */
  readonly googleConfigured: boolean;
  authorizationUrl(input: { redirectUri: string; challenge: string; state: string; locale: 'fr' | 'en' }): Promise<string>;
  exchangeCode(input: { code: string; verifier: string; redirectUri: string }): Promise<TakatakIdentity>;
  // Claude (Anthropic) · 2026-11-11 — sign-in on r2nette.ca without visiting takatak.ca.
  /**
   * Ask the hub to email a sign-in code. `redirectTo` names the site that asked: the hub's
   * email template reads it ({{ .RedirectTo }}) so each site's code email speaks about
   * that site and not another. A value the hub does not allow is ignored (it answers 200).
   */
  sendEmailCode(email: string, options?: { redirectTo?: string }): Promise<void>;
  verifyEmailCode(email: string, code: string): Promise<HubSession>;
  /** The hub keeps its own state for Google and never returns ours; PKCE binds the code to this browser. */
  googleAuthorizationUrl(input: { redirectUri: string; challenge: string }): string;
  exchangeGoogleCode(input: { code: string; verifier: string }): Promise<HubSession>;
  /** Opens the R2NETTE authorization in the hub; returns its id without a browser. */
  beginAuthorization(input: { redirectUri: string; challenge: string; state: string; locale: 'fr' | 'en' }): Promise<string>;
  authorizationDetails(input: { authorizationId: string; accessToken: string; subject: string; locale: 'fr' | 'en' }): Promise<AuthorizationView>;
  decideConsent(input: { authorizationId: string; accessToken: string; decision: 'approve' | 'deny' }): Promise<string>;
  /** Ends the hub session this server held for the consent step. Never throws. */
  revokeSession(accessToken: string): Promise<void>;
}

const AUTHORIZATION_ID = /^[a-z2-7]{32}$/;

const SCOPE_TEXT: Record<string, { fr: string; en: string }> = {
  openid: { fr: 'Confirmer que vous êtes connecté à TAKATAK', en: 'Confirm that you are signed in to TAKATAK' },
  email: { fr: 'Voir votre adresse courriel', en: 'See your email address' },
  profile: { fr: 'Voir votre nom et votre profil', en: 'See your name and profile' },
  phone: { fr: 'Voir votre numéro de téléphone', en: 'See your phone number' },
  offline_access: { fr: 'Rester connecté après avoir fermé l’application', en: 'Stay connected after you close the application' },
};

/** Same wording as takatak.ca's consent page, so the screen reads the same everywhere. */
export function consentScopeText(scope: string, locale: 'fr' | 'en'): string[] {
  return scope
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => {
      const known = SCOPE_TEXT[part];
      if (known) return known[locale];
      const safe = /^[a-z0-9_.:/-]{1,64}$/i.test(part) ? part : '?';
      return locale === 'fr' ? `Accès « ${safe} »` : `Access “${safe}”`;
    });
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
      const url = new URL(this.issuer);
      // https everywhere; plain http only for a hub stub on this machine.
      const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
      return url.protocol === 'https:' || local;
    } catch {
      return false;
    }
  }

  get googleConfigured(): boolean {
    return this.configured && Boolean(this.anonKey);
  }

  private hubHeaders(accessToken?: string): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json', 'Content-Type': 'application/json' };
    if (this.anonKey) headers.apikey = this.anonKey;
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    return headers;
  }

  /** One hub call; network failures and 5xx are "unavailable", never a 4xx code. */
  private async hub(path: string, init: RequestInit): Promise<Response> {
    if (!this.issuer) this.unavailable();
    let response: Response;
    try {
      response = await this.fetcher(`${this.issuer}${path}`, { ...init, signal: AbortSignal.timeout(10_000) });
    } catch {
      this.unavailable();
    }
    if (response.status >= 500) this.unavailable();
    return response;
  }

  private static async body(response: Response): Promise<Record<string, unknown> | null> {
    return (await response.json().catch(() => null)) as Record<string, unknown> | null;
  }

  private sessionFrom(body: Record<string, unknown> | null): HubSession | null {
    const accessToken = text(body?.access_token, 8192);
    const user = (body?.user ?? null) as Record<string, unknown> | null;
    const subject = text(user?.id, 128);
    if (!accessToken || !subject) return null;
    const email = text(user?.email)?.toLowerCase() ?? null;
    const phoneRaw = text(user?.phone, 32);
    const phone = phoneRaw ? (phoneRaw.startsWith('+') ? phoneRaw : `+${phoneRaw}`) : null;
    return { accessToken, subject, email, phone: phone && E164.test(phone) ? phone : null };
  }

  async sendEmailCode(email: string, options: { redirectTo?: string } = {}): Promise<void> {
    const query = options.redirectTo ? `?redirect_to=${encodeURIComponent(options.redirectTo)}` : '';
    const response = await this.hub(`/otp${query}`, { method: 'POST', headers: this.hubHeaders(), body: JSON.stringify({ email, create_user: true }) });
    if (response.status === 429) throw new IdentityError('Please wait before trying again.', 'OTP_PROVIDER_LIMIT');
    if (!response.ok) this.unavailable();
  }

  async verifyEmailCode(email: string, code: string): Promise<HubSession> {
    const response = await this.hub('/verify', { method: 'POST', headers: this.hubHeaders(), body: JSON.stringify({ type: 'email', email, token: code }) });
    if (response.status === 429) throw new IdentityError('Please wait before trying again.', 'OTP_PROVIDER_LIMIT');
    const invalid = () => new IdentityError('The code is invalid or expired.', 'EMAIL_CODE_INVALID');
    if (!response.ok) throw invalid();
    const body = await SupabaseTakatakOAuthProvider.body(response);
    const session = this.sessionFrom(body);
    const user = (body?.user ?? null) as Record<string, unknown> | null;
    const confirmedAt = text(user?.email_confirmed_at, 64);
    if (!session || session.email !== email || !confirmedAt || !Number.isFinite(Date.parse(confirmedAt))) throw invalid();
    return session;
  }

  googleAuthorizationUrl(input: { redirectUri: string; challenge: string }): string {
    if (!this.googleConfigured) {
      throw new IdentityError('TAKATAK Google authentication is not configured.', 'GOOGLE_AUTH_NOT_CONFIGURED');
    }
    const url = new URL(`${this.issuer}/authorize`);
    url.searchParams.set('provider', 'google');
    url.searchParams.set('redirect_to', input.redirectUri);
    url.searchParams.set('code_challenge', input.challenge);
    url.searchParams.set('code_challenge_method', 's256');
    return url.toString();
  }

  async exchangeGoogleCode(input: { code: string; verifier: string }): Promise<HubSession> {
    const response = await this.hub('/token?grant_type=pkce', {
      method: 'POST',
      headers: this.hubHeaders(),
      body: JSON.stringify({ auth_code: input.code, code_verifier: input.verifier }),
    });
    const denied = () => new IdentityError('Google sign-in could not be completed.', 'GOOGLE_AUTH_DENIED');
    if (!response.ok) throw denied();
    const body = await SupabaseTakatakOAuthProvider.body(response);
    const session = this.sessionFrom(body);
    const user = (body?.user ?? null) as { app_metadata?: { providers?: unknown }; identities?: Array<{ provider?: unknown }> } | null;
    const providers = [
      ...(Array.isArray(user?.app_metadata?.providers) ? user.app_metadata.providers : []),
      ...(Array.isArray(user?.identities) ? user.identities.map((identity) => identity?.provider) : []),
    ];
    if (!session || !providers.includes('google')) throw denied();
    return session;
  }

  async beginAuthorization(input: { redirectUri: string; challenge: string; state: string; locale: 'fr' | 'en' }): Promise<string> {
    const url = await this.authorizationUrl(input);
    let response: Response;
    try {
      response = await this.fetcher(url, { redirect: 'manual', headers: { accept: 'text/html' }, signal: AbortSignal.timeout(10_000) });
    } catch {
      this.unavailable();
    }
    if (response.status >= 500) this.unavailable();
    const invalid = () => new IdentityError('TAKATAK could not open this authorization.', 'CONSENT_INVALID');
    const location = response.headers.get('location');
    if (response.status < 300 || response.status > 399 || !location) throw invalid();
    let target: URL;
    try {
      target = new URL(location, url);
    } catch {
      throw invalid();
    }
    const issuerHost = new URL(this.issuer!).host;
    if (target.protocol !== 'https:' || (target.host !== 'takatak.ca' && target.host !== issuerHost)) throw invalid();
    const id = target.searchParams.get('authorization_id') ?? '';
    if (!AUTHORIZATION_ID.test(id)) throw invalid();
    return id;
  }

  async authorizationDetails(input: { authorizationId: string; accessToken: string; subject: string; locale: 'fr' | 'en' }): Promise<AuthorizationView> {
    const response = await this.hub(`/oauth/authorizations/${input.authorizationId}`, { headers: this.hubHeaders(input.accessToken) });
    const invalid = () => new IdentityError('TAKATAK cannot read this authorization.', 'CONSENT_INVALID');
    if (response.status === 404 || response.status === 410) throw SupabaseTakatakOAuthProvider.gone();
    if (!response.ok) throw invalid();
    const data = await SupabaseTakatakOAuthProvider.body(response);
    if (!data) throw invalid();
    if (typeof data.authorization_id === 'string') {
      const user = (data.user ?? null) as Record<string, unknown> | null;
      const client = (data.client ?? null) as Record<string, unknown> | null;
      const returnAddress = text(data.redirect_uri, 2048);
      if (data.authorization_id !== input.authorizationId || text(user?.id, 128) !== input.subject || !returnAddress) throw invalid();
      const email = text(user?.email)?.toLowerCase() ?? null;
      const account = email && email.includes('@')
        ? email
        : input.locale === 'fr' ? 'Compte TAKATAK connecté' : 'Signed-in TAKATAK account';
      return {
        kind: 'consent',
        details: {
          authorizationId: input.authorizationId,
          appName: text(client?.name, 80) ?? (input.locale === 'fr' ? 'Une application' : 'An application'),
          returnAddress,
          account,
          scopes: consentScopeText(typeof data.scope === 'string' ? data.scope : '', input.locale),
        },
      };
    }
    const redirectUrl = text(data.redirect_url, 2048);
    if (redirectUrl) return { kind: 'approved', redirectUrl };
    throw invalid();
  }

  async decideConsent(input: { authorizationId: string; accessToken: string; decision: 'approve' | 'deny' }): Promise<string> {
    const response = await this.hub(`/oauth/authorizations/${input.authorizationId}/consent`, {
      method: 'POST',
      headers: this.hubHeaders(input.accessToken),
      body: JSON.stringify({ action: input.decision }),
    });
    const invalid = () => new IdentityError('TAKATAK could not record this choice.', 'CONSENT_INVALID');
    if (response.status === 404 || response.status === 410) throw SupabaseTakatakOAuthProvider.gone();
    if (!response.ok) throw invalid();
    const data = await SupabaseTakatakOAuthProvider.body(response);
    const redirectUrl = text(data?.redirect_url, 2048);
    if (!redirectUrl) throw invalid();
    return redirectUrl;
  }

  async revokeSession(accessToken: string): Promise<void> {
    if (!this.issuer) return;
    try {
      await this.fetcher(`${this.issuer}/logout?scope=local`, { method: 'POST', headers: this.hubHeaders(accessToken), signal: AbortSignal.timeout(5_000) });
    } catch {
      // Best effort: the R2NETTE session is what the customer uses from here.
    }
  }

  /** The hub no longer knows the authorization (expired or already decided). */
  private static gone(): IdentityError {
    return new IdentityError('This sign-in expired. Start again.', 'CONSENT_EXPIRED');
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
