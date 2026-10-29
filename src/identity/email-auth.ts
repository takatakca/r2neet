// Codex — assistant OpenAI · 2026-10-29
import { IdentityError } from './identity.js';

export interface EmailAuthProvider {
  readonly configured: boolean;
  send(email: string): Promise<void>;
  verify(email: string, code: string): Promise<{ subject: string; email: string }>;
}

/** Server-to-server OTP: never trust browser JWTs or user_metadata. */
export class SupabaseEmailAuthProvider implements EmailAuthProvider {
  private readonly url?: string;
  private readonly key?: string;
  private readonly enabled: boolean;
  constructor(env: Record<string, string | undefined> = process.env, private readonly fetcher: typeof fetch = fetch) {
    this.url = env.TAKATAK_SUPABASE_URL?.trim().replace(/\/+$/, '');
    this.key = env.TAKATAK_SUPABASE_ANON_KEY?.trim();
    // Opt in only after SMTP and the {{ .Token }} email template are verified.
    this.enabled = env.R2NETTE_EMAIL_AUTH_ENABLED === 'true';
  }
  get configured(): boolean {
    if (!this.enabled || !this.url || !this.key) return false;
    try { return new URL(this.url).protocol === 'https:'; } catch { return false; }
  }
  private async request(operation: 'otp' | 'verify', payload: object): Promise<unknown> {
    if (!this.configured) throw new IdentityError('Email sign-in is not configured.', 'EMAIL_AUTH_NOT_CONFIGURED');
    let response: Response;
    try {
      response = await this.fetcher(`${this.url}/auth/v1/${operation}`, {
        method: 'POST', headers: { apikey: this.key!, Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000),
      });
    } catch { throw new IdentityError('Email sign-in is temporarily unavailable.', 'EMAIL_AUTH_UNAVAILABLE'); }
    if (response.status === 429) throw new IdentityError('Please wait before trying again.', 'OTP_PROVIDER_LIMIT');
    if (!response.ok) throw new IdentityError('The code is invalid or expired.', operation === 'verify' && response.status < 500 ? 'EMAIL_CODE_INVALID' : 'EMAIL_AUTH_UNAVAILABLE');
    try { return await response.json(); } catch { throw new IdentityError('Email sign-in is temporarily unavailable.', 'EMAIL_AUTH_UNAVAILABLE'); }
  }
  async send(email: string): Promise<void> {
    await this.request('otp', { email, create_user: true });
  }
  async verify(email: string, code: string): Promise<{ subject: string; email: string }> {
    const body = await this.request('verify', { email, token: code, type: 'email' }) as { user?: { id?: unknown; email?: unknown; email_confirmed_at?: unknown } };
    const u = body?.user;
    if (!u || typeof u.id !== 'string' || !u.id || typeof u.email !== 'string' || u.email.toLowerCase() !== email || typeof u.email_confirmed_at !== 'string' || !Number.isFinite(Date.parse(u.email_confirmed_at))) {
      throw new IdentityError('The code is invalid or expired.', 'EMAIL_CODE_INVALID');
    }
    return { subject: u.id, email };
  }
}
