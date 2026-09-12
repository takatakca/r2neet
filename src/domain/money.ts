/**
 * R2NETTE money utilities.
 *
 * INVARIANT: every authoritative monetary amount in this system is an integer
 * number of CENTS. Floating-point arithmetic is never used as the authoritative
 * representation of money.
 *
 *   $110.00 -> 11000
 *
 * Rates (tax rates, discount percentages) are stored as MICRO-PERCENT:
 * the percentage multiplied by 1_000_000.
 *
 *   5%      -> 5_000_000
 *   9.975%  -> 9_975_000
 *   25%     -> 25_000_000
 *
 * This lets us express 9.975% exactly as an integer and keeps every
 * calculation in integer space.
 */

export type Cents = number;
export type MicroPercent = number;

export const MICRO_PERCENT_SCALE = 1_000_000;
/** cents * microPercent / PERCENT_DIVISOR = cents */
const PERCENT_DIVISOR = 100 * MICRO_PERCENT_SCALE;

export const CURRENCY = 'CAD' as const;

export function percent(value: number): MicroPercent {
  return Math.round(value * MICRO_PERCENT_SCALE);
}

export function dollars(value: number): Cents {
  return Math.round(value * 100);
}

/**
 * Integer division rounding half away from zero (ROUND_HALF_UP).
 * Exact — no floating point is involved in the rounding decision.
 */
export function divRoundHalfUp(numerator: number, denominator: number): number {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator)) {
    throw new Error('divRoundHalfUp requires integers');
  }
  if (denominator <= 0) throw new Error('denominator must be positive');

  const negative = numerator < 0;
  const n = Math.abs(numerator);

  const q = Math.floor(n / denominator);
  const remainder = n - q * denominator;
  const rounded = remainder * 2 >= denominator ? q + 1 : q;

  return negative ? -rounded : rounded;
}

/**
 * Apply a micro-percent rate to a cent amount, rounding half-up to the cent.
 *
 *   applyRate(13500, percent(9.975)) === 1347   // 13.46625 -> 13.47
 */
export function applyRate(amount: Cents, rate: MicroPercent): Cents {
  assertCents(amount);
  if (!Number.isInteger(rate) || rate < 0) {
    throw new Error(`invalid rate: ${rate}`);
  }
  return divRoundHalfUp(amount * rate, PERCENT_DIVISOR);
}

export function sum(...amounts: Cents[]): Cents {
  return amounts.reduce((total, amount) => {
    assertCents(amount);
    return total + amount;
  }, 0);
}

export function assertCents(amount: unknown): asserts amount is Cents {
  if (typeof amount !== 'number' || !Number.isInteger(amount)) {
    throw new Error(`monetary amount must be an integer of cents, received: ${String(amount)}`);
  }
  if (!Number.isSafeInteger(amount)) {
    throw new Error(`monetary amount outside safe integer range: ${amount}`);
  }
}

export function assertNonNegative(amount: Cents, label = 'amount'): Cents {
  assertCents(amount);
  if (amount < 0) throw new Error(`${label} cannot be negative: ${amount}`);
  return amount;
}

/** Presentation only. Never feed formatted output back into a calculation. */
export function formatCAD(amount: Cents): string {
  assertCents(amount);
  const negative = amount < 0;
  const abs = Math.abs(amount);
  const body = `$${Math.floor(abs / 100).toLocaleString('en-CA')}.${String(abs % 100).padStart(2, '0')}`;
  return negative ? `-${body}` : body;
}

export function formatRate(rate: MicroPercent): string {
  const asPercent = rate / MICRO_PERCENT_SCALE;
  return `${Number(asPercent.toFixed(3))}%`;
}
