# R2NETTE -> TAKATAK integration

Status (2026-10-17): the signed outbox implementation and database migration are present in R2NETTE `main`, but production delivery remains deliberately disabled. The TAKATAK receiver route from `takatakca/takatak-v1#175` is present in `takatak-v1` `main` (`574766b7`, 2026-10-16) at `src/app/api/integrations/r2nette/events/route.ts`; its production deployment, `R2NETTE_SYNC_*` secrets and signature checks are still unverified, so the sender stays off.

## Customer identity (phone OTP) — same project for every TAKATAK company

Customer login and sign-up on R2NETTE, RentAuto and takatak.ca all run against the **one shared TAKATAK Supabase Auth project**: the browser or server calls GoTrue `signInWithOtp` / `verifyOtp` with that project's public anon/publishable key, Supabase sends the code through the Twilio provider configured in its dashboard, and each company keeps its own customer record keyed by the verified E.164 phone. R2NETTE does this server-side in `src/identity/identity.ts` with `TAKATAK_SUPABASE_URL` and `TAKATAK_SUPABASE_ANON_KEY`; there is no Twilio credential in R2NETTE for OTP (the `TWILIO_*` variables are for the callback dialler and notifications only).

When a customer says the code never arrives, open `/admin#integrations`: the first card asks the TAKATAK project live whether phone sign-in is enabled, which SMS provider it reports and whether phone auto-confirm is on. `PHONE DISABLED` means Authentication → Providers → Phone (and Twilio) must be enabled on the TAKATAK project itself; `UNREACHABLE` means the URL or key is wrong. A refused send is also logged as `takatak_otp_send_failed` with the GoTrue `error_code`, never the phone number. `READY` is still not proof of delivery: only a real handset test is.

## Boundary

R2NETTE remains the operational source of truth for its own bookings, pricing, availability, payments and customer-service data. TAKATAK receives only the narrow master-identity/customer-relationship projection supported by its verified R2NETTE contract.

The bridge never sends passwords, OTPs, sessions, raw card data, Stripe client secrets, door/alarm codes, entry instructions or private booking notes.

## Events

R2NETTE queues the following signed events:

- `CUSTOMER_REGISTERED`
- `PROFILE_UPDATED`
- `ADDRESS_UPDATED`
- `PAYMENT_SUMMARY_UPDATED`

Profile events carry the approved identity/profile fields, verified-phone proof, consent records and saved service addresses. Payment events carry booking number, mapped payment status, integer minor units (CAD cents), refunded minor units and an optional Stripe customer reference.

## Delivery design

Business writes and outbox writes are committed in the same PostgreSQL transaction. HTTP delivery is performed later by the existing scheduler.

This means:

- a temporary TAKATAK outage never blocks registration, address updates or payment processing;
- retries reuse the persisted event id and payload;
- profile events have higher priority than payment summaries;
- multiple scheduler instances use a short database lease to avoid duplicate concurrent sends;
- remote 408/425/429/5xx responses are retried with bounded backoff;
- a payment 409 is retried because the master may still be waiting for the profile;
- non-retryable contract/identity conflicts are moved to `DEAD` for operator review.

TAKATAK itself also persists processed event ids, so delivery is idempotent on both sides.

## Signature

The sender uses the master contract:

`HMAC-SHA256(secret, timestamp + "." + eventId + "." + rawBody)`

Headers:

- `x-integration-id`
- `x-event-id`
- `x-timestamp`
- `x-signature: sha256=<hex>`

The raw JSON bytes signed are exactly the bytes sent.

## R2NETTE environment

Server-only variables:

```text
TAKATAK_R2NETTE_SYNC_ENABLED=false
TAKATAK_R2NETTE_SYNC_URL=
TAKATAK_R2NETTE_SYNC_CLIENT_ID=
TAKATAK_R2NETTE_SYNC_WEBHOOK_SECRET=
```

Production activation sequence:

1. Merge and release the TAKATAK receiver PR under TAKATAK's normal release controls.
2. Configure TAKATAK receiver variables `R2NETTE_SYNC_ENABLED=true`, `R2NETTE_SYNC_CLIENT_ID` and `R2NETTE_SYNC_WEBHOOK_SECRET`.
3. Verify the receiver URL is reachable over HTTPS and still rejects missing/invalid signatures.
4. Put the matching client id and secret in the R2NETTE GitHub production environment. Never paste secret values in issues, docs or chat.
5. Set the R2NETTE URL to the deployed receiver, currently designed as `https://takatak.ca/api/integrations/r2nette/events`.
6. Keep `TAKATAK_R2NETTE_SYNC_ENABLED=false` until both ends are configured.
7. After the outbox migration is deployed, run `npm run sync:takatak-backfill` once in the R2NETTE application environment. It only queues deterministic current snapshots; it does not call TAKATAK and is safe to rerun.
8. Enable the bridge, rerun the R2NETTE server setup/deploy workflow through the normal approved production gate, and verify the `takatak-sync` worker succeeds.
9. Verify a test registration/profile update reaches TAKATAK, then a test payment summary. Do not use destructive production payment tests.

## Failure handling

The queue is visible in PostgreSQL table `TakatakSyncEvent`.

Important states:

- `PENDING`: never attempted yet
- `RETRY`: temporary failure, scheduled again
- `DELIVERED`: accepted by TAKATAK
- `DEAD`: final/manual-review failure

The scheduler worker is called `takatak-sync`. Worker health becomes production-critical only when `TAKATAK_R2NETTE_SYNC_ENABLED=true`.

## TAKATAK-side dependency

The master contract already exists in `takatakca/takatak-v1/src/lib/integrations/r2nette`. R2NETTE must not bypass it or write master database tables directly.

The public Next.js route is handled separately in TAKATAK PR #175. R2NETTE production sync must remain disabled until that PR has passed CI, been approved/merged by the TAKATAK release coordinator, deployed under the existing TAKATAK production gate, and verified.
