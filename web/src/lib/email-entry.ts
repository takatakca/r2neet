import './consent.js';
// Codex — assistant OpenAI · 2026-10-29 · Claude (Anthropic) · 2026-11-11
//
// Sign in or sign up on r2nette.ca with the TAKATAK account as the master:
// email code or Google, verified by TAKATAK through this site's server, then
// TAKATAK's "Autoriser l’accès" screen shown here, then the existing callback
// opens the R2NETTE session. The visitor never leaves r2nette.ca.
import { detectLocale, persistLocale } from '../i18n/index.js';

type Step = 'choose' | 'code' | 'consent';
let locale = detectLocale();
let busy = false;
let configured = false;
let step: Step = 'choose';
let consent: { app: string; returnAddress: string; account: string; scopes: string[]; needsTerms: boolean } | null = null;

const $ = (id: string) => document.getElementById(id)!;
const input = (id: string) => $(id) as HTMLInputElement;
const say = (fr: string, en: string) => (locale === 'fr' ? fr : en);

const copy: Record<string, [string, string]> = {
  eyebrow: ['Votre compte, simplement', 'Your account, simplified'],
  title: ['Votre courriel. Votre prochain ménage.', 'Your email. Your next clean.'],
  intro: [
    'Connectez-vous ou créez votre compte TAKATAK. Un seul compte pour R2NETTE et tous les sites du Groupe TAKATAK. Aucun mot de passe.',
    'Sign in or create your TAKATAK account. One account for R2NETTE and every Groupe TAKATAK website. No password.',
  ],
  emailLabel: ['Adresse courriel', 'Email address'],
  send: ['Recevoir mon code', 'Send my code'],
  orGoogle: ['ou', 'or'],
  googleLabel: ['Continuer avec Google', 'Continue with Google'],
  termsLabel: ['Nouveau client : j’accepte les conditions et la politique de confidentialité.', 'New customer: I accept the terms and privacy policy.'],
  termsLink: ['Conditions', 'Terms'],
  privacyLink: ['Confidentialité', 'Privacy'],
  codeLabel: ['Code reçu par courriel', 'Email verification code'],
  verify: ['Vérifier et continuer', 'Verify and continue'],
  change: ['Changer de courriel', 'Change email'],
  consentTitle: ['Autoriser l’accès', 'Authorize access'],
  consentIntro: ['R2NETTE demande l’accès à votre compte TAKATAK.', 'R2NETTE is asking to access your TAKATAK account.'],
  consentAppLabel: ['Application', 'Application'],
  consentReturnLabel: ['Adresse de retour', 'Return address'],
  consentAccountLabel: ['Compte', 'Account'],
  consentScopesLabel: ['Accès demandé', 'Requested access'],
  consentNote: ['TAKATAK ne transmet votre choix qu’à cette adresse de retour.', 'TAKATAK sends your choice only to this return address.'],
  consentTermsLabel: ['Nouveau client : j’accepte les conditions et la politique de confidentialité.', 'New customer: I accept the terms and privacy policy.'],
  consentTermsLink: ['Conditions', 'Terms'],
  consentPrivacyLink: ['Confidentialité', 'Privacy'],
  approve: ['Autoriser', 'Authorize'],
  deny: ['Refuser', 'Refuse'],
  smsNote: ['Après votre premier paiement, vous pourrez vérifier votre téléphone pour les confirmations SMS.', 'After your first payment, you can verify your phone for SMS confirmations.'],
  back: ['Retour au site', 'Back to the website'],
};

const reasons: Record<string, [string, string]> = {
  terms: ['Bienvenue ! Acceptez les conditions pour créer votre compte R2NETTE, puis recommencez.', 'Welcome! Accept the terms to create your R2NETTE account, then start again.'],
  'terms-needed': ['Cochez la case des conditions pour créer votre compte, puis touchez Autoriser.', 'Tick the terms box to create your account, then tap Authorize.'],
  cancelled: ['Vous avez refusé l’accès. Vous pouvez recommencer quand vous voulez.', 'You refused access. You can start again whenever you like.'],
  expired: ['La connexion a expiré. Recommencez.', 'The sign-in expired. Start again.'],
  'link-required': ['Un autre compte TAKATAK est déjà relié au compte R2NETTE de ce courriel. Utilisez ce compte, ou appelez le (514) 825-2825.', 'Another TAKATAK account is already linked to the R2NETTE account for this email. Use that account, or call (514) 825-2825.'],
  'email-required': ['Votre compte TAKATAK n’a pas de courriel confirmé. Utilisez le code par courriel ci-dessus.', 'Your TAKATAK account has no confirmed email. Use the email code above.'],
  unavailable: ['Connexion indisponible pour le moment. Réessayez ou appelez le (514) 825-2825.', 'Sign-in is unavailable right now. Try again or call (514) 825-2825.'],
  error: ['La connexion n’a pas fonctionné. Réessayez.', 'The sign-in did not work. Try again.'],
};

function translate(): void {
  document.documentElement.lang = locale;
  for (const [id, words] of Object.entries(copy)) $(id).textContent = words[locale === 'fr' ? 0 : 1];
  $('language').textContent = locale === 'fr' ? 'EN' : 'FR';
  googleLink();
  if (consent) renderConsent();
}

function returnTo(): string {
  const requested = new URLSearchParams(location.search).get('returnTo') || '/#book';
  try {
    const target = new URL(requested, location.origin);
    if (target.origin === location.origin && !target.pathname.startsWith('/api/')) return target.pathname + target.search + target.hash;
  } catch { /* default */ }
  return '/#book';
}

function googleLink(): void {
  const query = new URLSearchParams({ locale, returnTo: returnTo() });
  if (input('terms').checked) query.set('terms', '1');
  ($('googleButton') as HTMLAnchorElement).href = '/api/v1/auth/takatak/google/start?' + query.toString();
}

function show(next: Step): void {
  step = next;
  $('chooseStep').hidden = next !== 'choose';
  $('codeForm').hidden = next !== 'code';
  $('consentCard').hidden = next !== 'consent';
  $('smsNote').hidden = next === 'consent';
}

function status(text: string): void { $('status').textContent = text; }

class CallError extends Error {
  constructor(readonly code: string, readonly httpStatus: number) { super(code); }
}

async function call(path: string, method: 'GET' | 'POST', body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch('/api/v1/auth/takatak/' + path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
  if (!res.ok) throw new CallError(data?.error?.code ?? 'UNAVAILABLE', res.status);
  return data as Record<string, unknown>;
}

function explain(e: unknown): void {
  const code = e instanceof CallError ? e.code : '';
  const expired = e instanceof CallError && e.httpStatus === 410;
  if (code === 'TERMS_REQUIRED' && consent) { consent.needsTerms = true; renderConsent(); status(reasons['terms-needed']![locale === 'fr' ? 0 : 1]); return; }
  // The handoff is single-use: after a refused decision only a new start works.
  if (expired || code === 'CONSENT_INVALID') { consent = null; show('choose'); }
  status(
    expired ? reasons.expired![locale === 'fr' ? 0 : 1]
      : code === 'EMAIL_CODE_INVALID' ? say('Code invalide ou expiré. Vérifiez votre courriel ou demandez un nouveau code.', 'Invalid or expired code. Check your email or request a new code.')
        : /LIMIT|COOLDOWN/.test(code) ? say('Veuillez patienter avant de réessayer.', 'Please wait before trying again.')
          : code === 'VALIDATION_ERROR' ? say('Vérifiez le courriel et le code (6 chiffres).', 'Check the email and the code (6 digits).')
            : reasons.unavailable![locale === 'fr' ? 0 : 1],
  );
}

function lock(on: boolean): void {
  busy = on;
  document.querySelectorAll<HTMLButtonElement>('button').forEach((b) => { if (b.id !== 'language') b.disabled = on; });
}

function renderConsent(): void {
  if (!consent) return;
  $('consentApp').textContent = consent.app;
  $('consentReturn').textContent = consent.returnAddress;
  $('consentAccount').textContent = consent.account;
  const list = $('consentScopes');
  list.textContent = '';
  for (const scope of consent.scopes) {
    const item = document.createElement('li');
    item.textContent = scope;
    list.append(item);
  }
  // A first-time customer accepts the terms here, where they are, not after a failure.
  $('consentTermsRow').hidden = !consent.needsTerms;
}

/** After a code or Google: fetch the authorization details and show the TAKATAK screen, or finish. */
async function openConsent(): Promise<void> {
  const data = await call('consent?locale=' + locale, 'GET');
  if (typeof data.next === 'string') { location.assign(data.next); return; }
  consent = {
    app: String(data.app ?? ''),
    returnAddress: String(data.returnAddress ?? ''),
    account: String(data.account ?? ''),
    scopes: Array.isArray(data.scopes) ? data.scopes.map(String) : [],
    needsTerms: data.needsTerms === true,
  };
  renderConsent();
  status('');
  show('consent');
  $('approve').focus();
}

async function decide(decision: 'approve' | 'deny'): Promise<void> {
  if (busy) return;
  if (decision === 'approve' && consent?.needsTerms && !input('consentTerms').checked) {
    status(reasons['terms-needed']![locale === 'fr' ? 0 : 1]);
    input('consentTerms').focus();
    return;
  }
  lock(true);
  try {
    const data = await call('consent', 'POST', consent?.needsTerms && decision === 'approve' ? { decision, terms: true } : { decision });
    if (typeof data.next === 'string') { location.assign(data.next); return; }
    throw new CallError('UNAVAILABLE', 500);
  } catch (e) {
    explain(e);
    lock(false);
  }
}

$('emailForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (busy || !configured) return;
  lock(true);
  status('');
  try {
    await call('email/send', 'POST', { email: input('email').value.trim() });
    show('code');
    input('code').value = '';
    input('code').focus();
    status(say('Code envoyé. Vérifiez aussi vos indésirables.', 'Code sent. Check your spam folder too.'));
  } catch (err) {
    explain(err);
  } finally {
    lock(false);
  }
});

$('codeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (busy) return;
  lock(true);
  status('');
  try {
    const data = await call('email/verify', 'POST', {
      email: input('email').value.trim(),
      code: input('code').value.replace(/\s+/g, ''),
      locale,
      terms: input('terms').checked,
      returnTo: returnTo(),
    });
    if (typeof data.next === 'string') { location.assign(data.next); return; }
    await openConsent();
    lock(false);
  } catch (err) {
    explain(err);
    lock(false);
  }
});

$('change').addEventListener('click', () => {
  if (busy) return;
  show('choose');
  input('code').value = '';
  status('');
  input('email').focus();
});
$('approve').addEventListener('click', () => { void decide('approve'); });
$('deny').addEventListener('click', () => { void decide('deny'); });
$('language').addEventListener('click', () => {
  locale = locale === 'fr' ? 'en' : 'fr';
  persistLocale(locale);
  translate();
  // The access lines come from TAKATAK in one language; ask for them again.
  if (step === 'consent' && !busy) openConsent().catch(explain);
});
input('terms').addEventListener('change', googleLink);

translate();
input('send').disabled = true;
const params = new URLSearchParams(location.search);

/**
 * Already signed in? Then the sign-in page has nothing to ask: go where the customer was
 * headed, or to their account. (The Account menu link used to land here and showed the form
 * to a signed-in customer.) Not while a sign-in is in progress or just failed, and not right
 * after the account page sent the visitor here, so the two can never send each other back.
 */
async function leaveIfSignedIn(): Promise<void> {
  if (params.get('consent') === '1' || params.get('takatak')) return;
  try {
    if (sessionStorage.getItem('r2n.signInBounce')) { sessionStorage.removeItem('r2n.signInBounce'); return; }
  } catch { /* private mode */ }
  try {
    const response = await fetch('/api/v1/customer/context', { credentials: 'same-origin' });
    if (!response.ok) return;
  } catch { return; }
  location.replace(params.get('returnTo') ? returnTo() : '/account');
}
void leaveIfSignedIn();
fetch('/api/v1/auth/takatak/config', { credentials: 'same-origin' })
  .then((r) => r.json())
  .catch(() => ({}))
  .then(async (cfg: { configured?: boolean; google?: boolean }) => {
    configured = cfg?.configured === true;
    input('send').disabled = !configured;
    $('googleButton').hidden = !(configured && cfg?.google === true);
    $('orGoogle').hidden = $('googleButton').hidden;
    if (!configured) { status(reasons.unavailable![locale === 'fr' ? 0 : 1]); return; }
    const reason = params.get('takatak');
    if (reason) {
      status((reasons[reason] ?? reasons.error!)[locale === 'fr' ? 0 : 1]);
      if (reason === 'terms') input('terms').focus();
    }
    if (params.get('consent') === '1') {
      try { await openConsent(); } catch (err) { explain(err); }
    }
  });

// The cookie banner (consent.ts) is fixed over the bottom of small screens
// until the visitor chooses. Keep this page's own buttons clear of it: the
// measured height feeds --privacy-banner-h (padding + scroll-padding in CSS).
function trackPrivacyBanner(): void {
  const root = document.documentElement;
  const measure = (): void => {
    const banner = document.getElementById('privacyBanner');
    const height = banner && !banner.hidden ? Math.ceil(banner.getBoundingClientRect().height + 16) : 0;
    root.style.setProperty('--privacy-banner-h', `${height}px`);
  };
  const watch = (banner: Element): void => {
    new MutationObserver(measure).observe(banner, { attributes: true, attributeFilter: ['hidden'] });
    if (typeof ResizeObserver === 'function') new ResizeObserver(measure).observe(banner);
    measure();
  };
  const existing = document.getElementById('privacyBanner');
  if (existing) watch(existing);
  else {
    const added = new MutationObserver(() => {
      const banner = document.getElementById('privacyBanner');
      if (banner) { added.disconnect(); watch(banner); }
    });
    added.observe(document.body, { childList: true });
  }
  window.addEventListener('resize', measure);
  measure();
}
trackPrivacyBanner();
