# Payments

## Stripe is not the pricing engine

Every amount sent to Stripe comes from a persisted `Booking.grandTotalCents`,
which is itself a frozen quote snapshot. Nothing in a request body reaches
that number. `POST /payments/payment-intent` accepts `bookingId` and nothing
else that matters — a body carrying `amountCents: 100` is ignored, and a test
asserts the intent is still created for 25869.

## Provider idempotency: the timeout problem

Deleting a failed idempotency record is safe for purely local work. It is not
safe once Stripe is involved: a request can reach Stripe and succeed while our
process sees only a socket hang up. Deleting the key and retrying would mint a
new Stripe key and create a second PaymentIntent — a duplicate charge.

So provider operations use a durable, stateful record:

    IN_PROGRESS ──▶ SUCCEEDED
        │
        ├────────▶ FAILED_RETRYABLE   (network, 5xx, 429 — key preserved)
        └────────▶ FAILED_FINAL       (card declined — same key won't help)

`providerIdempotencyKey` is stored on first attempt and **reused verbatim** on
retry, so Stripe replays the original object. `FAILED_RETRYABLE` retries;
`FAILED_FINAL` refuses and asks for a fresh attempt.

Proven by test: the fake provider registers the intent under its idempotency
key *before* throwing a simulated timeout — exactly like Stripe, where the
object exists on their side even though we never saw the response. After the
retry, `createPaymentIntentCalls` is still 1 and one Payment row exists.

## Payment policies

| Policy | Due today |
|---|---|
| `PAY_LATER` | $0 — no PaymentIntent is created at all |
| `FULL_PAYMENT` | the booking total |
| `DEPOSIT` | fixed cents or micro-percent, capped at the total |
| `CARD_ON_FILE` | $0, SetupIntent only |

Recurring timing (`AT_BOOKING`, `24_HOURS_BEFORE`, `48_HOURS_BEFORE`,
`AFTER_SERVICE`, `PAY_LATER`) is read from `BusinessConfiguration`, default
`24_HOURS_BEFORE`.

## Webhook authority

The browser never confirms a booking. `payment_intent.succeeded` does, inside
a transaction that updates the payment, confirms the booking, writes one
status-history row and redeems any reserved promotion claim.

Replay protection is the `StripeEvent` primary key: it *is* the Stripe event
id, so a redelivery collides on insert and returns `processed: false` without
touching anything. Signature verification is HMAC-SHA256 over `t.payload` with
timing-safe comparison and a 300-second tolerance; a bad signature is a 400
that reveals nothing about why.

## Recurring is not a subscription

A weekly plan is not one fixed Stripe Subscription. Products, travel distance,
add-ons and tax can all change between visits, so each occurrence gets its own
authoritative quote and its own off-session PaymentIntent, keyed on the
booking. A worker running three times creates one intent.

`requires_action` sets the payment to `REQUIRES_ACTION` and the booking to
`PAYMENT_ACTION_REQUIRED`. It is never retried as a transient failure and
never reported as paid.

## 3D Secure

Default is DYNAMIC: `automatic_payment_methods` is enabled and Stripe, Radar
and the issuer decide when a challenge is needed. Challenging every payment
measurably hurts conversion, so there is no such default.

## What is never stored

No PAN, no CVC, no wallet cryptogram. Only provider tokens
(`pm_…`, `pi_…`, `seti_…`) plus display crumbs. A test dumps the payment
method table and asserts nothing matching a 13–19 digit run and no
`cvc`/`cvv` appears.

Stripe metadata carries only internal ids. A test sets an address containing a
door code and asserts it never reaches the provider.

## Test mode

`LiveStripeProvider.isTestMode` checks for an `sk_test_` prefix. Automated
tests use `FakeStripeProvider`, which honours idempotency keys the way Stripe
does — that fidelity is what makes the timeout test meaningful.

Local webhooks:

    stripe listen --forward-to localhost:3000/api/v1/stripe/webhook

## Credential-only blockers

`STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`.
Without them `/payment-config` returns `configured: false` and payment routes
return `INTEGRATION_NOT_CONFIGURED`. Nothing pretends to succeed.

Apple Pay and Google Pay additionally need payment-domain registration in the
Stripe dashboard for each domain served over HTTPS. That is dashboard
configuration, not code.

## Stripe sandbox setup

No live keys needed to develop or test. From the Stripe dashboard in **test
mode**:

```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...        # from `stripe listen`
```

Forward webhooks locally:

```
stripe listen --forward-to localhost:3000/api/v1/stripe/webhook
```

Test cards:

| Scenario | Number |
|---|---|
| Success | 4242 4242 4242 4242 |
| Declined | 4000 0000 0000 0002 |
| 3DS required | 4000 0027 6000 3184 |
| Insufficient funds | 4000 0000 0000 9995 |

Any future expiry, any CVC, any postal code.

**Apple Pay / Google Pay** additionally require payment-domain registration in
the Stripe dashboard for every domain and subdomain serving Express Checkout,
including staging. Until that is done the Express Checkout Element simply
reports no available methods and the UI hides the fast-checkout block — it
does not show a button that cannot work.

## Checkout rendering

`checkoutMode()` decides what to mount:

| Policy | Due today | Mounted |
|---|---|---|
| PAY_LATER | $0 | nothing — no card form for a payment that isn't happening |
| FULL_PAYMENT | booking total | PaymentIntent + Elements |
| DEPOSIT | server-calculated | PaymentIntent + Elements, with total/deposit/remaining shown |
| CARD_ON_FILE | $0 | SetupIntent + Elements, with consent copy |

Express Checkout is mounted first; its `ready` event carries the methods
Stripe actually resolved. When none are available the whole "Fast checkout"
block is hidden rather than left as an empty box. Wallets are set to `never`
inside the Payment Element so they are not duplicated.

Success is never declared from a browser callback. `awaitBackendConfirmation`
polls `GET /payments/:id` for a bounded window and then reports "still
processing" — it never claims success and never starts a second payment.

## Quote revalidation

`POST /quotes/:id/revalidate` runs before any Stripe object is created. If the
welcome offer turned out to be already redeemed, it returns **409
QUOTE_REPRICE_REQUIRED** with the old total, the new total, the difference and
the new itemised lines, and creates a fresh quote. The original quote is never
mutated.

`POST /payments/payment-intent` performs the same check and refuses with the
same code, so there is no path to a PaymentIntent at a price the customer has
not seen. A test asserts `createPaymentIntentCalls === 0` in that case.

Note the WEEKLY case: the 25% frequency discount beats the $15 welcome offer,
so the offer was never claimed and losing it changes nothing — revalidation
returns VALID and no reprice screen appears.
