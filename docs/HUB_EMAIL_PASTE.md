# Make the r2nette.ca code emails say what the owner asked (2 minutes, Supabase dashboard)

Why this is a manual step: the code emails are sent by the TAKATAK hub (Supabase project `pcjfahhlozsseqqevimi`), and
their wording is a project setting that only an account with access to that Supabase project can change (the
management API answers "No access token provided" to this session, and no Supabase tool available to it edits Auth
settings). The r2nette.ca server already tells the hub which site asked (`redirect_to`). These pastes make the hub
answer in R2NETTE's voice for r2nette.ca and keep TAKATAK's wording for takatak.ca, so takatak.ca's emails do not change.

Open: Supabase dashboard → project `pcjfahhlozsseqqevimi` → **Authentication**.

## 1. URL Configuration → Redirect URLs → Add URL

```
https://r2nette.ca/api/v1/auth/takatak/google/callback
```

Without this line the hub ignores the marker and keeps the TAKATAK wording.

## 2. Email Templates → **Confirm signup** (the sign-up email for a brand-new address)

**Subject:**

```
{{ if eq .RedirectTo "https://r2nette.ca/api/v1/auth/takatak/google/callback" }}OTP for r2nette.ca Sign Up{{ else }}Confirm your email address{{ end }}
```

**Message body** (replace everything in the box):

```html
{{ if eq .RedirectTo "https://r2nette.ca/api/v1/auth/takatak/google/callback" }}
<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#0a2547">
<p>Your one time password is below for r2nette.ca sign up.</p>
<p style="font-size:30px;font-weight:bold;letter-spacing:6px;margin:8px 0 16px">{{ .Token }}</p>
</div>
{{ else }}
<h2>Confirm your email address</h2>
<p>Follow the link below to confirm this email address and finish signing up.</p>
<p><a href="{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=email">Confirm email address</a></p>
{{ end }}
```

The `{{ else }}` half is the email takatak.ca sends today (rebuilt from the message received on 2026-11-13; its link
is `https://takatak.ca/auth/callback?token_hash=…&type=email`). If the box already holds the exact text you want for
takatak.ca, keep it in that half. The R2NETTE half has no link on purpose: a mail scanner that opens links on delivery
cannot use up the code. Optional: add a French line under the English one, for example
`<p>Votre mot de passe à usage unique pour l’inscription à r2nette.ca :</p>`.

## 3. Email Templates → **Magic Link** (an address the hub already knows: older accounts, "forgot password")

**Subject:**

```
{{ if eq .RedirectTo "https://r2nette.ca/api/v1/auth/takatak/google/callback" }}OTP for r2nette.ca{{ else }}Votre code de connexion / Your sign-in code{{ end }}
```

**Message body** (replace everything in the box):

```html
{{ if eq .RedirectTo "https://r2nette.ca/api/v1/auth/takatak/google/callback" }}
<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#0a2547">
<p>Your one time password is below for r2nette.ca.</p>
<p style="font-size:30px;font-weight:bold;letter-spacing:6px;margin:8px 0 16px">{{ .Token }}</p>
</div>
{{ else }}
<h2>Join a TAKATAK workspace</h2>
<p>You have been invited to join a TAKATAK workspace.</p>
<p><a href="{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=magiclink">Continue to workspace</a></p>
<hr>
<h2>Code de connexion / Sign-in code</h2>
<p>Pour la connexion par code, saisissez le code suivant sur la page où vous l’avez demandé :</p>
<p style="font-size:30px;font-weight:bold;letter-spacing:6px">{{ .Token }}</p>
<p>For code sign-in, enter this code only on the page where you requested it.</p>
<p>Si vous n’avez pas demandé ce code, ignorez ce courriel. Ne communiquez ce code à personne.</p>
<p>If you did not request this code, ignore this email. Do not share this code.</p>
{{ end }}
```

This one says "r2nette.ca" without "Sign Up" because it is also what a returning customer gets for "first sign-in or
forgot password". The `{{ else }}` half is the email takatak.ca sends today (rebuilt from the message received on
2026-11-12, with its broken link `https://takatak.ca&token_hash=…` corrected).

**Step 2 is required for Sign up by email** (live check, 2026-11-13 01:46 UTC): the Confirm-signup template that was in
place had a link and no code, so a brand-new customer was sent to the code step and never received a code. Google
sign-up and every customer the hub already knows (Magic Link, which carries the code) were not affected.

## 4. Test

On r2nette.ca (`/login?tab=signup`), sign up with a brand-new address: the email must read
**OTP for r2nette.ca Sign Up** / *Your one time password is below for r2nette.ca sign up.* and show the code. Then do
the same with an address the hub already knows, and request a sign-up on takatak.ca: it must read as before.
If a test email shows raw `{{ … }}` text or the TAKATAK wording on r2nette.ca, step 1 is missing or the subject box does
not accept templates; tell the assistant what you see.

## Known limit

The sender line (`TAKATAK <noreply@mimt.ca>`) is one project-wide SMTP setting, so the *content* changes per site but
the *From name* does not. Removing TAKATAK from the sender line of R2NETTE's codes needs a Send Email Hook (an edge
function that picks sender and wording per site) and a mail-sending account; that is separate work.
