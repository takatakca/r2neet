/**
 * Account area.
 *
 * Same rules as the booking flow: identity from the session cookie, every
 * amount and every slot from the server, no inline handlers, and a visible
 * failure state rather than a blank page.
 */

import {
  detectLocale,
  persistLocale,
  translate,
  translateError,
  formatMoney,
  maskPhoneDisplay,
  type Locale,
} from '../i18n/index.js';
import { ApiError, torontoDateKey, formatSlotTime, formatSlotDate } from './api.js';

let locale: Locale = detectLocale();
const t = (k: string, v: Record<string, string | number> = {}) => translate(locale, k, v);
const $ = (id: string) => document.getElementById(id);
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

interface AccountBooking {
  id: string;
  bookingNumber: string;
  startAt: string;
  endAt: string;
  status: string;
  serviceName: string;
  serviceNameFr: string;
  serviceOptionId: string;
  requiredStaffCount: number;
  crewAssigned: number;
  addressSummary: string;
  grandTotalCents: number;
  paymentStatus: string;
  canCancel: boolean;
  canReschedule: boolean;
  withinCutoff: boolean;
}

interface Overview {
  customer: { firstName: string | null; email: string | null; verifiedPhone: string | null };
  upcoming: AccountBooking[];
  past: AccountBooking[];
  addresses: { id: string; label: string | null; formattedAddress: string; isDefault: boolean }[];
  plans: {
    id: string;
    frequency: string;
    serviceName: string;
    addressSummary: string;
    status: string;
    canPause: boolean;
    canResume: boolean;
  }[];
  paymentMethods: { id: string; brand: string | null; last4: string | null; isDefault: boolean }[];
}

let data: Overview | null = null;
let rescheduling: AccountBooking | null = null;
let rescheduleDay: string | null = null;
let chosenSlot: string | null = null;

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...((init.headers as object) ?? {}) },
    credentials: 'same-origin',
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const e = (json as { error?: { code?: string; message?: string } }).error;
    throw new ApiError(e?.code ?? 'GENERIC', e?.message ?? 'Request failed', res.status);
  }
  return json as T;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(msg: string): void {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('on');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 4200);
}

const openSheet = (html: string) => {
  const b = $('sheetBody');
  if (b) b.innerHTML = html;
  $('sheet')?.classList.add('on');
};
const closeSheet = () => $('sheet')?.classList.remove('on');

/* ------------------------------------------------------------------ */

function statusPill(b: AccountBooking): string {
  if (b.status === 'CANCELLED') return `<span class="pill bad">${esc(t('status.cancelled'))}</span>`;
  if (b.status === 'COMPLETED') return `<span class="pill ok">${esc(t('status.completed'))}</span>`;
  if (b.crewAssigned >= b.requiredStaffCount)
    return `<span class="pill ok">${esc(t('status.crewConfirmed'))}</span>`;
  return `<span class="pill mut">${esc(t('status.confirmed'))}</span>`;
}

function bookingCard(b: AccountBooking, hero = false): string {
  // Short form on the card; the sheet shows the full date.
  const dayLabel = new Intl.DateTimeFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', {
    timeZone: 'America/Toronto',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(b.startAt));
  const paid = b.paymentStatus === 'PAID';
  const actions = hero || b.canCancel || b.canReschedule
    ? `<div class="acts">
        ${b.canReschedule ? `<button class="btn btn-ghost" data-action="reschedule" data-id="${b.id}">${esc(t('account.reschedule'))}</button>` : ''}
        ${b.canCancel ? `<button class="btn ${hero ? 'btn-ghost' : 'btn-danger'}" data-action="cancel" data-id="${b.id}">${esc(t('account.cancel'))}</button>` : ''}
        ${b.withinCutoff ? `<a class="btn btn-ghost" href="tel:+15148252825">${esc(t('account.callToChange'))}</a>` : ''}
      </div>`
    : '';
  const cutoffNote = b.withinCutoff
    ? `<div class="note" style="margin-top:14px">${esc(t('account.cutoffNote'))}</div>`
    : '';

  return `<div class="card${hero ? ' next' : ''}">
    ${hero ? `<span class="bub" style="width:90px;height:90px;top:-24px;right:-18px"></span>` : ''}
    <div class="row1">
      <div class="when"><div class="d">${esc(dayLabel)}</div>
        <div class="t">${esc(formatSlotTime(b.startAt, locale))}</div></div>
      <div class="info"><b>${esc(locale === 'fr' ? b.serviceNameFr : b.serviceName)}</b>
        <span>${esc(b.addressSummary)}</span>
        <span class="mono" style="margin-top:6px">${esc(b.bookingNumber)}</span>
        <div style="margin-top:9px;display:flex;gap:7px;flex-wrap:wrap">
          ${statusPill(b)}
          <span class="pill ${paid ? 'ok' : 'gold'}">${esc(paid ? t('confirm.paid') : t('confirm.payLater'))}</span>
          <span class="pill mut mono">${formatMoney(b.grandTotalCents, locale)}</span>
        </div>
      </div>
    </div>
    ${cutoffNote}${actions}</div>`;
}

function render(): void {
  if (!data) return;

  const greeting = $('greeting');
  if (greeting) {
    greeting.textContent = data.customer.firstName
      ? t('account.greeting', { name: data.customer.firstName })
      : t('account.title');
  }
  const sub = $('subline');
  if (sub) {
    sub.textContent = data.upcoming.length
      ? t('account.nextCount', { n: data.upcoming.length })
      : t('account.noneScheduled');
  }

  const up = $('upcoming');
  if (up) {
    up.innerHTML = data.upcoming.length
      ? data.upcoming.map((b, i) => bookingCard(b, i === 0)).join('')
      : `<div class="empty"><div class="ic">🧼</div>
          <div class="t">${esc(t('account.emptyTitle'))}</div>
          <div class="s">${esc(t('account.emptyBody'))}</div>
          <a class="btn btn-primary" href="/book">${esc(t('account.bookNew'))}</a></div>`;
  }

  const past = $('past');
  if (past) {
    past.innerHTML = data.past.length
      ? data.past.map((b) => bookingCard(b)).join('')
      : `<div class="empty"><div class="ic">📋</div>
          <div class="t">${esc(t('account.noPast'))}</div></div>`;
  }

  // Upcoming plan dates load after the panel paints, so the tab never waits.
  setTimeout(() => void loadPlanDates(), 0);
  const settings = $('settings');
  if (settings) {
    settings.innerHTML = `
      <div class="section"><h2>${esc(t('account.yourDetails'))}</h2>
        <div class="card">
          <div style="display:grid;gap:12px">
            <div><label class="d" style="font-size:13px;font-weight:600">${esc(t('details.name'))}</label>
              <input class="slot" style="width:100%;text-align:left;padding:13px 14px;font-weight:400"
                id="pfName" value="${esc(data.customer.firstName ?? '')}"></div>
            <div><label class="d" style="font-size:13px;font-weight:600">${esc(t('details.email'))}</label>
              <input class="slot" style="width:100%;text-align:left;padding:13px 14px;font-weight:400"
                id="pfEmail" type="email" value="${esc(data.customer.email ?? '')}"></div>
            <div class="note">${esc(t('details.verified'))}: <b>${esc(data.customer.verifiedPhone ? maskPhoneDisplay(data.customer.verifiedPhone) : '—')}</b></div>
          </div>
          <div class="err" id="pfErr" hidden></div>
          <div class="acts"><button class="btn btn-primary" data-action="save-profile">${esc(t('account.save'))}</button></div>
        </div>
      </div>

      <div class="section"><h2>${esc(t('account.places'))}</h2>
        ${data.addresses.length ? data.addresses.map((a) => `
          <div class="card"><div class="addr">
            <div class="t"><b>${esc(a.label ?? t('account.home'))}</b><span>${esc(a.formattedAddress)}</span></div>
            ${a.isDefault ? `<span class="pill ok">${esc(t('account.default'))}</span>`
              : `<button class="btn-quiet" data-action="make-default" data-id="${a.id}">${esc(t('account.makeDefault'))}</button>`}
            <button class="btn-quiet" data-action="delete-address" data-id="${a.id}">${esc(t('account.remove'))}</button>
          </div></div>`).join('')
          : `<div class="note">${esc(t('account.noPlaces'))}</div>`}
      </div>

      <div class="section"><h2>${esc(t('account.plans'))}</h2>
        ${data.plans.length ? data.plans.map((p) => `
          <div class="card"><div class="addr"><div class="t">
            <b>${esc(p.serviceName)}</b>
            <span>${esc(t('frequency.' + p.frequency))} · ${esc(p.addressSummary)}</span>
            <span class="mono" id="next-${p.id}">${esc(t('common.loading'))}</span>
          </div><span class="pill ${p.status === 'ACTIVE' ? 'ok' : 'mut'}">${esc(t('status.' + p.status.toLowerCase()))}</span></div>
          <div class="acts">
            ${p.canPause ? `<button class="btn btn-ghost" data-action="plan-status" data-id="${p.id}" data-status="PAUSED">${esc(t('account.pausePlan'))}</button>` : ''}
            ${p.canResume ? `<button class="btn btn-primary" data-action="plan-status" data-id="${p.id}" data-status="ACTIVE">${esc(t('account.resumePlan'))}</button>` : ''}
          </div></div>`).join('')
          : `<div class="note">${esc(t('account.noPlans'))}</div>`}
      </div>

      <div class="section"><h2>${esc(t('account.payment'))}</h2>
        ${data.paymentMethods.length ? data.paymentMethods.map((m) => `
          <div class="card"><div class="addr"><div class="t">
            <b>${esc((m.brand ?? 'Card').toUpperCase())} •••• ${esc(m.last4 ?? '')}</b>
            <span>${esc(t('account.savedCard'))}</span></div>
            ${m.isDefault ? `<span class="pill ok">${esc(t('account.default'))}</span>` : ''}
          </div></div>`).join('')
          : `<div class="note">${esc(t('account.noCards'))}</div>`}
      </div>`;
  }
}

/* ------------------------------------------------------------------ */

/** Show each plan's next visits, fetched per plan so one failure is contained. */
async function loadPlanDates(): Promise<void> {
  for (const p of data?.plans ?? []) {
    const el = $(`next-${p.id}`);
    if (!el) continue;
    try {
      const res = await call<{ upcoming: string[] }>(`/api/v1/account/plans/${p.id}/upcoming`);
      el.textContent = res.upcoming.length
        ? `${t('account.nextVisits')}: ${res.upcoming
            .slice(0, 3)
            .map((iso) => formatSlotDate(iso, locale))
            .join(' · ')}`
        : t('account.noUpcoming');
    } catch {
      el.textContent = '';
    }
  }
}

async function load(): Promise<void> {
  try {
    data = await call<Overview>('/api/v1/account/overview');
    render();
  } catch (e) {
    const up = $('upcoming');
    const unauth = e instanceof ApiError && e.code === 'UNAUTHORIZED';
    if (up) {
      up.innerHTML = `<div class="empty"><div class="ic">${unauth ? '🔐' : '⚠'}</div>
        <div class="t">${esc(unauth ? t('account.signInTitle') : t('error.GENERIC'))}</div>
        <div class="s">${esc(unauth ? t('account.signInBody') : '')}</div>
        <a class="btn btn-primary" href="/book">${esc(t('account.bookNew'))}</a></div>`;
    }
  }
}

async function openReschedule(id: string): Promise<void> {
  rescheduling = data?.upcoming.find((b) => b.id === id) ?? null;
  if (!rescheduling) return;
  chosenSlot = null;
  rescheduleDay = torontoDateKey(new Date(Date.now() + 2 * 86400000));
  renderRescheduleSheet();
  void loadRescheduleSlots();
}

function renderRescheduleSheet(): void {
  const days: string[] = [];
  for (let i = 1; i <= 14; i++) days.push(torontoDateKey(new Date(Date.now() + i * 86400000)));
  const fmt = (key: string, o: Intl.DateTimeFormatOptions) => {
    const [y, m, d] = key.split('-').map(Number);
    return new Intl.DateTimeFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', {
      timeZone: 'America/Toronto',
      ...o,
    }).format(new Date(Date.UTC(y!, m! - 1, d!, 16)));
  };
  openSheet(`<h2>${esc(t('account.pickNewTime'))}</h2>
    <p class="s">${esc(t('account.currentlyAt', { when: formatSlotDate(rescheduling!.startAt, locale) + ' · ' + formatSlotTime(rescheduling!.startAt, locale) }))}</p>
    <div class="days">${days
      .map(
        (k) => `<button class="day" data-action="resch-day" data-day="${k}" aria-pressed="${rescheduleDay === k}">
        <span class="w">${esc(fmt(k, { weekday: 'short' }))}</span>
        <span class="n">${esc(fmt(k, { day: 'numeric' }))}</span></button>`,
      )
      .join('')}</div>
    <div id="reschSlots"></div>
    <div class="err" id="reschErr" hidden></div>
    <div class="acts" style="margin-top:16px">
      <button class="btn btn-primary" id="reschConfirm" data-action="resch-confirm" disabled>${esc(t('account.confirmChange'))}</button>
      <button class="btn-quiet" data-action="close-sheet">${esc(t('common.back'))}</button>
    </div>`);
}

async function loadRescheduleSlots(): Promise<void> {
  const box = $('reschSlots');
  if (!box || !rescheduling || !rescheduleDay) return;
  box.innerHTML = `<div class="slots">${'<div class="sk" style="height:48px;margin:0"></div>'.repeat(6)}</div>`;
  try {
    const res = await call<{ slots: { startAt: string }[] }>(
      `/api/v1/availability?serviceOptionId=${encodeURIComponent(rescheduling.serviceOptionId)}&date=${rescheduleDay}`,
    );
    box.innerHTML = res.slots.length
      ? `<div class="slots">${res.slots
          .map(
            (s) => `<button class="slot" data-action="resch-slot" data-slot="${s.startAt}"
          aria-pressed="${chosenSlot === s.startAt}">${esc(formatSlotTime(s.startAt, locale))}</button>`,
          )
          .join('')}</div>`
      : `<div class="note">${esc(t('slots.none'))}</div>`;
  } catch {
    box.innerHTML = `<div class="note">${esc(t('error.GENERIC'))}</div>`;
  }
}

function confirmCancel(id: string): void {
  const b = data?.upcoming.find((x) => x.id === id);
  if (!b) return;
  openSheet(`<h2>${esc(t('account.cancelTitle'))}</h2>
    <p class="s">${esc(t('account.cancelBody', { when: formatSlotDate(b.startAt, locale) }))}</p>
    <div class="note">${esc(t('account.cancelPolicy'))}</div>
    <div class="err" id="cancelErr" hidden></div>
    <div class="acts" style="margin-top:18px">
      <button class="btn btn-danger" id="cancelGo" data-action="cancel-confirm" data-id="${id}">${esc(t('account.cancelConfirm'))}</button>
      <button class="btn-quiet" data-action="close-sheet">${esc(t('account.keepIt'))}</button>
    </div>`);
}

/* ------------------------------------------------------------------ */

const ACTIONS: Record<string, (el: HTMLElement) => void | Promise<void>> = {
  'set-locale': (el) => {
    locale = el.dataset.locale as Locale;
    persistLocale(locale);
    applyLocale();
    render();
  },
  tab: (el) => {
    const pane = el.dataset.pane!;
    document.querySelectorAll('.tab').forEach((t2) => t2.classList.toggle('on', (t2 as HTMLElement).dataset.pane === pane));
    document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('on', p.id === pane));
  },
  'close-sheet': () => closeSheet(),
  reschedule: (el) => void openReschedule(el.dataset.id!),
  'resch-day': (el) => {
    rescheduleDay = el.dataset.day!;
    chosenSlot = null;
    const btn = $('reschConfirm') as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
    document.querySelectorAll('.day').forEach((d) =>
      d.setAttribute('aria-pressed', String((d as HTMLElement).dataset.day === rescheduleDay)),
    );
    void loadRescheduleSlots();
  },
  'resch-slot': (el) => {
    chosenSlot = el.dataset.slot!;
    document.querySelectorAll('.slot').forEach((s) =>
      s.setAttribute('aria-pressed', String((s as HTMLElement).dataset.slot === chosenSlot)),
    );
    const btn = $('reschConfirm') as HTMLButtonElement | null;
    if (btn) btn.disabled = false;
  },
  'resch-confirm': async () => {
    if (!rescheduling || !chosenSlot) return;
    const btn = $('reschConfirm') as HTMLButtonElement;
    btn.disabled = true;
    btn.innerHTML = `<span class="spin"></span> ${esc(t('account.saving'))}`;
    try {
      await call(`/api/v1/account/bookings/${rescheduling.id}/reschedule`, {
        method: 'POST',
        body: JSON.stringify({ startAt: chosenSlot }),
      });
      closeSheet();
      toast(t('account.moved'));
      await load();
    } catch (e) {
      const err = $('reschErr');
      if (err) {
        err.textContent = translateError(locale, e instanceof ApiError ? e.code : undefined);
        err.hidden = false;
      }
      btn.disabled = false;
      btn.textContent = t('account.confirmChange');
      // A taken slot means the list is stale — refresh it rather than retry.
      if (e instanceof ApiError && e.code === 'SLOT_UNAVAILABLE') void loadRescheduleSlots();
    }
  },
  cancel: (el) => confirmCancel(el.dataset.id!),
  'cancel-confirm': async (el) => {
    const btn = $('cancelGo') as HTMLButtonElement;
    btn.disabled = true;
    btn.innerHTML = `<span class="spin"></span> ${esc(t('account.saving'))}`;
    try {
      await call(`/api/v1/account/bookings/${el.dataset.id}/cancel`, { method: 'POST' });
      closeSheet();
      toast(t('account.cancelled'));
      await load();
    } catch (e) {
      const err = $('cancelErr');
      if (err) {
        err.textContent = translateError(locale, e instanceof ApiError ? e.code : undefined);
        err.hidden = false;
      }
      btn.disabled = false;
      btn.textContent = t('account.cancelConfirm');
    }
  },
  'plan-status': async (el) => {
    try {
      await call(`/api/v1/account/plans/${el.dataset.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: el.dataset.status }),
      });
      toast(el.dataset.status === 'PAUSED' ? t('account.planPaused') : t('account.planResumed'));
      await load();
    } catch (e) {
      toast(translateError(locale, e instanceof ApiError ? e.code : undefined));
    }
  },
  'make-default': async (el) => {
    await call(`/api/v1/account/addresses/${el.dataset.id}/default`, { method: 'POST' });
    await load();
  },
  'delete-address': async (el) => {
    try {
      await call(`/api/v1/account/addresses/${el.dataset.id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      toast(translateError(locale, e instanceof ApiError ? e.code : undefined));
    }
  },
  'save-profile': async () => {
    const name = ($('pfName') as HTMLInputElement)?.value ?? '';
    const email = ($('pfEmail') as HTMLInputElement)?.value ?? '';
    try {
      await call('/api/v1/account/profile', {
        method: 'PATCH',
        body: JSON.stringify({ firstName: name, email }),
      });
      toast(t('account.saved'));
      await load();
    } catch (e) {
      const err = $('pfErr');
      if (err) {
        err.textContent = translateError(locale, e instanceof ApiError ? e.code : undefined);
        err.hidden = false;
      }
    }
  },
};

function applyLocale(): void {
  document.documentElement.lang = locale === 'fr' ? 'fr-CA' : 'en-CA';
  document.querySelectorAll<HTMLElement>('[data-t]').forEach((el) => {
    const v = t(el.dataset.t!);
    if (v !== el.dataset.t) el.textContent = v;
  });
  document.querySelectorAll<HTMLElement>('.lang button').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.locale === locale)),
  );
}

export function bootAccount(): void {
  document.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!el) return;
    const fn = ACTIONS[el.dataset.action!];
    if (!fn) return;
    e.preventDefault();
    void fn(el);
  });
  applyLocale();
  void load();
}
