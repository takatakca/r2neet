// Codex — assistant OpenAI · 2026-10-29
import { detectLocale, formatMoney } from '../i18n/index.js';
import { checkoutMode, mountElements, awaitBackendConfirmation, type StripeLike, type PaymentConfig } from './checkout.js';
import './consent.js';
const fr=detectLocale()==='fr'; document.documentElement.lang=fr?'fr-CA':'en-CA';
const say=(a:string,b:string)=>fr?a:b;
const $=(id:string)=>document.getElementById(id)!;
const button=$('payButton') as HTMLButtonElement;
const bookingId=new URLSearchParams(location.search).get('booking');
async function call<T>(path:string,body?:object,key?:string):Promise<T>{
 const r=await fetch('/api/v1/'+path,{method:body?'POST':'GET',credentials:'same-origin',headers:{'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const result=await r.json().catch(()=>({}));if(!r.ok)throw new Error(result?.error?.code||'UNAVAILABLE');return result as T;
}
async function loadStripe(key:string):Promise<StripeLike>{
 const script=document.createElement('script');script.src='https://js.stripe.com/v3/';script.async=true;
 await new Promise<void>((resolve,reject)=>{script.onload=()=>resolve();script.onerror=()=>reject(new Error('STRIPE_UNAVAILABLE'));document.head.append(script);});
 const create=(window as unknown as {Stripe?:(key:string)=>StripeLike}).Stripe;if(!create)throw new Error('STRIPE_UNAVAILABLE');return create(key);
}
async function boot(){
 $('paymentTitle').textContent=say('Votre paiement sécurisé','Your secure payment');$('accountLink').textContent=say('Mes rendez-vous','My appointments');
 if(!bookingId||!/^[A-Za-z0-9_-]{1,100}$/.test(bookingId))throw new Error('BOOKING_NOT_FOUND');
 const cfg=await call<PaymentConfig>('payment-config?bookingId='+encodeURIComponent(bookingId));
 const mode=checkoutMode(cfg);
 $('paymentSummary').textContent=say('À régler maintenant : ','Due now: ')+formatMoney(cfg.amountDueNowCents||0,fr?'fr':'en');
 if(mode==='NONE'){button.hidden=true;$('paymentStatus').textContent=say('Aucun paiement exigé maintenant pour cette réservation.','No payment is due now for this booking.');return;}
 if(mode==='NOT_CONFIGURED'||!cfg.publishableKey)throw new Error('INTEGRATION_NOT_CONFIGURED');
 const setup=mode==='SETUP';
 if(setup)$('paymentSummary').textContent=say('Enregistrez votre carte pour les visites prévues. Aucun paiement maintenant.','Save your card for scheduled visits. No payment now.');
 const intent=await call<{clientSecret:string;paymentId:string}>(setup?'payments/setup-intent':'payments/payment-intent',setup?{}:{bookingId},`checkout:${bookingId}:${setup?'setup':'payment'}`);
 if(!intent.clientSecret||!intent.paymentId)throw new Error('PAYMENT_NOT_READY');
 const current=await call<{payment:{status:string}}>('payments/'+encodeURIComponent(intent.paymentId));
 if(current.payment.status==='SUCCEEDED'){button.hidden=true;$('paymentStatus').textContent=setup?say('Carte déjà enregistrée.','Card already saved.'):say('Paiement déjà reçu. Vérifiez votre téléphone dans votre compte.','Payment already received. Verify your phone in your account.');return;}
 const stripe=await loadStripe(cfg.publishableKey);$('expressSection').hidden=false;
 const {elements,expressElement}=await mountElements(stripe,intent.clientSecret,{express:$('express'),expressSection:$('expressSection'),payment:$('paymentElement')});
 button.textContent=setup?say('Enregistrer ma carte','Save my card'):say('Payer ','Pay ')+formatMoney(cfg.amountDueNowCents||0,fr?'fr':'en');button.disabled=false;
 let busy=false;
 button.addEventListener('click',()=>void confirm());
 expressElement.on('confirm',()=>void confirm());
 async function confirm(){if(busy)return;busy=true;button.disabled=true;
 try {
  const submitted=await elements.submit();if(submitted.error)throw new Error('PAYMENT_DETAILS');
  const options={elements,confirmParams:{return_url:location.origin+'/payment?booking='+encodeURIComponent(bookingId!)},redirect:'if_required'};
  const result=await (setup?stripe.confirmSetup(options):stripe.confirmPayment(options));if(result.error)throw new Error('PAYMENT_FAILED');
  $('paymentStatus').textContent=say('Confirmation du serveur en cours…','Waiting for server confirmation…');
  const outcome=await awaitBackendConfirmation(id=>call('payments/'+encodeURIComponent(id)),intent.paymentId);
  if(outcome!=='SUCCEEDED'){ $('paymentStatus').textContent=say('Paiement non confirmé. Consultez votre compte avant de réessayer.','Payment is not confirmed. Check your account before retrying.');return; }
  $('paymentStatus').textContent=setup?say('Carte enregistrée.','Card saved.'):say('Paiement reçu. Vous pouvez maintenant vérifier votre téléphone dans votre compte.','Payment received. You can now verify your phone in your account.');
  button.hidden=true;
 }catch{$('paymentStatus').textContent=say('Paiement non confirmé. Vérifiez les renseignements puis réessayez.','Payment not confirmed. Check your details and retry.');button.disabled=false;}finally{busy=false;}
 }
 // Express Checkout's confirm event must use the same server-verified flow.
 // The shared mount helper returns the element so the wallet is functional.
}
void boot().catch(()=>{button.hidden=true;$('paymentStatus').textContent=say('Le paiement est indisponible. Aucun succès n’est confirmé. Consultez votre compte ou contactez R2NETTE.','Payment is unavailable. No successful payment is confirmed. Check your account or contact R2NETTE.');});
