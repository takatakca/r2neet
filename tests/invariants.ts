/**
 * Business invariants that must be covered by a named, passing test.
 *
 * This replaces a global minimum test count. A count of 600 with 631 tests
 * silently permits deleting 31, cannot tell which 31, and rewards padding the
 * suite with trivia. It answers "are there enough tests?" when the question
 * is "are the things that must never break still proven?"
 *
 * Each entry names a rule that would cost real money, break the law, or
 * expose customer data if it regressed, and points at the test that proves
 * it. Deleting or renaming that test fails CI by name, and the failure says
 * what stopped being verified.
 *
 * Adding an invariant here is a deliberate act. So is removing one.
 */

export interface Invariant {
  /**
   * Stable identifier, embedded in the test title as `[INV-...]`.
   *
   * Matching on an id rather than on prose means a test can be reworded
   * freely, and a rename cannot silently rebind an invariant to a different,
   * weaker test. The id is the contract; the sentence is documentation.
   */
  id: string;
  /** What must remain true, in business terms. */
  rule: string;
  /** Why it matters if it breaks. */
  consequence: string;
  /**
   * A human-readable pointer to the proving test. Documentation only — the
   * `id` tag is what binds them, so this can drift without breaking anything.
   */
  test: string;
  /** Where it lived when declared. A move is reported as a note, not a failure. */
  file: string;
}

export const INVARIANTS: Invariant[] = [
  /* ---------------- tax and pricing ---------------- */
  {
    id: 'INV-TAX-01',
    rule: 'QST is calculated on the pre-tax subtotal, never on GST',
    consequence: 'Compounding would overcharge every customer and misstate remittances to Revenu Québec.',
    test: 'without compounding',
    file: 'tests/pricing.test.ts',
  },
  {
    id: 'INV-TAX-02',
    rule: 'Each tax line rounds half-up independently',
    consequence: 'Rounding the total instead of each line drifts by cents that never reconcile.',
    test: 'rounds $13.46625 up to $13.47',
    file: 'tests/pricing.test.ts',
  },
  {
    id: 'INV-TAX-03',
    rule: 'Frequency discounts apply to the service only, not products, travel or tax',
    consequence: 'Discounting tax would understate what is owed to the government.',
    test: 'leaves $12 products intact under a 25% weekly discount',
    file: 'tests/pricing.test.ts',
  },
  {
    id: 'INV-TAX-04',
    rule: 'One transportation fee per visit, regardless of crew size',
    consequence: 'Charging per cleaner double-bills every two-person job.',
    test: 'leaves $25 transport intact under a 25% weekly discount',
    file: 'tests/pricing.test.ts',
  },
  {
    id: 'INV-TAX-05',
    rule: 'Only the single best discount applies',
    consequence: 'Stacking discounts gives away margin on every booking.',
    test: 'returns its own authoritative amount',
    file: 'tests/pricing.test.ts',
  },

  /* ---------------- money movement ---------------- */
  {
    id: 'INV-PAY-01',
    rule: 'The server prices the booking; a client-supplied amount is ignored',
    consequence: 'A customer could otherwise set their own price.',
    test: 'ignores a client-supplied amount and charges the authoritative total',
    file: 'tests/payments.test.ts',
  },
  {
    id: 'INV-PAY-02',
    rule: 'Stripe webhooks are verified against the raw request body',
    consequence: 'Re-serialising before verification lets a forged event mark a booking paid.',
    test: 'a re-serialized body fails, proving raw bytes are what is verified',
    file: 'tests/payments.test.ts',
  },
  {
    id: 'INV-PAY-03',
    rule: 'A replayed webhook is a no-op',
    consequence: 'Stripe retries; without this a customer is charged or credited twice.',
    test: 'a replayed webhook changes nothing a second time',
    file: 'tests/payments.test.ts',
  },
  {
    id: 'INV-PAY-04',
    rule: 'Running the billing worker twice does not charge twice',
    consequence: 'Duplicate charges on recurring plans.',
    test: 'running the worker twice does not charge twice',
    file: 'tests/billing.test.ts',
  },
  {
    id: 'INV-PAY-05',
    rule: 'A dead card stops immediately instead of retrying',
    consequence: 'Retrying a closed account attracts issuer blocks and fees.',
    test: 'a dead card stops immediately rather than retrying',
    file: 'tests/billing.test.ts',
  },
  {
    id: 'INV-PAY-06',
    rule: 'No Stripe object is created while a price change is unaccepted',
    consequence: 'Charging a total the customer never saw.',
    test: 'no Stripe object is created while a reprice is outstanding',
    file: 'tests/reprice.test.ts',
  },

  /* ---------------- capacity ---------------- */
  {
    id: 'INV-CAP-01',
    rule: 'Two concurrent bookings cannot claim the last crew',
    consequence: 'Two customers promised the same cleaners at the same hour.',
    test: 'concurrent booking-number allocation produces no duplicates',
    file: 'tests/postgres.test.ts',
  },
  {
    id: 'INV-CAP-02',
    rule: 'Rescheduling re-verifies capacity',
    consequence: 'A customer could move onto a slot the business cannot staff.',
    test: 'refuses a slot the business cannot staff',
    file: 'tests/account.test.ts',
  },
  {
    id: 'INV-CAP-03',
    rule: 'Recurring generation is idempotent',
    consequence: 'Duplicate visits on the dispatch board and duplicate charges.',
    test: 'is idempotent: running twice creates nothing extra',
    file: 'tests/recurrence.test.ts',
  },

  /* ---------------- time ---------------- */
  {
    id: 'INV-TIME-01',
    rule: 'Weekly visits keep their wall-clock time across DST',
    consequence: 'Every weekly cleaning silently moves an hour for the winter.',
    test: 'WEEKLY keeps the wall-clock time across the November fall-back',
    file: 'tests/recurrence.test.ts',
  },
  {
    id: 'INV-TIME-02',
    rule: 'Monthly visits clamp in February and return to the chosen day',
    consequence: 'A 31st booking drifts permanently to the 28th.',
    test: 'MONTHLY from the 31st clamps in February and RETURNS to the 31st',
    file: 'tests/recurrence.test.ts',
  },
  {
    id: 'INV-TIME-03',
    rule: 'Daily scheduled jobs hold their local hour across DST',
    consequence: 'The nightly backup and morning digest drift an hour twice a year.',
    test: 'holds the same LOCAL hour across the fall-back',
    file: 'tests/scheduler.test.ts',
  },

  /* ---------------- promotions ---------------- */
  {
    id: 'INV-PROMO-01',
    rule: 'Generating a quote never reserves a promotion',
    consequence: 'Browsing prices would burn a customer\u2019s one lifetime offer.',
    test: 'generating quotes writes zero claim rows',
    file: 'tests/promotion-claims.test.ts',
  },
  {
    id: 'INV-PROMO-02',
    rule: 'Two concurrent checkouts cannot both claim the welcome offer',
    consequence: 'The lifetime limit becomes unenforceable.',
    test: 'two concurrent checkouts cannot both reserve the offer',
    file: 'tests/promotion-claims.test.ts',
  },

  /* ---------------- identity and access ---------------- */
  {
    id: 'INV-AUTH-01',
    rule: 'A correct password alone issues no session when 2FA is on',
    consequence: 'Two-factor would be decorative.',
    test: 'THE PASSWORD ALONE ISSUES NO SESSION once enrolled',
    file: 'tests/totp.test.ts',
  },
  {
    id: 'INV-AUTH-02',
    rule: 'A TOTP code cannot be replayed',
    consequence: 'An observed code stays usable for its full 30 seconds.',
    test: 'REPLAY: the same code cannot be used twice',
    file: 'tests/totp.test.ts',
  },
  {
    id: 'INV-AUTH-03',
    rule: 'Two-factor secrets are encrypted at rest',
    consequence: 'A database dump alone would let anyone generate valid codes.',
    test: 'never writes the raw secret to the database',
    file: 'tests/totp.test.ts',
  },
  {
    id: 'INV-AUTH-04',
    rule: 'A cleaner sees only their own jobs',
    consequence: 'Staff could read colleagues\u2019 schedules and customer addresses.',
    test: 'a cleaner sees only their own jobs, whatever staffId they send',
    file: 'tests/staff-auth.test.ts',
  },
  {
    id: 'INV-AUTH-05',
    rule: 'A dispatcher cannot moderate reviews or read integrations',
    consequence: 'Role separation would be advisory rather than enforced.',
    test: 'a dispatcher cannot moderate reviews or read integrations',
    file: 'tests/staff-auth.test.ts',
  },
  {
    id: 'INV-AUTH-06',
    rule: 'One customer cannot read another customer\u2019s record',
    consequence: 'A privacy breach.',
    test: 'never exposes another customer bookings or addresses',
    file: 'tests/account.test.ts',
  },
  {
    id: 'INV-AUTH-07',
    rule: 'The concierge cannot be talked into widening its own access',
    consequence: 'Prompt injection would expose other customers\u2019 bookings.',
    test: 'PROMPT INJECTION',
    file: 'tests/concierge.test.ts',
  },

  /* ---------------- truthfulness ---------------- */
  {
    id: 'INV-TRUTH-01',
    rule: 'A review source is earned, never claimed',
    consequence: 'Fabricated Google reviews are fraud.',
    test: 'refuses to create a GOOGLE review without provider provenance',
    file: 'tests/concierge.test.ts',
  },
  {
    id: 'INV-TRUTH-02',
    rule: 'With no published reviews, the rating shows nothing',
    consequence: 'Inventing a score misleads customers.',
    test: 'shows nothing rather than a fabricated score when there are no reviews',
    file: 'tests/concierge.test.ts',
  },
  {
    id: 'INV-TRUTH-03',
    rule: 'PAY_LATER mounts no card form and never says paid',
    consequence: 'Claiming payment that never happened.',
    test: 'mounts nothing for PAY_LATER with nothing due',
    file: 'tests/frontend.test.ts',
  },
  {
    id: 'INV-TRUTH-04',
    rule: 'Wallet availability comes from Stripe, never from our own guess',
    consequence: 'A wallet button that cannot complete a payment.',
    test: 'never probes ApplePaySession',
    file: 'tests/frontend.test.ts',
  },

  /* ---------------- data safety ---------------- */
  {
    id: 'INV-DATA-01',
    rule: 'Destructive operations are refused outside a test database',
    consequence: 'A test run could wipe production.',
    test: 'blocks destructive operations against production',
    file: 'tests/postgres.test.ts',
  },
  {
    id: 'INV-DATA-02',
    rule: 'Logs redact passwords, codes, tokens and contact details',
    consequence: 'Customer data leaking into log aggregation.',
    test: 'removes passwords, codes and tokens at any depth',
    file: 'tests/hardening.test.ts',
  },
  {
    id: 'INV-DATA-03',
    rule: 'An upload is verified, not assumed, before the local copy is removed',
    consequence: 'A gateway that accepts and discards would silently lose every backup.',
    test: 'catches a gateway that returns success and stores nothing',
    file: 'tests/infrastructure.test.ts',
  },
  {
    id: 'INV-DATA-04',
    rule: 'The Setmore import refuses to guess an ambiguous service',
    consequence: 'Sending the wrong number of cleaners to someone\u2019s home.',
    test: 'REFUSES to guess when crew size or duration is missing',
    file: 'tests/setmore-migration.test.ts',
  },
];

/** Directories where coverage is enforced, and why. */
export const COVERAGE_CRITICAL = [
  'src/engine',
  'src/payments',
  'src/auth',
  'src/scheduling',
  'src/promotions',
];
