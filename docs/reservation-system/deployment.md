# Deployment and operations

## Before the first public request

```bash
NODE_ENV=production
DATABASE_URL=postgresql://…          # not the test database
PRISMA_DATABASE_URL=$DATABASE_URL
TRUST_PROXY=true                     # required for HTTPS detection
STRIPE_SECRET_KEY=sk_live_…
STRIPE_PUBLISHABLE_KEY=pk_live_…
STRIPE_WEBHOOK_SECRET=whsec_…
```

The app **refuses to start** in production if `ADMIN_TOKEN` is still set, if
`TEST_DATABASE_URL` equals `DATABASE_URL`, or if a Stripe key is present
without a webhook secret — a payment that can never confirm is worse than no
payment at all. Stripe test keys in production produce a loud warning but do
not block startup.

## Security headers

Every response carries a CSP with **no `unsafe-inline` and no `unsafe-eval`
for scripts**. That is the directive that actually stops injected script, and
the bundles are external files specifically so it can stay strict. Inline
style is allowed because each page ships one `<style>` block.

`frame-ancestors 'none'` and `X-Frame-Options: DENY` mean the booking flow
cannot be framed. Camera, microphone and location are denied outright.
`X-Powered-By` is removed — never advertise the stack.

HSTS is sent only in production, since it is meaningless over http and
painful to undo if set on a domain that is not yet TLS-only.

## HTTPS

`REQUIRE_HTTPS` (default on in production) redirects insecure GETs with 308.
An insecure **POST is refused with 403, never redirected** — a redirect drops
the body, so the customer would see a silent failure.

## Rate limiting

Applied per client and per route class, because an SMS costs money and a page
view does not:

| Class | Window | Max |
|---|---|---|
| `otp` — phone verification | 1 hour | 15 |
| `auth` — staff login, password change | 15 min | 20 |
| `payment` | 15 min | 30 |
| `booking` — writes | 15 min | 40 |
| `read` | 1 min | 240 |

The Stripe webhook is **never** limited: it is signature-verified, and
dropping it for volume would lose payment confirmations.

429 responses carry `Retry-After` and a plain message that does not disclose
the exact budget.

This is in-process, so it protects one instance. **Put a limiter at the edge
as well.** The app-level one exists so a misconfigured proxy is not the only
thing standing between you and a hammering.

## Logging

One JSON line per request with a stable `X-Request-Id`, echoed to the client
so a customer can quote it. Query strings are never logged — only the path —
because identifiers end up in them.

`redact()` removes passwords, OTP codes, tokens, client secrets, emails and
phone numbers at any nesting depth, and strips anything shaped like a card
number or a phone from free text.

## Health checks

- `GET /healthz` — liveness. **Does not touch the database.** Restarting the
  app because Postgres blipped turns a blip into an outage.
- `GET /readyz` — readiness. Pings the database and returns 503 while
  draining, so a load balancer stops sending traffic before shutdown.

Point the orchestrator's liveness probe at `/healthz` and its readiness probe
at `/readyz`. Never the other way round.

## Graceful shutdown

On SIGTERM the process fails readiness, waits ~5s for the load balancer to
notice, stops accepting connections, lets in-flight requests finish, closes
the database pool, and exits. A 25-second hard timeout prevents a hung
shutdown from blocking a deploy.

`uncaughtException` triggers the same drain: a process in an unknown state
must not keep serving.

## Backups

Nothing in this repository backs up your data. Before taking real bookings:

```bash
pg_dump "$DATABASE_URL" --format=custom --file=r2nette-$(date +%F).dump
```

Automate it daily, store it off the database host, and **restore it into a
scratch database at least once** — an untested backup is a guess.

Booking numbers, price snapshots and promotion claims are all in Postgres.
Losing it loses the business record; Stripe holds only the payment side.

## Still not built

- Second factor for OWNER accounts
- Automated backup scheduling and restore verification
- An error-tracking service (only structured logs today)
- Log shipping and retention
