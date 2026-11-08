// Codex — assistant OpenAI · 2026-10-29
import { detectLocale } from '../i18n/index.js';
import { formatSlotDate, formatSlotTime, torontoDateKey } from './api.js';
const esc=(s:unknown)=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]!));
type EventRow={id:string;bookingNumber:string;startAt:string;endAt:string;status:string;service:string;serviceFr:string;address:string};
type View='month'|'week'|'day'|'agenda';
let view:View='month',anchor=torontoDateKey(new Date()),seq=0;
const day=(key:string)=>new Date(key+'T12:00:00Z');
const offset=(key:string,n:number)=>{const d=day(key);d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
export function calendarRange(key:string,mode:View):{from:string;to:string}{
 if(mode==='month'){const d=day(key.slice(0,7)+'-01');const monday=(d.getUTCDay()+6)%7;const from=offset(d.toISOString().slice(0,10),-monday);return {from,to:offset(from,42)};}
 if(mode==='week'){const from=offset(key,-((day(key).getUTCDay()+6)%7));return {from,to:offset(from,7)};}
 return {from:key,to:offset(key,mode==='day'?1:30)};
}
export function gpsLinks(address:string):{google:string;waze:string;apple:string}{return {google:'https://www.google.com/maps/dir/?api=1&destination='+encodeURIComponent(address),waze:'https://www.waze.com/ul?q='+encodeURIComponent(address)+'&navigate=yes',apple:'https://maps.apple.com/?daddr='+encodeURIComponent(address)};}
function directions(address:string){const links=gpsLinks(address);return Object.entries(links).map(([label,url])=>`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label==='google'?'Google Maps':label==='waze'?'Waze':'Apple Plans'}</a>`).join(' · ');}
export function setupAccountExperience(locale=detectLocale()):void{
 const fr=locale==='fr',say=(a:string,b:string)=>fr?a:b;
 const upcoming=document.getElementById('upcoming');if(!upcoming)return;
 let root=document.getElementById('customerCalendar');
 if(!root){root=document.createElement('section');root.id='customerCalendar';root.className='section';upcoming.before(root);}
 root.innerHTML=`<h2>${say('Mon calendrier','My calendar')}</h2><div class="card"><div class="acts">${(['day','week','month','agenda'] as View[]).map((mode,i)=>`<button class="btn btn-ghost" type="button" data-calendar-view="${mode}" aria-pressed="${view===mode}">${[say('Jour','Day'),say('Semaine','Week'),say('Mois','Month'),say('Compact','Agenda')][i]}</button>`).join('')}</div><div class="acts"><button type="button" class="btn btn-ghost" data-calendar-move="-1" aria-label="${say('Période précédente','Previous period')}">←</button><label>${say('Date','Date')} <input type="date" id="calendarAnchor" value="${anchor}"></label><button type="button" class="btn btn-ghost" data-calendar-move="1" aria-label="${say('Période suivante','Next period')}">→</button><a class="btn btn-primary" href="/#book">${say('Réserver','Book a visit')}</a></div><div id="calendarEvents" aria-live="polite"></div></div>`;
 root.onclick=e=>{const el=(e.target as HTMLElement).closest<HTMLElement>('[data-calendar-view],[data-calendar-move],[data-calendar-day]');if(!el)return;
 if(el.dataset.calendarView)view=el.dataset.calendarView as View;
 if(el.dataset.calendarDay){anchor=el.dataset.calendarDay;view='day';}
 if(el.dataset.calendarMove){const direction=Number(el.dataset.calendarMove);if(view==='month'){const d=day(anchor);d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+direction);anchor=d.toISOString().slice(0,10);}else anchor=offset(anchor,direction*(view==='week'?7:view==='agenda'?30:1));}
 setupAccountExperience(locale);
 };
 root.querySelector('#calendarAnchor')!.addEventListener('change',e=>{const key=(e.target as HTMLInputElement).value;if(/^\d{4}-\d{2}-\d{2}$/.test(key)){anchor=key;setupAccountExperience(locale);}});
 const callSeq=++seq;const range=calendarRange(anchor,view);const activeView=view;
 void fetch(`/api/v1/account/calendar?from=${range.from}&to=${range.to}`,{credentials:'same-origin'}).then(async r=>{if(!r.ok)throw new Error();return r.json();}).then((data:{bookings:EventRow[];truncated:boolean})=>{
 if(callSeq!==seq)return;const box=document.getElementById('calendarEvents');if(!box)return;
 const events=data.bookings;
 if(activeView==='month'){
 box.innerHTML=`<div class="customer-month-grid">${Array.from({length:42},(_,i)=>{const key=offset(range.from,i),items=events.filter(b=>torontoDateKey(new Date(b.startAt))===key);return `<button type="button" class="customer-calendar-day" data-calendar-day="${key}" aria-label="${key}: ${items.length} ${say('rendez-vous','appointments')}"><b>${Number(key.slice(-2))}</b>${items.length?`<span>${items.length} ${say('visite(s)','visit(s)')}</span>`:''}</button>`;}).join('')}</div>`;
 }else{box.innerHTML=events.length?events.map(b=>`<article class="customer-calendar-event"><strong>${esc(formatSlotDate(b.startAt,locale))} · ${esc(formatSlotTime(b.startAt,locale))}–${esc(formatSlotTime(b.endAt,locale))}</strong><p>${esc(fr?b.serviceFr:b.service)} · ${esc(b.bookingNumber)} · ${esc(b.status)}</p><p>${esc(b.address)}</p><p>${directions(b.address)}</p><p><a href="/account">${say('Gérer le rendez-vous depuis la liste de réservations','Manage this visit from your booking list')}</a></p></article>`).join(''):`<p>${say('Aucun rendez-vous pendant cette période.','No appointments in this period.')}</p>`;}
 if(data.truncated)box.insertAdjacentHTML('beforeend',`<p>${say('Affichage limité à 500 visites. Réduisez la période.','Showing up to 500 visits. Narrow the date range.')}</p>`);
 }).catch(()=>{if(callSeq===seq){const box=document.getElementById('calendarEvents');if(box)box.textContent=say('Calendrier indisponible. Vos réservations restent dans la liste ci-dessous.','Calendar unavailable. Your bookings remain in the list below.');}});
 void setupPhone(fr);
}
async function setupPhone(fr:boolean){
 const settings=document.getElementById('settings');if(!settings)return;
 const say=(a:string,b:string)=>fr?a:b;
 let root=document.getElementById('accountPhone');if(!root){root=document.createElement('section');root.id='accountPhone';root.className='section';settings.prepend(root);}
 try{const r=await fetch('/api/v1/account/phone/status',{credentials:'same-origin'});if(!r.ok)throw new Error();const s=await r.json();
 root.innerHTML=`<h2>${say('Confirmations SMS','SMS confirmations')}</h2><div class="card">${s.verified?say('Votre téléphone est vérifié.','Your phone is verified.'):!s.eligible?say('Après votre premier paiement réussi, vous pourrez vérifier votre téléphone ici. Aucun SMS envoyé à l’inscription.','After your first successful payment, verify your phone here. No SMS is sent at signup.'):!s.configured?say('Paiement confirmé. La vérification SMS n’est pas encore disponible.','Payment confirmed. SMS verification is not available yet.'):`<p>${say('Activez les confirmations SMS de service. Ce choix ne vous abonne pas aux offres marketing.','Enable service SMS confirmations. This does not subscribe you to marketing offers.')}</p><label for="accountPhoneNumber">${say('Téléphone','Phone')}</label><input class="slot" id="accountPhoneNumber" type="tel" autocomplete="tel"><button type="button" class="btn btn-primary" id="accountPhoneSend">${say('Recevoir un code','Send a code')}</button><div id="accountPhoneCodeBlock" hidden><label for="accountPhoneCode">${say('Code reçu','Verification code')}</label><input class="slot" id="accountPhoneCode" inputmode="numeric" autocomplete="one-time-code" maxlength="10"><button class="btn btn-primary" id="accountPhoneVerify">${say('Vérifier','Verify')}</button></div>`}<p role="status" id="accountPhoneStatus"></p></div>`;
 let busy=false;let number='';
 const send=root.querySelector<HTMLButtonElement>('#accountPhoneSend'),verify=root.querySelector<HTMLButtonElement>('#accountPhoneVerify');
 const act=async(operation:'send'|'verify')=>{if(busy)return;busy=true;if(send)send.disabled=true;if(verify)verify.disabled=true;
 try{const phone=operation==='send'?(root!.querySelector('#accountPhoneNumber') as HTMLInputElement).value:number;const code=operation==='verify'?(root!.querySelector('#accountPhoneCode') as HTMLInputElement).value:undefined;
 const response=await fetch('/api/v1/account/phone/'+operation,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone,...(code?{code}:{})})});if(!response.ok)throw new Error();
 if(operation==='send'){number=phone;(root!.querySelector('#accountPhoneNumber') as HTMLInputElement).readOnly=true;(root!.querySelector('#accountPhoneCodeBlock') as HTMLElement).hidden=false;root!.querySelector('#accountPhoneStatus')!.textContent=say('Code envoyé.','Code sent.');}else await setupPhone(fr);
 }catch{root!.querySelector('#accountPhoneStatus')!.textContent=say('Vérification non terminée. Vérifiez les renseignements ou réessayez plus tard.','Verification incomplete. Check your details or retry later.');}finally{busy=false;if(send)send.disabled=false;if(verify)verify.disabled=false;}};
 send?.addEventListener('click',()=>void act('send'));verify?.addEventListener('click',()=>void act('verify'));
 }catch{root.textContent=say('État SMS indisponible.','SMS status unavailable.');}
}
