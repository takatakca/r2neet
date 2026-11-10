import './consent.js';
// Codex — assistant OpenAI · 2026-10-29
import { detectLocale, persistLocale } from '../i18n/index.js';
let locale = detectLocale();
const $ = (id: string) => document.getElementById(id)!;
const say = (fr: string, en: string) => locale === 'fr' ? fr : en;
const input = (id: string) => $(id) as HTMLInputElement;
let busy = false, available = false;
let entryMode: 'email' | 'both' | 'takatak' = 'email', configKnown = false;
const copy: Record<string, [string, string]> = {
  eyebrow: ['Votre compte, simplement', 'Your account, simplified'], title: ['Votre courriel. Votre prochain ménage.', 'Your email. Your next clean.'],
  intro: ['Recevez un code par courriel pour vous inscrire ou vous connecter. Aucun mot de passe. Aucun SMS à cette étape.', 'Get an email code to sign up or sign in. No password. No SMS at this stage.'],
  emailLabel: ['Adresse courriel', 'Email address'], send: ['Recevoir mon code', 'Send my code'], codeLabel: ['Code reçu par courriel', 'Email verification code'],
  termsLabel: ['J’accepte les conditions et la politique de confidentialité.', 'I accept the terms and privacy policy.'], termsLink: ['Conditions', 'Terms'], privacyLink: ['Confidentialité', 'Privacy'],
  verify: ['Vérifier et continuer', 'Verify and continue'], change: ['Changer de courriel', 'Change email'],
  smsNote: ['Après votre premier paiement, vous pourrez vérifier votre téléphone pour les confirmations SMS.', 'After your first payment, you can verify your phone for SMS confirmations.'],
  legacy: ['Déjà un compte avec téléphone ?', 'Already have a phone-based account?'], back: ['Retour au site', 'Back to the website'],
  takatak: ['Continuer avec TAKATAK', 'Continue with TAKATAK'], takatakHint: ['Un seul compte TAKATAK pour R2NETTE et tous les sites du Groupe TAKATAK.', 'One TAKATAK account for R2NETTE and every Groupe TAKATAK website.'],
  takatakTermsLabel: ['Nouveau client : j’accepte les conditions et la politique de confidentialité.', 'New customer: I accept the terms and privacy policy.'], orEmail: ['ou par courriel', 'or by email'],
};
function translate() { document.documentElement.lang = locale; for (const [id, words] of Object.entries(copy)) $(id).textContent = words[locale === 'fr' ? 0 : 1]; if (entryMode !== 'email') $('intro').textContent = entryMode === 'both' ? say('Continuez avec votre compte TAKATAK ou recevez un code par courriel. Aucun mot de passe. Aucun SMS à cette étape.', 'Continue with your TAKATAK account or get an email code. No password. No SMS at this stage.') : say('Connectez-vous ou créez votre compte avec TAKATAK. Aucun mot de passe R2NETTE. Aucun SMS à cette étape.', 'Sign in or create your account with TAKATAK. No R2NETTE password. No SMS at this stage.'); $('language').textContent = locale === 'fr' ? 'EN' : 'FR'; takatakLink(); takatakNotice(); }
// Claude (Anthropic) · 2026-11-10 — TAKATAK is the master account; R2NETTE receives a copy after sign-in.
function returnTo(): string {
  const requested = new URLSearchParams(location.search).get('returnTo') || '/#book';
  try { const target = new URL(requested, location.origin); if (target.origin === location.origin && !target.pathname.startsWith('/api/')) return target.pathname + target.search + target.hash; } catch { /* default */ }
  return '/#book';
}
function takatakLink() {
  const query = new URLSearchParams({ locale, returnTo: returnTo() });
  if (input('takatakTerms').checked) query.set('terms', '1');
  ($('takatak') as HTMLAnchorElement).href = '/api/v1/auth/takatak/start?' + query.toString();
}
const takatakReasons: Record<string, [string, string]> = {
  terms: ['Bienvenue ! Cochez la case des conditions, puis touchez « Continuer avec TAKATAK » pour créer votre compte R2NETTE.', 'Welcome! Tick the terms box, then tap “Continue with TAKATAK” to create your R2NETTE account.'],
  cancelled: ['Connexion TAKATAK annulée. Vous pouvez recommencer ou utiliser votre courriel.', 'TAKATAK sign-in was cancelled. Try again or use your email.'],
  expired: ['La connexion TAKATAK a expiré. Touchez « Continuer avec TAKATAK » pour recommencer.', 'The TAKATAK sign-in expired. Tap “Continue with TAKATAK” to start again.'],
  'link-required': ['Un compte R2NETTE existe déjà avec ce courriel ou ce téléphone. Connectez-vous avec votre méthode habituelle, puis reliez TAKATAK depuis votre compte.', 'An R2NETTE account already uses this email or phone. Sign in with your usual method, then link TAKATAK from your account.'],
  'email-required': ['Votre compte TAKATAK n’a pas encore de courriel confirmé. Confirmez-en un sur takatak.ca ou inscrivez-vous par courriel ci-dessous.', 'Your TAKATAK account has no confirmed email yet. Confirm one on takatak.ca or sign up by email below.'],
  unavailable: ['La connexion TAKATAK n’est pas encore disponible. Utilisez votre courriel ci-dessous.', 'TAKATAK sign-in is not available yet. Use your email below.'],
  error: ['La connexion TAKATAK n’a pas fonctionné. Réessayez ou utilisez votre courriel.', 'TAKATAK sign-in did not work. Try again or use your email.'],
};
function takatakNotice() {
  if (!configKnown) return;
  const reason = new URLSearchParams(location.search).get('takatak');
  const words = reason ? takatakReasons[reason] ?? takatakReasons.error! : null;
  const box = $('takatakBlock').hidden ? $('status') : $('takatakStatus');
  if (words) { box.textContent = words[locale === 'fr' ? 0 : 1]; box.hidden = false; }
}
async function call(path: string, body: unknown) {
  const res = await fetch('/api/v1/auth/email/' + path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.code ?? 'UNAVAILABLE');
}
function error(e: unknown) {
  const code = e instanceof Error ? e.message : '';
  $('status').textContent = code === 'ACCOUNT_LINK_REQUIRED'
    ? say('Ce compte utilise déjà une autre méthode de connexion. Utilisez le lien de connexion par téléphone ci-dessous.', 'This account already uses another sign-in method. Use phone sign-in below.')
    : code === 'EMAIL_CODE_INVALID' ? say('Code invalide ou expiré. Vérifiez votre courriel ou demandez un nouveau code.', 'Invalid or expired code. Check your email or request a new code.')
    : /LIMIT|COOLDOWN/.test(code) ? say('Veuillez patienter avant de réessayer.', 'Please wait before trying again.')
    : say('Connexion indisponible pour le moment. Réessayez plus tard ou contactez R2NETTE.', 'Sign-in is unavailable right now. Try later or contact R2NETTE.');
}
function lock(on: boolean) { busy = on; document.querySelectorAll<HTMLButtonElement>('form button').forEach(b => b.disabled = on); }
$('emailForm').addEventListener('submit', async e => { e.preventDefault(); if (busy || !available) return; lock(true); $('status').textContent = '';
  try { await call('send', { email: input('email').value.trim() }); $('emailForm').hidden = true; $('codeForm').hidden = false; input('code').focus(); $('status').textContent = say('Code envoyé. Vérifiez aussi vos indésirables.', 'Code sent. Check your spam folder too.'); } catch (err) { error(err); } finally { lock(false); }
});
$('codeForm').addEventListener('submit', async e => { e.preventDefault(); if (busy || !input('terms').checked) return; lock(true);
  try { await call('verify', { email: input('email').value.trim(), code: input('code').value.trim(), locale, termsAccepted: true });
    location.assign(returnTo());
  } catch (err) { error(err); lock(false); }
});
$('change').addEventListener('click', () => { if (busy) return; $('emailForm').hidden = false; $('codeForm').hidden = true; input('code').value = ''; $('status').textContent = ''; input('email').focus(); });
$('language').addEventListener('click', () => { locale = locale === 'fr' ? 'en' : 'fr'; persistLocale(locale); translate(); });
input('takatakTerms').addEventListener('change', takatakLink);
translate();
input('send').disabled = true;
const config = (path: string) => fetch(path, { credentials: 'same-origin' }).then(r => r.json()).then(cfg => cfg?.configured === true).catch(() => false);
Promise.all([config('/api/v1/auth/takatak/config'), config('/api/v1/auth/email/config')]).then(([takatak, email]) => {
  available = email;
  input('send').disabled = !email;
  $('takatakBlock').hidden = !takatak;
  // With TAKATAK on and email codes off, show only the working path instead of a dead form.
  if (takatak && !email) { $('emailForm').hidden = true; $('orEmail').hidden = true; }
  if (!takatak && !email) error(new Error('UNAVAILABLE'));
  entryMode = takatak ? (email ? 'both' : 'takatak') : 'email';
  configKnown = true;
  translate();
  if (takatak && new URLSearchParams(location.search).get('takatak') === 'terms') input('takatakTerms').focus();
});
