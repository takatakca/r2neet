// Codex — assistant OpenAI · 2026-10-29
import './consent.css';
export const CONSENT_VERSION = '2026-10-29';
export interface Consent { version: string; analytics: boolean; marketing: boolean; updatedAt: string }
export function validConsent(value: unknown): value is Consent {
  if (!value || typeof value !== 'object') return false;
  const c = value as Consent;
  return c.version === CONSENT_VERSION && typeof c.analytics === 'boolean' && typeof c.marketing === 'boolean' && Number.isFinite(Date.parse(c.updatedAt)) && Date.now() - Date.parse(c.updatedAt) < 180 * 86400000 && Date.parse(c.updatedAt) <= Date.now();
}
const KEY = 'r2n_privacy_choices';
let choice: Consent | null = null;
try { const saved = JSON.parse(localStorage.getItem(KEY) || 'null'); if (validConsent(saved)) choice = saved; } catch { /* Default deny. */ }
const fr = () => document.documentElement.lang.startsWith('fr');
const say = (a: string,b: string) => fr()?a:b;
let pixelLoaded = false;
async function activate() {
  if (!choice?.marketing || pixelLoaded || !['/', '/commercial'].includes(location.pathname) || location.search) return;
  // No provider request or remote script before explicit marketing consent.
  const cfg = await fetch('/api/v1/public/experience').then(r=>r.ok?r.json():null).catch(()=>null);
  if (!choice?.marketing || !/^\d{10,20}$/.test(cfg?.metaPixelId || '')) return;
  pixelLoaded = true;
  type F = ((...args: unknown[]) => void) & { queue: unknown[][]; callMethod?: (...args: unknown[]) => void; push?: F; loaded?: boolean; version?: string };
  const w = window as unknown as { fbq?: F; _fbq?: F };
  const fbq: F = Object.assign((...args: unknown[])=>{ if (!choice?.marketing) return; if (fbq.callMethod) fbq.callMethod(...args); else fbq.queue.push(args); },{queue:[] as unknown[][]});
  fbq.push=fbq; fbq.loaded=true; fbq.version='2.0'; w.fbq=fbq; w._fbq=fbq;
  fbq('consent','grant');fbq('init',cfg.metaPixelId);fbq('track','PageView');
  const script=document.createElement('script');script.async=true;script.src='https://connect.facebook.net/en_US/fbevents.js';document.head.append(script);
}
function clearMarketingCookies() {
  for (const domain of ['',`; domain=${location.hostname}`,`; domain=.${location.hostname.replace(/^www\./,'')}`]) {
    for (const name of ['_fbp','_fbc']) document.cookie=`${name}=; Max-Age=0; path=/${domain}; SameSite=Lax`;
  }
}
function setup() {
  if (document.getElementById('privacyBanner')) return;
  const banner=document.createElement('section'); banner.id='privacyBanner';banner.className='privacy-banner';banner.setAttribute('aria-label',say('Vos choix de confidentialité','Your privacy choices'));
  banner.innerHTML=`<div><strong>${say('Votre visite. Vos choix.','Your visit. Your choices.')}</strong><p>${say('Les témoins nécessaires font fonctionner votre réservation. Les traceurs de mesure et de publicité restent désactivés sans votre accord.','Necessary cookies keep your booking working. Measurement and advertising trackers stay off without your permission.')} <a href="/privacy">${say('Confidentialité','Privacy')}</a></p></div><div class="privacy-actions"><button type="button" data-choice="deny">${say('Tout refuser','Reject optional')}</button><button type="button" data-choice="manage">${say('Personnaliser','Customize')}</button><button type="button" data-choice="accept">${say('Tout accepter','Accept all')}</button></div><p role="status" id="privacyStatus"></p>`;
  banner.hidden=choice!==null;document.body.append(banner);
  const manage=document.createElement('button');manage.className='privacy-manage';manage.type='button';manage.textContent=say('Mes témoins','Cookie choices');manage.addEventListener('click',openPreferences);document.body.append(manage);
  banner.addEventListener('click',e=>{const action=(e.target as HTMLElement).closest<HTMLButtonElement>('[data-choice]')?.dataset.choice;if(action==='manage')openPreferences();if(action==='deny')void save(false,false);if(action==='accept')void save(true,true);});
  if (!choice?.marketing) clearMarketingCookies();
  void activate();
}
let saving=false;
async function save(analytics: boolean, marketing: boolean) {
  if(saving)return;saving=true;
  const old=choice?.marketing===true;
  const next={version:CONSENT_VERSION,analytics,marketing,updatedAt:new Date().toISOString()};
  // Withdrawal takes effect locally even when the audit endpoint is down.
  if(!marketing){choice=next;clearMarketingCookies();}
  try {
    const res=await fetch('/api/v1/privacy/consent',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:CONSENT_VERSION,analytics,marketing})});
    if(!res.ok)throw new Error('consent');
    choice=next;try{localStorage.setItem(KEY,JSON.stringify(next));}catch{ /* Current page still honors it. */ }
    document.getElementById('privacyBanner')!.hidden=true;
    (document.getElementById('privacyPreferences') as HTMLDialogElement|null)?.close();
    if(old&&!marketing){location.reload();return;}
    await activate();
  }catch{
    if(!marketing){try{localStorage.setItem(KEY,JSON.stringify(next));}catch{} if(old){location.reload();return;}}
    const status=document.getElementById('privacyStatus');if(status)status.textContent=say('Choix facultatifs désactivés. Enregistrement indisponible, veuillez réessayer.','Optional tracking is off. Could not record your choices; please retry.');
    const dialogStatus=document.getElementById('privacyDialogStatus');if(dialogStatus)dialogStatus.textContent=say('Enregistrement indisponible. Aucun traceur supplémentaire activé.','Could not save. No additional tracking enabled.');
  }finally{saving=false;}
}
function openPreferences(){
  let dialog=document.getElementById('privacyPreferences') as HTMLDialogElement|null;
  if(!dialog){dialog=document.createElement('dialog');dialog.id='privacyPreferences';dialog.className='privacy-dialog';document.body.append(dialog);}
  dialog.innerHTML=`<h2>${say('Vos préférences','Your preferences')}</h2><p>${say('Nécessaires : connexion, sécurité, réservation et paiement. Toujours actifs.','Necessary: sign-in, security, booking and payment. Always active.')}</p><label><input type="checkbox" id="privacyAnalytics" ${choice?.analytics?'checked':''}> ${say('Mesure facultative de fréquentation','Optional audience measurement')}</label><label><input type="checkbox" id="privacyMarketing" ${choice?.marketing?'checked':''}> ${say('Publicité Meta : visites du site transmises à Facebook/Instagram si le pixel est configuré.','Meta advertising: website visits shared with Facebook/Instagram if the pixel is configured.')}</label><p>${say('Ce choix ne vous abonne pas aux infolettres. Vous pouvez le modifier ici à tout moment.','This does not subscribe you to newsletters. You can change it here at any time.')}</p><div class="privacy-actions"><button type="button" id="privacyReject">${say('Tout refuser','Reject optional')}</button><button type="button" id="privacySave">${say('Enregistrer','Save choices')}</button><button type="button" id="privacyClose">${say('Fermer','Close')}</button></div><p role="status" id="privacyDialogStatus"></p>`;
  dialog.querySelector('#privacyReject')!.addEventListener('click',()=>void save(false,false));
  dialog.querySelector('#privacySave')!.addEventListener('click',()=>void save((dialog!.querySelector('#privacyAnalytics') as HTMLInputElement).checked,(dialog!.querySelector('#privacyMarketing') as HTMLInputElement).checked));
  dialog.querySelector('#privacyClose')!.addEventListener('click',()=>dialog!.close());dialog.showModal();
}
if(typeof document!=='undefined'){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',setup);else setup();}
