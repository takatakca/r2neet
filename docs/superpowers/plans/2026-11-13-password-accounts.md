# Password accounts on r2nette.ca — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/login` gets Sign in / Sign up tabs; customers sign in with email + password or Google, and sign up with Google or email code, then create a password, then see the « Autoriser l'accès » card and return to the page they left.

**Architecture:** The password lives only in the TAKATAK hub (Supabase Auth). r2nette sets it with `PUT /auth/v1/user` using the hub session it already holds after the code or Google step, and checks it with `POST /auth/v1/token?grant_type=password`. The hub session rides in the existing encrypted handoff cookie with a `stage: 'password'` marker; the consent routes refuse that stage. One shared pure policy module is used by server and page.

**Tech Stack:** Express 5 + TypeScript, zod, Vitest + supertest, Vite page scripts (`web/`), Playwright for the real-browser run, a local hub stand-in.

**Spec:** `docs/superpowers/specs/2026-11-13-password-accounts-design.md`

## Global Constraints

- Password policy (hub, observed 2026-11-12): ≥ **12** characters; at least one lower-case, one upper-case, one digit, one symbol from `!@#$%^&*()_+-=[]{};'\:"|<>?,./`~`; ≤ **72 bytes** (UTF-8).
- Passwords are never trimmed, normalised, logged, stored, put in a cookie, or sent anywhere but the hub call.
- Sign-in failure is always `INVALID_CREDENTIALS` (401) with the same message for unknown and known emails.
- Limits: 5 failed password sign-ins per email per 15 minutes (429 after); existing per-IP `checksPerIp` (30/hour) applies; the password-stage cookie lives `TTL_MS` (10 minutes).
- The authorization card is shown after every sign-in route (decision 22); `returnTo` goes through `safeReturn`.
- Copy is FR and EN. Style follows `BRAND.md` (electric blue on deep navy; green only for status).
- No new database column and no new outbox event.

## Review Focus

- A password longer than 72 **bytes** but shorter than 72 characters (emoji, accents) is refused as too long (test in Task 1).
- A password with leading/trailing spaces is accepted and sent exactly as typed (Task 4).
- Submitting the password step twice, or after the card started, answers 410 and never a 500 (Task 4).
- Calling `/consent` or the callback while still in the password stage is refused with 409 (Task 4).
- A wrong password for an unknown email and for a known one look identical, and the 6th failure in 15 minutes is 429 (Task 4).

---

### Task 1: Shared password policy

**Files:**
- Create: `src/shared/password-policy.ts`
- Test: `tests/password-policy.test.ts`

**Interfaces:**
- Produces: `PASSWORD_MIN_LENGTH = 12`, `PASSWORD_MAX_BYTES = 72`, `type PasswordProblem = 'length' | 'lower' | 'upper' | 'digit' | 'symbol' | 'too-long' | 'email'`, `passwordProblems(password: string, email?: string | null): PasswordProblem[]` (empty = acceptable), `suggestPassword(length?: number): string` (default 16, uses `globalThis.crypto.getRandomValues`, always passes `passwordProblems`).

- [ ] **Step 1: Write the failing tests** — `passwordProblems('Abcdef1!ghijk')` is `[]`; `'short1A!'` has `['length']`; one case per missing class (`'abcdefghijk1!'` → `['upper']` …); `'é'.repeat(40) + 'Aa1!'` has `'too-long'` (≥ 73 bytes, < 73 characters); a password containing the email local part (≥ 4 chars, case-insensitive) has `'email'`; `suggestPassword()` 300 times always returns `[]` problems and length 16, and two calls differ.
- [ ] **Step 2: Run** `npx vitest run tests/password-policy.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the module (signature above). Count length in code points (`[...password].length`) and bytes with `new TextEncoder()`.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `git add src/shared tests/password-policy.test.ts && git commit -m "Password policy shared by server and page"`.

### Task 2: Hub provider — set and check a password

**Files:**
- Modify: `src/identity/takatak-oauth.ts` (interface `TakatakOAuthProvider` and class `SupabaseTakatakOAuthProvider`)
- Test: `tests/takatak-signin-provider.test.ts`

**Interfaces:**
- Produces: `signInWithPassword(email: string, password: string): Promise<HubSession>` and `setPassword(accessToken: string, password: string): Promise<void>` on the interface and the class.
- Errors (all `IdentityError`): `INVALID_CREDENTIALS` (hub 400/401, or user not email-confirmed), `PASSWORD_PROVIDER_LIMIT` (429), `WEAK_PASSWORD` (hub 422 `weak_password`), `PASSWORD_UNCHANGED` (hub 422 `same_password`), `CONSENT_EXPIRED` (hub 401/403 on `PUT /user`).

- [ ] **Step 1: Write failing tests** with the existing `fakeFetch` helper: sign-in posts `{email,password}` to `/token?grant_type=password` and returns the session; `400 invalid_credentials` → `INVALID_CREDENTIALS`; 429 → `PASSWORD_PROVIDER_LIMIT`; 5xx → the existing unavailable error; `setPassword` sends `PUT /user` with `{password}` and the bearer token, resolves on 200; 422 bodies `weak_password` / `same_password` map as above; 401 → `CONSENT_EXPIRED`; the password never appears in any thrown error message.
- [ ] **Step 2: Run** `npx vitest run tests/takatak-signin-provider.test.ts` — Expected: FAIL (methods missing).
- [ ] **Step 3: Implement** both methods with the existing `this.hub()` and `this.hubHeaders(token)` helpers and `sessionFrom()`. Require `user.email_confirmed_at` on sign-in like `verifyEmailCode` does.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "Hub provider: sign in with and set a password"`.

### Task 3: Flow cookies carry the stage and the intent

**Files:**
- Modify: `src/api/takatak-consent-cookie.ts`, `src/api/takatak-shared.ts`
- Test: `tests/takatak-consent-cookie.test.ts`

**Interfaces:**
- Produces: `ConsentHandoff.stage?: 'password'` (encoded as `st`; `authorizationId` may be `''` only when `stage === 'password'`); `Pending.intent: 'signin' | 'signup' | 'reset'` (optional on read, default `'signin'`); `newPending({…, intent?})`.

- [ ] **Step 1: Write failing tests** — a `stage:'password'` handoff with empty `authorizationId` round-trips; an empty `authorizationId` without the stage is still rejected; an unknown stage is dropped; `readPending` accepts a cookie without `intent` (old cookies) as `'signin'` and rejects an unknown intent.
- [ ] **Step 2: Run** `npx vitest run tests/takatak-consent-cookie.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the cookie and pending changes; keep `MAX_CONSENT_COOKIE_BYTES` checks.
- [ ] **Step 4: Run** the file again — Expected: PASS. Run `npx vitest run tests/takatak-signin.test.ts` — Expected: still PASS.
- [ ] **Step 5: Commit** `git commit -am "Flow cookies: password stage and sign-in intent"`.

### Task 4: Routes — password stage, set, and sign-in

**Files:**
- Modify: `src/api/takatak-signin.ts`
- Test: `tests/takatak-signin.test.ts` (extend `setup()`'s fake provider with `signInWithPassword` and `setPassword` mocks)

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces (under `/api/v1/auth/takatak`): `POST /email/verify` accepts `intent` (`signin` default | `signup` | `reset`) and for the last two answers `{ password: true, email }`; `GET /google/start?intent=`; Google callback for a non-`signin` intent redirects to `/login?step=password[&returnTo=…]`; `GET /password/status` → `{ email }` or 410; `POST /password/set { password, confirm }` → `{ consent: true }`; `POST /password/login { email, password, locale, terms, returnTo? }` → `{ consent: true }`.
- Errors: `PASSWORD_MISMATCH` 400, `WEAK_PASSWORD` 400, `PASSWORD_UNCHANGED` 400, `INVALID_CREDENTIALS` 401, `PASSWORD_REQUIRED` 409 (consent routes in the password stage), `CONSENT_EXPIRED` 410 (no stage / expired / already used).

- [ ] **Step 1: Write failing tests** (names are the assertions):
  - `signup verify stops at the password step`: response `{password:true,email}`, `provider.setPassword` not called, `GET consent` → 409 `PASSWORD_REQUIRED`.
  - `set refuses a mismatch and a weak password without calling the hub` (400 `PASSWORD_MISMATCH` / `WEAK_PASSWORD`; handoff kept so a retry works).
  - `set sets the password at the hub, then shows the card, then Autoriser signs in and returns to returnTo` (full path through `consent` approve and the callback; `provider.setPassword` called once with `('hub-at', password)`).
  - `a password with leading and trailing spaces is sent exactly as typed`.
  - `set without a stage, or a second time, is 410 and never 500`.
  - `no cookie or response contains the password` (assert on `jar.header()` and the JSON bodies).
  - `google signup returns to the password step, google signin goes straight to the card`.
  - `password login: success → card; wrong password → 401 INVALID_CREDENTIALS with the same body for an unknown and a known email; the 6th failure within 15 minutes → 429; a success clears the count; per-IP limit applies`.
  - `a forged returnTo is replaced by the default on every new route`.
- [ ] **Step 2: Run** `npx vitest run tests/takatak-signin.test.ts` — Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the routes. Add `intent` to `verifySchema`; add a small `AttemptWindow(limit, windowMs, clock)` class (take/record/clear) for password failures; reuse `beginConsent`, `safeReturn`, `checksPerIp`, `consentPerIp`; map the new codes in `toApiError`. In the password stage write a `newPending` (returnTo, locale, terms) **and** the handoff with `stage: 'password'`; `password/set` reads both, then calls `beginConsent`.
- [ ] **Step 4: Run** the file and `npx tsc --noEmit` — Expected: PASS, no type errors.
- [ ] **Step 5: Commit** `git commit -am "Sign-in routes: password stage, set password, password sign-in"`.

### Task 5: The page — tabs and password screens

**Files:**
- Modify: `web/email.html`, `web/src/lib/email-entry.ts`, `web/public/experience.css`
- Test: `tests/safe-path.test.ts` stays green; behaviour proven in Task 6.

**Interfaces:**
- Consumes: Task 1 (`passwordProblems`, `suggestPassword` imported from `../../../src/shared/password-policy.js`), Task 4 routes.
- Produces (element ids the browser run uses): tabs `tabSignin`, `tabSignup` (`role="tab"`, `aria-selected`); sign-in form `loginForm` with `loginEmail`, `loginPassword`, `loginSubmit`, link `forgot`; sign-up uses `emailForm`/`email`/`send`; `codeForm`; password step `passwordForm` with `newPassword`, `confirmPassword`, `savePassword`, `suggest`, `rules` (one `li` per rule with `data-rule`), `togglePassword`; Google buttons keep `googleButton`. URL: `?tab=signup`, `?step=password`.

- [ ] **Step 1: Implement the markup** — tabs; sign-in panel (email + password with `autocomplete="username"`/`"current-password"`, Google, « Première connexion ou mot de passe oublié ? »); sign-up panel (Google, email → code); password step (two fields `autocomplete="new-password"`, live checklist, match line, show/hide, « Suggérer un mot de passe »). Rewrite the intro copy (no more « Aucun mot de passe »).
- [ ] **Step 2: Implement the logic** in `email-entry.ts`: mode state (`signin|signup|reset`), tab switching (updates `?tab=`), `send` and `verify` carry `intent`, `{password:true}` shows the password step, `?step=password` calls `GET /password/status` (410 → message and back to the tabs), `password/set` and `password/login` call then `openConsent()`, error texts FR/EN for every code in Task 4, Google link carries `intent`, `leaveIfSignedIn` unchanged.
- [ ] **Step 3: Style** the tabs, checklist (✓ green status colour only, ✗ muted) and fields at 320–1280 px.
- [ ] **Step 4: Verify** `npx tsc --noEmit && npm run build` — Expected: both succeed.
- [ ] **Step 5: Commit** `git commit -am "Login page: sign in / sign up tabs and password screens"`.

### Task 6: Stand-in hub with the real policy, and the real-browser run

**Files:**
- Create: `scripts/dev/hub-stub.cjs` (extends the earlier stand-in: `PUT /auth/v1/user`, `POST /auth/v1/token?grant_type=password`, the exact policy above, per-user password memory, `/__approve`), `scripts/dev/signin-browser-check.cjs`
- Modify: `RUN.md` (one paragraph: how to run both)

- [ ] **Step 1: Write the stand-in** and start it with the local server (env as in `docs/TAKATAK_INTEGRATION.md`).
- [ ] **Step 2: Write the browser run** (phone 390 FR and desktop 1280 EN) asserting: tabs switch and are keyboard reachable; sign up by email → code → password step shows the checklist, mismatch and weak errors, valid password → card → back to the page left; sign up by Google → password step → card; sign in by password → card → back; wrong password message; forgot password (code → new password) then password sign-in with the new one; a previously code-only customer can still get in; no horizontal overflow; no page errors.
- [ ] **Step 3: Run** `node scripts/dev/signin-browser-check.cjs` — Expected: `all checks passed`; also rerun the 30-step flow and account runs from the earlier session (regression).
- [ ] **Step 4: Commit** `git add scripts/dev RUN.md && git commit -m "Dev tools: hub stand-in with the real password policy and a browser run"`.

### Task 7: Documents, full suite, pull request

**Files:**
- Modify: `docs/TAKATAK_INTEGRATION.md` (flow, hub policy, data-to-TAKATAK status and the owner steps to enable it), `docs/DECISIONS.md` (decision 23), `docs/AGENT_HANDOFF.md`, `WORKLOG.md`

- [ ] **Step 1:** Write the documents (decision 23: password lives in the hub; why not r2nette; policy; owner steps to enable the sync: `TAKATAK_R2NETTE_SYNC_ENABLED`, signing secret on both sides, run `npm run sync:takatak-backfill` once).
- [ ] **Step 2: Run** `npx tsc --noEmit && npx vitest run && npm run test:invariants && npm run build` — Expected: all green.
- [ ] **Step 3:** Push `claude/password-accounts`, open the PR with Why / What / Tests; subscribe to its activity.

### Task 8: After the owner merges — live check

- [ ] Run the live sign-up with a clearly labelled test address on the owner's mailbox (`takatak.ca+r2test<date>@gmail.com`), read the code with the mailbox tool, set a generated password, sign out, sign in by password, then report; note the test account in the work log.
