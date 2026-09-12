/**
 * Stripe checkout.
 *
 * Everything here goes through official Stripe.js. There is deliberately no
 * `ApplePaySession` check, no `PaymentRequest` probe, and no hand-drawn
 * wallet button anywhere in this file — the Express Checkout Element decides
 * what Apple Pay / Google Pay / Link availability actually is for this
 * device, browser, account and domain. Guessing that ourselves is how you end
 * up showing a button that cannot complete a payment.
 */

export type CheckoutState =
  | 'IDLE'
  | 'PREPARING'
  | 'READY'
  | 'CONFIRMING'
  | 'REQUIRES_ACTION'
  | 'PROCESSING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'NOT_CONFIGURED';

export interface PaymentConfig {
  configured: boolean;
  publishableKey: string | null;
  currency: string;
  paymentPolicy?: string;
  amountDueNowCents?: number;
  bookingTotalCents?: number;
  remainingBalanceCents?: number;
  recurringPaymentRequired?: boolean;
  recurringPaymentTiming?: string;
}

/** R2NETTE's palette applied to Stripe's own secure fields. */
export function appearance() {
  return {
    theme: 'stripe' as const,
    variables: {
      colorPrimary: '#00C2A0',
      colorBackground: '#ffffff',
      colorText: '#07283F',
      colorDanger: '#C4383C',
      fontFamily: "'Instrument Sans', system-ui, sans-serif",
      fontSizeBase: '16px',
      borderRadius: '12px',
      spacingUnit: '4px',
    },
    rules: {
      '.Input': { border: '1.5px solid #DCE7EE', boxShadow: 'none', padding: '13px 14px' },
      '.Input:focus': { border: '1.5px solid #00C2A0', boxShadow: '0 0 0 3px rgba(0,194,160,.14)' },
      '.Label': { fontWeight: '600', fontSize: '13.5px', color: '#07283F' },
      '.Tab': { border: '1.5px solid #DCE7EE', boxShadow: 'none' },
      '.Tab--selected': { borderColor: '#00C2A0', boxShadow: '0 0 0 3px rgba(0,194,160,.14)' },
    },
  };
}

/**
 * Decide what checkout to render.
 *
 * PAY_LATER with nothing due mounts NOTHING — no card form for a payment
 * that isn't happening.
 */
export function checkoutMode(cfg: PaymentConfig): 'NONE' | 'PAYMENT' | 'SETUP' | 'NOT_CONFIGURED' {
  if (cfg.recurringPaymentRequired) {
    return cfg.configured ? 'SETUP' : 'NOT_CONFIGURED';
  }
  const due = cfg.amountDueNowCents ?? 0;
  if (due === 0) return 'NONE';
  return cfg.configured ? 'PAYMENT' : 'NOT_CONFIGURED';
}

export interface StripeLike {
  elements(opts: Record<string, unknown>): ElementsLike;
  confirmPayment(opts: Record<string, unknown>): Promise<{ error?: { code?: string; message?: string } }>;
  confirmSetup(opts: Record<string, unknown>): Promise<{ error?: { code?: string; message?: string } }>;
}
export interface ElementsLike {
  create(type: string, opts?: Record<string, unknown>): ElementLike;
  submit(): Promise<{ error?: { message?: string } }>;
}
export interface ElementLike {
  mount(selector: string | HTMLElement): void;
  on(event: string, handler: (e: unknown) => void): void;
  unmount?(): void;
}

export interface MountResult {
  elements: ElementsLike;
  /** True only when Stripe reported at least one express method. */
  expressAvailable: boolean;
}

/**
 * Mount Express Checkout + Payment Element against a client secret.
 *
 * The `ready` event on the Express Checkout Element carries the methods
 * Stripe actually resolved. When it reports none, we remove the whole
 * "Fast checkout" block rather than leaving an empty box above the card
 * form.
 */
export async function mountElements(
  stripe: StripeLike,
  clientSecret: string,
  nodes: { express: HTMLElement; expressSection: HTMLElement; payment: HTMLElement },
): Promise<MountResult> {
  const elements = stripe.elements({ clientSecret, appearance: appearance() });

  const express = elements.create('expressCheckout');
  let expressAvailable = false;

  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    express.on('ready', (e: unknown) => {
      const methods = (e as { availablePaymentMethods?: Record<string, boolean> })
        ?.availablePaymentMethods;
      expressAvailable = Boolean(methods && Object.values(methods).some(Boolean));
      if (!expressAvailable) nodes.expressSection.hidden = true;
      done();
    });
    // No wallet on this device is a normal outcome, not an error.
    express.on('loaderror', () => {
      nodes.expressSection.hidden = true;
      done();
    });
    express.mount(nodes.express);
    setTimeout(() => {
      if (!settled) nodes.expressSection.hidden = true;
      done();
    }, 4000);
  });

  // Wallets live in Express Checkout, so they are not duplicated here.
  const payment = elements.create('payment', {
    wallets: { applePay: 'never', googlePay: 'never' },
  });
  payment.mount(nodes.payment);

  return { elements, expressAvailable };
}

/**
 * Poll the backend until it agrees the payment succeeded.
 *
 * Stripe's browser callback is not proof: the webhook is. This waits a
 * bounded time and then reports "still processing" rather than either lying
 * about success or starting a second payment.
 */
export async function awaitBackendConfirmation(
  fetchPayment: (id: string) => Promise<{ payment: { status: string; requiresAction: boolean } }>,
  paymentId: string,
  opts: { timeoutMs?: number; intervalMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<'SUCCEEDED' | 'FAILED' | 'REQUIRES_ACTION' | 'STILL_PROCESSING'> {
  const timeoutMs = opts.timeoutMs ?? 20000;
  const intervalMs = opts.intervalMs ?? 1500;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const started = now();

  while (now() - started < timeoutMs) {
    try {
      const res = await fetchPayment(paymentId);
      const s = res.payment.status;
      if (s === 'SUCCEEDED') return 'SUCCEEDED';
      if (s === 'FAILED' || s === 'CANCELLED') return 'FAILED';
      if (s === 'REQUIRES_ACTION') return 'REQUIRES_ACTION';
    } catch {
      // transient; keep waiting
    }
    await sleep(intervalMs);
  }
  return 'STILL_PROCESSING';
}

/** Provider/backend errors mapped to keys the dictionaries already carry. */
export function mapPaymentError(code: string | undefined): string {
  switch (code) {
    case 'card_declined':
    case 'insufficient_funds':
      return 'error.CARD_DECLINED';
    case 'authentication_required':
      return 'error.AUTHENTICATION_REQUIRED';
    case 'invalid_number':
    case 'incorrect_cvc':
    case 'expired_card':
      return 'error.CARD_INVALID';
    case 'INTEGRATION_NOT_CONFIGURED':
      return 'error.INTEGRATION_NOT_CONFIGURED';
    case 'HOLD_EXPIRED':
      return 'error.HOLD_EXPIRED';
    case 'QUOTE_EXPIRED':
      return 'error.QUOTE_EXPIRED';
    case 'QUOTE_REPRICE_REQUIRED':
      return 'error.QUOTE_REPRICE_REQUIRED';
    case 'NETWORK':
      return 'error.NETWORK';
    default:
      return 'error.PAYMENT_GENERIC';
  }
}
