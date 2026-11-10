# R2NETTE -> TAKATAK integration

Status (2026-10-14): the signed outbox implementation and database migration are present in R2NETTE `main`, but production delivery remains deliberately disabled. The TAKATAK receiving PR `takatakca/takatak-v1#175` is still OPEN and must pass its independent release and signature checks before activation.

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

## "Continuer avec TAKATAK" sign-in (Claude, Anthropic — 2026-11-10)

TAKATAK is the master account for every Groupe TAKATAK site. R2NETTE signs customers in through TAKATAK and keeps its own copy of the customer.

1. `/login` and `/signup` show **Continuer avec TAKATAK** when `GET /api/v1/auth/takatak/config` says it is configured. The email-code form stays below it as the alternative; when email codes are off, only the TAKATAK path is shown.
2. `GET /api/v1/auth/takatak/start` creates the PKCE verifier and state, keeps them in an httpOnly cookie scoped to `/api/v1/auth/takatak` (10 minutes) and redirects to the TAKATAK Supabase OAuth server (`/auth/v1/oauth/authorize`, scope `openid email profile phone`).
3. The customer signs in, or creates the TAKATAK account, on takatak.ca and authorizes R2NETTE on `takatak.ca/oauth/consent`.
4. `GET /api/v1/auth/takatak/callback` checks the state, exchanges the code server-to-server as a public client (no secret) and reads `/auth/v1/oauth/userinfo`. The browser never sees a TAKATAK token, and R2NETTE stores no TAKATAK token.
5. Account matching, in order: the TAKATAK user id in `Customer.emailAuthSubject` (customers who used the email-code form already have it, because those codes come from the same TAKATAK project); a phone that both TAKATAK and R2NETTE already verified; otherwise a new customer, only with a TAKATAK-verified email and the terms box ticked. A historic R2NETTE profile that merely lists the same email is never taken over: its owner signs in with the usual method and uses **Relier mon compte TAKATAK** on `/account` (`intent=link`).
6. R2NETTE copies TAKATAK's verified email, name and verified phone into empty fields only, then queues the usual `CUSTOMER_REGISTERED` / `PROFILE_UPDATED` event in the outbox above, so TAKATAK receives the R2NETTE profile back once the sync is enabled.

Setup (done 2026-11-10 by Claude on the owner's instruction, except the deploy):

- Done: OAuth app **R2NETTE** registered in TAKATAK Supabase (public client, `none` auth, `authorization_code,refresh_token`, redirect `https://r2nette.ca/api/v1/auth/takatak/callback`). Client id `8e551e10-b1e1-4cf5-8af9-72fc791b9086` (public, not a secret). Probe: `/auth/v1/oauth/authorize` with this client answered 302 to `https://takatak.ca/oauth/consent`.
- Done: GitHub `production` environment variable `TAKATAK_OAUTH_CLIENT_ID` set to that id.
- Remaining: merge this branch, run **Server setup** (copies the id to the server), deploy, then a real sign-in.

Reference steps:

- In the TAKATAK Supabase project (`pcjfahhlozsseqqevimi`), Authentication › OAuth Apps: register **R2NETTE** as a public client, PKCE, grant types `authorization_code` and `refresh_token`, redirect URI `https://r2nette.ca/api/v1/auth/takatak/callback`.
- Put its client id in the GitHub `production` environment as `TAKATAK_OAUTH_CLIENT_ID` (variable or secret; it is not a secret), with `PUBLIC_URL=https://r2nette.ca`, then run **Server setup** and deploy.
- takatak-v1: the login page's "Create an account" link must keep `?next=` so a visitor without a TAKATAK account returns to the consent screen after sign-up (branch `claude/email-signup-transfer`).
