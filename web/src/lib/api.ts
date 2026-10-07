/**
 * API client and booking flow state.
 *
 * The rule this file enforces: the frontend renders server truth and never
 * computes it. There is no tax maths here, no discount resolution, no
 * distance, no booking number. Every money figure comes from a quote
 * response; every slot comes from the availability endpoint.
 */

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    /** Present on QUOTE_REPRICE_REQUIRED: old vs new totals and the new lines. */
    readonly reprice?: unknown,
  ) {
    super(message);
  }
}

async function call<T>(
  path: string,
  init: RequestInit & { idempotencyKey?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;

  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers,
      // The session is an HttpOnly cookie. Nothing identity-related is ever
      // put in localStorage.
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError('NETWORK', 'Network request failed', 0);
  }

  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const parsed = json as { error?: { code?: string; message?: string }; reprice?: unknown };
    throw new ApiError(
      parsed.error?.code ?? 'GENERIC',
      parsed.error?.message ?? 'Request failed',
      res.status,
      parsed.reprice,
    );
  }
  return json as T;
}

/* ---------------- types mirroring the API ---------------- */

export interface ServiceOption {
  id: string;
  slug: string;
  categoryId: string;
  name: { en: string; fr: string };
  pricingMode: 'FIXED' | 'QUOTE_REQUIRED';
  basePriceCents: number | null;
  appointmentDurationMinutes: number | null;
  requiredStaffCount: number;
  labourMinutes: number | null;
  allowedFrequencies: string[];
  productSupplyMode: string;
}

export interface QuoteLine {
  type: string;
  description: string;
  quantity: number;
  unitAmountCents: number;
  subtotalCents: number;
  taxable: boolean;
}

export interface VisitPricing {
  baseServiceCents: number;
  discountedServiceCents: number;
  appliedDiscount: { source: string; amountCents: number; percentage?: number } | null;
}

export interface Quote {
  id: string;
  lines: QuoteLine[];
  subtotalBeforeTaxCents: number;
  taxLines: { name: string; amountCents: number }[];
  taxTotalCents: number;
  grandTotalCents: number;
  expiresAt: string;
  warningCodes?: string[];
  firstVisit?: VisitPricing;
  subsequentVisitPricingPreview?: VisitPricing;
}

export interface SavedAddress {
  id: string;
  label: string | null;
  formattedAddress: string;
  city: string;
  postalCode: string;
  unit: string | null;
  isDefault: boolean;
}

export interface CustomerContext {
  customer: {
    id: string;
    firstName: string | null;
    email: string | null;
    verifiedPhone: string | null;
    isReturningCustomer: boolean;
  };
  addresses: SavedAddress[];
  usualClean: {
    serviceOptionId: string;
    serviceName: string;
    requiredStaffCount: number;
    appointmentDurationMinutes: number | null;
    frequency: string;
    addressId: string;
    addressSummary: string;
  } | null;
}

export interface Slot {
  startAt: string;
  endAt: string;
  preferredStaffAvailable: boolean;
}

export interface Hold {
  id: string;
  startAt: string;
  endAt: string;
  expiresAt: string;
}

export interface Booking {
  id: string;
  bookingNumber: string;
  startAt: string;
  endAt: string;
  status: string;
  grandTotalCents: number;
  paymentStatus: string;
  paymentPolicy: string;
  crewSize: number;
}

export interface PaymentConfig {
  publishableKey: string | null;
  currency: string;
  country: string;
  configured: boolean;
}

/* ---------------- endpoints ---------------- */

export const api = {
  /** Cheap reachability probe used during boot. Exposes nothing sensitive. */
  health: () => call<{ ok: boolean }>('/api/v1/health'),

  publicPromotions: () =>
    call<{ newCustomer: { code: string; amountCents: number; categoryId: string | null }[]; maxAmountCents: number | null }>(
      '/api/v1/promotions/public',
    ),

  reviewSummary: () =>
    call<{ averageRating: number | null; reviewCount: number }>('/api/v1/reviews/summary'),

  reviews: (limit = 6) =>
    call<{ reviews: { id: string; source: string; customerDisplayName: string; rating: number; reviewText: string | null }[] }>(
      `/api/v1/reviews?limit=${limit}`,
    ),

  requestCallback: (phoneE164: string, delay: 'NOW' | 'IN_FIVE_MINUTES' = 'NOW') =>
    call<{ callbackId: string; status: string }>('/api/v1/callbacks', {
      method: 'POST',
      body: JSON.stringify({ phoneE164, delay }),
    }),

  services: () => call<{ services: ServiceOption[] }>('/api/v1/services'),

  sendCode: (phone: string) =>
    call<{ sent: boolean; message: string; maskedPhone: string }>('/api/v1/auth/phone/send', {
      method: 'POST',
      body: JSON.stringify({ phone }),
    }),

  verifyCode: (phone: string, code: string) =>
    call<{ customer: { id: string; firstName: string | null; isReturningCustomer: boolean } }>(
      '/api/v1/auth/phone/verify',
      { method: 'POST', body: JSON.stringify({ phone, code }) },
    ),

  context: () => call<CustomerContext>('/api/v1/customer/context'),

  autocomplete: (q: string, sessionId?: string) =>
    call<{ sessionId: string; suggestions: { placeId: string; primaryText: string; secondaryText: string }[] }>(
      `/api/v1/address/autocomplete?q=${encodeURIComponent(q)}${sessionId ? `&sessionId=${sessionId}` : ''}`,
    ),

  selectAddress: (placeId: string, sessionId: string, unit?: string) =>
    call<{ address: SavedAddress; travel: { distanceKm: number; durationMinutes: number } }>(
      '/api/v1/address/select',
      { method: 'POST', body: JSON.stringify({ placeId, sessionId, unit }) },
    ),

  /**
   * Note what is NOT sent: no total, no tax, no distance. The server resolves
   * distance from addressId and prices everything itself.
   */
  quote: (input: {
    serviceOptionId: string;
    frequency: string;
    productSupplyOption?: string;
    addressId?: string;
    addOns?: { id: string; quantity: number }[];
  }) => call<{ quote: Quote }>('/api/v1/quotes', { method: 'POST', body: JSON.stringify(input) }),

  availability: (serviceOptionId: string, date: string) =>
    call<{ date: string; slots: Slot[] }>(
      `/api/v1/availability?serviceOptionId=${encodeURIComponent(serviceOptionId)}&date=${date}`,
    ),

  createHold: (quoteId: string, startAt: string, idempotencyKey: string) =>
    call<{ hold: Hold }>('/api/v1/booking-holds', {
      method: 'POST',
      body: JSON.stringify({ quoteId, startAt }),
      idempotencyKey,
    }),

  paymentConfig: (bookingId?: string) =>
    call<PaymentConfig>(
      `/api/v1/payment-config${bookingId ? `?bookingId=${encodeURIComponent(bookingId)}` : ''}`,
    ),

  /** Re-check promotion eligibility BEFORE any Stripe object is created. */
  revalidate: (quoteId: string) =>
    call<{ status: 'VALID'; quoteId: string; grandTotalCents: number }>(
      `/api/v1/quotes/${quoteId}/revalidate`,
      { method: 'POST' },
    ),

  quoteById: (id: string) => call<{ quote: Quote }>(`/api/v1/quotes/${id}`),

  setupIntent: (idempotencyKey: string) =>
    call<{ clientSecret: string; paymentId: string }>('/api/v1/payments/setup-intent', {
      method: 'POST',
      body: JSON.stringify({}),
      idempotencyKey,
    }),

  createBooking: (
    input: { holdId: string; quoteId: string; addressId: string },
    idempotencyKey: string,
  ) =>
    call<{ booking: Booking }>('/api/v1/bookings', {
      method: 'POST',
      body: JSON.stringify(input),
      idempotencyKey,
    }),

  paymentIntent: (bookingId: string, idempotencyKey: string) =>
    call<{
      amountDueNowCents: number;
      policy: string;
      clientSecret: string | null;
      paymentId: string | null;
      bookingTotalCents: number | null;
      remainingBalanceCents: number | null;
      message: string | null;
    }>('/api/v1/payments/payment-intent', {
      method: 'POST',
      body: JSON.stringify({ bookingId }),
      idempotencyKey,
    }),

  payment: (id: string) =>
    call<{ payment: { id: string; status: string; requiresAction: boolean } }>(
      `/api/v1/payments/${id}`,
    ),
};

/* ---------------- booking flow state ---------------- */

export type Step =
  | 'service'
  | 'identity'
  | 'welcome'
  | 'property'
  | 'products'
  | 'frequency'
  | 'address'
  | 'slots'
  | 'details'
  | 'checkout'
  | 'confirmation';

export interface BookingDraft {
  step: Step;
  serviceOptionId: string | null;
  propertyType: string | null;
  propertySize: string | null;
  isShortTermRental: boolean;
  bedrooms: number;
  bathrooms: number;
  productSupplyOption: string | null;
  frequency: string | null;
  addressId: string | null;
  addressSummary: string | null;
  slotStartAt: string | null;
  name: string;
  email: string;
  notes: string;
}

export const emptyDraft: BookingDraft = {
  step: 'service',
  serviceOptionId: null,
  propertyType: null,
  propertySize: null,
  isShortTermRental: false,
  bedrooms: 2,
  bathrooms: 1,
  productSupplyOption: null,
  frequency: null,
  addressId: null,
  addressSummary: null,
  slotStartAt: null,
  name: '',
  email: '',
  notes: '',
};

const DRAFT_KEY = 'r2n_draft';

/**
 * Persist only non-sensitive selections, so a session expiring mid-booking
 * does not destroy someone's progress. No phone, email, address text or
 * payment data goes to storage.
 */
export function saveDraft(d: BookingDraft): void {
  try {
    const { name, email, notes, ...safe } = d;
    localStorage.setItem(DRAFT_KEY, JSON.stringify(safe));
  } catch {
    /* ignore */
  }
}

export function loadDraft(): Partial<BookingDraft> | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as Partial<BookingDraft>) : null;
  } catch {
    return null;
  }
}

export function clearDraft(): void {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* ignore */
  }
}

/** Local YYYY-MM-DD in Toronto, for the availability endpoint. */
export function torontoDateKey(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

export function formatSlotTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', {
    timeZone: 'America/Toronto',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

export function formatSlotDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', {
    timeZone: 'America/Toronto',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date(iso));
}

/** Countdown against the SERVER's expiry. The client never invents one. */
export function remainingMs(expiresAt: string, now: number = Date.now()): number {
  return Math.max(0, new Date(expiresAt).getTime() - now);
}

export function formatCountdown(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Build a calendar file from the PERSISTED booking, never a held time. */
export function buildIcs(booking: Booking, summary: string, location: string): string {
  const stamp = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//R2NETTE//Booking//EN',
    'BEGIN:VEVENT',
    `UID:${booking.bookingNumber}@r2nette.ca`,
    `DTSTAMP:${stamp(new Date().toISOString())}`,
    `DTSTART:${stamp(booking.startAt)}`,
    `DTEND:${stamp(booking.endAt)}`,
    `SUMMARY:${summary}`,
    `LOCATION:${location}`,
    `DESCRIPTION:R2NETTE booking ${booking.bookingNumber}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}
