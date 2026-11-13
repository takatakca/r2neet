// Claude (Anthropic) · 2026-11-13 — real-browser check of /login: Sign in / Sign up tabs, the password step,
// the « Autoriser l’accès » card and the return to the page the customer left.
//
//   1. start the hub stand-in:   node scripts/dev/hub-stub.cjs
//   2. start this site against it (see RUN.md, "Checking the sign-in in a browser") on BASE, default http://127.0.0.1:3100
//   3. node scripts/dev/signin-browser-check.cjs            # desktop, English
//      MOBILE=1 node scripts/dev/signin-browser-check.cjs   # phone, French
//
// Restart the site between the two runs: it limits sign-in attempts per visitor per hour (as it should).
const { chromium, devices } = require('playwright');

const base = (process.env.BASE || 'http://127.0.0.1:3100').replace(/\/$/, '');
const hubUrl = process.env.HUB || 'http://127.0.0.1:3200';
const phone = process.env.MOBILE === '1';
const fr = phone; // the phone run is French, the desktop run English
const shots = process.env.SHOTS || '';
let failures = 0;
const check = (ok, what) => { console.log((ok ? '  ok   ' : '  FAIL ') + what); if (!ok) failures++; };
const T = (frText, enText) => (fr ? frText : enText);

const PW1 = 'Correct-Horse-9!x';
const PW2 = 'Another-Safe-Pass-7#';
const stamp = `${Date.now() % 1e7}${Math.floor(Math.random() * 90 + 10)}`;
const addr = (tag) => `${tag}${stamp}@example.test`;
const hub = (path) => fetch(hubUrl + path).then((r) => r.json());
const hubUser = async (email) => (await hub('/__users')).find((u) => u.email === email);

const viewport = phone ? { ...devices['iPhone 13'], locale: 'fr-CA' } : { viewport: { width: 1280, height: 900 }, locale: 'en-CA' };

async function fresh(b, path = '/login') {
  const ctx = await b.newContext(viewport);
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await p.goto(base + path, { waitUntil: 'load', timeout: 45000 });
  const deny = p.locator('#privacyBanner [data-choice="deny"]');
  if (await deny.isVisible().catch(() => false)) await deny.click();
  await p.waitForFunction(() => document.getElementById('send') && !document.getElementById('send').disabled, null, { timeout: 15000 });
  return { ctx, p, errors };
}
const visible = (p, sel) => p.locator(sel).first().isVisible().catch(() => false);
const shot = async (p, name) => { if (shots) await p.screenshot({ path: `${shots}/${phone ? 'phone' : 'desktop'}-${name}.png`, fullPage: true }); };
const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
const signedIn = async (ctx) => (await ctx.request.get(base + '/api/v1/customer/context')).status() === 200;
const text = (p, sel) => p.locator(sel).first().innerText();

async function approveCard(p, expectCard = true) {
  await p.waitForSelector('#consentCard:not([hidden])', { timeout: 15000 });
  if (expectCard) check(/R2NETTE/.test(await text(p, '#consentApp')), 'the authorization card names R2NETTE');
  if (await visible(p, '#consentTermsRow')) await p.check('#consentTerms');
  await Promise.all([p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 }), p.click('#approve')]);
}

// The site asks for 30 seconds between two codes to the same address; a second test on one address waits it out.
const sentAt = new Map();
async function waitForCooldown(email) {
  const wait = (sentAt.get(email) || 0) + 31_000 - Date.now();
  if (wait > 0) { console.log(`       (waiting ${Math.ceil(wait / 1000)} s: one code per address every 30 s)`); await new Promise((r) => setTimeout(r, wait)); }
  sentAt.set(email, Date.now());
}

/** Code step shared by sign-up and "forgot": email, code, then the password step. */
async function toPasswordStep(p, email, { tabSignup = true } = {}) {
  await waitForCooldown(email);
  if (tabSignup) await p.click('#tabSignup');
  await p.fill('#email', email);
  if (tabSignup && await visible(p, '#terms')) await p.check('#terms');
  await p.click('#send');
  await p.waitForSelector('#codeForm:not([hidden])', { timeout: 15000 });
  await p.fill('#code', '123456');
  await p.click('#verify');
  await p.waitForSelector('#passwordForm:not([hidden])', { timeout: 15000 });
}

async function choosePassword(p, password) {
  await p.fill('#newPassword', password);
  await p.fill('#confirmPassword', password);
  await p.click('#savePassword');
}

(async () => {
  // CHROMIUM=/path lets a machine whose Playwright browsers differ from the project's pinned version use another build.
  const b = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  console.log(`${phone ? 'Phone (390 px, French)' : 'Desktop (1280 px, English)'} against ${base}`);
  await hub('/__reset');

  console.log('== 1. two tabs, keyboard, no overflow');
  {
    const { ctx, p, errors } = await fresh(b);
    check((await p.locator('[role=tab]').count()) === 2, 'two tabs');
    check((await text(p, '#tabSignin')) === T('Se connecter', 'Sign in') && (await text(p, '#tabSignup')) === T('S’inscrire', 'Sign up'), 'tab labels are in the page language');
    check((await p.getAttribute('#tabSignin', 'aria-selected')) === 'true' && (await visible(p, '#loginForm')), 'Sign in is the first tab and shows email + password');
    check(await visible(p, '#googleButton'), 'the sign-in tab offers Google');
    check(!(await visible(p, '#emailForm')), 'the sign-up form is not shown on the sign-in tab');
    check(!(await overflow(p)), 'no sideways scroll on the sign-in tab');
    await shot(p, 'tabs-signin');
    await p.click('#tabSignup');
    check((await p.getAttribute('#tabSignup', 'aria-selected')) === 'true' && (await visible(p, '#emailForm')) && (await visible(p, '#googleSignup')), 'Sign up shows Google and the email form');
    check(new URL(p.url()).searchParams.get('tab') === 'signup', 'the address says ?tab=signup');
    check(!(await overflow(p)), 'no sideways scroll on the sign-up tab');
    await shot(p, 'tabs-signup');
    await p.focus('#tabSignup');
    await p.keyboard.press('ArrowLeft');
    check((await p.getAttribute('#tabSignin', 'aria-selected')) === 'true' && (await p.evaluate(() => document.activeElement.id)) === 'tabSignin', 'ArrowLeft moves to Sign in and keeps focus on the tab');
    await p.keyboard.press('ArrowRight');
    check((await p.getAttribute('#tabSignup', 'aria-selected')) === 'true', 'ArrowRight moves back to Sign up');
    await p.goto(base + '/login?tab=signup', { waitUntil: 'load' });
    check(await visible(p, '#emailForm'), '/login?tab=signup opens on Sign up');
    check(errors.length === 0, 'no page errors ' + errors.join('|'));
    await ctx.close();
  }

  console.log('== 2. sign up by email: code, then password, then the card, then back to the page left');
  const maker = addr('signup');
  {
    const { ctx, p, errors } = await fresh(b, '/login?returnTo=%2Fterms');
    await toPasswordStep(p, maker);
    check(!(await visible(p, '#consentCard')), 'the card is NOT shown before the password is chosen');
    check((await text(p, '#passwordEmail')) === maker, 'the step names the account');
    check((await p.locator('#rules li[data-ok=true]').count()) === 0, 'no rule is ticked on an empty password');
    check(!(await overflow(p)), 'no sideways scroll on the password step');
    await shot(p, 'password-step');

    await p.fill('#newPassword', 'abcdefghijkl');
    check((await p.locator('#rules li[data-ok=true]').count()) === 2, 'typing "abcdefghijkl" ticks length and lower-case only');
    await p.fill('#newPassword', PW1);
    check((await p.locator('#rules li[data-ok=true]').count()) === 5, 'a good password ticks all five rules');
    await p.fill('#confirmPassword', PW1 + 'x');
    check(/not|pas/i.test(await text(p, '#matchNote')), 'a different confirmation says so while typing');
    await p.click('#savePassword');
    check(/not the same|pas identiques/i.test(await text(p, '#status')) && (await visible(p, '#passwordForm')), 'submitting a mismatch is refused with a message and the step stays open');
    await p.fill('#newPassword', 'weakpass');
    await p.fill('#confirmPassword', 'weakpass');
    await p.click('#savePassword');
    check((await visible(p, '#passwordForm')) && (await text(p, '#status')).length > 5, 'a weak password is refused before any request');
    check((await hubUser(maker))?.hasPassword === false, 'the hub still has no password for this address');

    await p.click('#togglePassword');
    check((await p.getAttribute('#newPassword', 'type')) === 'text' && (await p.getAttribute('#confirmPassword', 'type')) === 'text', 'Show reveals both fields');
    await p.click('#suggest');
    const suggested = await p.inputValue('#newPassword');
    check(suggested.length === 16 && suggested === (await p.inputValue('#confirmPassword')), 'Suggest fills both fields with a 16-character password');
    check((await p.locator('#rules li[data-ok=true]').count()) === 5, 'the suggested password passes every rule');

    await p.fill('#newPassword', PW1);
    await p.fill('#confirmPassword', PW1);
    await p.click('#savePassword');
    await approveCard(p);
    check(new URL(p.url()).pathname === '/terms', 'after Autoriser the customer is back on the page they left (' + new URL(p.url()).pathname + ')');
    check(await signedIn(ctx), 'the customer is signed in');
    check((await hubUser(maker))?.hasPassword === true, 'the password was set at the hub (the TAKATAK account)');
    check(errors.length === 0, 'no page errors ' + errors.join('|'));
    await ctx.close();
  }

  console.log('== 3. sign in with email + password');
  {
    const { ctx, p, errors } = await fresh(b, '/login?returnTo=%2Fterms');
    check(!(await visible(p, '#emailForm')), 'sign-in opens on the Sign in tab');
    await p.fill('#loginEmail', maker.toUpperCase());
    await p.fill('#loginPassword', 'Wrong-Horse-9!x');
    await p.click('#loginSubmit');
    await p.waitForFunction(() => document.getElementById('status').textContent.length > 5);
    check(/incorrect|Wrong email/i.test(await text(p, '#status')), 'a wrong password says "wrong email or password"');
    check((await p.evaluate(() => document.activeElement.id)) === 'loginPassword', 'focus goes back to the password field');
    check(!(await visible(p, '#consentCard')), 'no card after a wrong password');
    await p.click('#toggleLogin');
    check((await p.getAttribute('#loginPassword', 'type')) === 'text', 'Show reveals the sign-in password');
    await p.fill('#loginPassword', PW1);
    await p.click('#loginSubmit');
    await approveCard(p);
    check(new URL(p.url()).pathname === '/terms', 'back on the page the customer left');
    check(await signedIn(ctx), 'signed in with the password');
    check(errors.length === 0, 'no page errors ' + errors.join('|'));
    await ctx.close();
  }

  console.log('== 4. an address with no account looks the same as a wrong password');
  {
    const { ctx, p } = await fresh(b);
    await p.fill('#loginEmail', addr('nobody'));
    await p.fill('#loginPassword', PW1);
    await p.click('#loginSubmit');
    await p.waitForFunction(() => document.getElementById('status').textContent.length > 5);
    check(/incorrect|Wrong email/i.test(await text(p, '#status')), 'same message for an unknown address');
    await ctx.close();
  }

  console.log('== 5. sign up with Google: password step, then the card');
  const googler = addr('google');
  {
    await hub(`/__google?email=${encodeURIComponent(googler)}`);
    const { ctx, p, errors } = await fresh(b, '/login?tab=signup&returnTo=%2Fterms');
    await Promise.all([p.waitForURL(/step=password/, { timeout: 20000 }), p.click('#googleSignup')]);
    await p.waitForSelector('#passwordForm:not([hidden])', { timeout: 15000 });
    check((await text(p, '#passwordEmail')) === googler, 'the password step names the Google account');
    check(!(await visible(p, '#consentCard')), 'the card is not shown before the password');
    await choosePassword(p, PW1);
    await approveCard(p);
    check(new URL(p.url()).pathname === '/terms' && (await signedIn(ctx)), 'signed in and back on the page left');
    check((await hubUser(googler))?.hasPassword === true, 'the Google customer now has a password at the hub');
    check(errors.length === 0, 'no page errors ' + errors.join('|'));
    await ctx.close();
  }

  console.log('== 6. sign in with Google (existing): straight to the card, no password step');
  {
    await hub(`/__google?email=${encodeURIComponent(googler)}`);
    const { ctx, p } = await fresh(b, '/login?returnTo=%2Fterms');
    await Promise.all([p.waitForURL(/consent=1/, { timeout: 20000 }), p.click('#googleButton')]);
    await p.waitForSelector('#consentCard:not([hidden])', { timeout: 15000 });
    check(!(await visible(p, '#passwordForm')), 'no password step for a Google sign-in');
    await approveCard(p);
    check(new URL(p.url()).pathname === '/terms' && (await signedIn(ctx)), 'signed in and back on the page left');
    await ctx.close();
  }

  console.log('== 7. forgot password / first sign-in of an older account: code, then a new password');
  {
    const { ctx, p, errors } = await fresh(b, '/login?returnTo=%2Fterms');
    await p.fill('#loginEmail', maker);
    await p.click('#forgot');
    check((await visible(p, '#emailForm')) && (await visible(p, '#resetNote')) && !(await visible(p, '#googleSignup')), 'the code form opens without Google and the terms');
    check((await p.inputValue('#email')) === maker, 'the typed email is carried over');
    await toPasswordStep(p, maker, { tabSignup: false });
    check(!(await visible(p, '#consentCard')), 'the card waits for the new password');
    await choosePassword(p, PW1);
    // The same password as before is fine: it is already set.
    await approveCard(p);
    await ctx.close();

    const second = await fresh(b, '/login?returnTo=%2Fterms');
    await second.p.fill('#loginEmail', maker);
    await second.p.click('#forgot');
    await toPasswordStep(second.p, maker, { tabSignup: false });
    await choosePassword(second.p, PW2);
    await approveCard(second.p);
    check(await signedIn(second.ctx), 'a new password was chosen and the customer is signed in');
    await second.ctx.close();

    const old = await fresh(b);
    await old.p.fill('#loginEmail', maker);
    await old.p.fill('#loginPassword', PW1);
    await old.p.click('#loginSubmit');
    await old.p.waitForFunction(() => document.getElementById('status').textContent.length > 5);
    check(/incorrect|Wrong email/i.test(await text(old.p, '#status')), 'the old password no longer works');
    await old.p.fill('#loginPassword', PW2);
    await old.p.click('#loginSubmit');
    await approveCard(old.p);
    check(await signedIn(old.ctx), 'the new password works');
    check(errors.length === 0, 'no page errors ' + errors.join('|'));
    await old.ctx.close();
  }

  console.log('== 8. an older code-only customer (no password yet) gets in through "first sign-in"');
  {
    const legacy = addr('legacy');
    await fetch(hubUrl + '/auth/v1/otp', { method: 'POST', body: JSON.stringify({ email: legacy }) }); // exists at the hub, no password
    const { ctx, p } = await fresh(b, '/login?returnTo=%2Fterms');
    await p.fill('#loginEmail', legacy);
    await p.fill('#loginPassword', PW1);
    await p.click('#loginSubmit');
    await p.waitForFunction(() => document.getElementById('status').textContent.length > 5);
    check(/first sign-in|Première connexion/i.test(await text(p, '#status')), 'the message points to "First sign-in or forgot your password?"');
    await p.click('#forgot');
    await toPasswordStep(p, legacy, { tabSignup: false });
    await choosePassword(p, PW1);
    await approveCard(p);
    check(await signedIn(ctx), 'signed in, and the older account now has a password');
    await ctx.close();
  }

  console.log('== 9. five wrong passwords lock that address for a while');
  {
    const { ctx, p } = await fresh(b);
    const victim = addr('lock');
    for (let i = 0; i < 5; i += 1) {
      await p.fill('#loginEmail', victim);
      await p.fill('#loginPassword', 'Nope-Nope-Nope-1!');
      await p.click('#loginSubmit');
      await p.waitForFunction((n) => document.getElementById('status').textContent.length > 5 && !document.getElementById('loginSubmit').disabled, i);
    }
    await p.fill('#loginPassword', 'Nope-Nope-Nope-1!');
    await p.click('#loginSubmit');
    await p.waitForFunction(() => /15|minutes/.test(document.getElementById('status').textContent), null, { timeout: 8000 }).catch(() => {});
    check(/15 minutes|15 minutes/.test(await text(p, '#status')), 'the sixth try says to wait: ' + JSON.stringify(await text(p, '#status')));
    check(await visible(p, '#googleButton'), 'Google is still offered as another way in');
    await ctx.close();
  }

  console.log('== 10. the card cannot be reached before the password');
  {
    const { ctx, p } = await fresh(b);
    await toPasswordStep(p, addr('guard'));
    const read = await ctx.request.get(base + '/api/v1/auth/takatak/consent');
    check(read.status() === 409, 'GET /consent while the password is pending is refused (' + read.status() + ')');
    await p.goto(base + '/login?consent=1', { waitUntil: 'load' });
    await p.waitForSelector('#passwordForm:not([hidden])', { timeout: 15000 });
    check(!(await visible(p, '#consentCard')), '/login?consent=1 lands on the password step, not the card');
    await ctx.close();
  }

  console.log('== 11. language switch keeps the step');
  {
    const { ctx, p } = await fresh(b);
    await toPasswordStep(p, addr('lang'));
    const before = await text(p, '#savePassword');
    await p.click('#language');
    check((await text(p, '#savePassword')) !== before && (await visible(p, '#passwordForm')), 'the password step is re-worded in the other language and stays open');
    check((await text(p, '#ruleLength')).length > 3, 'the rules are re-worded too');
    await ctx.close();
  }

  await b.close();
  console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('ERROR', String(e.message || e).split('\n').slice(0, 8).join(' | ')); process.exit(2); });
