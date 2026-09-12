# Concierge, callbacks and reviews

## The concierge sits above the reservation system

It never becomes the reservation system. Every factual answer comes from a
tool in `src/concierge/tools.ts`, which are the same code paths the booking UI
uses.

Two properties are structural, not just instructed:

**It cannot compute a price.** No prompt contains a tax rate, a discount
percentage or any arithmetic. `createQuote` returns the authoritative number
and the model narrates it. A test asserts the tool returns exactly 20121 for
Basic 2×3 weekly — the same $201.21 the booking flow produces.

**It cannot widen its own access.** Every customer-scoped tool takes
`customerId` from the verified session, never from arguments. The prompt
injection test passes `{ bookingId: <B's booking>, customerId: <B> }` while
authenticated as A, and gets "we could not find that booking" — the argument
is simply ignored.

`PUBLIC_TOOLS` is the allowlist for unverified visitors: catalogue, quote,
availability, reviews, phone numbers, callback. Everything else throws
UNAUTHORIZED.

Sensitive actions — booking, payment, cancellation, reschedule — are in
`CONFIRMATION_REQUIRED` and can never be executed from inferred intent.

## Guided first, AI second

`QUICK_ACTIONS` is the primary path and works identically with no AI provider
configured. It is cheaper, faster, and cannot hallucinate. When
`AI_API_KEY`/`AI_PROVIDER` are absent the chat box is hidden — there is no
fake typing indicator.

## Callbacks: staff-first bridge

We ring R2NETTE first and dial the customer only once a person has actually
picked up. Calling the customer first and then hunting for staff leaves them
listening to silence, which is worse than not calling.

    REQUESTED → QUEUED → STAFF_RINGING → STAFF_ACCEPTED
              → CUSTOMER_RINGING → CONNECTED → COMPLETED

`CONNECTED` is only ever set from a provider event, never from the fact that
we placed a call. Tests assert `voice.customerCalls` is empty while the status
is `STAFF_RINGING`.

Staff missing the call is a retry, capped at three attempts. The customer
missing it is not our cue to keep dialling them.

**Worker safety** uses a database lease, not an in-process lock:

```sql
UPDATE "CallbackRequest" SET "claimedBy" = $worker, "claimedUntil" = $lease
WHERE "id" = (SELECT "id" FROM "CallbackRequest"
              WHERE status='QUEUED' AND (claimedUntil IS NULL OR claimedUntil < now())
              ORDER BY "requestedAt" LIMIT 1 FOR UPDATE SKIP LOCKED)
RETURNING "id"
```

Tested with two independent `PrismaClient` instances racing: exactly one wins.

With no Twilio Voice credentials the request is still persisted and shown to
operations. Nothing animates "Calling…".

Wording is "we'll try to reach you within about 5 minutes" — an operational
target, never a guarantee.

## Reviews: a source is earned, not claimed

| Source | Requires |
|---|---|
| `GOOGLE` | an externalId from the provider sync |
| `SETMORE_LEGACY` | an externalId from a verified import |
| `R2NETTE_VERIFIED` | a **completed** booking plus a valid invitation token |
| `MANUAL_APPROVED` | nothing — but it stays labelled MANUAL_APPROVED |

`ReviewService.create` is the only creation path and enforces this. Tests
prove a hand-typed testimonial cannot be labelled Google, and that a review
against a merely CONFIRMED booking is rejected.

Invitations store only a SHA-256 hash of the token, expire, and are single
use.

Aggregates come from PUBLISHED rows only. With zero reviews the summary
returns `averageRating: null` and `reviewCount: 0` so the hero can show
nothing rather than invent "5.0 from 21 reviews".

Google sync is idempotent on `(source, externalId)`. A failed sync records
`lastError` and leaves `lastSuccessfulSyncAt` untouched — it never reports
CONNECTED because environment variables exist.

## Business phones

Seeded with the one number R2NETTE actually publishes: (514) 825-2825, inbound
only. Outbound calling must be enabled deliberately before the staff-first
bridge can dial from it.

## Credential-only blockers

`AI_PROVIDER` + `AI_API_KEY`, `TWILIO_VOICE_NUMBER`, and the four
`GOOGLE_BUSINESS_*` values. Each surfaces as NOT_CONFIGURED with the feature
degraded honestly rather than faked.
