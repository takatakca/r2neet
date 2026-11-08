import './consent.js';
// Codex — assistant OpenAI · 2026-10-29
import { detectLocale, persistLocale } from '../i18n/index.js';
let locale = detectLocale();
const $ = (id: string) => document.getElementById(id)!;
const say = (fr: string, en: string) => locale === 'fr' ? fr : en;
const input = (id: string) => $(id) as HTMLInputElement;
let busy = false, available = false;
const copy: Record<string, [string, string]> = {
  eyebrow: ['Votre compte, simplement', 'Your account, simplified'], title: ['Votre courriel. Votre prochain ménage.', 'Your email. Your next clean.'],
  intro: ['Recevez un code par courriel pour vous inscrire ou vous connecter. Aucun mot de passe. Aucun SMS à cette étape.', 'Get an email code to sign up or sign in. No password. No SMS at this stage.'],
  emailLabel: ['Adresse courriel', 'Email address'], send: ['Recevoir mon code', 'Send my code'], codeLabel: ['Code reçu par courriel', 'Email verification code'],
  termsLabel: ['J’accepte les conditions et la politique de confidentialité.', 'I accept the terms and privacy policy.'], termsLink: ['Conditions', 'Terms'], privacyLink: ['Confidentialité', 'Privacy'],
  verify: ['Vérifier et continuer', 'Verify and continue'], change: ['Changer de courriel', 'Change email'],
  smsNote: ['Après votre premier paiement, vous pourrez vérifier votre téléphone pour les confirmations SMS.', 'After your first payment, you can verify your phone for SMS confirmations.'],
  legacy: ['Déjà un compte avec téléphone ?', 'Already have a phone-based account?'], back: ['Retour au site', 'Back to the website'],
};
function translate() { document.documentElement.lang = locale; for (const [id, words] of Object.entries(copy)) $(id).textContent = words[locale === 'fr' ? 0 : 1]; $('language').textContent = locale === 'fr' ? 'EN' : 'FR'; }
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
    const requested = new URLSearchParams(location.search).get('returnTo') || '/#book';
    const target = new URL(requested, location.origin);
    location.assign(target.origin === location.origin && !target.pathname.startsWith('/api/') ? target.pathname + target.search + target.hash : '/#book');
  } catch (err) { error(err); lock(false); }
});
$('change').addEventListener('click', () => { if (busy) return; $('emailForm').hidden = false; $('codeForm').hidden = true; input('code').value = ''; $('status').textContent = ''; input('email').focus(); });
$('language').addEventListener('click', () => { locale = locale === 'fr' ? 'en' : 'fr'; persistLocale(locale); translate(); });
translate();
input('send').disabled = true;
fetch('/api/v1/auth/email/config', { credentials: 'same-origin' }).then(r => r.json()).then(cfg => { available = cfg.configured === true; input('send').disabled = !available; if (!available) error(new Error('UNAVAILABLE')); }).catch(error);
