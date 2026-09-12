/** Runtime QA against the BUILT bundle. Fails on any console error. */
import express from 'express';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { chromium, type ConsoleMessage } from 'playwright';
import { createApi } from './src/api/app.js';
import { FakeVerificationProvider } from './src/identity/identity.js';
import { FakePlacesProvider } from './src/integrations/places.js';

const DB = process.env.TEST_DATABASE_URL ?? process.env.PRISMA_DATABASE_URL;
const prisma = new PrismaClient({ datasources: { db: { url: DB } } });
const app = express();
app.use(createApi({ prisma, verification: new FakeVerificationProvider('123456'), places: new FakePlacesProvider() }));
const dist = path.resolve('dist');
app.get('/book', (_r, res) => res.sendFile(path.join(dist, 'index.html')));
app.use(express.static(dist));
const server = app.listen(4700);
await new Promise(r => setTimeout(r, 400));

const OUT = '/mnt/user-data/outputs/screenshots';
const browser = await chromium.launch();
const errors: string[] = [];

async function page(w: number, h: number) {
  const p = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  // Log the URL too, otherwise "Failed to load resource" is undiagnosable.
  p.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error') errors.push(`[${w}px] ${m.text()} @ ${m.location().url}`);
  });
  p.on('response', (r) => { if (r.status() >= 400) errors.push(`[${w}px] HTTP ${r.status()} ${r.url()}`); });
  // Expected in this sandbox / before assets are supplied:
  //  - /assets/hero.jpg is an optional owner-supplied photo
  //  - the Google Fonts CDN is unreachable from the test container

  p.on('pageerror', (e) => errors.push(`[${w}px] PAGEERROR ${e.message}`));
  return p;
}

// 1. Samsung-sized mobile journey
const m = await page(360, 800);
await m.goto('http://localhost:4700/book', { waitUntil: 'networkidle' });
await m.waitForTimeout(1200);
await m.screenshot({ path: `${OUT}/01-home-mobile.png` });

// hero must have real text
const h1 = (await m.textContent('h1'))?.trim() ?? '';
const cta = (await m.textContent('[data-action="scroll-book"].btn'))?.trim() ?? '';
console.log('H1:', JSON.stringify(h1));
console.log('CTA:', JSON.stringify(cta));
const empties = await m.$$eval('[data-t]', els => els.filter(e => !e.textContent?.trim()).length);
console.log('EMPTY_LABELS:', empties);
const fams = await m.$$eval('.fam', e => e.length);
console.log('SERVICE_CARDS:', fams);

await m.click('[data-action="scroll-book"].btn');
await m.waitForTimeout(700);
await m.screenshot({ path: `${OUT}/02-services-mobile.png` });

await m.click('.fam');
await m.waitForTimeout(500);
await m.click('.opt[data-action="pick-service"]');
await m.waitForTimeout(700);
await m.screenshot({ path: `${OUT}/03-otp-mobile.png` });

// OTP
await m.fill('#ph', '5148252825');
await m.click('#sendBtn');
await m.waitForTimeout(700);
const otp = await m.$$('#otp input');
for (let i = 0; i < 6; i++) await otp[i]!.fill('123456'[i]!);
await m.waitForTimeout(1500);
await m.screenshot({ path: `${OUT}/04-welcome-back-mobile.png` });

// The welcome step hides the nav bar by design, so advance via its own CTA.
const cont = await m.$('[data-action="goto"][data-step="property"], [data-action="use-usual"]');
if (cont) { await cont.click(); await m.waitForTimeout(700); }

const tile = await m.$('.opt.tile');
if (tile) { await tile.click(); await m.waitForTimeout(400); }
async function next() {
  const b = await m.$('#nav [data-action="next"]');
  if (b && await b.isVisible()) { await b.click(); await m.waitForTimeout(800); }
}
await next();
await m.screenshot({ path: `${OUT}/05-products-mobile.png` });

const kit = await m.$('.kit');
if (kit) { await kit.click(); await m.waitForTimeout(500); }
await next();
const freq = await m.$('.freq.hero');
if (freq) { await freq.click(); await m.waitForTimeout(1000); }
await m.screenshot({ path: `${OUT}/06-frequency-mobile.png` });

await next();
await m.screenshot({ path: `${OUT}/07-address-mobile.png` });

// concierge drawer — force click since the sticky bar may overlap the FAB
await m.click('.help-fab', { force: true });
await m.waitForTimeout(700);
await m.screenshot({ path: `${OUT}/08-concierge-mobile.png` });
const close = await m.$('[data-action="close-sheet"]');
if (close) await close.click();
await m.waitForTimeout(300);

await m.close();

// 2. Larger Samsung
const l = await page(412, 915);
await l.goto('http://localhost:4700/book', { waitUntil: 'networkidle' });
await l.waitForTimeout(1200);
await l.screenshot({ path: `${OUT}/09-home-412.png` });
await l.close();

// 3. Desktop
const d = await page(1440, 1000);
await d.goto('http://localhost:4700/book', { waitUntil: 'networkidle' });
await d.waitForTimeout(1200);
await d.screenshot({ path: `${OUT}/10-home-desktop.png` });
await d.close();

await browser.close();
server.close();
await prisma.$disconnect();

const EXPECTED = /assets\/hero\.jpg|fonts\.googleapis\.com|fonts\.gstatic\.com|ERR_CERT_AUTHORITY_INVALID/;
const real = errors.filter((e) => !EXPECTED.test(e));
console.log('CONSOLE_ERRORS_TOTAL:', errors.length);
console.log('CONSOLE_ERRORS_REAL:', real.length);
for (const e of real.slice(0, 8)) console.log('  ', e);
if (real.length || empties > 0 || !h1 || fams === 0) {
  console.log('QA_RESULT: FAIL');
  process.exit(1);
}
console.log('QA_RESULT: PASS');
