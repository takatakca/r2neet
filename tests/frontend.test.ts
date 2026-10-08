import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  detectLocale,
  persistLocale,
  translate,
  translateError,
  formatMoney,
  formatPhoneInput,
  maskPhoneDisplay,
} from '../web/src/i18n/index.js';
import {
  remainingMs,
  formatCountdown,
  torontoDateKey,
  formatSlotTime,
  buildIcs,
  saveDraft,
  loadDraft,
  clearDraft,
  emptyDraft,
  type Booking,
} from '../web/src/lib/api.js';
import { api } from '../web/src/lib/api.js';

/** Minimal localStorage for the node test environment. */
function installStorage() {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
  return store;
}

function setNavigator(languages: string[]) {
  // navigator is a getter-only global in Node 22; redefine it.
  Object.defineProperty(globalThis, 'navigator', {
    value: { languages, language: languages[0] },
    configurable: true,
    writable: true,
  });
}

describe('locale detection', () => {
  beforeEach(() => {
    installStorage();
  });

  it('chooses French for a Québec browser', () => {
    setNavigator(['fr-CA', 'fr', 'en']);
    expect(detectLocale()).toBe('fr');
  });

  it('chooses French for any fr* variant', () => {
    setNavigator(['fr-FR']);
    expect(detectLocale()).toBe('fr');
  });

  it('defaults to English otherwise', () => {
    setNavigator(['en-CA', 'en']);
    expect(detectLocale()).toBe('en');
    setNavigator(['de-DE']);
    expect(detectLocale()).toBe('en');
  });

  it('a manual choice always beats the browser', () => {
    setNavigator(['fr-CA']);
    persistLocale('en');
    expect(detectLocale()).toBe('en');
  });

  it('survives storage being unavailable', () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    setNavigator(['fr-CA']);
    expect(() => detectLocale()).not.toThrow();
    expect(detectLocale()).toBe('fr');
  });
});

describe('translation', () => {
  it('translates both languages', () => {
    expect(translate('en', 'checkout.dueToday')).toBe('Due today');
    expect(translate('fr', 'checkout.dueToday')).toBe("À payer aujourd'hui");
    expect(translate('en', 'callback.phoneRequired')).toMatch(/phone number/i);
    expect(translate('fr', 'callback.phoneRequired')).toMatch(/numéro de téléphone/i);
  });

  it('interpolates variables', () => {
    expect(translate('en', 'welcome.back', { name: 'Pascal' })).toBe('Welcome back, Pascal.');
    expect(translate('fr', 'welcome.back', { name: 'Pascal' })).toBe('Bon retour, Pascal.');
  });

  it('falls back to English for a missing French key rather than showing the key', () => {
    expect(translate('fr', 'common.continue')).toBe('Continuer');
    expect(translate('fr', 'definitely.missing.key')).toBe('definitely.missing.key');
  });

  it('turns backend error codes into human copy in both languages', () => {
    expect(translateError('en', 'SLOT_UNAVAILABLE')).toMatch(/just taken/i);
    expect(translateError('fr', 'SLOT_UNAVAILABLE')).toMatch(/vient d'être prise/i);
    expect(translateError('en', 'HOLD_EXPIRED')).toMatch(/released/i);
  });

  it('never leaks an unknown internal code to the customer', () => {
    const msg = translateError('en', 'PRISMA_P2002_CONSTRAINT_VIOLATION');
    expect(msg).toBe('Something went wrong. Please try again.');
    expect(msg).not.toMatch(/PRISMA|P2002/);
  });

  it('has no missing keys across the two dictionaries', () => {
    const keys = ['checkout.dueToday', 'ledger.total', 'otp.send', 'confirm.title', 'slots.title'];
    for (const k of keys) {
      expect(translate('en', k)).not.toBe(k);
      expect(translate('fr', k)).not.toBe(k);
    }
  });
});

describe('formatting', () => {
  it('formats CAD for each locale', () => {
    expect(formatMoney(15522, 'en')).toContain('155.22');
    expect(formatMoney(15522, 'fr')).toContain('155,22');
  });

  it('formats negative amounts as discounts', () => {
    expect(formatMoney(-2750, 'en')).toMatch(/^-/);
  });

  it('formats a phone as the customer types, without demanding +1', () => {
    expect(formatPhoneInput('5')).toBe('5');
    expect(formatPhoneInput('514')).toBe('514');
    expect(formatPhoneInput('514825')).toBe('(514) 825');
    expect(formatPhoneInput('5148252825')).toBe('(514) 825-2825');
    expect(formatPhoneInput('15148252825')).toBe('(514) 825-2825');
    expect(formatPhoneInput('(514) 825-2825')).toBe('(514) 825-2825');
  });

  it('masks a verified phone for display', () => {
    expect(maskPhoneDisplay('+15148252825')).toBe('(514) •••-2825');
  });
});

describe('hold countdown', () => {
  it('counts down against the server expiry, not a client guess', () => {
    const now = Date.now();
    const expiresAt = new Date(now + 10 * 60_000).toISOString();
    expect(formatCountdown(remainingMs(expiresAt, now))).toBe('10:00');
    expect(formatCountdown(remainingMs(expiresAt, now + 30_000))).toBe('9:30');
  });

  it('never goes negative once expired', () => {
    const expiresAt = new Date(Date.now() - 60_000).toISOString();
    expect(remainingMs(expiresAt)).toBe(0);
    expect(formatCountdown(0)).toBe('0:00');
  });
});

describe('dates', () => {
  it('produces a Toronto date key for the availability endpoint', () => {
    // 03:00 UTC on 15 Sept is still 14 Sept in Toronto.
    expect(torontoDateKey(new Date('2026-09-15T03:00:00Z'))).toBe('2026-09-14');
  });

  it('renders slot times in Toronto for both locales', () => {
    const iso = '2026-09-14T14:00:00Z'; // 10:00 EDT
    expect(formatSlotTime(iso, 'en')).toMatch(/10:00/);
    expect(formatSlotTime(iso, 'fr')).toMatch(/10\s*h\s*00|10:00/);
  });
});

describe('calendar file', () => {
  const booking: Booking = {
    id: 'b1',
    bookingNumber: 'R2N-2026-000042',
    startAt: '2026-09-14T14:00:00Z',
    endAt: '2026-09-14T17:00:00Z',
    status: 'CONFIRMED',
    grandTotalCents: 25869,
    paymentStatus: 'NOT_COLLECTED',
    paymentPolicy: 'PAY_LATER',
    crewSize: 2,
  };

  it('builds an ICS from the persisted booking', () => {
    const ics = buildIcs(booking, 'R2NETTE cleaning', '754 Av. 36e, Lachine');
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('UID:R2N-2026-000042@r2nette.ca');
    expect(ics).toContain('DTSTART:20260914T140000Z');
    expect(ics).toContain('DTEND:20260914T170000Z');
    expect(ics).toContain('754 Av. 36e, Lachine');
  });
});

describe('draft persistence', () => {
  beforeEach(() => {
    installStorage();
  });

  it('keeps selections so an expired session does not lose progress', () => {
    saveDraft({
      ...emptyDraft,
      step: 'slots',
      serviceOptionId: 'svc_basic_2x3',
      frequency: 'WEEKLY',
      productSupplyOption: 'R2NETTE_BASIC',
    });
    const loaded = loadDraft()!;
    expect(loaded.serviceOptionId).toBe('svc_basic_2x3');
    expect(loaded.frequency).toBe('WEEKLY');
  });

  it('never persists personal details', () => {
    saveDraft({
      ...emptyDraft,
      name: 'Pascal Denis',
      email: 'pascal@example.com',
      notes: 'Buzzer 402, door code 1234',
    });
    const raw = localStorage.getItem('r2n_draft')!;
    expect(raw).not.toMatch(/Pascal/);
    expect(raw).not.toMatch(/example\.com/);
    expect(raw).not.toMatch(/1234/);
  });

  it('clears cleanly', () => {
    saveDraft(emptyDraft);
    clearDraft();
    expect(loadDraft()).toBeNull();
  });
});

describe('callback requests', () => {
  it('sends the customer-selected callback time', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ callbackId: 'callback-1', status: 'QUEUED' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    try {
      await api.requestCallback('+15145551234', 'IN_FIVE_MINUTES');
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(init.body as string)).toEqual({
        phoneE164: '+15145551234',
        delay: 'IN_FIVE_MINUTES',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/* ------------------------------------------------------------------ */
/* checkout                                                            */
/* ------------------------------------------------------------------ */

import {
  checkoutMode,
  appearance,
  mountElements,
  awaitBackendConfirmation,
  mapPaymentError,
  type PaymentConfig,
  type StripeLike,
} from '../web/src/lib/checkout.js';
import { readFileSync } from 'node:fs';

const base: PaymentConfig = { configured: true, publishableKey: 'pk_test_x', currency: 'CAD' };

describe('checkout mode', () => {
  it('[INV-TRUTH-03] mounts nothing for PAY_LATER with nothing due', () => {
    expect(checkoutMode({ ...base, paymentPolicy: 'PAY_LATER', amountDueNowCents: 0 })).toBe('NONE');
  });

  it('mounts a payment flow for FULL_PAYMENT', () => {
    expect(checkoutMode({ ...base, paymentPolicy: 'FULL_PAYMENT', amountDueNowCents: 25869 })).toBe('PAYMENT');
  });

  it('mounts a setup flow when a saved card is required', () => {
    expect(checkoutMode({ ...base, paymentPolicy: 'CARD_ON_FILE', amountDueNowCents: 0, recurringPaymentRequired: true })).toBe('SETUP');
  });

  it('mounts a payment flow for a deposit', () => {
    expect(checkoutMode({ ...base, paymentPolicy: 'DEPOSIT', amountDueNowCents: 5000, bookingTotalCents: 25869 })).toBe('PAYMENT');
  });

  it('reports NOT_CONFIGURED rather than faking checkout when Stripe is absent', () => {
    expect(checkoutMode({ ...base, configured: false, amountDueNowCents: 25869 })).toBe('NOT_CONFIGURED');
  });

  it('PAY_LATER still works with no Stripe keys at all', () => {
    expect(checkoutMode({ ...base, configured: false, amountDueNowCents: 0 })).toBe('NONE');
  });
});

describe('Stripe appearance', () => {
  it('carries the R2NETTE palette into Stripe fields', () => {
    const a = appearance();
    expect(a.variables.colorPrimary).toBe('#00C2A0');
    expect(a.variables.colorText).toBe('#07283F');
    expect(a.variables.fontFamily).toMatch(/Instrument Sans/);
  });
});

/** Minimal Stripe.js double that mimics the real Element event surface. */
function fakeStripe(availableMethods: Record<string, boolean> | null): {
  stripe: StripeLike;
  created: string[];
  paymentOpts: Record<string, unknown> | null;
} {
  const created: string[] = [];
  let paymentOpts: Record<string, unknown> | null = null;
  const stripe: StripeLike = {
    elements: () => ({
      create: (type: string, opts?: Record<string, unknown>) => {
        created.push(type);
        if (type === 'payment') paymentOpts = opts ?? null;
        return {
          mount: () => undefined,
          on: (event: string, handler: (e: unknown) => void) => {
            if (type === 'expressCheckout' && event === 'ready') {
              setTimeout(() => handler({ availablePaymentMethods: availableMethods ?? {} }), 0);
            }
          },
        };
      },
      submit: async () => ({}),
    }),
    confirmPayment: async () => ({}),
    confirmSetup: async () => ({}),
  };
  return { stripe, created, get paymentOpts() { return paymentOpts; } } as never;
}

describe('Stripe Elements mounting', () => {
  function nodes() {
    return {
      express: { } as HTMLElement,
      expressSection: { hidden: false } as HTMLElement,
      payment: { } as HTMLElement,
    };
  }

  it('creates the real Express Checkout and Payment Elements', async () => {
    const f = fakeStripe({ applePay: true, link: true });
    const n = nodes();
    const res = await mountElements(f.stripe, 'pi_x_secret', n);
    expect(f.created).toContain('expressCheckout');
    expect(f.created).toContain('payment');
    expect(res.expressAvailable).toBe(true);
    expect(n.expressSection.hidden).toBe(false);
  });

  it('hides the fast-checkout block when Stripe reports no wallets', async () => {
    const f = fakeStripe({ applePay: false, googlePay: false, link: false });
    const n = nodes();
    const res = await mountElements(f.stripe, 'pi_x_secret', n);
    expect(res.expressAvailable).toBe(false);
    expect(n.expressSection.hidden).toBe(true); // no empty box
    expect(f.created).toContain('payment'); // card form still there
  });

  it('does not duplicate wallets inside the Payment Element', async () => {
    const f = fakeStripe({ applePay: true });
    await mountElements(f.stripe, 'pi_x_secret', nodes());
    expect((f as never as { paymentOpts: { wallets: Record<string, string> } }).paymentOpts.wallets)
      .toEqual({ applePay: 'never', googlePay: 'never' });
  });
});

describe('no homemade wallet detection', () => {
  /** Strip comments so a note explaining what we DON'T do isn't a false hit. */
  const strip = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '');
  const sources = [
    readFileSync(new URL('../web/src/lib/checkout.ts', import.meta.url), 'utf8'),
    readFileSync(new URL('../web/src/lib/api.ts', import.meta.url), 'utf8'),
    readFileSync(new URL('../web/index.html', import.meta.url), 'utf8'),
  ].map(strip).join('\n');

  it('[INV-TRUTH-04] never probes ApplePaySession', () => {
    expect(sources).not.toMatch(/ApplePaySession/);
  });

  it('never probes PaymentRequest for wallet visibility', () => {
    expect(sources).not.toMatch(/window\.PaymentRequest|new PaymentRequest/);
  });

  it('never hand-draws a wallet button', () => {
    expect(sources).not.toMatch(/class="wbtn|apple-pay-button|gpay-button/);
  });

  it('contains no manual kilometre input anywhere in the production app', () => {
    expect(sources).not.toMatch(/id="km"|distanceKm.*input|Distance from our base/);
  });

  it('never hardcodes a review aggregate', () => {
    expect(sources).not.toMatch(/5\.0 from 21|5\.0 · 21/);
  });
});

describe('landing page discovery metadata', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const robots = readFileSync(new URL('../web/public/robots.txt', import.meta.url), 'utf8');
  const sitemap = readFileSync(new URL('../web/public/sitemap.xml', import.meta.url), 'utf8');

  it('provides canonical and social preview metadata for ad shares', () => {
    expect(html).toContain('<link rel="canonical" href="https://r2nette.ca/">');
    expect(html).toContain('<meta property="og:url" content="https://r2nette.ca/">');
    expect(html).toContain('<meta property="og:image" content="https://r2nette.ca/assets/hero.jpg">');
    expect(html).toContain('<meta property="og:image:width" content="1774">');
    expect(html).toContain('<meta property="og:image:height" content="887">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toContain('<link rel="preload" as="image" href="/assets/hero.jpg" fetchpriority="high">');
  });

  it('publishes the canonical public URL and excludes private paths from crawling', () => {
    expect(robots).toContain('Sitemap: https://r2nette.ca/sitemap.xml');
    expect(robots).toContain('Disallow: /api/');
    expect(sitemap).toContain('<loc>https://r2nette.ca/</loc>');
    expect(sitemap).not.toMatch(/\/(?:account|admin|crew|login|signup|verify|api)(?:\/|<)/);
    for (const page of ['auth', 'verify', 'signup', 'account', 'admin', 'crew']) {
      const source = readFileSync(new URL(`../web/${page}.html`, import.meta.url), 'utf8');
      expect(source).toMatch(/<meta name="robots" content="noindex,follow"\s*\/?>/);
    }
  });

  it('publishes structured cleaning-service details without invented ratings', () => {
    const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    expect(match).not.toBeNull();
    const structuredData = JSON.parse(match![1]!) as Record<string, unknown>;
    expect(structuredData['@type']).toBe('CleaningService');
    expect(structuredData.telephone).toBe('+1-514-825-2825');
    expect(structuredData.areaServed).toEqual([
      { '@type': 'City', name: 'Montréal' },
      { '@type': 'City', name: 'Laval' },
    ]);
    expect(structuredData.aggregateRating).toBeUndefined();
  });
});

describe('installable app shell', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const manifest = JSON.parse(
    readFileSync(new URL('../web/public/manifest.webmanifest', import.meta.url), 'utf8'),
  ) as {
    display: string;
    start_url: string;
    icons: { sizes: string; purpose: string; src: string }[];
  };
  const worker = readFileSync(new URL('../web/public/sw.js', import.meta.url), 'utf8');

  it('links the install manifest and platform home-screen icon', () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    expect(html).toContain('<link rel="apple-touch-icon" href="/assets/brand/apple-touch-icon.png">');
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/?source=installed-app');
    expect(manifest.icons).toContainEqual(
      expect.objectContaining({ sizes: '192x192', purpose: 'any', src: '/assets/brand/pwa-icon-192.png' }),
    );
    expect(manifest.icons).toContainEqual(
      expect.objectContaining({
        sizes: '512x512',
        purpose: 'maskable',
        src: '/assets/brand/pwa-icon-maskable-512.png',
      }),
    );
    for (const icon of manifest.icons) {
      if (icon.src.endsWith('.png')) {
        expect(readFileSync(new URL(`../web/public${icon.src}`, import.meta.url)).subarray(0, 8))
          .toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      }
    }
  });

  describe('admin page routing', () => {
    it('dispatches only literal route names', () => {
      const admin = readFileSync(new URL('../web/admin.html', import.meta.url), 'utf8');

      expect(admin).toContain("case 'dispatch': dispatch(); break;");
      expect(admin).toContain("case 'operations': operationsPage(); break;");
      expect(admin).toContain('default: dashboard();');
      expect(admin).not.toContain('PAGES[id]');
    });
  });

  it('keeps API and identity routes network-only in the service worker', () => {
    expect(worker).toContain('const NETWORK_ONLY_PATH = /^\\/(?:api\\/|auth');
    expect(worker).toContain("if (url.origin !== self.location.origin || NETWORK_ONLY_PATH.test(url.pathname)) return;");
    expect(worker).toContain(".catch(async () => (await caches.match(APP_SHELL_URL))");
    expect(worker).toContain(".catch(() => new Response('', { status: 503, statusText: 'Offline' }))");
    expect(worker).toContain('OFFLINE_URL');
    expect(readFileSync(new URL('../web/public/offline.html', import.meta.url), 'utf8'))
      .toContain('Reconnect to the internet');
  });
});

describe('backend confirmation wait', () => {
  const noSleep = async () => undefined;

  it('reports success once the backend agrees', async () => {
    let calls = 0;
    const res = await awaitBackendConfirmation(
      async () => {
        calls++;
        return { payment: { status: calls < 3 ? 'PROCESSING' : 'SUCCEEDED', requiresAction: false } };
      },
      'pay_1',
      { sleep: noSleep, intervalMs: 1 },
    );
    expect(res).toBe('SUCCEEDED');
    expect(calls).toBe(3);
  });

  it('surfaces requires-action rather than claiming success', async () => {
    const res = await awaitBackendConfirmation(
      async () => ({ payment: { status: 'REQUIRES_ACTION', requiresAction: true } }),
      'pay_1',
      { sleep: noSleep },
    );
    expect(res).toBe('REQUIRES_ACTION');
  });

  it('reports failure', async () => {
    const res = await awaitBackendConfirmation(
      async () => ({ payment: { status: 'FAILED', requiresAction: false } }),
      'pay_1',
      { sleep: noSleep },
    );
    expect(res).toBe('FAILED');
  });

  it('gives up with STILL_PROCESSING instead of lying or re-charging', async () => {
    let t = 0;
    const res = await awaitBackendConfirmation(
      async () => ({ payment: { status: 'PROCESSING', requiresAction: false } }),
      'pay_1',
      { sleep: noSleep, now: () => (t += 3000), timeoutMs: 9000 },
    );
    expect(res).toBe('STILL_PROCESSING');
  });

  it('keeps waiting through a transient network error', async () => {
    let calls = 0;
    const res = await awaitBackendConfirmation(
      async () => {
        calls++;
        if (calls < 2) throw new Error('network');
        return { payment: { status: 'SUCCEEDED', requiresAction: false } };
      },
      'pay_1',
      { sleep: noSleep, intervalMs: 1 },
    );
    expect(res).toBe('SUCCEEDED');
  });
});

describe('payment error mapping', () => {
  it('maps provider codes to human copy in both languages', () => {
    expect(translate('en', mapPaymentError('card_declined'))).toMatch(/declined/i);
    expect(translate('fr', mapPaymentError('card_declined'))).toMatch(/refusée/i);
    expect(translate('en', mapPaymentError('authentication_required'))).toMatch(/bank/i);
  });

  it('never shows a raw provider code to the customer', () => {
    const msg = translate('en', mapPaymentError('some_internal_stripe_code'));
    expect(msg).not.toMatch(/some_internal_stripe_code/);
    expect(msg).toMatch(/couldn't process/i);
  });

  it('maps the reprice code to a review prompt, not an error', () => {
    expect(translate('en', mapPaymentError('QUOTE_REPRICE_REQUIRED'))).toMatch(/updated/i);
  });
});
