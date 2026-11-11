# TAKATAK embedded sign-in on r2nette.ca — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a customer sign in or sign up on r2nette.ca with an email code or Google, with the account kept in the TAKATAK hub and TAKATAK's "Autoriser l'accès" consent shown on r2nette.ca, without ever visiting takatak.ca.

**Architecture:** R2NETTE's server talks to the TAKATAK Supabase hub for the code (or the Google PKCE exchange), obtains the user's hub session, opens the R2NETTE OAuth authorization itself, shows the consent data to the page, approves on the user's behalf, and hands the hub's `redirect_url` to the browser so the **existing** `/api/v1/auth/takatak/callback` finishes the sign-in unchanged. New code: shared helpers extracted from the current router, eight provider calls, an encrypted consent cookie, one new router, one rewritten page.

**Tech Stack:** Express 5 + TypeScript (`src/api`, `src/identity`), Vitest + supertest, Vite page (`web/email.html` + `web/src/lib/email-entry.ts`), Playwright for the browser check, AES-GCM helpers in `src/auth/encryption.ts`.

**Spec:** `docs/superpowers/specs/2026-11-11-takatak-embedded-signin-design.md`

## Global Constraints

- Hub endpoints are built from `TAKATAK_SUPABASE_URL` + `/auth/v1`; every hub request carries `apikey: <TAKATAK_SUPABASE_ANON_KEY>` and a 10 s `AbortSignal.timeout`.
- OAuth client id comes from `TAKATAK_OAUTH_CLIENT_ID`; scope is exactly `openid email profile phone`; PKCE `S256`; callback path `/api/v1/auth/takatak/callback`.
- Authorization ids match `/^[a-z2-7]{32}$/`; the consent page host must be `takatak.ca` or the issuer host.
- Cookies: httpOnly, `secure` when `NODE_ENV === 'production'`, `sameSite: 'lax'`, 10 minutes (`TTL_MS = 600_000`), paths: pending `/api/v1/auth/takatak`, consent `/api/v1/auth/takatak`, google `/api/v1/auth/takatak/google`.
- JSON routes: reject when `sec-fetch-site` is `cross-site` or the body is not `application/json` (403 `REQUEST_REJECTED`, as `email-first.ts`); `Cache-Control: no-store`; `Referrer-Policy: no-referrer`.
- Emails are trimmed and lower-cased before any use; codes match `/^\d{6,10}$/`.
- Error codes: `TAKATAK_AUTH_UNAVAILABLE` (503), `EMAIL_CODE_INVALID` (401), `OTP_COOLDOWN`/`OTP_PHONE_LIMIT`/`OTP_IP_LIMIT`/`OTP_ATTEMPT_LIMIT`/`OTP_PROVIDER_LIMIT` (429), `CONSENT_EXPIRED` (410), `CONSENT_INVALID` (502), `GOOGLE_AUTH_NOT_CONFIGURED` (503).
- Copy is bilingual FR/EN; brand per `BRAND.md` (deep navy `#060d1f`/`#0a2547`, electric blue `#1f8bff`).
- No new environment variables, no database migration.
- Commits end with the session's attribution lines; the work log line in `WORKLOG.md` is updated before stopping.

## Review Focus

1. Email typed as `  Marie@Example.CA ` must send and verify as `marie@example.ca` (hub lower-cases); test in Task 4.
2. A code with spaces or letters (`12 34 56`, `abc123`) must be refused by the server with `VALIDATION_ERROR`, never forwarded to the hub; test in Task 4.
3. Double-tap on **Autoriser** (two POSTs): the second must answer 410 `CONSENT_EXPIRED` because the cookie was cleared by the first, and nothing else happens; test in Task 4.
4. Hub details whose `user.id` differs from the session's `subject` must be refused as `CONSENT_INVALID` (same guard as takatak.ca); test in Task 2.
5. A hub `redirect_url` on our callback but with a different `state` must be refused (502 `CONSENT_INVALID`) so a forged approval cannot complete a sign-in; test in Task 4.

---

### Task 1: Extract shared TAKATAK helpers (refactor, no behaviour change)

**Files:**
- Create: `src/api/takatak-shared.ts`
- Modify: `src/api/takatak-oauth.ts` (remove the moved pieces, import them)
- Test: existing `tests/takatak-oauth.test.ts`, `tests/takatak-oauth-db.test.ts`

**Interfaces:**
- Produces, in `src/api/takatak-shared.ts`:
  - `export const TAKATAK_OAUTH_COOKIE = 'r2n_takatak_oauth'`, `COOKIE_PATH = '/api/v1/auth/takatak'`, `CALLBACK_PATH = '/api/v1/auth/takatak/callback'`, `TTL_MS = 600_000`, `DEFAULT_RETURN = '/#book'`
  - `export interface Pending { v: 1; state: string; verifier: string; returnTo: string; locale: 'fr' | 'en'; terms: boolean; link: string | null; createdAt: number }`
  - `export function readPending(raw: unknown, now: number): Pending | null` (moved as is)
  - `export function newPending(input: { returnTo: string; locale: 'fr' | 'en'; terms: boolean; link: string | null; now: number }): Pending` (random `state` and `verifier`, 32 bytes base64url each)
  - `export function challengeOf(verifier: string): string` (sha256, base64url)
  - `export function writePending(res: Response, pending: Pending, secure: boolean): void` and `export function clearPending(res: Response): void`
  - `export function publicOrigin(publicUrl: string | undefined): string | null` (today's `origin()` body)
  - `export function safeReturn(value: unknown, base: string): string` (moved as is)
  - `export function backToLogin(res: Response, reason: string, returnTo?: string, path?: string): void` (moved as is)
  - `export function sameSecret(a: string, b: string): boolean` (moved as is)
  - `export class Stop extends Error { constructor(readonly reason: string) }` (moved as is)

- [ ] **Step 1: Run the current suites to record the baseline**

Run: `npx vitest run tests/takatak-oauth.test.ts tests/takatak-oauth-db.test.ts`
Expected: PASS (17 tests).

- [ ] **Step 2: Create `src/api/takatak-shared.ts` with the exports above, moving code verbatim from `src/api/takatak-oauth.ts:22-67` and `:97-135`**

`newPending` and `writePending` are the body of the `/start` route (`src/api/takatak-oauth.ts:158-180`) split in two; `writePending` sets the cookie with `maxAge: TTL_MS`.

- [ ] **Step 3: Make `src/api/takatak-oauth.ts` import from `./takatak-shared.js` and use `newPending`/`writePending`/`clearPending` in `/start` and `/callback`**

Keep `export { TAKATAK_OAUTH_COOKIE }` re-exported from `takatak-oauth.ts` so existing imports keep working.

- [ ] **Step 4: Run the suites and the type check**

Run: `npx tsc --noEmit && npx vitest run tests/takatak-oauth.test.ts tests/takatak-oauth-db.test.ts`
Expected: tsc clean; PASS 17.

- [ ] **Step 5: Commit**

```bash
git add src/api/takatak-shared.ts src/api/takatak-oauth.ts
git commit -m "refactor(takatak): share pending-cookie and redirect helpers"
```

---

### Task 2: Hub calls in the provider

**Files:**
- Modify: `src/identity/takatak-oauth.ts` (interface at `:19-23`, class `SupabaseTakatakOAuthProvider`)
- Test: `tests/takatak-signin-provider.test.ts` (new)

**Interfaces:**
- Produces (added to `TakatakOAuthProvider` and implemented by `SupabaseTakatakOAuthProvider`):

```ts
export interface HubSession { accessToken: string; subject: string; email: string | null; phone: string | null }
export interface ConsentDetails { authorizationId: string; appName: string; returnAddress: string; account: string; scopes: string[] }
export type AuthorizationView = { kind: 'consent'; details: ConsentDetails } | { kind: 'approved'; redirectUrl: string };

readonly googleConfigured: boolean;                       // configured && anonKey
sendEmailCode(email: string): Promise<void>;              // POST {issuer}/otp {email, create_user:true}
verifyEmailCode(email: string, code: string): Promise<HubSession>; // POST {issuer}/verify {type:'email', email, token:code}
googleAuthorizationUrl(input: { redirectUri: string; challenge: string; state: string }): string; // {issuer}/authorize?provider=google&redirect_to&state&code_challenge&code_challenge_method=s256
exchangeGoogleCode(input: { code: string; verifier: string }): Promise<HubSession>; // POST {issuer}/token?grant_type=pkce {auth_code, code_verifier}
beginAuthorization(input: { redirectUri: string; challenge: string; state: string; locale: 'fr'|'en' }): Promise<string>; // authorization id
authorizationDetails(input: { authorizationId: string; accessToken: string; subject: string; locale: 'fr'|'en' }): Promise<AuthorizationView>;
decideConsent(input: { authorizationId: string; accessToken: string; decision: 'approve'|'deny' }): Promise<string>; // redirect_url
revokeSession(accessToken: string): Promise<void>;        // POST {issuer}/logout?scope=local; never throws
```
- `export function consentScopeText(scope: string, locale: 'fr'|'en'): string[]` with exactly: `openid` → "Confirmer que vous êtes connecté à TAKATAK" / "Confirm that you are signed in to TAKATAK"; `email` → "Voir votre adresse courriel" / "See your email address"; `profile` → "Voir votre nom et votre profil" / "See your name and profile"; `phone` → "Voir votre numéro de téléphone" / "See your phone number"; `offline_access` → "Rester connecté après avoir fermé l’application" / "Stay connected after you close the application"; unknown → `Accès « x »` / `Access “x”`.
- Error mapping: network/5xx → `IdentityError('…', 'TAKATAK_AUTH_UNAVAILABLE')`; `/verify` 4xx → `'EMAIL_CODE_INVALID'`; `/otp` or `/verify` 429 → `'OTP_PROVIDER_LIMIT'`; `/token` 4xx → `'GOOGLE_AUTH_DENIED'`; details/consent 4xx or payload mismatch → `'CONSENT_INVALID'`.

- [ ] **Step 1: Write the failing tests in `tests/takatak-signin-provider.test.ts`** (same `env` and fake-`fetch` style as `tests/takatak-oauth.test.ts:249-300`):

```ts
it('sends the email code with create_user and the anon key', …)  // url ends /auth/v1/otp; body {email:'marie@example.ca', create_user:true}; headers apikey
it('verifies the code and returns the hub session only for a confirmed matching email', …)
  // reply {access_token:'at', user:{id:'u1', email:'marie@example.ca', email_confirmed_at:'2026-11-11T00:00:00Z', phone:'15145551212'}} → {accessToken:'at', subject:'u1', email:'marie@example.ca', phone:'+15145551212'}
  // reply with email 'other@example.ca' → rejects EMAIL_CODE_INVALID; 400 → EMAIL_CODE_INVALID; 429 → OTP_PROVIDER_LIMIT; fetch throws → TAKATAK_AUTH_UNAVAILABLE
it('builds the Google authorize url with state and PKCE', …)      // provider=google, redirect_to, state, code_challenge, code_challenge_method=s256
it('exchanges the Google code and requires the google identity', …) // body {auth_code, code_verifier}; user.identities [{provider:'google'}] ok; without → GOOGLE_AUTH_DENIED
it('begins an authorization and reads the id from the consent redirect', …)
  // fetch returns Response(null,{status:302, headers:{location:'https://takatak.ca/oauth/consent?authorization_id=abcdefghijklmnopqrstuvwxyz234567'}}) → 'abcdefghijklmnopqrstuvwxyz234567'
  // location on 'https://evil.example/…' → CONSENT_INVALID; id 'ABC' → CONSENT_INVALID; verifies init.redirect === 'manual'
it('reads consent details, rejects another user, and recognises an already approved request', …)
  // {authorization_id, client:{name:'R2NETTE'}, redirect_uri:CALLBACK, scope:'openid email profile phone', user:{id:'u1', email:'marie@example.ca'}} with subject 'u1' →
  //   {kind:'consent', details:{authorizationId, appName:'R2NETTE', returnAddress:CALLBACK, account:'marie@example.ca', scopes:[4 FR lines]}}
  // same with user.id 'u2' → CONSENT_INVALID; {redirect_url:'https://r2nette.ca/api/v1/auth/takatak/callback?code=x&state=s'} → {kind:'approved', redirectUrl}
it('approves and denies with the user token and returns redirect_url', …) // POST …/authorizations/{id}/consent, Authorization: Bearer at, body {action:'approve'|'deny'}
it('revokes the hub session quietly', …) // POST /logout?scope=local with Bearer; a 500 does not throw
it('maps scopes to the TAKATAK wording in both languages', …)
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/takatak-signin-provider.test.ts`
Expected: FAIL (methods missing).

- [ ] **Step 3: Implement the interface additions and `consentScopeText` in `src/identity/takatak-oauth.ts`**

Reuse `this.issuer`, `this.clientId`, `this.anonKey`, `this.fetcher`, `text()`, `E164`, and `endpoints()` for the authorize URL. `beginAuthorization` calls `authorizationUrl(...)` then `fetch(url, { redirect: 'manual', signal })` and parses `Location`. Account label: `user.email` if it contains `@`, else the session phone, else "Compte TAKATAK connecté" / "Signed-in TAKATAK account".

- [ ] **Step 4: Run the new tests, the existing provider tests and tsc**

Run: `npx tsc --noEmit && npx vitest run tests/takatak-signin-provider.test.ts tests/takatak-oauth.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/identity/takatak-oauth.ts tests/takatak-signin-provider.test.ts
git commit -m "feat(takatak): hub email code, Google exchange and consent calls"
```

---

### Task 3: Encrypted consent cookie

**Files:**
- Create: `src/api/takatak-consent-cookie.ts`
- Test: `tests/takatak-consent-cookie.test.ts` (new)

**Interfaces:**
- Produces:

```ts
export const TAKATAK_CONSENT_COOKIE = 'r2n_takatak_consent';
export interface ConsentHandoff { authorizationId: string; accessToken: string; subject: string; createdAt: number }
export function encodeConsent(h: ConsentHandoff, env?: NodeJS.ProcessEnv): string  // base64url JSON {v:1, id, subject, token: encryptSecret(accessToken, env), createdAt}
export function decodeConsent(raw: unknown, now: number, env?: NodeJS.ProcessEnv): ConsentHandoff | null // null when malformed, wrong version, older than TTL_MS, or decryption fails
export function writeConsentCookie(res: Response, h: ConsentHandoff, secure: boolean, env?: NodeJS.ProcessEnv): void // path COOKIE_PATH, maxAge TTL_MS
export function clearConsentCookie(res: Response): void
```
- Consumes: `encryptSecret`, `decryptSecret`, `encryptionConfigured`, `generateEncryptionKey` from `src/auth/encryption.ts`; `COOKIE_PATH`, `TTL_MS` from Task 1.

- [ ] **Step 1: Write the failing tests** (`env = { FIELD_ENCRYPTION_KEY: generateEncryptionKey() }` as in `tests/totp.test.ts:390`):

```ts
it('round-trips a handoff and never stores the token in clear', …) // encodeConsent → string not containing 'at-secret'; decodeConsent(..., now) deep-equals input
it('rejects a stale, malformed, or foreign-key cookie', …) // createdAt older than 600_000 → null; 'garbage' → null; decode with another key → null
it('refuses to encode without an encryption key', …) // env {} → throws (IdentityError or Error) with message containing 'FIELD_ENCRYPTION_KEY'
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/takatak-consent-cookie.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement `src/api/takatak-consent-cookie.ts`**

- [ ] **Step 4: Run the tests** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/takatak-consent-cookie.ts tests/takatak-consent-cookie.test.ts
git commit -m "feat(takatak): encrypted consent handoff cookie"
```

---

### Task 4: Sign-in router (email, Google, consent) and config

**Files:**
- Create: `src/api/takatak-signin.ts`
- Modify: `src/api/app.ts:469` (mount after `takatakOAuthRoutes`), `src/api/takatak-oauth.ts` config route (add `google`)
- Test: `tests/takatak-signin.test.ts` (new; copy the `setup()` harness from `tests/takatak-oauth.test.ts:16-96`, extend the fake provider with the Task 2 methods as `vi.fn`, and pass `env`-style encryption by setting `process.env.FIELD_ENCRYPTION_KEY = generateEncryptionKey()` in `beforeAll`)

**Interfaces:**
- Produces: `export function takatakSignInRoutes(prisma: PrismaClient, provider: TakatakOAuthProvider, options: { publicUrl?: string; now: () => Date }): Router` mounted at `/api/v1`, with the routes of spec §3.1:
  - `POST /auth/takatak/email/send` body `{email}` → `{ sent: true }`
  - `POST /auth/takatak/email/verify` body `{email, code, locale: 'fr'|'en', terms: boolean}` → `{ consent: true }` | `{ next: string }`
  - `GET /auth/takatak/consent` → `{ app, returnAddress, account, scopes }` | `{ next }` | 410
  - `POST /auth/takatak/consent` body `{decision: 'approve'|'deny'}` → `{ next }`
  - `GET /auth/takatak/google/start?locale&returnTo&terms` → 303 hub Google URL; cookie `r2n_takatak_google` (`{v:1, state, verifier, returnTo, locale, terms, createdAt}` base64url JSON, path `/api/v1/auth/takatak/google`)
  - `GET /auth/takatak/google/callback?code&state` → 303 `/login?consent=1&returnTo=…` | 303 `next` | 303 `/login?takatak=<reason>`
  - `GET /auth/takatak/config` → `{ configured, google }`
- Internal helper `beginConsent(req, res, session: HubSession, input: { returnTo; locale; terms }): Promise<{ consent: true } | { next: string }>` implementing spec §3.3; `acceptRedirect(url: string, base: string, pending: Pending): string | null` returns the url only when `origin+pathname === base + CALLBACK_PATH` and `searchParams.get('state')` equals `pending.state` (timing-safe).
- Consumes: Task 1 helpers, Task 2 provider methods, Task 3 cookie functions, `RateLimiter` from `src/identity/identity.ts` (keys: `sha256(email)` and `req.ip`), `ApiError` from `./app.js`.

- [ ] **Step 1: Write the failing route tests in `tests/takatak-signin.test.ts`:**

```ts
it('sends a code, verifies it, shows consent, approves, and the existing callback signs the new customer in', …)
  // POST send {email:'  Marie@Example.CA '} → 200 {sent:true}; provider.sendEmailCode called with 'marie@example.ca'  (Review Focus 1)
  // POST verify {email, code:'123456', locale:'fr', terms:true} → 200 {consent:true}; set-cookie has r2n_takatak_oauth and r2n_takatak_consent; provider.beginAuthorization called with challenge === sha256(verifier from pending cookie)
  // GET consent with both cookies → 200 {app:'R2NETTE', returnAddress:CALLBACK, account:'marie@example.ca', scopes:[…]}
  // POST consent {decision:'approve'} → 200 {next: `${CALLBACK}?code=abc&state=<pending.state>`}; consent cookie cleared; provider.revokeSession called
  // GET next with the pending cookie → 303 '/#book'; sessions.length === 1; customers[0].emailAuthSubject === 'takatak-user-1'
it('skips the consent screen when the hub reports an earlier approval', …) // authorizationDetails → {kind:'approved'} ⇒ verify answers {next}
it('refuses a redirect_url with another state or another host', …)        // {next} never issued; 502 CONSENT_INVALID; no session   (Review Focus 5)
it('answers 410 when the consent cookie is missing, stale, or already used', …) // GET consent without cookie → 410; after approve, a second POST approve → 410  (Review Focus 3)
it('ends a refusal at /login?takatak=cancelled', …)                         // deny → {next} with error=access_denied → callback 303 '/login?takatak=cancelled'
it('rejects malformed codes and emails before calling the hub', …)        // code '12 34 56' and 'abc123' → 400 VALIDATION_ERROR; provider.verifyEmailCode not called  (Review Focus 2)
it('maps hub errors to the documented codes', …)                           // verify throws EMAIL_CODE_INVALID → 401; OTP_PROVIDER_LIMIT → 429; TAKATAK_AUTH_UNAVAILABLE → 503
it('rate limits sends per email and per ip', …)                            // second send 10 s later → 429 OTP_COOLDOWN (resendCooldownSeconds 30); 6th send in the hour for one email (advance now by 31 s each) → 429 OTP_PHONE_LIMIT (sendsPerPhonePerHour 5); 6th wrong code → 429 OTP_ATTEMPT_LIMIT (checkAttemptsPerPhone 5)
it('rejects cross-site and non-JSON requests', …)                          // sec-fetch-site: cross-site → 403 REQUEST_REJECTED
it('starts Google with PKCE and finishes with the consent step', …)
  // GET google/start?locale=en&returnTo=/account&terms=1 → 303 to provider url with state; cookie r2n_takatak_google
  // GET google/callback?code=g&state=<same> with cookie → provider.exchangeGoogleCode({code:'g', verifier}) → 303 '/login?consent=1&returnTo=%2Faccount'; consent + pending cookies set
  // wrong state → 303 '/login?takatak=expired'; provider error → '/login?takatak=error'
it('reports google in the config', …)                                      // GET /api/v1/auth/takatak/config → {configured:true, google:true}; with googleConfigured=false → google:false
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/takatak-signin.test.ts` — Expected: FAIL (404s / module missing).

- [ ] **Step 3: Implement `src/api/takatak-signin.ts`, mount it in `src/api/app.ts` right after line 469, and add `google: provider.googleConfigured && origin() !== null` to the config route in `src/api/takatak-oauth.ts`**

Send route: `limiter.assertCanSend(key, ip)` then `limiter.recordSend(key, ip)` before awaiting the hub (as `email-first.ts:40-43`). Verify route: `limiter.assertCanCheck(key)`, `limiter.recordFailedCheck(key)` before the hub call. Google callback and consent POST clear their cookies in every branch. Encryption not configured → 503 `TAKATAK_AUTH_UNAVAILABLE`.

- [ ] **Step 4: Run the new tests, then the whole suite and tsc**

Run: `npx tsc --noEmit && npx vitest run tests/takatak-signin.test.ts && npx vitest run` (full run needs the local PostgreSQL 16 test database: `TZ=UTC NODE_ENV=test TEST_DATABASE_URL=… PRISMA_DATABASE_URL=…`)
Expected: PASS; total ≥ 790 + new tests; `npm run test:invariants` green.

- [ ] **Step 5: Commit**

```bash
git add src/api/takatak-signin.ts src/api/app.ts src/api/takatak-oauth.ts tests/takatak-signin.test.ts
git commit -m "feat(takatak): sign in on r2nette.ca by email code or Google with hub consent"
```

---

### Task 5: The sign-in page

**Files:**
- Modify: `web/email.html` (whole body), `web/src/lib/email-entry.ts` (rewrite), `web/public/experience.css` (append `.google-button`, `.consent-card`, `.consent-row`, `.consent-scope`, `.consent-actions` rules)
- Verify: `npm run build`, Playwright script (below)

**Interfaces:**
- Consumes the Task 4 routes and `GET /auth/takatak/config` `{configured, google}`.
- Page ids: `emailForm`/`email`/`send`, `googleButton` (`<a class="google-button">`), `terms`/`termsLabel`, `codeForm`/`code`/`verify`/`change`, `consentCard` with `consentApp`, `consentReturn`, `consentAccount`, `consentScopes` (`<ul>`), `approve`, `deny`, `status`, `language`, `legacy`, `back`. The `takatakBlock` section, `takatak` link, `takatakTerms` and `orEmail` are removed.
- Copy (FR / EN), exact: intro "Connectez-vous ou créez votre compte TAKATAK. Un seul compte pour R2NETTE et tous les sites du Groupe TAKATAK. Aucun mot de passe." / "Sign in or create your TAKATAK account. One account for R2NETTE and every Groupe TAKATAK website. No password."; divider "ou" / "or"; Google button "Continuer avec Google" / "Continue with Google"; terms "Nouveau client : j’accepte les conditions et la politique de confidentialité." / "New customer: I accept the terms and privacy policy."; consent eyebrow "GROUPE TAKATAK", tagline "Digital Solutions. Real Results.", title "Autoriser l’accès" / "Authorize access", intro "R2NETTE demande l’accès à votre compte TAKATAK." / "R2NETTE is asking to access your TAKATAK account.", rows "Application" / "Application", "Adresse de retour" / "Return address", "Compte" / "Account", "Accès demandé" / "Requested access", note "TAKATAK ne transmet votre choix qu’à cette adresse de retour." / "TAKATAK sends your choice only to this return address.", buttons "Autoriser" / "Authorize", "Refuser" / "Refuse"; expired "La connexion a expiré. Recommencez." / "The sign-in expired. Start again."; unavailable "Connexion indisponible pour le moment. Réessayez ou appelez le (514) 825-2825." / "Sign-in is unavailable right now. Try again or call (514) 825-2825."
- Behaviour: on load → `GET config`; hide `googleButton` when `google` is false; show the unavailable message when `configured` is false; if `?consent=1` → `GET consent` and show the card; `?takatak=<reason>` messages kept from the current `takatakReasons` map. Send → state 2. Verify → `{consent:true}` ⇒ `GET consent` ⇒ state 3; `{next}` ⇒ `location.assign(next)`. Approve/deny → `POST consent` ⇒ `location.assign(next)`. 410 anywhere ⇒ state 1 + expired message. Google link href = `/api/v1/auth/takatak/google/start?locale=…&returnTo=…[&terms=1]`, refreshed when the terms box or language changes.

- [ ] **Step 1: Rewrite `web/email.html` with the three states (state 2 and 3 `hidden`), and `web/src/lib/email-entry.ts` with the behaviour above; append the CSS**

`.google-button`: white background, `1px solid var(--line)`, 52 px min-height, Google "G" as inline SVG. `.consent-card`: background `#060d1f`, colour `#f5f8fc`, radius 18 px, padding 22 px, labels in `#1f8bff` uppercase 11 px letter-spaced, scope pills `rgba(255,255,255,.06)` with `1px solid rgba(31,139,255,.35)`, buttons full width on phones.

- [ ] **Step 2: Build**

Run: `npm run build` — Expected: `✓ built`, `email-*.js` emitted, no warnings about missing ids.

- [ ] **Step 3: Browser check against a local server with a fake hub**

Start the API locally against the local database as in the previous sessions (`PORT=3100`), with `TAKATAK_SUPABASE_URL`, `TAKATAK_SUPABASE_ANON_KEY=x`, `TAKATAK_OAUTH_CLIENT_ID=x`, `PUBLIC_URL=http://127.0.0.1:3100`, `FIELD_ENCRYPTION_KEY=<generated>` pointing `TAKATAK_SUPABASE_URL` at a tiny Node stub (scratchpad script) that answers `/auth/v1/otp` 200, `/auth/v1/verify` with a session for the typed email, `/auth/v1/oauth/authorize` 302 to `https://takatak.ca/oauth/consent?authorization_id=<32 chars>`, `/oauth/authorizations/:id` with R2NETTE details, `/consent` with `redirect_url` to the local callback, `/oauth/token` and `/oauth/userinfo` with the same user. Playwright (Galaxy S9+ and 1280 px): type email → code `123456` → consent card visible with 4 scopes → Autoriser → lands on `/#book` with `r2n_session` cookie; Refuser → `/login?takatak=cancelled` message; no console errors; no horizontal overflow at 360 px. Save screenshots of the three states.

- [ ] **Step 4: Commit**

```bash
git add web/email.html web/src/lib/email-entry.ts web/public/experience.css
git commit -m "feat(login): email code, Google and TAKATAK consent on r2nette.ca"
```

---

### Task 6: Docs, owner steps, work log, PR, deploy, live test

**Files:**
- Modify: `docs/TAKATAK_INTEGRATION.md` (new section "Connexion sur r2nette.ca" with the flow and the two Supabase steps, including the Magic Link template text below), `docs/AGENT_HANDOFF.md` (dated signed entry), `WORKLOG.md` (line → PR number, then `done`), `.env.example` (comment: `R2NETTE_EMAIL_AUTH_ENABLED` no longer used by the page)

**Interfaces:** none (documentation and release).

- [ ] **Step 1: Write the Magic Link template text into `docs/TAKATAK_INTEGRATION.md`**

Subject: `Votre code de connexion TAKATAK / Your TAKATAK sign-in code`. Body (HTML allowed): heading "Code de connexion / Sign-in code"; "Saisissez ce code sur la page où vous l’avez demandé : **{{ .Token }}**"; "Enter this code only on the page where you requested it."; "Si vous n’avez pas demandé ce code, ignorez ce courriel. / If you did not request this code, ignore this email."; small line "Ou ouvrez ce lien / Or open this link: {{ .ConfirmationURL }}". Also the Redirect URL to add: `https://r2nette.ca/api/v1/auth/takatak/google/callback`.

- [ ] **Step 2: Update handoff, work log and `.env.example`; commit; push; open the PR** (title "Sign in on r2nette.ca by email code or Google, TAKATAK as the hub"; body: why, flow, tests, owner steps, PR attribution lines)

- [ ] **Step 3: Wait for CI and the review bots; fix findings; merge (owner click if the harness refuses); wait for Deploy; check `https://r2nette.ca/api/v1/auth/takatak/config` → `{"configured":true,"google":true}` and the page shows email + Google**

- [ ] **Step 4: Live test with the owner's account** (approved by the owner on 2026-11-11): on r2nette.ca/login enter `takatak.ca@gmail.com`, read the newest "Sign-in code" email in that mailbox through the Gmail connector, enter the code, screenshot the consent card, Autoriser, screenshot the signed-in return; never write the code anywhere. Then ask the owner to try Google once the Redirect URL is added.

- [ ] **Step 5: Record the result in `docs/AGENT_HANDOFF.md`, `WORKLOG.md` (status `done`) and the owner's Drive note; commit and push**

---

### Phase 2 (separate plan): Google button on takatak.ca

Not part of this plan. Spec §9. Start only after Task 6 Step 4 passes.
