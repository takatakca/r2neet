/** Codex — assistant OpenAI · 2026-10-29.
 * UI smoke with explicitly simulated API responses. No actual email/SMS/payment.
 * Run Vite, then: npx vite-node scripts/verify-premium-browser.ts
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { SERVICES, ADD_ONS, PRODUCT_OPTIONS } from '../src/data/catalogue.js';
import { FREQUENCY_RULES } from '../src/data/config.js';
const origin=process.env.PREMIUM_TEST_URL||'http://127.0.0.1:4173';
const output=process.env.PREMIUM_TEST_OUTPUT||'/tmp/r2nette-premium-audit';mkdirSync(output,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const report:unknown[]=[];
try{for(const viewport of [{width:390,height:844},{width:1440,height:1000}]){
 let authenticated=false;const errors:string[]=[];const calls:string[]=[];const remote:string[]=[];
 const context=await browser.newContext({viewport,locale:'fr-CA',serviceWorkers:'block'});
 const page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
 const tomorrow=new Date(Date.now()+86400000).toISOString().slice(0,10);
 const customer={id:'customer-test',firstName:'Alex',lastName:'Test',email:'alex@example.test',verifiedPhone:null,isReturningCustomer:false};
 const address={id:'address-test',label:'Maison',formattedAddress:'123 Rue Test, Montréal, QC',city:'Montréal',postalCode:'H1A 1A1',unit:null,isDefault:true};
 const quote={id:'quote-test',lines:[{description:'Service — fixture',subtotalCents:10000}],subtotalBeforeTaxCents:10000,taxLines:[{name:'TPS',amountCents:500},{name:'TVQ',amountCents:998}],taxTotalCents:1498,grandTotalCents:11498,expiresAt:new Date(Date.now()+3600000).toISOString()};
 const hold={id:'hold-test',startAt:tomorrow+'T15:00:00Z',endAt:tomorrow+'T17:00:00Z',expiresAt:new Date(Date.now()+600000).toISOString()};
 const booking={id:'booking-test',bookingNumber:'TEST-001',startAt:hold.startAt,endAt:hold.endAt,status:'CONFIRMED',grandTotalCents:11498,paymentStatus:'NOT_COLLECTED',paymentPolicy:'PAY_LATER',crewSize:1,serviceDetails:null};
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.origin!==origin){remote.push(url.hostname);await route.abort();return;}
  if(!url.pathname.startsWith('/api/')){await route.continue();return;}
  calls.push(route.request().method()+' '+url.pathname);
  const ok=(json:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(json)});
  const path=url.pathname.replace('/api/v1/','');
  if(path==='health')return ok({ok:true});
  if(path==='services')return ok({services:SERVICES.filter(s=>s.active&&s.publiclyBookable),addOns:ADD_ONS.filter(s=>s.active),productSupplyOptions:Object.values(PRODUCT_OPTIONS),frequencyRules:Object.values(FREQUENCY_RULES).map(r=>({...r,discountPercent:r.discountRate/1000000}))});
  if(path==='customer/context')return authenticated?ok({customer,addresses:[address],usualClean:null}):ok({error:{code:'UNAUTHORIZED'}},401);
  if(path==='customer/me')return authenticated?ok({customer}):ok({error:{code:'UNAUTHORIZED'}},401);
  if(path==='privacy/consent')return ok({recorded:true});
  if(path==='public/experience')return ok({profiles:[{platform:'facebook',url:'https://www.facebook.com/r2nette'}],metaPixelId:'123456789012345'});
  if(path==='promotions/public')return ok({newCustomer:[],maxAmountCents:null});
  if(path==='reviews/summary')return ok({averageRating:null,reviewCount:0});
  if(path==='reviews')return ok({reviews:[]});
  if(path==='auth/email/config')return ok({configured:true});
  if(path==='auth/email/send')return ok({sent:true});
  if(path==='auth/email/verify'){authenticated=true;return ok({authenticated:true});}
  if(path==='quotes')return ok({quote});
  if(path==='availability')return ok({slots:[{startAt:hold.startAt,endAt:hold.endAt,preferredStaffAvailable:false}]});
  if(path==='booking-holds')return ok({hold});
  if(path==='account/profile')return ok({customer});
  if(path==='payment-config')return ok({configured:false,publishableKey:null,currency:'CAD',paymentPolicy:'PAY_LATER',amountDueNowCents:0});
  if(path==='bookings')return ok({booking});
  if(path==='account/overview')return ok({customer,upcoming:[{...booking,serviceName:'Test cleaning',serviceNameFr:'Ménage de test',serviceOptionId:SERVICES[0]!.id,addressSummary:address.formattedAddress,requiredStaffCount:1,crewAssigned:0,canCancel:true,canReschedule:true,withinCutoff:false}],past:[],addresses:[address],plans:[],paymentMethods:[]});
  if(path==='account/calendar')return ok({bookings:[{...booking,service:'Test cleaning',serviceFr:'Ménage de test',address:address.formattedAddress}],truncated:false});
  if(path==='account/phone/status')return ok({eligible:false,verified:false,configured:false});
  if(path==='commercial/enquiries')return ok({reference:'enquiry-test',appointmentConfirmed:false},201);
  return ok({error:{code:'UNAVAILABLE'}},503);
 });
 await page.goto(origin);await page.waitForSelector('body[data-boot="READY"]');
 await page.locator('#privacyBanner [data-choice="deny"]').click();
 await page.waitForFunction(()=>document.getElementById('privacyBanner')?.hidden===true);
 if(remote.some(h=>/facebook/.test(h)))throw new Error('Meta request before consent');
 await page.locator('[data-action="scroll-book"]:visible').first().click();
 await page.waitForFunction(()=>Boolean((document.getElementById('bookingDialog') as HTMLDialogElement)?.open));
 await page.locator('#bookingDialog [data-action="pick-family"]').first().click();
 await page.locator('#bookingDialog [data-action="pick-service"]').first().click();
 await page.locator('#bookingDialog [data-action="pick-prop"][data-prop="apartment"]').click();
 await page.locator('#nav [data-action="next"]').click();
 if(await page.locator('[data-step="products"].on').count()){
  await page.locator('#bookingDialog [data-action="pick-product"]').first().click();await page.locator('#nav [data-action="next"]').click();
 }
 await page.locator('#nav [data-action="next"]').click();
 await page.waitForURL('**/login?**');await page.locator('#email').fill('alex@example.test');await page.locator('#send').click();await page.locator('#code').fill('123456');await page.locator('#terms').check();await page.locator('#verify').click();
 await page.waitForURL('**/#book');await page.waitForSelector('#bookingDialog[open]');
 await page.locator('[data-action="use-saved"]').first().click();await page.locator('#nav [data-action="next"]').click();
 await page.locator('[data-action="pick-slot"]').first().click();await page.locator('#nm').fill('Alex Test');if(await page.locator('#em').inputValue()!=='alex@example.test')throw new Error('Email profile was not restored');await page.locator('#nav [data-action="next"]').click();
 await page.waitForFunction(()=>{const el=document.querySelector('[data-step="checkout"].on');return el&&Number(getComputedStyle(el).opacity)>.99;});
 if(await page.locator('#sticky [data-action="next"]').isVisible())throw new Error('Checkout exposes an unconfirmed next-step action');
 await page.waitForSelector('#payArea .checkout-total');
 await page.locator('[data-step="checkout"].on').evaluate(async el=>{await Promise.all(el.getAnimations({subtree:true}).filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>undefined)));});
 const readable = await page.locator('.ledger .ln .l').first().evaluate(el=>getComputedStyle(el).color);
 if(readable==='rgb(255, 255, 255)')throw new Error('Invoice text is white on white');
 await page.screenshot({path:`${output}/checkout-${viewport.width}.png`,fullPage:false});
 await page.locator(viewport.width===390?'#sticky [data-action="confirm"]':'#confirmBtn').click();await page.waitForSelector('[data-step="confirmation"].on');
 await page.keyboard.press('Escape');await page.goto(origin+'/account');await page.waitForSelector('#customerCalendar .customer-calendar-day');await page.locator('[data-calendar-view="week"]').click();await page.waitForSelector('.customer-calendar-event');
 await page.screenshot({path:`${output}/calendar-${viewport.width}.png`,fullPage:true});
 await page.goto(origin+'/commercial');await page.locator('#company').fill('Test Office');await page.locator('#contactName').fill('Alex Test');await page.locator('#businessDetails').fill('Weekly cleaning for a test office.');await page.locator('#businessSubmit').click();await page.waitForFunction(()=>document.getElementById('businessStatus')?.textContent?.includes('enquiry-test'));
 await page.screenshot({path:`${output}/commercial-${viewport.width}.png`,fullPage:true});
 if(errors.length)throw new Error(errors.join('\n'));if(calls.some(c=>c.includes('/auth/phone/')||c.includes('/account/phone/send')))throw new Error('SMS during email signup');
 report.push({viewport,errors,apiCalls:calls.length,noSmsAtSignup:true,noMetaBeforeConsent:!remote.some(h=>/facebook/.test(h)),simulatedApi:true});
 if(viewport.width===390){
  await page.goto(origin);await page.waitForSelector('body[data-boot="READY"]');
  await page.locator('.privacy-manage').click();await page.locator('#privacyMarketing').check();
  const pixelRequest=page.waitForRequest(r=>r.url().includes('connect.facebook.net'));
  await page.locator('#privacySave').click();await pixelRequest;
  await page.locator('.privacy-manage').click();await page.locator('#privacyMarketing').uncheck();
  await Promise.all([page.waitForURL(origin+'/'),page.locator('#privacySave').click()]);
  await page.waitForSelector('body[data-boot="READY"]');
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('r2n_privacy_choices')||'{}').marketing===false);
  if(await page.locator('script[src*="connect.facebook.net"]').count())throw new Error('Meta reloaded after withdrawal');
  report.push({consentGrantAndWithdrawal:true,simulatedApi:true,remoteMetaScriptBlockedByTest:true});
 }
 await context.close();
}}finally{await browser.close();writeFileSync(output+'/report.json',JSON.stringify(report,null,2));}
console.log(JSON.stringify({output,report},null,2));
