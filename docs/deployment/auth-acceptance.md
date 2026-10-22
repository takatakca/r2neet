# Google and phone OTP acceptance checklist

Production commit under test: `319bce3e0aecc22c29374a76cda236a96fcffdcc` on `https://r2nette.ca`.

Do not redeploy, reinstall the VPS, or paste secret values while running this list. Use one phone number and one Google account that you control. Do not use a customer’s phone or Google account.

Already observed without completing a sign-in:

- `GET /api/v1/auth/google/start` returns 302 to production Supabase `pcjfahhlozsseqqevimi`, using PKCE S256 and redirect `https://r2nette.ca/api/v1/auth/google/callback`.
- That Supabase URL then returns 302 to Google.
- `POST /api/v1/auth/phone/send` with an empty body returns HTTP 400 `VALIDATION_ERROR` and does not send SMS.

## Human configuration still required

These live in Google Cloud and the TAKATAK production Supabase project. They are not in this repository.

1. Google Cloud, for the OAuth client used by Supabase Auth: the authorized redirect URI is `https://pcjfahhlozsseqqevimi.supabase.co/auth/v1/callback`. It is not the R2NETTE callback. Confirm the consent screen is published for the customers who should sign in. A Testing-mode screen only allows listed test users. The live handoff to Google does not prove that a customer can finish consent and return.
2. Supabase project `pcjfahhlozsseqqevimi`, Authentication → URL configuration: keep `https://r2nette.ca/api/v1/auth/google/callback` in the redirect allowlist. The live start request was accepted, so the URL is allowed today.
3. Same Supabase project, Authentication → Providers → Phone: enable phone sign-in and its Twilio SMS provider. R2NETTE only has the project URL and anon key. The Twilio credential for OTP belongs in Supabase, not in the R2NETTE server env and not in chat.
4. Send one real code to a phone you control and finish the cases below. No automated check has delivered an SMS.

Stripe, R2NETTE’s own Twilio Voice number, Maps, dispatch origin, off-host backup, and the alert webhook are separate optional warnings. They are not part of this sign-in path.

## Cases

Record the HTTP status and the error `code` only. Do not record OTP codes, cookies, or tokens.

### First-time Google link, existing customer

1. Sign out. Start at `/api/v1/auth/google/start`.
2. Finish Google consent with an account that is not yet linked in R2NETTE.
3. Expect a redirect to `/login?google=phone`. No customer session cookie yet.
4. Send a code with intent `google` for the phone already on that R2NETTE customer. The response says a code was sent and does not say whether the number exists.
5. Submit the correct code with intent `google`.
6. Expect `AUTHENTICATED` for that existing customer. The Google subject is stored only after this OTP.

### First-time Google link, new phone

1. Repeat the Google start with a different unlinked Google account.
2. Verify a phone that has no completed R2NETTE profile.
3. Expect `PROFILE_REQUIRED`, then complete registration.
4. Expect the new customer to be signed in and the Google subject linked in that same registration. Email is stored as profile data. It is not the lookup key for the Google account.

### Returning linked user

1. Sign out. Start Google again with the account linked above.
2. Expect a session and a redirect to the account page without another OTP.
3. A second unused Google account must not replace the subject already stored on that customer. Expect `GOOGLE_ACCOUNT_ALREADY_LINKED`.
4. The same Google account must not attach to a second customer. Expect `GOOGLE_ACCOUNT_ALREADY_LINKED`.

### Invalid OTP

1. Send a code to a phone you control.
2. Submit a wrong 6-digit code. Expect `OTP_DENIED` and the message that the code is not right.
3. Submit `abc`. Expect `OTP_MALFORMED`. This attempt must not call the SMS provider.
4. Repeat a wrong code until the app returns `OTP_ATTEMPT_LIMIT` (5 incorrect checks for that phone). Requesting another code is then required.
5. A second send within 30 seconds returns `OTP_COOLDOWN`. More than 5 sends for one phone in an hour returns `OTP_PHONE_LIMIT`.

### Expired sessions

1. Wait until the Supabase phone code is past the expiry configured in that project, then submit it. The live provider reports a rejected code as `OTP_DENIED`, with the same message as a wrong code. `OTP_EXPIRED` is not the production response.
2. Start Google, wait more than 10 minutes, then return to the callback. Expect `/login?google=error`. The OAuth state cookies last 10 minutes.
3. Reach `/login?google=phone`, wait more than 60 minutes, then send or verify with intent `google`. Expect `GOOGLE_LINK_EXPIRED`.
4. Sign in, wait more than 60 minutes, then open a signed-in page. Expect HTTP 401 `UNAUTHORIZED`.
5. For a new phone, leave the profile form more than 60 minutes. Completing it returns `REGISTRATION_SESSION_EXPIRED`.

### Account takeover prevention

- Google alone never opens a session for an unlinked subject. The phone OTP is required first.
- Phone send returns the same shape for a known number and an unknown number. Account existence is visible only after a correct code.
- A normal login clears a pending Google link cookie, so a phone login does not silently attach the waiting Google subject.
- Linking checks the phone that just passed OTP. A code for a different number does not complete the link.
- An existing customer keeps the Google subject already stored. A different subject is refused.
- One Google subject cannot be saved on two customers.
- The Google callback looks up `googleAuthSubject` only. It does not select a customer by email.

## Stop conditions

Stop and do not continue the list if a code is sent to a number you do not control, if a Google account you do not control receives a session, or if an unlinked Google subject gets a customer session before a phone OTP.
