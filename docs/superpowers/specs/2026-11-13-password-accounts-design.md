# Password accounts on r2nette.ca — design (short)

Date: 2026-11-13 · Author: Claude (Anthropic) · Status: approved by the owner in chat on 2026-11-13
(scope choice: "Build it: profile, addresses, payments").

## Intent and why

The owner wants customers to be able to sign in with an email and a password, not only with an emailed code or
Google, and wants TAKATAK — the main data hub — to keep the customer data. Why: customers who come back should not
have to wait for an email every time (the TAKATAK code email also still reads "TAKATAK", which the owner wants gone
from r2nette's customer experience; a password sign-in sends no email at all).

## What the owner asked for (their words, in short)

`/login` has two tabs, **Sign in** and **Sign up**.

- **Sign up**: Google, or email → code → **create a password and confirm it** → the « Autoriser l'accès » card →
  back to the page the customer left, signed in.
- **Sign in** (has an account): email + password, or Google.
- Checked in a real browser. TAKATAK also stores the data.

## Goals

1. Two tabs on `/login` (FR/EN), phone and desktop, keyboard and screen-reader friendly.
2. Password sign-in, sign-up with a password, and a way back in for existing customers who have no password yet
   or forgot it (email code, then a new password).
3. The authorization card stays on **every** sign-in (decision 22), then the customer returns to `returnTo`.
4. Customer data reaches TAKATAK through the existing signed outbox (profile, addresses, payment summaries).

## Non-goals

- Bookings as a new TAKATAK event (the owner chose the narrower scope; it also needs a TAKATAK release).
- A password form on takatak.ca (takatak-v1 stays email-code/Google; the same hub password would work there once
  that site adds a form).
- "Change password" inside the account page (r2nette does not keep the hub session; the reset flow covers it).
- Changing hub (Supabase) settings, including the code-email wording.

## Anti-goals (a failure even if it "works")

- r2nette stores, logs or sends a password anywhere other than the one call to the hub. No password hash in the
  r2nette database, no password in logs, errors, analytics, the outbox or the cookie jar after the step.
- A sign-in error that tells an attacker whether an email has an account.
- Existing customers losing access.
- A password step that can be skipped by going to the callback or the consent route directly.

## Constraints found

- The hub is Supabase Auth, email provider **on**, password grant works (probed 2026-11-12 with a made-up account).
- **Hub password policy (observed):** at least **12 characters** and at least one lower-case letter, one upper-case
  letter, one digit and one symbol from `!@#$%^&*()_+-=[]{};'\:"|<>?,./`~`. r2nette must show and enforce the same
  rules so the customer never meets an unexplained hub error. Upper bound 72 bytes (bcrypt).
- Every hub call leaves from r2nette's server IP, so the hub's per-IP limits are shared by all r2nette customers.
  r2nette keeps its own per-email and per-IP limits in front of the hub (existing pattern).
- The code email wording is a hub setting (docs/HUB_EMAIL_PASTE.md); this feature does not change it.

## Approaches considered

| | Where the password lives | Trade-offs |
|---|---|---|
| **A (chosen)** | In the TAKATAK hub (Supabase Auth); r2nette calls `PUT /user` to set it and `POST /token?grant_type=password` to check it | One password for every TAKATAK site; nothing secret stored in r2nette; reuses the hub's hashing, lockout and policy. Cost: bound by the hub's strict policy and per-IP limits |
| B | In r2nette (own hash column, own reset email) | Own policy and wording. Cost: r2nette has no mail sender yet (email adapter off), a second password store to defend, and TAKATAK is no longer the master of the account |
| C | No password; keep code/Google only (maybe passkeys later) | Least to defend. Does not give the owner what was asked |

A fits "TAKATAK is our main hub" and decisions 19–22.

## Design (A)

Pages and states on `web/email.html`: tabs `Se connecter | Créer un compte`; steps `choose`, `code`,
`password` (new), `consent` (existing). `?tab=signup` and `?step=password` are honoured.

Server (`src/api/takatak-signin.ts`, `src/identity/takatak-oauth.ts`), new or changed routes under
`/api/v1/auth/takatak`:

| Route | Purpose |
|---|---|
| `POST /email/verify {…, intent}` | `intent` `signin` (default, unchanged) goes to the card; `signup` and `reset` stop at the password step |
| `GET /google/start?intent=` | the intent rides in the flow cookie; a `signup` Google return stops at the password step |
| `GET /password/status` | tells the page whether a password step is waiting (and for which email) |
| `POST /password/set {password, confirm}` | validates the policy, `PUT /user` at the hub with the held session, then opens the authorization (the card) |
| `POST /password/login {email, password, returnTo, locale, terms}` | `POST /token?grant_type=password` at the hub, then the card |

The password step holds the hub session in the existing encrypted httpOnly handoff cookie with a `stage` marker.
`GET/POST /consent` refuse a handoff that is still in the password stage.

Policy lives in one shared pure module (`src/shared/password-policy.ts`) used by the server and the page.

Sign-in failure is always the same `INVALID_CREDENTIALS` (401), counted per email and per IP.

## Data to TAKATAK

No new events. Sign-up creates the customer through the existing callback, which already queues
`CUSTOMER_REGISTERED` / `PROFILE_UPDATED` (and addresses and payment summaries as they change) in the signed
outbox. The bridge never carries passwords. Delivery is off until the owner enables `TAKATAK_R2NETTE_SYNC_ENABLED`
with the shared signing secret on both sides; that is an owner step and is documented, not done here.

## Tests and proof

Unit tests for the policy and the provider; route tests with a fake provider (set password, wrong password,
weak password, stage guard, no enumeration, limits); a local hub stand-in that enforces the real policy; a real
browser run (phone and desktop, FR and EN): sign up by email, sign up by Google, sign in by password, wrong
password, mismatch, weak password, forgot password, every step returning to the page left. A live check follows
the merge, with a clearly labelled test address.

## Left to the builder (my calls)

Wording, the password checklist and a "suggest a strong password" button, show/hide toggle, exact limits
(5 failures per email per 15 minutes, existing per-IP window), and the `stage` field name.
