import './consent.js';
import { sameSitePath } from './safe-path.js';
// Codex — assistant OpenAI · 2026-10-29 · Claude (Anthropic) · 2026-11-11, 2026-11-13
//
// Sign in or sign up on r2nette.ca with the TAKATAK account as the master.
//   Sign in:  email + password, or Google.
//   Sign up:  Google, or email code; then the customer chooses a password.
//   First sign-in of an older code-only account, or a forgotten password: the same email code, then a new password.
// Every road ends with TAKATAK's « Autoriser l’accès » screen shown here, then the existing callback opens the
// R2NETTE session and the customer is taken back to the page they left. The password lives in the TAKATAK hub;
// this page only sends it to this site's server and never keeps it.
import { detectLocale, persistLocale } from '../i18n/index.js';
import { passwordProblems, suggestPassword, type PasswordProblem } from '../../../src/shared/password-policy.js';

type Step = 'choose' | 'code' | 'password' | 'consent';
type Mode = 'signin' | 'signup' | 'reset';
const params = new URLSearchParams(location.search);
let locale = detectLocale();
let busy = false;
let configured = false;
let step: Step = 'choose';
let mode: Mode = params.get('tab') === 'signup' ? 'signup' : 'signin';
let consent: { app: string; returnAddress: string; account: string; scopes: string[]; needsTerms: boolean } | null = null;

const $ = (id: string) => document.getElementById(id)!;
const input = (id: string) => $(id) as HTMLInputElement;
const say = (fr: string, en: string) => (locale === 'fr' ? fr : en);
const pick = (words: [string, string]) => words[locale === 'fr' ? 0 : 1];

const copy: Record<string, [string, string]> = {
  eyebrow: ['Votre compte, simplement', 'Your account, simplified'],
  title: ['Votre courriel. Votre prochain ménage.', 'Your email. Your next clean.'],
  tabSignin: ['Se connecter', 'Sign in'],
  tabSignup: ['S’inscrire', 'Sign up'],
  loginEmailLabel: ['Adresse courriel', 'Email address'],
  loginPasswordLabel: ['Mot de passe', 'Password'],
  loginSubmit: ['Se connecter', 'Sign in'],
  forgot: ['Première connexion ou mot de passe oublié ?', 'First sign-in or forgot your password?'],
  orGoogle: ['ou', 'or'],
  orGoogleSignup: ['ou', 'or'],
  googleLabel: ['Continuer avec Google', 'Continue with Google'],
  googleSignupLabel: ['S’inscrire avec Google', 'Sign up with Google'],
  resetNote: [
    'Entrez votre courriel : nous vous envoyons un code, puis vous choisissez un mot de passe.',
    'Enter your email: we send you a code, then you choose a password.',
  ],
  emailLabel: ['Adresse courriel', 'Email address'],
  send: ['Recevoir mon code', 'Send my code'],
  backToSignin: ['Retour à la connexion', 'Back to sign in'],
  termsLabel: ['Nouveau client : j’accepte les conditions et la politique de confidentialité.', 'New customer: I accept the terms and privacy policy.'],
  termsLink: ['Conditions', 'Terms'],
  privacyLink: ['Confidentialité', 'Privacy'],
  codeLabel: ['Code reçu par courriel', 'Email verification code'],
  verify: ['Vérifier et continuer', 'Verify and continue'],
  change: ['Changer de courriel', 'Change email'],
  passwordForLabel: ['Compte :', 'Account:'],
  newPasswordLabel: ['Mot de passe', 'Password'],
  ruleLength: ['12 caractères ou plus', '12 characters or more'],
  ruleLower: ['une lettre minuscule', 'a lower-case letter'],
  ruleUpper: ['une lettre majuscule', 'an upper-case letter'],
  ruleDigit: ['un chiffre', 'a digit'],
  ruleSymbol: ['un symbole (! @ # $ % …)', 'a symbol (! @ # $ % …)'],
  confirmPasswordLabel: ['Confirmez le mot de passe', 'Confirm the password'],
  suggest: ['Suggérer un mot de passe fort', 'Suggest a strong password'],
  savePassword: ['Enregistrer et continuer', 'Save and continue'],
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

/** The line under the title follows where the customer is. */
const intros = {
  signin: ['Entrez votre courriel et votre mot de passe. Un seul compte pour R2NETTE et tous les sites du Groupe TAKATAK.', 'Enter your email and password. One account for R2NETTE and every Groupe TAKATAK website.'],
  signup: ['Créez votre compte avec Google, ou avec un code reçu par courriel et un mot de passe. Un seul compte pour tous les sites du Groupe TAKATAK.', 'Create your account with Google, or with an emailed code and a password. One account for every Groupe TAKATAK website.'],
  reset: ['Pour une première connexion ou un mot de passe oublié : un code par courriel, puis un nouveau mot de passe.', 'For a first sign-in or a forgotten password: an emailed code, then a new password.'],
  code: ['Entrez le code que nous venons de vous envoyer par courriel.', 'Enter the code we just emailed you.'],
  passwordSignup: ['Dernière étape : choisissez un mot de passe. La prochaine fois, vous vous connectez sans code.', 'Last step: choose a password. Next time you sign in without a code.'],
  passwordReset: ['Choisissez votre nouveau mot de passe. Il fonctionne partout avec votre compte TAKATAK.', 'Choose your new password. It works everywhere with your TAKATAK account.'],
  consent: ['Une dernière confirmation, puis vous revenez là où vous étiez.', 'One last confirmation, then you go back to where you were.'],
} as const satisfies Record<string, [string, string]>;

const reasons: Record<string, [string, string]> = {
  terms: ['Bienvenue ! Acceptez les conditions pour créer votre compte R2NETTE, puis recommencez.', 'Welcome! Accept the terms to create your R2NETTE account, then start again.'],
  'terms-needed': ['Cochez la case des conditions pour créer votre compte, puis touchez Autoriser.', 'Tick the terms box to create your account, then tap Authorize.'],
  cancelled: ['Vous avez refusé l’accès. Vous pouvez recommencer quand vous voulez.', 'You refused access. You can start again whenever you like.'],
  expired: ['La connexion a expiré. Recommencez.', 'The sign-in expired. Start again.'],
  'link-required': ['Un autre compte TAKATAK est déjà relié au compte R2NETTE de ce courriel. Utilisez ce compte, ou appelez le (514) 825-2825.', 'Another TAKATAK account is already linked to the R2NETTE account for this email. Use that account, or call (514) 825-2825.'],
  'email-required': ['Votre compte TAKATAK n’a pas de courriel confirmé. Utilisez le code par courriel.', 'Your TAKATAK account has no confirmed email. Use the email code.'],
  unavailable: ['Connexion indisponible pour le moment. Réessayez ou appelez le (514) 825-2825.', 'Sign-in is unavailable right now. Try again or call (514) 825-2825.'],
  error: ['La connexion n’a pas fonctionné. Réessayez.', 'The sign-in did not work. Try again.'],
};

/** What each server answer means to the customer. Anything not listed falls back to "unavailable". */
const answers: Record<string, [string, string]> = {
  EMAIL_CODE_INVALID: ['Code invalide ou expiré. Vérifiez votre courriel ou demandez un nouveau code.', 'Invalid or expired code. Check your email or request a new code.'],
  INVALID_CREDENTIALS: [
    'Courriel ou mot de passe incorrect. Pas encore de mot de passe ? Touchez « Première connexion ou mot de passe oublié ? ».',
    'Wrong email or password. No password yet? Tap “First sign-in or forgot your password?”.',
  ],
  PASSWORD_LOGIN_LIMIT: [
    'Trop d’essais avec ce courriel. Réessayez dans 15 minutes, ou connectez-vous avec Google ou un code.',
    'Too many tries with this email. Try again in 15 minutes, or sign in with Google or a code.',
  ],
  SIGNIN_IP_LIMIT: ['Trop d’essais depuis cet appareil. Réessayez plus tard.', 'Too many tries from this device. Try again later.'],
  PASSWORD_MISMATCH: ['Les deux mots de passe ne sont pas identiques.', 'The two passwords are not the same.'],
  // The page already checks the list; this is TAKATAK refusing a password that passes it (too common, seen in a leak).
  WEAK_PASSWORD: ['TAKATAK refuse ce mot de passe (trop courant ou trop faible). Choisissez-en un autre ou touchez « Suggérer un mot de passe fort ».', 'TAKATAK refuses this password (too common or too weak). Choose another one or tap “Suggest a strong password”.'],
};
const rulesMissing: [string, string] = ['Complétez la liste ci-dessus : le mot de passe doit respecter chaque règle.', 'Complete the list above: the password must meet every rule.'];

function translate(): void {
  document.documentElement.lang = locale;
  for (const [id, words] of Object.entries(copy)) $(id).textContent = pick(words);
  $('language').textContent = locale === 'fr' ? 'EN' : 'FR';
  $('tabs').setAttribute('aria-label', say('Connexion ou création de compte', 'Sign in or create an account'));
  $('rules').setAttribute('aria-label', say('Règles du mot de passe', 'Password rules'));
  for (const [button, field] of revealPairs()) paintReveal(button, field);
  renderIntro();
  googleLinks();
  if (step === 'password') updateRules();
  if (consent) renderConsent();
}

function renderIntro(): void {
  const key = step === 'code' ? 'code'
    : step === 'password' ? (mode === 'reset' ? 'passwordReset' : 'passwordSignup')
      : step === 'consent' ? 'consent'
        : mode;
  $('intro').textContent = pick(intros[key]);
}

function returnTo(): string {
  const requested = params.get('returnTo') || '/#book';
  const path = sameSitePath(requested, location.origin);
  return path && !path.startsWith('/api/') ? path : '/#book';
}

function googleLinks(): void {
  const query = new URLSearchParams({ locale, returnTo: returnTo() });
  ($('googleButton') as HTMLAnchorElement).href = '/api/v1/auth/takatak/google/start?' + query.toString();
  const signup = new URLSearchParams(query);
  signup.set('intent', 'signup');
  if (input('terms').checked) signup.set('terms', '1');
  ($('googleSignup') as HTMLAnchorElement).href = '/api/v1/auth/takatak/google/start?' + signup.toString();
}

function show(next: Step): void {
  step = next;
  $('chooseStep').hidden = next !== 'choose';
  $('codeForm').hidden = next !== 'code';
  $('passwordForm').hidden = next !== 'password';
  $('consentCard').hidden = next !== 'consent';
  $('smsNote').hidden = next === 'consent' || next === 'password';
  renderIntro();
}

/* ---------------- tabs ---------------- */

const tabIds = ['tabSignin', 'tabSignup'] as const;

function setMode(next: Mode, options: { focus?: boolean } = {}): void {
  // Keep what was typed when the customer flips between the tabs.
  const from = mode === 'signin' ? input('loginEmail') : input('email');
  const to = next === 'signin' ? input('loginEmail') : input('email');
  if (from.value && !to.value) to.value = from.value;
  mode = next;
  const signingIn = next === 'signin';
  $('signinPanel').hidden = !signingIn;
  $('signupPanel').hidden = signingIn;
  $('signupExtras').hidden = next === 'reset';
  $('resetNote').hidden = next !== 'reset';
  $('backToSignin').hidden = next !== 'reset';
  const selected = next === 'signup' ? 'tabSignup' : 'tabSignin';
  for (const id of tabIds) {
    $(id).setAttribute('aria-selected', String(id === selected));
    $(id).tabIndex = id === selected ? 0 : -1;
  }
  try {
    const url = new URL(location.href);
    if (next === 'signup') url.searchParams.set('tab', 'signup'); else url.searchParams.delete('tab');
    history.replaceState(null, '', url);
  } catch { /* the address bar is cosmetic */ }
  renderIntro();
  status('');
  if (options.focus !== false) (signingIn ? input('loginEmail') : input('email')).focus();
}

for (const id of tabIds) {
  $(id).addEventListener('click', () => { if (!busy) setMode(id === 'tabSignup' ? 'signup' : 'signin'); });
  // Arrow keys move between the tabs, as in any tab list.
  $(id).addEventListener('keydown', (event) => {
    const key = (event as KeyboardEvent).key;
    if (busy || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return;
    event.preventDefault();
    const target = key === 'Home' ? 'tabSignin' : key === 'End' ? 'tabSignup' : id === 'tabSignin' ? 'tabSignup' : 'tabSignin';
    setMode(target === 'tabSignup' ? 'signup' : 'signin', { focus: false });
    $(target).focus();
  });
}
$('forgot').addEventListener('click', () => { if (!busy) setMode('reset'); });
$('backToSignin').addEventListener('click', () => { if (!busy) setMode('signin'); });

/* ---------------- password fields ---------------- */

function revealPairs(): Array<[HTMLElement, HTMLInputElement[]]> {
  return [
    [$('toggleLogin'), [input('loginPassword')]],
    [$('togglePassword'), [input('newPassword'), input('confirmPassword')]],
  ];
}
function paintReveal(button: HTMLElement, fields: HTMLInputElement[]): void {
  const shown = fields[0]!.type === 'text';
  button.textContent = shown ? say('Masquer', 'Hide') : say('Afficher', 'Show');
  button.setAttribute('aria-pressed', String(shown));
  button.setAttribute('aria-label', shown ? say('Masquer le mot de passe', 'Hide the password') : say('Afficher le mot de passe', 'Show the password'));
}
function setRevealed(button: HTMLElement, fields: HTMLInputElement[], shown: boolean): void {
  for (const field of fields) field.type = shown ? 'text' : 'password';
  paintReveal(button, fields);
}
for (const [button, fields] of revealPairs()) {
  button.addEventListener('click', () => setRevealed(button, fields, fields[0]!.type !== 'text'));
}

const RULES = ['length', 'lower', 'upper', 'digit', 'symbol'] as const;

function updateRules(): void {
  const password = input('newPassword').value;
  const problems = new Set<PasswordProblem>(passwordProblems(password, $('passwordEmail').textContent));
  for (const rule of RULES) {
    const item = document.querySelector<HTMLElement>(`#rules [data-rule="${rule}"]`)!;
    const done = !problems.has(rule);
    item.dataset.ok = String(done);
    item.querySelector('.sr-only')!.textContent = done ? say(' : fait', ': done') : say(' : à faire', ': to do');
  }
  $('passwordNote').textContent = problems.has('too-long')
    ? say('Ce mot de passe est trop long (72 octets au maximum).', 'This password is too long (72 bytes at most).')
    : problems.has('email')
      ? say('Évitez de mettre le début de votre courriel dans le mot de passe.', 'Avoid using the first part of your email in the password.')
      : '';
  const again = input('confirmPassword').value;
  const match = $('matchNote');
  match.textContent = !again ? '' : again === password ? say('Les mots de passe sont identiques.', 'The passwords match.') : say('Les mots de passe ne sont pas identiques.', 'The passwords do not match.');
  match.dataset.ok = String(Boolean(again) && again === password);
}
input('newPassword').addEventListener('input', updateRules);
input('confirmPassword').addEventListener('input', updateRules);

$('suggest').addEventListener('click', () => {
  const password = suggestPassword();
  input('newPassword').value = password;
  input('confirmPassword').value = password;
  // Shown, so it can be read and noted down; the password manager can also keep it.
  setRevealed($('togglePassword'), [input('newPassword'), input('confirmPassword')], true);
  updateRules();
  status(say('Mot de passe suggéré. Notez-le ou laissez votre gestionnaire de mots de passe l’enregistrer.', 'Password suggested. Note it down or let your password manager save it.'));
});

function showPasswordStep(email: string | null): void {
  $('passwordEmail').textContent = email ?? '';
  input('passwordUsername').value = email ?? '';
  input('newPassword').value = '';
  input('confirmPassword').value = '';
  setRevealed($('togglePassword'), [input('newPassword'), input('confirmPassword')], false);
  show('password');
  updateRules();
  status('');
  input('newPassword').focus();
}

/** A password step waits on the server (after a Google return, or a reload): ask what it is for. */
async function openPasswordStep(): Promise<void> {
  const data = await call('password/status', 'GET');
  mode = data.intent === 'reset' ? 'reset' : 'signup';
  showPasswordStep(typeof data.email === 'string' ? data.email : null);
}

/* ---------------- calls and messages ---------------- */

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
  if (code === 'TERMS_REQUIRED' && consent) { consent.needsTerms = true; renderConsent(); status(pick(reasons['terms-needed']!)); return; }
  // The handoff is single-use: after a refused decision only a new start works.
  if (expired || code === 'CONSENT_INVALID') { consent = null; show('choose'); }
  status(
    expired ? pick(reasons.expired!)
      : answers[code] ? pick(answers[code]!)
        : /LIMIT|COOLDOWN/.test(code) ? say('Veuillez patienter avant de réessayer.', 'Please wait before trying again.')
          : code === 'VALIDATION_ERROR' ? say('Vérifiez les champs et réessayez.', 'Check the fields and try again.')
            : pick(reasons.unavailable!),
  );
}

function lock(on: boolean): void {
  busy = on;
  document.querySelectorAll<HTMLButtonElement>('button').forEach((b) => { if (b.id !== 'language') b.disabled = on; });
  if (!on) applyConfigured();
}

/** The two submit buttons that start a request stay off until the server says sign-in is set up. */
function applyConfigured(): void {
  input('send').disabled = !configured;
  input('loginSubmit').disabled = !configured;
}

/* ---------------- the authorization card ---------------- */

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

/** After the password (or a code, or Google): fetch the authorization details and show the TAKATAK screen, or finish. */
async function openConsent(): Promise<void> {
  let data: Record<string, unknown>;
  try {
    data = await call('consent?locale=' + locale, 'GET');
  } catch (e) {
    // The password has not been chosen yet: that is the step to show, not the card.
    if (e instanceof CallError && e.code === 'PASSWORD_REQUIRED') { await openPasswordStep(); return; }
    throw e;
  }
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
    status(pick(reasons['terms-needed']!));
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

/* ---------------- forms ---------------- */

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (busy || !configured) return;
  lock(true);
  status('');
  try {
    await call('password/login', 'POST', {
      email: input('loginEmail').value.trim(),
      password: input('loginPassword').value,
      locale,
      terms: false,
      returnTo: returnTo(),
    });
    input('loginPassword').value = '';
    await openConsent();
    lock(false);
  } catch (err) {
    explain(err);
    lock(false);
    if (step === 'choose') { input('loginPassword').focus(); input('loginPassword').select(); }
  }
});

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
      intent: mode === 'reset' ? 'reset' : 'signup',
    });
    if (typeof data.next === 'string') { location.assign(data.next); return; }
    if (data.password === true) {
      showPasswordStep(typeof data.email === 'string' ? data.email : input('email').value.trim());
      lock(false);
      input('newPassword').focus();
      return;
    }
    await openConsent();
    lock(false);
  } catch (err) {
    explain(err);
    lock(false);
  }
});

$('passwordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (busy) return;
  const password = input('newPassword').value;
  const again = input('confirmPassword').value;
  if (passwordProblems(password, $('passwordEmail').textContent).length) {
    status(pick(rulesMissing));
    input('newPassword').focus();
    return;
  }
  if (password !== again) {
    status(pick(answers.PASSWORD_MISMATCH!));
    input('confirmPassword').focus();
    return;
  }
  lock(true);
  status('');
  try {
    await call('password/set', 'POST', { password, confirm: again });
    // The page does not keep the password a moment longer than it needs to.
    input('newPassword').value = '';
    input('confirmPassword').value = '';
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
input('terms').addEventListener('change', googleLinks);

/* ---------------- start ---------------- */

translate();
setMode(mode, { focus: false });
applyConfigured();

/**
 * Already signed in? Then the sign-in page has nothing to ask: go where the customer was
 * headed, or to their account. (The Account menu link used to land here and showed the form
 * to a signed-in customer.) Not while a sign-in is in progress or just failed, and not right
 * after the account page sent the visitor here, so the two can never send each other back.
 */
async function leaveIfSignedIn(): Promise<void> {
  if (params.get('consent') === '1' || params.get('step') === 'password' || params.get('takatak')) return;
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
    applyConfigured();
    const google = configured && cfg?.google === true;
    $('googleButton').hidden = !google;
    $('orGoogle').hidden = !google;
    $('googleSignup').hidden = !google;
    $('orGoogleSignup').hidden = !google;
    if (!configured) { status(pick(reasons.unavailable!)); return; }
    const reason = params.get('takatak');
    if (reason) {
      status(pick(reasons[reason] ?? reasons.error!));
      if (reason === 'terms') { setMode('signup', { focus: false }); input('terms').focus(); }
    }
    if (params.get('step') === 'password') {
      try { await openPasswordStep(); } catch (err) { explain(err); }
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
