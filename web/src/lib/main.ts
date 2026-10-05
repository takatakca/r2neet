/**
 * R2NETTE booking application entry.
 *
 * Two structural fixes from the broken build:
 *
 * 1. NO inline `onclick` handlers and nothing attached to `window`. Every
 *    interaction is a delegated listener keyed on `data-action`. A bundle
 *    that fails to load can no longer produce "goNext is not defined" —
 *    there is no global to be missing.
 *
 * 2. An explicit boot sequence with a visible failure state. The HTML ships
 *    with real fallback copy, so a JS failure degrades to readable content
 *    plus a recovery screen, never a blank page with empty pills.
 */

import {
  detectLocale,
  persistLocale,
  translate,
  translateError,
  formatMoney,
  formatPhoneInput,
  maskPhoneDisplay,
  type Locale,
} from '../i18n/index.js';
import {
  api,
  ApiError,
  emptyDraft,
  saveDraft,
  loadDraft,
  clearDraft,
  torontoDateKey,
  formatSlotTime,
  formatSlotDate,
  remainingMs,
  formatCountdown,
  buildIcs,
  type ServiceOption,
  type Quote,
  type CustomerContext,
  type Hold,
  type Booking,
} from './api.js';
import { checkoutMode, mapPaymentError, type PaymentConfig } from './checkout.js';

type BootState = 'BOOTING' | 'READY' | 'API_UNAVAILABLE' | 'FRONTEND_ERROR';

let locale: Locale = detectLocale();
const t = (k: string, v: Record<string, string | number> = {}) => translate(locale, k, v);

const S = { ...emptyDraft, ...(loadDraft() ?? {}) } as typeof emptyDraft & { familyId?: string };
let services: ServiceOption[] = [];
let ctx: CustomerContext | null = null;
let quote: Quote | null = null;
let hold: Hold | null = null;
let holdTimer: ReturnType<typeof setInterval> | null = null;
let addrSession: string | null = null;
let suggestTimer: ReturnType<typeof setTimeout> | null = null;
let paymentCfg: PaymentConfig | null = null;
let phoneRaw = '';
let verified = false;
let selectedDay: string | null = null;
let quoteSeq = 0;
let reviews: { averageRating: number | null; reviewCount: number } | null = null;
let bookingResult: Booking | null = null;

const STEPS = [
  'service',
  'welcome',
  'property',
  'products',
  'frequency',
  'address',
  'slots',
  'details',
  'checkout',
  'confirmation',
] as const;

/* Four phases the customer perceives, regardless of internal steps. */
const PHASE: Record<string, 'CLEAN' | 'HOME' | 'TIME' | 'CONFIRM'> = {
  service: 'CLEAN',
  welcome: 'CLEAN',
  property: 'HOME',
  products: 'CLEAN',
  frequency: 'CLEAN',
  address: 'HOME',
  slots: 'TIME',
  details: 'CONFIRM',
  checkout: 'CONFIRM',
  confirmation: 'CONFIRM',
};

const $ = (id: string) => document.getElementById(id);

const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Roll a money value from its previous number to the new one.
 *
 * The price is the emotional centre of this flow, so it should never snap.
 * Reduced-motion users get the final value immediately.
 */
function countMoney(el: HTMLElement, from: number, to: number, ms = 520): void {
  if (reduceMotion() || from === to) {
    el.textContent = formatMoney(to, locale);
    return;
  }
  const started = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - started) / ms);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = formatMoney(Math.round(from + (to - from) * eased), locale);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** One-shot class used to pulse an element when its value changes. */
function pulse(el: Element | null, cls = 'pulse', ms = 520): void {
  if (!el || reduceMotion()) return;
  el.classList.remove(cls);
  void (el as HTMLElement).offsetWidth; // restart the animation
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), ms);
}

let lastTotalCents = 0;
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const TICK =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"><path d="M20 6L9 17l-5-5"/></svg>';

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

function setBoot(state: BootState, detail?: string): void {
  document.body.dataset.boot = state;

  if (detail) {
    console.error('[r2nette boot]', detail);
  }
}

/** A late failure must not leave a half-rendered interface. */
function installErrorBoundary(): void {
  window.addEventListener('error', (e) => {
    if (document.body.dataset.boot !== 'READY') setBoot('FRONTEND_ERROR', e.message);
  });
  window.addEventListener('unhandledrejection', (e) => {
    if (document.body.dataset.boot !== 'READY') {
      setBoot('FRONTEND_ERROR', String((e as PromiseRejectionEvent).reason));
    }
  });
}

/* ------------------------------------------------------------------ */
/* i18n                                                                */
/* ------------------------------------------------------------------ */

function applyLocale(): void {
  document.documentElement.lang = locale === 'fr' ? 'fr-CA' : 'en-CA';
  document.querySelectorAll<HTMLElement>('[data-t]').forEach((el) => {
    const key = el.dataset.t!;
    const value = t(key);
    // Only replace when a translation exists, so fallback copy survives.
    if (value !== key) el.textContent = value;
  });
  document.querySelectorAll<HTMLElement>('.lang button').forEach((b) => {
    b.setAttribute('aria-pressed', String((b as HTMLElement).dataset.locale === locale));
  });
  const addr = $('addrInput') as HTMLInputElement | null;
  if (addr) addr.placeholder = t('address.search');
  render();
}

/* ------------------------------------------------------------------ */
/* toast                                                               */
/* ------------------------------------------------------------------ */

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(msg: string, kind: 'info' | 'save' = 'info'): void {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('save', kind === 'save');
  el.classList.add('on');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 4200);
}
const showError = (e: unknown) =>
  toast(translateError(locale, e instanceof ApiError ? e.code : undefined));

const svc = () => services.find((s) => s.id === S.serviceOptionId) ?? null;

/* ------------------------------------------------------------------ */
/* services                                                            */
/* ------------------------------------------------------------------ */

const FAMILIES = [
  { id: 'cat_basic', key: 'fam.basic', sub: 'fam.basicSub', art: 'basic' },
  { id: 'cat_deep', key: 'fam.deep', sub: 'fam.deepSub', art: 'deep' },
  { id: 'cat_other', key: 'fam.other', sub: 'fam.otherSub', art: 'other' },
];

function renderFamilies(): void {
  const box = $('families');
  if (!box) return;

  const imageByFamily: Record<string, string> = {
    basic: '/assets/services/basic.jpg',
    deep: '/assets/services/deep.jpg',
    other: '/assets/services/specialty.jpg',
  };

  box.innerHTML = FAMILIES.map((family) => {
    const image =
      imageByFamily[family.art] ??
      '/assets/services/specialty.jpg';

    return `
      <button
        type="button"
        class="landing-service-card"
        data-action="pick-family"
        data-family="${esc(family.id)}"
        aria-pressed="${S.familyId === family.id}"
      >
        <span
          class="landing-service-photo"
          style="background-image:url('${image}')"
          aria-hidden="true"
        ></span>

        <span class="landing-service-content">
          <span class="landing-service-copy">
            <strong>${esc(t(family.key))}</strong>
            <span>${esc(t(family.sub))}</span>
          </span>

          <span class="landing-service-arrow" aria-hidden="true">
            →
          </span>
        </span>
      </button>
    `;
  }).join('');

  renderServiceOptions();
}

function renderServiceOptions(): void {
  const box = $('serviceOpts');
  if (!box) return;
  if (!S.familyId) {
    box.innerHTML = '';
    return;
  }
  const list = services.filter((s) => s.categoryId === S.familyId);
  box.innerHTML =
    `<div class="eyebrow">${esc(t('service.crew'))}</div><div class="opts">` +
    list
      .map((s) => {
        const hrs = s.appointmentDurationMinutes ? s.appointmentDurationMinutes / 60 : null;
        const crew = `${s.requiredStaffCount} ${s.requiredStaffCount === 1 ? t('service.cleaner') : t('service.cleaners')}`;
        const dur = hrs ? ` · ${hrs} ${t('service.hours')}` : '';
        const price =
          s.pricingMode === 'QUOTE_REQUIRED'
            ? `<span class="amt sm">${esc(t('service.quote'))}</span>`
            : `<span class="amt">${formatMoney(s.basePriceCents ?? 0, locale)}</span><span class="per">${esc(t('service.perVisit'))}</span>`;
        return `<button type="button" class="opt" data-action="pick-service" data-service="${s.id}"
          aria-pressed="${S.serviceOptionId === s.id}">
          <span class="chk">${TICK}</span>
          <span class="opt-b"><span class="opt-t">${esc(s.name[locale] ?? s.name.en)}</span>
          <span class="opt-d">${esc(crew + dur)}</span></span>
          <span class="opt-p">${price}</span></button>`;
      })
      .join('') +
    '</div>';
}

/* ------------------------------------------------------------------ */
/* OTP                                                                 */
/* ------------------------------------------------------------------ */

function openSheet(html: string): void {
  const body = $('sheetBody');
  const sheet = $('sheet');
  if (!body || !sheet) return;
  body.innerHTML = html;
  sheet.classList.add('on');
}
const closeSheet = () => $('sheet')?.classList.remove('on');

function openIdentitySheet(): void {
  openSheet(`<h2>${esc(t('otp.title'))}</h2><p class="s">${esc(t('otp.sub'))}</p>
    <label class="fl" for="ph">${esc(t('otp.phone'))}</label>
    <input class="inp" id="ph" type="tel" inputmode="tel" autocomplete="tel" placeholder="(514) 825-2825">
    <div class="err" id="phErr" hidden></div>
    <button class="btn btn-primary full" id="sendBtn" data-action="send-code">${esc(t('otp.send'))}</button>`);
  const ph = $('ph') as HTMLInputElement;
  ph.addEventListener('input', () => {
    ph.value = formatPhoneInput(ph.value);
  });
  ph.focus();
}

async function sendCode(): Promise<void> {
  const btn = $('sendBtn') as HTMLButtonElement | null;
  const input = $('ph') as HTMLInputElement | null;
  if (input) phoneRaw = input.value;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="spin"></span> ${esc(t('otp.sending'))}`;
  }
  try {
    const res = await api.sendCode(phoneRaw, 'login');
    openOtpSheet(res.maskedPhone);
  } catch (e) {
    const err = $('phErr');
    if (err) {
      err.textContent = translateError(locale, e instanceof ApiError ? e.code : undefined);
      err.hidden = false;
    } else showError(e);
    if (btn) {
      btn.disabled = false;
      btn.textContent = t('otp.send');
    }
  }
}

function openOtpSheet(masked: string): void {
  openSheet(`<h2>${esc(t('otp.codeTitle'))}</h2><p class="s">${esc(t('otp.codeSub'))} ${esc(masked)}</p>
    <div class="otp" id="otp">${[1, 2, 3, 4, 5, 6]
      .map((i) => `<input inputmode="numeric" pattern="[0-9]*" maxlength="1" aria-label="Digit ${i}">`)
      .join('')}</div>
    <div class="err" id="otpErr" hidden></div>
    <div class="ctr"><button class="link" id="resend" disabled></button></div>
    <div class="ctr"><button class="link" data-action="change-number">${esc(t('otp.changeNumber'))}</button></div>`);

  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('#otp input'));
  inputs[0]?.focus();
  inputs.forEach((inp, i) => {
    inp.addEventListener('input', () => {
      inp.value = inp.value.replace(/\D/g, '').slice(0, 1);
      if (inp.value && i < 5) inputs[i + 1]?.focus();
      if (inputs.every((x) => x.value)) void verifyCode(inputs.map((x) => x.value).join(''));
    });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !inp.value && i > 0) inputs[i - 1]?.focus();
    });
    inp.addEventListener('paste', (e) => {
      e.preventDefault();
      const d = (e.clipboardData?.getData('text') ?? '').replace(/\D/g, '').slice(0, 6);
      d.split('').forEach((c, k) => {
        if (inputs[k]) inputs[k]!.value = c;
      });
      if (d.length === 6) void verifyCode(d);
      else inputs[Math.min(d.length, 5)]?.focus();
    });
  });

  let left = 30;
  const rb = $('resend') as HTMLButtonElement;
  rb.textContent = t('otp.resendIn', { s: left });
  const iv = setInterval(() => {
    left--;
    rb.textContent = left > 0 ? t('otp.resendIn', { s: left }) : t('otp.resend');
    rb.disabled = left > 0;
    if (left <= 0) {
      clearInterval(iv);
      rb.dataset.action = 'send-code';
    }
  }, 1000);
}

async function verifyCode(code: string): Promise<void> {
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('#otp input'));
  const err = $('otpErr');
  inputs.forEach((i) => (i.disabled = true));
  if (err) err.hidden = true;
  try {
    await api.verifyCode(phoneRaw, code, 'login');
    verified = true;
    closeSheet();
    try {
      ctx = await api.context();
    } catch {
      /* profile is optional to continue */
    }
    renderWelcome();
    goTo('welcome');
  } catch (e) {
    inputs.forEach((i) => {
      i.disabled = false;
      i.value = '';
      i.classList.add('bad');
    });
    inputs[0]?.focus();
    if (err) {
      err.textContent = translateError(locale, e instanceof ApiError ? e.code : undefined);
      err.hidden = false;
    }
    setTimeout(() => inputs.forEach((i) => i.classList.remove('bad')), 1200);
  }
}

function renderWelcome(): void {
  const box = $('welcomeBody');
  if (!box) return;
  const c = ctx?.customer;
  if (!c) {
    box.innerHTML = '';
    return;
  }
  const u = ctx?.usualClean;
  if (u) {
    box.innerHTML = `<div class="eyebrow">${esc(t('welcome.eyebrow'))}</div>
      <h2 class="big">${esc(t('welcome.back', { name: c.firstName ?? '' }))}</h2>
      <div class="usual">
        <div class="eyebrow light">${esc(t('usual.title'))}</div>
        <div class="usual-svc">${esc(u.serviceName)}</div>
        <div class="usual-meta">${u.requiredStaffCount} ${u.requiredStaffCount === 1 ? t('service.cleaner') : t('service.cleaners')} · ${esc(t('frequency.' + u.frequency))}</div>
        <div class="usual-addr">${esc(u.addressSummary ?? '')}</div>
        <button class="btn btn-primary full" data-action="use-usual">${esc(t('usual.cta'))}</button>
        <button class="link light" data-action="goto" data-step="property">${esc(t('usual.change'))}</button>
      </div>`;
  } else {
    box.innerHTML = `<h2 class="big">${esc(t('welcome.new'))}</h2>
      <p class="sub">${esc(t('welcome.newSub'))}</p>
      <button class="btn btn-primary" data-action="goto" data-step="property">${esc(t('common.continue'))}</button>`;
  }
}

/* ------------------------------------------------------------------ */
/* property / products / frequency                                     */
/* ------------------------------------------------------------------ */

const PROPS = [
  { id: 'apartment', ic: '🏢', k: 'property.apartment' },
  { id: 'condo', ic: '🏙', k: 'property.condo' },
  { id: 'house', ic: '🏡', k: 'property.house' },
  { id: 'airbnb', ic: '🔑', k: 'property.airbnb' },
  { id: 'chalet', ic: '🌲', k: 'property.chalet' },
  { id: 'commercial', ic: '🏬', k: 'property.commercial' },
];

function renderProperty(): void {
  const box = $('propTypes');
  if (!box) return;
  box.innerHTML = PROPS.map(
    (p) => `<button type="button" class="opt tile" data-action="pick-prop" data-prop="${p.id}"
      aria-pressed="${S.propertyType === p.id}"><span class="ic">${p.ic}</span>
      <span class="opt-t">${esc(t(p.k))}</span></button>`,
  ).join('');

  const d = $('propDetail');
  if (!d) return;
  if (['apartment', 'condo', 'airbnb'].includes(S.propertyType ?? '')) {
    const sizes = ['Studio', '1½', '2½', '3½', '4½', '5½', '6½', '7½+'];
    d.innerHTML =
      `<div class="eyebrow">${esc(t('property.size'))}</div><div class="opts tiles">` +
      sizes
        .map(
          (z) => `<button type="button" class="opt tile" data-action="pick-size" data-size="${z}"
        aria-pressed="${S.propertySize === z}"><span class="opt-t">${z}</span></button>`,
        )
        .join('') +
      '</div>';
  } else if (S.propertyType) {
    d.innerHTML = `<div class="f2">
      <div><label class="fl">${esc(t('property.bedrooms'))}</label>
        <input class="inp" type="number" min="0" max="12" value="${S.bedrooms}" data-field="bedrooms"></div>
      <div><label class="fl">${esc(t('property.bathrooms'))}</label>
        <input class="inp" type="number" min="0" max="12" value="${S.bathrooms}" data-field="bathrooms"></div></div>`;
  } else d.innerHTML = '';
}

function renderProducts(): void {
  const box = $('products');
  const s = svc();
  if (!box) return;
  if (!s || s.productSupplyMode === 'NOT_APPLICABLE') {
    box.innerHTML = `<div class="note">${esc(t('products.na'))}</div>`;
    return;
  }
  const deep = s.categoryId === 'cat_deep' || s.id === 'svc_move';
  const cents = deep ? 1500 : 1200;
  const code = deep ? 'R2NETTE_DEEP' : 'R2NETTE_BASIC';
  box.innerHTML = `
    <button type="button" class="kit" data-action="pick-product" data-product="CLIENT_SUPPLIED"
      aria-pressed="${S.productSupplyOption === 'CLIENT_SUPPLIED'}">
      <span class="kit-art own"></span>
      <span class="kit-b"><span class="kit-t">${esc(t('products.client'))}</span>
      <span class="kit-d">${esc(t('products.clientSub'))}</span>
      <span class="kit-p">${formatMoney(0, locale)}</span></span></button>
    <button type="button" class="kit" data-action="pick-product" data-product="${code}"
      aria-pressed="${S.productSupplyOption === code}">
      <span class="kit-art r2"></span>
      <span class="kit-b"><span class="kit-t">${esc(t('products.r2nette'))}</span>
      <span class="kit-d">${esc(t('products.r2netteSub'))}</span>
      <span class="kit-p save">+${formatMoney(cents, locale)} <small>${esc(t('products.plusTax'))}</small></span></span></button>`;
}

function renderFrequency(): void {
  const box = $('freq');
  if (!box) return;
  const s = svc();
  const allowed = s ? s.allowedFrequencies : [];
  const pct: Record<string, number> = { ONE_TIME: 0, MONTHLY: 10, BIWEEKLY: 15, WEEKLY: 25 };
  box.innerHTML = ['ONE_TIME', 'MONTHLY', 'BIWEEKLY', 'WEEKLY']
    .map((f) => {
      const ok = allowed.includes(f);
      const hero = f === 'WEEKLY' && ok;
      const save = pct[f]
        ? `<span class="freq-save">${esc(t('frequency.save', { p: pct[f]! }))}</span>`
        : '';
      // The badge lives INSIDE the card: a <button> clips overflow, so
      // anything hanging off its edge gets cut.
      return `<button type="button" class="freq${hero ? ' hero' : ''}" ${ok ? '' : 'disabled'}
        data-action="pick-freq" data-freq="${f}" aria-pressed="${S.frequency === f}">
        ${hero ? `<span class="badge">${esc(t('frequency.bestValue'))}</span>` : ''}
        <span class="freq-main"><span class="freq-t">${esc(t('frequency.' + f))}</span>${save}</span>
        </button>`;
    })
    .join('');
}

/* ------------------------------------------------------------------ */
/* address                                                             */
/* ------------------------------------------------------------------ */

function renderAddress(): void {
  const saved = ctx?.addresses ?? [];
  const box = $('savedAddrs');
  const search = $('addrSearch');
  const picked = $('addrPicked');
  if (!box || !search || !picked) return;

  if (saved.length && !S.addressId) {
    box.innerHTML =
      `<div class="eyebrow">${esc(t('address.saved'))}</div><div class="opts mb">` +
      saved
        .map(
          (a) => `<button type="button" class="opt" data-action="use-saved" data-addr="${a.id}">
          <span class="chk">${TICK}</span><span class="opt-b">
          <span class="opt-t">${esc(a.label ?? 'Home')}</span>
          <span class="opt-d">${esc(a.formattedAddress)}</span></span></button>`,
        )
        .join('') +
      `</div><div class="eyebrow">${esc(t('address.elsewhere'))}</div>`;
  } else box.innerHTML = '';

  if (S.addressId && S.addressSummary) {
    search.hidden = true;
    picked.hidden = false;
    picked.innerHTML = `<div class="found"><span class="ok">✓</span>
      <div><div class="found-t">${esc(t('address.found'))}</div>
      <div class="found-a">${esc(S.addressSummary)}</div></div>
      <button class="link" data-action="clear-address">${esc(t('address.change'))}</button></div>`;
  } else {
    search.hidden = false;
    picked.hidden = true;
  }
}

/* ------------------------------------------------------------------ */
/* quote & ledger                                                      */
/* ------------------------------------------------------------------ */

async function refreshQuote(): Promise<void> {
  const s = svc();
  if (!s || !S.frequency || s.pricingMode === 'QUOTE_REQUIRED') return;
  if (s.productSupplyMode === 'REQUIRED_SELECTION' && !S.productSupplyOption) return;
  const seq = ++quoteSeq;
  try {
    const res = await api.quote({
      serviceOptionId: S.serviceOptionId!,
      frequency: S.frequency,
      productSupplyOption: S.productSupplyOption ?? undefined,
      addressId: S.addressId ?? undefined,
    });
    if (seq !== quoteSeq) return;
    quote = res.quote;
    renderLedger();
  } catch (e) {
    showError(e);
  }
}

function renderLedger(): void {
  const box = $('ledgerBody');
  const sticky = $('sticky');
  if (!box || !sticky) return;
  if (!quote) {
    box.innerHTML = `<div class="empty">${esc(t('ledger.empty'))}</div>`;
    sticky.hidden = true;
    return;
  }
  let h = '<div class="lines">';
  let row = 0;
  for (const l of quote.lines) {
    const save = l.subtotalCents < 0;
    // Lines cascade in rather than appearing as a block.
    h += `<div class="ln${save ? ' save' : ''}${l.subtotalCents === 0 ? ' mut' : ''}"
      style="animation-delay:${row++ * 45}ms">
      <span class="l">${esc(l.description)}</span>
      <span class="v">${formatMoney(l.subtotalCents, locale)}</span></div>`;
  }
  h += `<div class="ln rule mut"><span class="l">${esc(t('ledger.subtotal'))}</span>
    <span class="v">${formatMoney(quote.subtotalBeforeTaxCents, locale)}</span></div>`;
  for (const tx of quote.taxLines) {
    h += `<div class="ln mut"><span class="l">${esc(tx.name)}</span>
      <span class="v">${formatMoney(tx.amountCents, locale)}</span></div>`;
  }
  h += `<div class="ln tot"><span class="l">${esc(t('ledger.total'))}</span>
    <span class="v" id="ledgerTotal">${formatMoney(lastTotalCents, locale)}</span></div></div><div class="lf">`;
  h += `<div class="due"><span>${esc(t('checkout.dueToday'))}</span>
    <span class="mono">${formatMoney(paymentCfg?.amountDueNowCents ?? 0, locale)}</span></div>`;
  const disc = quote.firstVisit?.appliedDiscount;
  if (disc) h += `<div class="savepill">★ ${formatMoney(disc.amountCents, locale)}</div>`;
  if (quote.subsequentVisitPricingPreview) {
    h += `<div class="nextv"><b>${esc(t('ledger.laterVisits'))}:</b>
      ${formatMoney(quote.subsequentVisitPricingPreview.discountedServiceCents, locale)}
      — ${esc(t('ledger.laterNote'))}</div>`;
  }
  box.innerHTML = h + '</div>';

  const changed = quote.grandTotalCents !== lastTotalCents;
  const ledgerTotal = $('ledgerTotal');
  if (ledgerTotal) countMoney(ledgerTotal, lastTotalCents, quote.grandTotalCents);

  sticky.hidden = false;
  const tot = $('stickyTot');
  if (tot) countMoney(tot, lastTotalCents, quote.grandTotalCents);
  if (changed) {
    pulse(document.querySelector('.ledger'));
    pulse(sticky);
  }
  lastTotalCents = quote.grandTotalCents;
  const ss = $('stickySave');
  if (ss) {
    if (disc) {
      ss.hidden = false;
      ss.textContent = `${t('ledger.youSave')} ${formatMoney(disc.amountCents, locale)}`;
    } else ss.hidden = true;
  }
}

/* ------------------------------------------------------------------ */
/* availability & hold                                                 */
/* ------------------------------------------------------------------ */

function renderDays(): void {
  const box = $('days');
  if (!box) return;
  const days: { key: string; date: Date }[] = [];
  for (let i = 0; i < 14; i++) {
    const dt = new Date(Date.now() + i * 86400000);
    days.push({ key: torontoDateKey(dt), date: dt });
  }
  if (!selectedDay) selectedDay = days[1]!.key;
  const fmt = (d: Date, o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', {
      timeZone: 'America/Toronto',
      ...o,
    }).format(d);
  box.innerHTML = days
    .map((d, i) => {
      const w = i === 0 ? t('slots.today') : i === 1 ? t('slots.tomorrow') : fmt(d.date, { weekday: 'short' });
      return `<button type="button" class="day" data-action="pick-day" data-day="${d.key}"
        aria-pressed="${selectedDay === d.key}"><span class="w">${esc(w)}</span>
        <span class="d">${esc(fmt(d.date, { day: 'numeric' }))}</span></button>`;
    })
    .join('');
}

async function loadSlots(): Promise<void> {
  const area = $('slotArea');
  if (!area || !S.serviceOptionId || !selectedDay) return;
  // Skeleton keeps the layout stable so nothing jumps when times arrive.
  area.innerHTML = `<div class="sk sk-line" style="width:52%"></div>
    <div class="sk-slots" style="margin-top:14px">${'<div class="sk sk-slot"></div>'.repeat(8)}</div>`;
  try {
    const res = await api.availability(S.serviceOptionId, selectedDay);
    if (!res.slots.length) {
      area.innerHTML = `<div class="empty-state">
        <div class="empty-ic">📅</div>
        <div class="empty-t">${esc(t('slots.none'))}</div>
        <button class="btn btn-ghost" data-action="open-help">${esc(t('concierge.callMe'))}</button></div>`;
      return;
    }
    area.innerHTML =
      `<div class="next-av"><span class="eyebrow light">${esc(t('slots.nextAvailable'))}</span>
        <span class="next-t">${esc(formatSlotTime(res.slots[0]!.startAt, locale))}</span></div>
      <div class="slots">` +
      res.slots
        .map(
          (s, i) => `<button type="button" class="slot" style="animation-delay:${i * 22}ms"
        data-action="pick-slot" data-slot="${s.startAt}"
        aria-pressed="${S.slotStartAt === s.startAt}">${esc(formatSlotTime(s.startAt, locale))}</button>`,
        )
        .join('') +
      '</div>';
  } catch (e) {
    area.innerHTML = `<div class="note">${esc(translateError(locale, e instanceof ApiError ? e.code : undefined))}</div>`;
  }
}

function startHoldTimer(): void {
  if (holdTimer) clearInterval(holdTimer);
  holdTimer = setInterval(renderHold, 1000);
  renderHold();
}

function renderHold(): void {
  if (!hold) return;
  const ms = remainingMs(hold.expiresAt);
  const warn = ms < 120000;
  const gone = ms <= 0;
  const html = gone
    ? `<div class="holdbar gone"><span>⚠</span> ${esc(t('hold.expired'))}
       <button class="link" data-action="back-to-slots">${esc(t('hold.findAnother'))}</button></div>`
    : `<div class="holdbar${warn ? ' warn' : ''}"><span class="ok">✓</span>
       <span>${esc(warn ? t('hold.soon') : t('hold.reserved'))}</span>
       <span class="time">${formatCountdown(ms)}</span></div>`;
  for (const id of ['holdBar', 'holdBar2']) {
    const el = $(id);
    if (el) el.innerHTML = html;
  }
  if (gone) {
    if (holdTimer) clearInterval(holdTimer);
    const b = $('confirmBtn') as HTMLButtonElement | null;
    if (b) b.disabled = true;
  }
}

/* ------------------------------------------------------------------ */
/* details / checkout / confirmation                                   */
/* ------------------------------------------------------------------ */

function renderDetails(): void {
  const c = ctx?.customer;
  const vp = $('verifiedPhone');
  if (vp) {
    vp.innerHTML = `<strong>✓ ${esc(t('details.verified'))}</strong> ${
      c?.verifiedPhone ? esc(maskPhoneDisplay(c.verifiedPhone)) : ''
    }`;
  }
  const nm = $('nm') as HTMLInputElement | null;
  const em = $('em') as HTMLInputElement | null;
  if (nm && c?.firstName && !nm.value) nm.value = c.firstName;
  if (em && c?.email && !em.value) em.value = c.email;
}

async function renderCheckout(): Promise<void> {
  const area = $('payArea');
  const btn = $('confirmBtn') as HTMLButtonElement | null;
  if (!area || !btn) return;
  btn.textContent = t('checkout.confirm');
  btn.disabled = false;

  try {
    paymentCfg = await api.paymentConfig();
  } catch {
    paymentCfg = null;
  }
  const mode = checkoutMode(paymentCfg ?? { configured: false, publishableKey: null, currency: 'CAD' });

  if (mode === 'NONE') {
    area.innerHTML = `<div class="due-hero"><div class="due-amt">${formatMoney(0, locale)}</div>
      <div class="due-lbl">${esc(t('checkout.dueToday'))}</div>
      <p>${esc(t('checkout.payLaterNote'))}</p></div>`;
    return;
  }
  if (mode === 'NOT_CONFIGURED') {
    area.innerHTML = `<div class="note">${esc(t('checkout.notConfigured'))}
      <button class="link" data-action="open-help">${esc(t('concierge.callMe'))}</button></div>`;
    btn.disabled = true;
    return;
  }
  area.innerHTML = `<div class="eyebrow">${esc(t('checkout.fastCheckout'))}</div>
    <div id="stripe-express"></div><div class="orsep">${esc(t('checkout.orPay'))}</div>
    <div id="stripe-payment"><div class="note">${esc(t('checkout.preparing'))}</div></div>`;
}

async function submitBooking(): Promise<void> {
  const btn = $('confirmBtn') as HTMLButtonElement;
  const err = $('payErr');
  if (err) err.hidden = true;
  if (!hold || remainingMs(hold.expiresAt) <= 0) {
    if (err) {
      err.textContent = t('hold.expired');
      err.hidden = false;
    }
    return;
  }
  btn.disabled = true;
  btn.innerHTML = `<span class="spin"></span> ${esc(t('checkout.confirming'))}`;
  try {
    const res = await api.createBooking(
      { holdId: hold.id, quoteId: quote!.id, addressId: S.addressId! },
      `booking:${hold.id}`,
    );
    if (holdTimer) clearInterval(holdTimer);
    clearDraft();
    bookingResult = res.booking;
    renderConfirmation(res.booking);
    goTo('confirmation');
    burst();
  } catch (e) {
    if (err) {
      err.textContent = translateError(locale, e instanceof ApiError ? e.code : undefined);
      err.hidden = false;
    }
    btn.disabled = false;
    btn.textContent = t('checkout.confirm');
    if (e instanceof ApiError && (e.code === 'HOLD_EXPIRED' || e.code === 'SLOT_UNAVAILABLE')) {
      backToSlots();
    }
  }
}

function renderConfirmation(b: Booking): void {
  const box = $('confirmBody');
  if (!box) return;
  const paid = b.paymentStatus === 'SUCCEEDED';
  const rows: [string, string][] = [
    [t('confirm.date'), formatSlotDate(b.startAt, locale)],
    [t('confirm.time'), `${formatSlotTime(b.startAt, locale)} – ${formatSlotTime(b.endAt, locale)}`],
    [t('confirm.address'), S.addressSummary ?? ''],
    [t('confirm.crew'), String(b.crewSize)],
    [t('confirm.total'), formatMoney(b.grandTotalCents, locale)],
    [t('confirm.payment'), paid ? t('confirm.paid') : t('confirm.payLater')],
  ];
  box.innerHTML = `<div class="confirm">
      <div class="ctop"><div class="ctick">✓</div>
        <h2>${esc(t('confirm.title'))}</h2>
        <p>${esc(t('confirm.sub'))}</p>
        <div class="cnum">${esc(b.bookingNumber)}</div></div>
      ${rows.map(([k, v]) => `<div class="crow"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('')}
    </div>
    <div class="conf-actions">
      <button class="btn btn-ghost" data-action="download-ics">${esc(t('confirm.calendar'))}</button>
      <a class="btn btn-ghost" href="tel:+15148252825">${esc(t('confirm.call'))}</a>
      <button class="btn btn-primary" data-action="book-another">${esc(t('confirm.another'))}</button>
    </div>`;
  // Once booked, the live price panel and sticky bar have no job left.
  const sticky = $('sticky');
  if (sticky) sticky.hidden = true;
  const aside = document.querySelector('aside');
  if (aside) (aside as HTMLElement).hidden = true;
  const fab = document.querySelector('.help-fab');
  if (fab) (fab as HTMLElement).hidden = true;
}

function burst(): void {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const colors = ['#00C2A0', '#FF9E1B', '#0B3A5C', '#EDF3F7'];
  for (let i = 0; i < 26; i++) {
    const d = document.createElement('div');
    d.style.cssText = `position:fixed;left:50%;top:30%;width:9px;height:9px;background:${colors[i % 4]};border-radius:2px;z-index:99;pointer-events:none`;
    document.body.appendChild(d);
    const a = Math.random() * Math.PI * 2;
    const dist = 90 + Math.random() * 220;
    d.animate(
      [
        { transform: 'translate(0,0)', opacity: 1 },
        {
          transform: `translate(${Math.cos(a) * dist}px,${Math.sin(a) * dist + 180}px) rotate(${Math.random() * 720}deg)`,
          opacity: 0,
        },
      ],
      { duration: 1100 + Math.random() * 700, easing: 'cubic-bezier(.2,.6,.3,1)' },
    ).onfinish = () => d.remove();
  }
}

/* ------------------------------------------------------------------ */
/* concierge & callback                                                */
/* ------------------------------------------------------------------ */

function openHelp(): void {
  const actions = [
    ['choose', 'concierge.chooseService'],
    ['price', 'concierge.getPrice'],
    ['times', 'concierge.findTime'],
    ['usual', 'concierge.bookUsual'],
    ['callme', 'concierge.callMe'],
    ['human', 'concierge.talkToSomeone'],
  ];
  openSheet(`<h2>${esc(t('concierge.title'))}</h2><p class="s">${esc(t('concierge.sub'))}</p>
    <div class="quick">${actions
      .map(
        ([id, key]) =>
          `<button class="quick-a" data-action="help-action" data-help="${id}">${esc(t(key))}</button>`,
      )
      .join('')}</div>
    <div class="note sm">${esc(t('concierge.noAi'))}</div>`);
}

function openCallback(): void {
  const phone = ctx?.customer.verifiedPhone;
  openSheet(`<h2>${esc(t('callback.title'))}</h2>
    <p class="s">${esc(t('callback.sub'))}</p>
    ${phone ? `<div class="note">${esc(t('callback.using'))} <b>${esc(maskPhoneDisplay(phone))}</b></div>`
            : `<label class="fl" for="cbPhone">${esc(t('otp.phone'))}</label>
               <input class="inp" id="cbPhone" type="tel" inputmode="tel" placeholder="(514) 825-2825">`}
    <div class="quick">
      <button class="quick-a" data-action="callback-now">${esc(t('callback.now'))}</button>
      <button class="quick-a" data-action="callback-5">${esc(t('callback.soon'))}</button>
    </div>
    <div class="err" id="cbErr" hidden></div>`);
  const p = $('cbPhone') as HTMLInputElement | null;
  p?.addEventListener('input', () => (p.value = formatPhoneInput(p.value)));
}

async function requestCallback(): Promise<void> {
  const input = $('cbPhone') as HTMLInputElement | null;
  const phone = ctx?.customer.verifiedPhone ?? input?.value ?? '';
  if (!phone) return;
  try {
    await api.requestCallback(phone);
    openSheet(`<div class="ctr pad"><div class="ctick sm">✓</div>
      <h2>${esc(t('callback.received'))}</h2>
      <p class="s">${esc(t('callback.target'))}</p>
      <button class="btn btn-primary full" data-action="close-sheet">${esc(t('common.continue'))}</button></div>`);
  } catch (e) {
    const err = $('cbErr');
    if (err) {
      err.textContent = translateError(locale, e instanceof ApiError ? e.code : undefined);
      err.hidden = false;
    }
  }
}

/* ------------------------------------------------------------------ */
/* reviews                                                             */
/* ------------------------------------------------------------------ */

/**
 * Welcome-offer card. The amount comes from the promotion engine, so if the
 * offers change or are disabled the hero follows automatically. Nothing here
 * is typed in from the brand board.
 */
async function loadPromotions(): Promise<void> {
  try {
    const p = await api.publicPromotions();
    if (p.maxAmountCents === null || p.maxAmountCents <= 0) return;
    const card = $('promoCard');
    const value = $('promoValue');
    if (!card || !value) return;
    card.hidden = false;
    const target = p.maxAmountCents;
    // Whole dollars at display size; cents only if the offer actually has them.
    const show = (cents: number) =>
      cents % 100 === 0 ? `$${Math.round(cents / 100)}` : formatMoney(cents, locale);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      value.textContent = show(target);
      return;
    }
    const started = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - started) / 700);
      const at = Math.round((target * (1 - Math.pow(1 - t, 3))) / 100) * 100;
      value.textContent = show(t < 1 ? at : target);
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  } catch {
    /* no offer shown rather than a fabricated one */
  }
}

async function loadReviews(): Promise<void> {
  try {
    const [summary, list] = await Promise.all([api.reviewSummary(), api.reviews(6)]);
    reviews = summary;
    const chip = $('ratingChip');
    // Only ever shown when real published reviews exist.
    if (chip && summary.averageRating !== null && summary.reviewCount > 0) {
      chip.innerHTML = `<span class="stars">${'★'.repeat(Math.round(summary.averageRating))}</span>
        ${summary.averageRating} · ${summary.reviewCount} ${esc(t('reviews.count'))}`;
      chip.hidden = false;
    }
    const rail = $('rail');
    const sect = $('reviewsSection');
    if (rail && list.reviews.length) {
      rail.innerHTML = list.reviews
        .map((r) => {
          const label =
            r.source === 'GOOGLE'
              ? t('reviews.google')
              : r.source === 'R2NETTE_VERIFIED'
                ? t('reviews.verified')
                : t('reviews.legacy');
          return `<article class="rev"><div class="stars">${'★'.repeat(r.rating)}</div>
            <p>${esc(r.reviewText ?? '')}</p>
            <div class="rev-f"><b>${esc(r.customerDisplayName)}</b>
            <span class="src ${esc(r.source)}">${esc(label)}</span></div></article>`;
        })
        .join('');
      if (sect) sect.hidden = false;
    }
  } catch {
    /* reviews are never allowed to block booking */
  }
}

/* ------------------------------------------------------------------ */
/* navigation                                                          */
/* ------------------------------------------------------------------ */

function visibleSteps(): string[] {
  const s = svc();
  const skip = new Set<string>();
  if (!ctx) skip.add('welcome');
  if (s && s.productSupplyMode === 'NOT_APPLICABLE') skip.add('products');
  return STEPS.filter((x) => !skip.has(x));
}

function goTo(step: string): void {
  S.step = step as typeof S.step;
  saveDraft(S);
  render();
  const book = $('book');
  if (book) window.scrollTo({ top: book.offsetTop - 60, behavior: 'smooth' });
}

async function goNext(): Promise<void> {
  const order = visibleSteps();
  const i = order.indexOf(S.step);
  const guards: Record<string, () => boolean> = {
    service: () => !!S.serviceOptionId,
    property: () => !!S.propertyType,
    products: () => {
      const s = svc();
      return !s || s.productSupplyMode === 'NOT_APPLICABLE' || !!S.productSupplyOption;
    },
    frequency: () => !!S.frequency,
    address: () => !!S.addressId,
    slots: () => !!hold,
    details: () =>
      !!($('nm') as HTMLInputElement)?.value.trim() &&
      /\S+@\S+\.\S{2,}/.test(($('em') as HTMLInputElement)?.value ?? ''),
  };
  const g = guards[S.step];
  if (g && !g()) {
    toast(t('guard.' + S.step));
    return;
  }
  if (S.step === 'frequency' || S.step === 'address') await refreshQuote();
  goTo(order[Math.min(i + 1, order.length - 1)]!);
}

function goToPhase(requestedPhase: string): void {
  const service = svc();

  if (requestedPhase === 'CLEAN') {
    goTo('service');
    return;
  }

  if (!service) {
    toast(t('guard.service'));
    goTo('service');
    return;
  }

  if (requestedPhase === 'HOME') {
    goTo('property');
    return;
  }

  if (!S.propertyType) {
    toast(t('guard.property'));
    goTo('property');
    return;
  }

  if (
    service.productSupplyMode === 'REQUIRED_SELECTION' &&
    !S.productSupplyOption
  ) {
    toast(t('guard.products'));
    goTo('products');
    return;
  }

  if (!S.frequency) {
    toast(t('guard.frequency'));
    goTo('frequency');
    return;
  }

  if (requestedPhase === 'TIME') {
    if (!S.addressId) {
      toast(t('guard.address'));
      goTo('address');
      return;
    }

    goTo('slots');
    return;
  }

  if (requestedPhase === 'CONFIRM') {
    if (!S.addressId) {
      toast(t('guard.address'));
      goTo('address');
      return;
    }

    if (!hold) {
      toast(t('guard.slots'));
      goTo('slots');
      return;
    }

    goTo('details');
  }
}

function goBack(): void {
  const order = visibleSteps();
  const i = order.indexOf(S.step);
  goTo(order[Math.max(i - 1, 0)]!);
}

function backToSlots(): void {
  hold = null;
  S.slotStartAt = null;
  if (holdTimer) clearInterval(holdTimer);
  goTo('slots');
  void loadSlots();
}

function render(): void {
  document.querySelectorAll<HTMLElement>('.step').forEach((el) => {
    el.classList.toggle('on', el.dataset.step === S.step);
  });
  const phase = PHASE[S.step] ?? 'CLEAN';
  document.querySelectorAll<HTMLElement>('.phase').forEach((el) => {
    const p = el.dataset.phase!;
    const order = ['CLEAN', 'HOME', 'TIME', 'CONFIRM'];
    el.classList.toggle('on', p === phase);
    el.classList.toggle('done', order.indexOf(p) < order.indexOf(phase));
  });

  const nav = $('nav');
  if (nav) {
    nav.style.display = ['service', 'welcome', 'confirmation', 'checkout'].includes(S.step)
      ? 'none'
      : 'flex';
  }
  const back = $('backBtn');
  if (back) back.style.display = visibleSteps().indexOf(S.step) === 0 ? 'none' : 'inline-flex';

  if (S.step === 'property') renderProperty();
  if (S.step === 'products') renderProducts();
  if (S.step === 'frequency') renderFrequency();
  if (S.step === 'address') renderAddress();
  if (S.step === 'slots') {
    renderDays();
    void loadSlots();
  }
  if (S.step === 'details') renderDetails();
  if (S.step === 'checkout') void renderCheckout();
}

/* ------------------------------------------------------------------ */
/* event delegation — the reason goNext can never be "not defined"     */
/* ------------------------------------------------------------------ */

const ACTIONS: Record<string, (el: HTMLElement) => void | Promise<void>> = {
  'set-locale': (el) => {
    locale = el.dataset.locale as Locale;
    persistLocale(locale);
    applyLocale();
  },

  'toggle-mobile-menu': () => {
    const menu = $('mobileNavigation');
    const button = $('mobileMenuButton');

    if (!menu || !button) return;

    const willOpen = menu.hidden;

    menu.hidden = !willOpen;
    button.setAttribute('aria-expanded', String(willOpen));
  },

  'book-again': async () => {
    const usual = ctx?.usualClean;

    if (usual) {
      S.familyId = services.find(
        (service) => service.id === usual.serviceOptionId,
      )?.categoryId;

      S.serviceOptionId = usual.serviceOptionId;

      renderFamilies();
      renderWelcome();
      goTo('welcome');

      return;
    }

    goTo('service');
  },

  'scroll-book': () => {
    if (!verified) {
      window.location.assign(
        `/login?returnTo=${encodeURIComponent('/#book')}`,
      );
      return;
    }

    $('book')?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  },

  'pick-family': (el) => {
    S.familyId = el.dataset.family;

    if (svc() && svc()!.categoryId !== S.familyId) {
      S.serviceOptionId = null;
    }

    renderFamilies();
  },

  'pick-service': async (el) => {
  const nextServiceId = el.dataset.service!;

  if (S.serviceOptionId !== nextServiceId) {
    quote = null;
    S.serviceOptionId = nextServiceId;
    S.productSupplyOption = null;
    S.addressId = null;
    S.addressSummary = null;
    S.slotStartAt = null;
    hold = null;
    selectedDay = null;
  }

  const service = svc();
  if (!service) return;

  /*
   * A newly selected service starts as a one-time cleaning when that
   * frequency is supported. This allows an immediately priceable service
   * to display its quote without forcing the customer to visit the
   * frequency screen first.
   */
  if (
    !S.frequency ||
    !service.allowedFrequencies.includes(S.frequency)
  ) {
    S.frequency = service.allowedFrequencies.includes('ONE_TIME')
      ? 'ONE_TIME'
      : service.allowedFrequencies[0] ?? null;
  }

  renderServiceOptions();
  renderLedger();
  saveDraft(S);

  if (service.pricingMode === 'QUOTE_REQUIRED') {
    toast(t('service.quoteNote'));
    return;
  }

  /*
   * Specialty services that do not require a product choice can now be
   * quoted immediately. Basic and Deep wait until the customer chooses
   * who supplies the products.
   */
  await refreshQuote();

  if (!verified) {
    window.location.assign(
      `/login?returnTo=${encodeURIComponent('/#book')}`,
    );
    return;
  }

  goTo('property');
},

  'send-code': () => {
    void sendCode();
  },

  'change-number': () => {
  window.location.assign(
    `/login?returnTo=${encodeURIComponent('/#book')}`,
  );
},

  'close-sheet': () => {
    closeSheet();
  },

  goto: (el) => {
    goTo(el.dataset.step!);
  },

  'go-phase': (el) => {
    goToPhase(el.dataset.phase!);
  },

  next: () => {
    void goNext();
  },

  back: () => {
    goBack();
  },

  'use-usual': async () => {
    const usual = ctx!.usualClean!;

    S.serviceOptionId = usual.serviceOptionId;
    S.frequency = usual.frequency;
    S.addressId = usual.addressId;
    S.addressSummary = usual.addressSummary;
    S.productSupplyOption =
      S.productSupplyOption ?? 'CLIENT_SUPPLIED';

    saveDraft(S);

    await refreshQuote();

    goTo('slots');
  },

  'pick-prop': (el) => {
    S.propertyType = el.dataset.prop!;
    S.isShortTermRental = el.dataset.prop === 'airbnb';

    renderProperty();
    saveDraft(S);
  },

  'pick-size': (el) => {
    S.propertySize = el.dataset.size!;

    renderProperty();
    saveDraft(S);
  },

  'pick-product': (el) => {
    S.productSupplyOption = el.dataset.product!;

    renderProducts();
    saveDraft(S);

    void refreshQuote();
  },

  'pick-freq': async (el) => {
    S.frequency = el.dataset.freq!;

    renderFrequency();
    saveDraft(S);

    await refreshQuote();

    const discount = quote?.firstVisit?.appliedDiscount;

    if (discount) {
      toast(
        t('frequency.savings', {
          amount: formatMoney(discount.amountCents, locale),
        }),
        'save',
      );
    }
  },

  'use-saved': async (el) => {
    const address = ctx!.addresses.find(
      (item) => item.id === el.dataset.addr,
    )!;

    S.addressId = address.id;
    S.addressSummary = address.formattedAddress;

    saveDraft(S);
    renderAddress();

    await refreshQuote();
  },

  'clear-address': () => {
    S.addressId = null;
    S.addressSummary = null;

    saveDraft(S);
    renderAddress();
  },

  'select-place': async (el) => {
    const suggestions = $('suggestions');

    if (suggestions) {
      suggestions.hidden = true;
    }

    toast(t('address.confirming'));

    try {
      const result = await api.selectAddress(
        el.dataset.place!,
        addrSession!,
      );

      addrSession = null;
      S.addressId = result.address.id;
      S.addressSummary = result.address.formattedAddress;

      saveDraft(S);
      renderAddress();

      await refreshQuote();
    } catch (error) {
      showError(error);
    }
  },

  'pick-day': (el) => {
    selectedDay = el.dataset.day!;

    renderDays();

    void loadSlots();
  },

  'pick-slot': async (el) => {
    S.slotStartAt = el.dataset.slot!;

    saveDraft(S);

    if (!quote) {
      await refreshQuote();
    }

    if (!quote) return;

    toast(t('hold.reserving'));

    try {
      const result = await api.createHold(
        quote.id,
        S.slotStartAt,
        `hold:${quote.id}:${S.slotStartAt}`,
      );

      hold = result.hold;

      startHoldTimer();
      goTo('details');
    } catch (error) {
      showError(error);

      if (
        error instanceof ApiError &&
        error.code === 'SLOT_UNAVAILABLE'
      ) {
        void loadSlots();
      }
    }
  },

  'back-to-slots': () => {
    backToSlots();
  },

  confirm: () => {
    void submitBooking();
  },

  'download-ics': () => {
    if (!bookingResult) return;

    const blob = new Blob(
      [
        buildIcs(
          bookingResult,
          'R2NETTE',
          S.addressSummary ?? '',
        ),
      ],
      {
        type: 'text/calendar',
      },
    );

    const downloadLink = document.createElement('a');

    downloadLink.href = URL.createObjectURL(blob);
    downloadLink.download = `${bookingResult.bookingNumber}.ics`;

    downloadLink.click();

    URL.revokeObjectURL(downloadLink.href);
  },

  'book-another': () => {
    location.reload();
  },

  'open-help': () => {
    openHelp();
  },

  'help-action': (el) => {
    const helpAction = el.dataset.help;

    if (
      helpAction === 'callme' ||
      helpAction === 'human'
    ) {
      openCallback();
      return;
    }

    closeSheet();

    $('book')?.scrollIntoView({ behavior: 'smooth' });
  },

  'callback-now': () => {
    void requestCallback();
  },

  'callback-5': () => {
    void requestCallback();
  },

  'retry-boot': () => {
    location.reload();
  },

  'show-ledger': () => {
    document.querySelector('.ledger')?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });
  },
};

function installDelegation(): void {
  document.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!el) return;
    const fn = ACTIONS[el.dataset.action!];
    if (!fn) return;
    e.preventDefault();
    try {
      void fn(el);
    } catch (err) {
      console.error('[action]', el.dataset.action, err);
      toast(t('error.GENERIC'));
    }
  });

  document.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.dataset.field === 'bedrooms') S.bedrooms = Number(el.value);
    if (el.dataset.field === 'bathrooms') S.bathrooms = Number(el.value);
    if (el.id === 'addrInput') void onAddressType(el.value);
  });
}

async function onAddressType(value: string): Promise<void> {
  if (suggestTimer) clearTimeout(suggestTimer);
  const q = value.trim();
  const box = $('suggestions');
  if (!box) return;
  if (q.length < 3) {
    box.hidden = true;
    return;
  }
  suggestTimer = setTimeout(async () => {
    try {
      const res = await api.autocomplete(q, addrSession ?? undefined);
      addrSession = res.sessionId;
      if (!res.suggestions.length) {
        box.hidden = true;
        return;
      }
      box.innerHTML = res.suggestions
        .map(
          (s) => `<button type="button" data-action="select-place" data-place="${esc(s.placeId)}">
          <span class="p">${esc(s.primaryText)}</span>
          <span class="s2">${esc(s.secondaryText)}</span></button>`,
        )
        .join('');
      box.hidden = false;
    } catch (e) {
      const err = $('addrErr');
      if (err) {
        err.textContent = translateError(locale, e instanceof ApiError ? e.code : undefined);
        err.hidden = false;
      }
    }
  }, 280);
}

/* ------------------------------------------------------------------ */
/* start                                                               */
/* ------------------------------------------------------------------ */

export async function boot(): Promise<void> {
  installErrorBoundary();
  installDelegation();
  setBoot('BOOTING');
  applyLocale();

  try {
    await api.health();
  } catch {
    setBoot('API_UNAVAILABLE');
    return;
  }

  try {
    services = (await api.services()).services;
  } catch (e) {
    setBoot('API_UNAVAILABLE', String(e));
    return;
  }

  renderFamilies();

  const deep = new URLSearchParams(location.search).get('service');
  if (deep) {
    const s = services.find((x) => x.id === deep || x.slug === deep);
    if (s) {
      S.familyId = s.categoryId;
      S.serviceOptionId = s.id;
      renderFamilies();
    }
  }

  render();
  setBoot('READY');
  // Non-essential: never blocks first paint.
  void loadPromotions();
  void loadReviews();
}
