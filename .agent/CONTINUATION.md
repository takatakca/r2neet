# R2NETTE — Agent Continuation

Last updated: 2026-10-14
Active branch: `codex/r2nette-takatak-outbox-20261013`
Active PR: #18
Target: `main`

## Mission

Finish R2NETTE as a production-grade booking and cleaning-service platform. Continue existing code; do not rebuild from zero. Customer booking experience is the current priority, while preserving the existing authoritative booking/pricing/payment backend.

## Current production baseline

- Production domain: `https://r2nette.ca`
- Last previously verified production commit before PR #18: `319bce3e0aecc22c29374a76cda236a96fcffdcc`
- Deployment model: push/merge to `main` -> CI -> automatic immutable Docker deploy to Contabo -> migration -> healthcheck/rollback.
- TAKATAK public site must not be auto-deployed from this project.

## Completed in PR #18

### TAKATAK bridge
- Durable PostgreSQL outbox model and additive migration.
- Transactional profile/address/payment event queueing.
- HMAC-signed delivery with retry/backoff/idempotence.
- Scheduler worker and worker-health integration.
- Existing-data idempotent backfill command.
- Production env plumbing and fail-closed config validation.
- R2NETTE -> TAKATAK sync remains disabled until the TAKATAK receiver is approved/deployed.
- Matching TAKATAK receiver PR: takatakca/takatak-v1#175. Do not merge/deploy TAKATAK from this R2NETTE session.

### Booking customer experience
- Premium booking introduction and trust assurances.
- Four-phase sticky progress navigation.
- Guided booking stage header with live step counter/context.
- Premium service cards and clearer crew/duration metadata.
- Improved property-selection cards.
- Improved frequency cards.
- Professional address selection and chosen-address state.
- Stronger real-availability day/time presentation.
- Premium details/contact fields with privacy reassurance.
- Premium checkout trust/protection messaging.
- Improved confirmation layout.
- Desktop sticky price ledger and stronger mobile price/navigation treatment.
- Bilingual EN/FR copy added for all new booking UI.

## Latest commits on active branch

- `29343ec3bab6c13081cbb27a6070ee85705b6ed4` — improve service/property choice clarity
- `9c51a181bde44f23f4dc802cc2ac6855f57bf830` — refine booking selection cards
- `14fe5ba65c47076e3a5d141f2303f2df7fa0df8a` — details/checkout bilingual copy
- `9c34b3cb39e439faebc691173492b04dd9a3e323` — polish booking details/availability/checkout
- `2c512e250d777b17e73628670632d7ea7074678f` — live guided booking stage
- `ed96db96b20a9cbc35b0c8ac958f4c378a216977` — booking experience translations
- `0a6379e60a159c597c519acc6f37da584ca74417` — premium booking shell

## Verification state

Before the latest booking-UI commits, PR #18 CI run #60 was fully green:
- TypeScript + production build
- Docker build/start
- migrations from an empty PostgreSQL database
- Prisma schema/migration parity
- full test suite + business invariants
- safety/security invariants

The newest UI commits should continue through the normal repository CI after push/merge. Do not disable production safety, migration, secret or deployment gates.

## Operational booking context completion

- Corrected the data model: Airbnb/Vrbo is now a short-term-rental attribute, not a property type.
- Booking contact name/email is saved to the real customer profile before checkout.
- Visit-specific property context is persisted on the Booking row in `serviceDetails`.
- Service notes are persisted for the assigned team; UI explicitly warns customers not to enter alarm/door codes.
- Returning-customer "usual clean" reuses only safe property context and never reuses old service notes.
- If an old booking lacks a reusable property/address, the shortcut asks only for the missing information.
- Assigned crew receives the property context/service notes through its scoped jobs endpoint.
- Confirmation shows the persisted property context.

## Server-driven booking catalogue completion

- Removed hardcoded $12/$15 product pricing from the browser.
- Public booking catalogue now exposes each service's allowed product options and the authoritative product amounts from server configuration.
- Product selection only shows options the selected service actually permits.
- Stale product selections are cleared when incompatible with a newly selected service.
- Removed hardcoded 10%/15%/25% frequency display values from the browser.
- Frequency savings now come from server `FREQUENCY_RULES`; the highest allowed discount is highlighted automatically.
- Live booking summary uses the selected server product name.
- Final quote/taxes remain server-authoritative as before.

## Latest booking completion

- Connected the existing ADD_ONS backend catalogue to the public booking catalogue.
- Added optional extras selection directly under frequency to avoid an unnecessary extra booking step.
- Extra prices come from the server catalogue; totals/taxes remain authoritative server quote output.
- Quantity controls respect each add-on's backend max quantity.
- Selected extras are persisted as non-sensitive draft state and shown in the live booking summary.

## Current active task

Booking UX phase 2 is now active after PR #18 merged to main. Live booking summary surfaces were added on desktop and mobile so customers can always see and edit the service, property, frequency/products, address and time they selected.

Priority order:
1. Service selection clarity and premium presentation.
2. Property/details selection and reduction of unnecessary effort.
3. Products/frequency choice and savings clarity.
4. Address and availability experience.
5. Customer details and payment/confirmation trust.
6. Responsive/mobile pass.
7. Production deploy verification on `r2nette.ca`.
8. Continue visual/UX refinement from real production observations without replacing the working booking state machine.

## After merge/deploy

Verify:
- `/healthz` 200
- `/readyz` 200
- live homepage and `/#book`
- booking phase navigation on desktop/mobile
- service cards and price ledger
- address selection
- live availability
- details/checkout rendering
- deployed commit SHA
- no TAKATAK sync activation until PR #175 is separately approved/deployed/configured

## External/manual blockers still known

- TAKATAK Supabase Phone Auth / Twilio SMS provider must be confirmed in the TAKATAK Supabase project.
- Google consent screen / callback configuration must be confirmed for full production Google sign-in.
- Optional production integrations remain provider-config dependent: Stripe live payment, Twilio Voice, Maps/dispatch origin, off-host backup, alert webhook.
- TAKATAK R2NETTE sync needs dedicated receiver environment values on both sides after TAKATAK PR #175 is approved.

## Rules for next agent

- Read `AGENTS.md`, `WORKLOG.md`, this file and open PRs first.
- Continue PR #18 or main after it merges. Do not duplicate this work.
- Keep GitHub as source of truth.
- Do not expose secrets.
- Do not weaken tenant/auth/payment/data protections for speed.
- Keep the client experience simple, premium and bilingual.
