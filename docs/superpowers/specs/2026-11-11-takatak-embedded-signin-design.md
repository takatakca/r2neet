# R2NETTE sign-in on r2nette.ca with TAKATAK as the hub — design

Date: 2026-11-11 · Author: Claude (Anthropic) · Status: approved by the owner in chat (2026-11-11), implementation pending.

## 1. Goal

A customer signs in or signs up **on r2nette.ca** and is never sent to takatak.ca. Two methods: an **email code** and **Google**. The account is created and kept in **TAKATAK** (Supabase project `pcjfahhlozsseqqevimi`, "TAKATAK User Official Dashboard V1"), which is the master identity for every Groupe TAKATAK site. After the code (or Google), the customer sees TAKATAK's **"Autoriser l'accès"** screen (Application, Adresse de retour, Compte, Accès demandé, Autoriser / Refuser) rendered by r2nette.ca, taps **Autoriser**, and lands signed in on r2nette.ca.

Second step, separate PR in `takatakca/takatak-v1`: a **Google** button on takatak.ca/login.

### Non-goals

- No change to the account-link flow in `/account` ("Relier mon compte TAKATAK"): it keeps using `/api/v1/auth/takatak/start` and takatak.ca.
- No change to phone (SMS) sign-in or to `/phone-login`.
- No new secrets on the server: the flow uses `TAKATAK_SUPABASE_URL`, `TAKATAK_SUPABASE_ANON_KEY` and `TAKATAK_OAUTH_CLIENT_ID`, which production already has.

## 2. Facts the design rests on (checked live on 2026-11-11)

- Hub auth providers enabled: `email`, `phone`, `google` (`/auth/v1/settings`). 5 users already signed in with Google.
- Hub SMTP works: a test code sent with `POST /auth/v1/otp` reached the owner's mailbox in 2 s, from "TAKATAK <noreply@mimt.ca>". The message body is the shared "Magic Link" template: subject "You've been invited", text "Join a TAKATAK workspace…", then a bilingual "Code de connexion / Sign-in code" block with the 6-digit `{{ .Token }}`. The code works; the wording is wrong for customers (owner action, §8).
- Hub OAuth 2.1 server: `GET /auth/v1/oauth/authorize` answers `302 → https://takatak.ca/oauth/consent?authorization_id=<32 chars a-z2-7>` **without any browser session**. The consent step is two REST calls that need only the user's access token (this is what takatak.ca's own consent page does, see `takatak-v1/src/app/api/oauth/consent/route.ts` and `@supabase/auth-js` 2.116 `_approveAuthorization`):
  - `GET /auth/v1/oauth/authorizations/{id}` → `{ authorization_id, client:{name}, redirect_uri, scope, user:{id,email} }`, or `{ redirect_url }` when this user already approved this client (skip consent);
  - `POST /auth/v1/oauth/authorizations/{id}/consent` body `{ "action": "approve" | "deny" }` → `{ redirect_url }`.
- R2NETTE client in the hub: id `8e551e10-b1e1-4cf5-8af9-72fc791b9086`, public, `redirect_uris = https://r2nette.ca/api/v1/auth/takatak/callback`, grants `authorization_code,refresh_token`.
- Hub trigger `handle_shared_auth_identity` (AFTER INSERT/UPDATE on `auth.users`) registers every new user in TAKATAK's shared identity, so a customer created from r2nette.ca is known to the hub.
- The hub echoes any `redirect_to` on `/auth/v1/authorize?provider=google` and validates it only at the end of the Google round-trip, so r2nette cannot self-check the allow-list; the owner must add the return address (§8).
- r2neet already has: `SupabaseEmailAuthProvider` (hub `/otp` + `/verify`, gated by `R2NETTE_EMAIL_AUTH_ENABLED`), `SupabaseGoogleAuthProvider` (hub `/authorize?provider=google` + PKCE exchange), `SupabaseTakatakOAuthProvider` (`authorizationUrl`, `exchangeCode` → `TakatakIdentity`), and `takatakOAuthRoutes` whose `/callback` turns a `TakatakIdentity` into an R2NETTE customer (`resolveCustomer`: match by TAKATAK user id, then by a phone both systems verified, else create with terms; never take over a historic profile by email alone) and opens the R2NETTE session.

## 3. Architecture

Everything lives in `takatakca/r2neet`. One new router file, additions to one provider, one rewritten page.

```
browser (r2nette.ca/login)                r2nette server                         TAKATAK hub (Supabase)
───────────────────────────               ──────────────────────────             ──────────────────────
email ──POST email/send──────────────────▶ rate limit, POST /auth/v1/otp ───────▶ emails the code
code  ──POST email/verify────────────────▶ POST /auth/v1/verify ────────────────▶ { access_token, user }
                                           create state+verifier+challenge
                                           set pending cookie (as /start does)
                                           GET /oauth/authorize (no follow) ─────▶ 302 …?authorization_id=X
                                           GET /oauth/authorizations/X (Bearer) ─▶ details | { redirect_url }
                                           set consent cookie {X, enc(token)}
      ◀── { consent: true } | { next }
      ──GET consent─────────────────────▶  read cookie, GET /oauth/authorizations/X ▶ details
      ◀── { app, returnAddress, account, scopes }
      renders "Autoriser l'accès"
      ──POST consent {decision}─────────▶  POST /oauth/authorizations/X/consent ──▶ { redirect_url }
                                           check redirect_url = our /callback?code&state
                                           clear consent cookie, POST /auth/v1/logout (best effort)
      ◀── { next: redirect_url }
      location.assign(next) ─────────────▶ existing /auth/takatak/callback: exchangeCode → resolveCustomer → session → 303 returnTo
```

Google replaces the first two arrows: `GET google/start` → hub `/auth/v1/authorize?provider=google&redirect_to=<ours>` (PKCE) → Google → `GET google/callback?code` → hub `POST /auth/v1/token?grant_type=pkce` → `{ access_token, user }` → same steps from "create state+verifier+challenge", then `303 /login?consent=1&returnTo=…` (or `303 next` when already approved).

### 3.1 Server: `src/api/takatak-signin.ts` (new router, mounted at `/api/v1`)

| Route | Purpose |
|---|---|
| `POST /auth/takatak/email/send` `{email}` | Rate limit (existing `RateLimiter`, key = sha256(email), ip). Provider `sendEmailCode(email)`. Reply `{ sent: true }`. Always the same reply whether or not the email exists in the hub (no enumeration). |
| `POST /auth/takatak/email/verify` `{email, code, locale, terms}` | Rate limit checks. Provider `verifyEmailCode(email, code)` → hub session. Then **begin consent** (§3.3) with `{ returnTo, locale, terms, link: null }`. Reply `{ consent: true }` or `{ next }`. |
| `GET /auth/takatak/google/start?locale&returnTo&terms` | Create state + verifier; write cookie `r2n_takatak_google` `{ v:1, state, verifier, returnTo, locale, terms, createdAt }` (httpOnly, secure, SameSite=Lax, path `/api/v1/auth/takatak/google`, 10 min; same shape and checks as the pending cookie, no table). 303 to provider `googleAuthorizationUrl(callback, challenge)` with `state` passed through to the hub. |
| `GET /auth/takatak/google/callback?code&state` | Read and clear the Google cookie; refuse when missing, stale, or `state` differs (timing-safe); provider `exchangeGoogleCode(code, verifier)` → hub session; **begin consent**; `303 /login?consent=1&returnTo=…` or `303 next`. Any failure → `303 /login?takatak=<reason>`. |
| `GET /auth/takatak/consent` | Read the consent cookie; provider `authorizationDetails(id, token)`; reply `{ app, returnAddress, account, scopes[], locale }` or `{ next }` (already approved) ; 410 `CONSENT_EXPIRED` when the cookie is missing or stale. |
| `POST /auth/takatak/consent` `{decision: 'approve'\|'deny'}` | Provider `decideConsent(id, token, decision)` → `redirect_url`. Accept it only if it is exactly our callback origin+path and its `state` equals the pending cookie's state. Clear the consent cookie. Best-effort hub logout of that token (scope `local`). Reply `{ next: redirect_url }`. |
| `GET /auth/takatak/config` (existing) | Add `google: boolean` (provider configured) and `email: true` so the page can hide what is off. |

Shared with the existing router: `Pending` cookie (`r2n_takatak_oauth`, state, verifier, returnTo, locale, terms, link=null, 10 min) is written by a helper extracted from `/start` so the existing `/callback` finishes both the old and the new flows unchanged. `safeReturn`, `origin()` and `backToLogin` move to a small shared module used by both routers.

**Consent cookie** `r2n_takatak_consent`: httpOnly, secure (production), SameSite=Lax, path `/api/v1/auth/takatak`, max-age 10 min; value = base64url JSON `{ v:1, id, token, createdAt }` where `token = encryptSecret(access_token)` (AES-GCM with the server's `FIELD_ENCRYPTION_KEY` keyring, `src/auth/encryption.ts`). If encryption is not configured (never in production: `validate-production-env` requires the key), the server answers 503 `TAKATAK_AUTH_UNAVAILABLE` rather than storing a bare token.

**Request hardening**, as `email-first.ts`: JSON only, reject `sec-fetch-site: cross-site`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`.

### 3.2 Provider additions: `src/identity/takatak-oauth.ts`

`TakatakOAuthProvider` gains:

```ts
sendEmailCode(email: string): Promise<void>;                      // POST {issuer}/otp { email, create_user: true }
verifyEmailCode(email: string, code: string): Promise<HubSession>; // POST {issuer}/verify { type:'email', email, token }
googleAuthorizationUrl(redirectUri: string, challenge: string, state: string): string; // {issuer}/authorize?provider=google&redirect_to&state&code_challenge&code_challenge_method=s256
exchangeGoogleCode(code: string, verifier: string): Promise<HubSession>; // POST {issuer}/token?grant_type=pkce
beginAuthorization(input: { redirectUri; challenge; state; locale }): Promise<string>; // GET authorize, redirect:'manual', parse authorization_id from Location (host must be takatak.ca or the issuer host; id /^[a-z2-7]{32}$/)
authorizationDetails(id: string, accessToken: string): Promise<ConsentDetails | { redirectUrl: string }>;
decideConsent(id: string, accessToken: string, decision: 'approve'|'deny'): Promise<string>; // redirect_url
revokeSession(accessToken: string): Promise<void>;                 // POST {issuer}/logout?scope=local, errors ignored
```

`HubSession = { accessToken: string; subject: string; email: string | null; phone: string | null }`. `verifyEmailCode` accepts the reply only if `user.email` equals the requested email and `email_confirmed_at` is a date; `exchangeGoogleCode` only if the user lists the `google` identity (as the current Google provider does). `ConsentDetails = { appName; returnAddress; account; scopes: string[] }` with the same scope wording as takatak.ca (`openid` → "Confirmer que vous êtes connecté à TAKATAK", `email` → "Voir votre adresse courriel", `profile` → "Voir votre nom et votre profil", `phone` → "Voir votre numéro de téléphone"; EN equivalents). All calls use `apikey: anon key`, 10 s timeouts, and map failures to the existing `IdentityError` codes (`TAKATAK_AUTH_UNAVAILABLE`, `TAKATAK_CODE_INVALID`, new `EMAIL_CODE_INVALID`, `OTP_PROVIDER_LIMIT`, `CONSENT_INVALID`).

`configured` stays `issuer && clientId` over https; `googleConfigured` = `configured && anonKey`.

### 3.3 Begin consent (shared server step)

1. `state`, `verifier` = 32 random bytes each (base64url); `challenge` = sha256(verifier).
2. Write the pending cookie `{ v:1, state, verifier, returnTo, locale, terms, link:null, createdAt }` (exactly what `/start` writes today).
3. `id = beginAuthorization({ redirectUri: origin + '/api/v1/auth/takatak/callback', challenge, state, locale })`.
4. `details = authorizationDetails(id, accessToken)`. If `{ redirectUrl }`: validate as in POST consent and return `{ next }` (consent already granted earlier; no screen). Otherwise write the consent cookie and return `{ consent: true }`.

### 3.4 Finish (unchanged)

`GET /api/v1/auth/takatak/callback?code&state` (existing): reads the pending cookie, checks state, `exchangeCode` (PKCE) → `TakatakIdentity` → `resolveCustomer` → R2NETTE session cookie → `303 returnTo`. Failures go back to `/login?takatak=<reason>` as today (`terms`, `email-required`, `link-required`, `cancelled`, `expired`, `error`). `cancelled` is what a **Refuser** produces: the hub's `redirect_url` then carries `error=access_denied`, and the callback already maps `req.query.error` to `cancelled`.

## 4. Page: `/login` and `/signup` (`web/email.html`, `web/src/lib/email-entry.ts`, `web/public/experience.css`)

One page, three states, FR/EN toggle kept.

**State 1 — choose.** Eyebrow "Votre compte, simplement". Title "Votre courriel. Votre prochain ménage." Intro "Connectez-vous ou créez votre compte TAKATAK. Un seul compte pour R2NETTE et tous les sites du Groupe TAKATAK. Aucun mot de passe." Form: email field + primary button "Recevoir mon code". Divider "ou". Secondary button "Continuer avec Google" (white, border, Google "G" mark, `href=/api/v1/auth/takatak/google/start?locale&returnTo[&terms=1]`). Checkbox "Nouveau client : j'accepte les conditions et la politique de confidentialité." (links to /terms, /privacy) — sent as `terms` with both methods; required only for brand-new customers (the server decides, as today). Existing links keep: "Déjà un compte avec téléphone ?" → `/phone-login`, "Retour au site". The dark "Continuer avec TAKATAK" button is removed. If `config.google` is false the Google button is hidden; if TAKATAK is not configured the page shows the existing "unavailable" message.

**State 2 — code.** "Code reçu par courriel" 6-digit field (`inputmode=numeric`, `autocomplete=one-time-code`), "Vérifier et continuer", "Changer de courriel", status line "Code envoyé. Vérifiez aussi vos indésirables." Errors: invalid/expired code, wait before retrying, unavailable.

**State 3 — consent.** A card in TAKATAK's style (deep navy `#060d1f`/`#0a2547` background, electric-blue accents, light text; see BRAND.md): eyebrow "GROUPE TAKATAK", tagline "Digital Solutions. Real Results.", title "Autoriser l'accès", intro "R2NETTE demande l'accès à votre compte TAKATAK.", then labelled rows **Application** (app name from the hub), **Adresse de retour** (`https://r2nette.ca/api/v1/auth/takatak/callback`), **Compte** (email or phone from the hub), **Accès demandé** (one pill per scope, hub wording above), note "TAKATAK ne transmet votre choix qu'à cette adresse de retour.", buttons **Autoriser** (primary) and **Refuser** (ghost), language switch. Autoriser → `POST consent {approve}` → `location.assign(next)`. Refuser → `POST consent {deny}` → `location.assign(next)` (ends at `/login?takatak=cancelled` with the existing message). On load, the page checks `?consent=1` (Google return) and otherwise `GET consent` after a successful verify; a 410 sends it back to state 1 with "La connexion a expiré, recommencez."

Phone layout: the card fits 360 px wide with 16 px gutters, buttons full width, no horizontal scroll.

## 5. Error handling

| Case | Server | Page |
|---|---|---|
| Email not deliverable / hub down | `sendEmailCode` throws → 503 `TAKATAK_AUTH_UNAVAILABLE` | "Connexion indisponible pour le moment. Réessayez ou appelez le (514) 825-2825." |
| Wrong or expired code | 401 `EMAIL_CODE_INVALID` | "Code invalide ou expiré." (stay in state 2) |
| Too many sends/attempts | 429 `OTP_*_LIMIT` | "Veuillez patienter avant de réessayer." |
| Consent cookie missing/expired, or hub says the authorization is gone | 410 `CONSENT_EXPIRED` | back to state 1 with "La connexion a expiré, recommencez." |
| Hub `redirect_url` is not our callback or state mismatch | 502 `CONSENT_INVALID`, cookie cleared | generic error, back to state 1 |
| Google cancelled / state mismatch / exchange failed | `303 /login?takatak=cancelled\|expired\|error` | existing messages |
| New customer without terms, email-required, link-required | existing callback reasons | existing messages (terms box focused) |
| Encryption key missing | 503 `TAKATAK_AUTH_UNAVAILABLE` | unavailable message |

## 6. Security notes

- The hub access token never reaches the browser in clear text and is held for at most 10 minutes, encrypted at rest in an httpOnly cookie scoped to `/api/v1/auth/takatak`; it is revoked (best effort) after the decision.
- PKCE verifier and `state` stay server-side in httpOnly cookies, as today; the callback refuses a `redirect_url` whose `state` differs from the pending cookie.
- Same-origin checks on every JSON route; the email send reply never reveals whether the address is known.
- Rate limits: the existing `RateLimiter` (per email hash + per IP) for send and verify; the hub's own limits apply on top.
- `returnTo` is restricted to same-origin, non-API, non-auth paths (existing `safeReturn`).

## 7. Testing

- Provider unit tests with a fake `fetch`: each hub call's request shape and auth headers; `beginAuthorization` parsing (good Location, foreign host, bad id); `authorizationDetails` for details and for the already-approved `{redirect_url}` form; `decideConsent` approve/deny; mapped errors for 4xx/5xx/network.
- Router tests (supertest, fake provider, in-memory prisma as in `tests/takatak-oauth.test.ts`): send → verify → consent GET → approve → callback → session cookie, customer created with terms; returning customer skips terms; already-approved skips the screen; deny → `cancelled`; expired consent cookie → 410; forged `redirect_url` → 502 and nothing created; rate limiting; Google start/callback happy path and failures; `config` exposes `google`.
- Existing 790 tests stay green; `tsc`, `vite build`, invariants.
- Chromium (Playwright) on the built page at 360 px and 1280 px: the three states render, no overflow, no console errors.
- Live: one email sign-in on r2nette.ca with takatak.ca@gmail.com (code read from that mailbox by the agent, never posted), screenshots of the consent card and the signed-in return; then the owner tests Google.

## 8. Owner actions (Supabase dashboard, project "TAKATAK User Official Dashboard V1")

1. **Authentication › Email Templates › Magic Link**: replace the subject and body so a customer receives a sign-in code, not a workspace invitation. Text supplied with the PR (bilingual, keeps `{{ .Token }}`, and keeps the `{{ .ConfirmationURL }}` link in a smaller "or open this link" line so TAKATAK's own magic-link uses keep working). If TAKATAK's workspace invitations rely on this template's wording, use the **Invite user** template for invitations instead.
2. **Authentication › URL Configuration › Redirect URLs**: add `https://r2nette.ca/api/v1/auth/takatak/google/callback`. Without it, a Google sign-in started on r2nette.ca ends on takatak.ca.

No GitHub secret changes. Deploy: merge → CI → Deploy (automatic). `R2NETTE_EMAIL_AUTH_ENABLED` and the old `/api/v1/auth/email/*` routes stay in place but unused by the page (removal is a later cleanup).

## 9. Phase 2 — takatak.ca (`takatakca/takatak-v1`, separate PR)

Add "Continuer avec Google" to `src/components/auth/master-phone-login-form.tsx` (under the SMS/Email tabs). It calls `createSupabaseBrowserClient().auth.signInWithOAuth({ provider: 'google', options: { redirectTo: origin + '/auth/callback?next=' + next } })`; the existing `/auth/callback` exchanges the code (`exchangeCodeForSession`) and runs `ensureProfileForSupabaseUser`. Hidden when Supabase is not configured. Tests: `npm run typecheck`, `npm run lint`, `npm run test:auth`, `npm run build`. Release through the TAKATAK release process (merge → staging; production promoted by the release coordinator). Agent-board rule in that repo's `AGENTS.md` (foodhubca issue #105) applies when that work starts.
