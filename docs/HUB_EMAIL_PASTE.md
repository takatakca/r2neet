# Make the sign-in code email say R2NETTE (2 minutes, Supabase dashboard)

Why this is a manual step: the code email is sent by the TAKATAK hub (Supabase project `pcjfahhlozsseqqevimi`), and
its wording is a project setting that only an account with access to that Supabase project can change. The r2nette.ca
server already tells the hub which site asked (`redirect_to`). These three pastes make the hub answer in R2NETTE's
voice for r2nette.ca and keep TAKATAK's wording for takatak.ca.

Open: Supabase dashboard → project `pcjfahhlozsseqqevimi` → **Authentication**.

## 1. URL Configuration → Redirect URLs → Add URL

```
https://r2nette.ca/api/v1/auth/takatak/google/callback
```

Without this line the hub ignores the marker and keeps the TAKATAK wording.

## 2. Email Templates → **Magic Link**

**Subject** (if the box shows the raw `{{ … }}` text in a test email, use the plain line under it instead):

```
{{ if eq .RedirectTo "https://r2nette.ca/api/v1/auth/takatak/google/callback" }}Votre code de connexion R2NETTE / Your R2NETTE sign-in code{{ else }}Votre code de connexion / Your sign-in code{{ end }}
```

Plain fallback: `Votre code de connexion / Your sign-in code`

**Message body** (replace everything in the box):

```html
{{ if eq .RedirectTo "https://r2nette.ca/api/v1/auth/takatak/google/callback" }}
<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#0a2547">
<p style="font-size:20px;font-weight:bold;color:#0b4da2;margin:0 0 4px">R2NETTE</p>
<p style="margin:0 0 20px;color:#6a8298;font-size:13px">Cleaning Services · r2nette.ca</p>
<h2 style="margin:0 0 10px">Code de connexion / Sign-in code</h2>
<p>Saisissez ce code sur r2nette.ca pour vous connecter :</p>
<p style="font-size:30px;font-weight:bold;letter-spacing:6px;margin:8px 0 16px">{{ .Token }}</p>
<p>Enter this code on r2nette.ca to sign in. Never share it.</p>
<p>Si vous n’avez pas demandé ce code, ignorez ce courriel. / If you did not request this code, ignore this email.</p>
<p style="color:#6a8298;font-size:12px">R2NETTE · (514) 825-2825</p>
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

The `{{ else }}` half is the email takatak.ca sends today, rebuilt from the message received on 2026-11-12, with its
broken link (`https://takatak.ca&token_hash=…`) corrected. The R2NETTE half has no link on purpose: a mail scanner that
opens links on delivery cannot use up the code.

## 3. Email Templates → **Confirm signup**

A brand-new address gets this template. Use the same subject, and the same body as step 2 with one change in the
TAKATAK half: `type=magiclink` becomes `type=signup`.

**This step is now required for Sign up by email (live check, 2026-11-13 01:46 UTC).** The current Confirm-signup
template has a link and no code ("Confirm your email address", link to takatak.ca). A brand-new customer who signs up
by email on r2nette.ca is sent to the code step and never receives a code. Google sign-up and every customer the hub
already knows (Magic Link template, which does carry the code) are not affected. Until this is pasted, a new customer
can open the link in that email (it confirms the address), then ask for a code again.

## 4. Test

On r2nette.ca, request a code with an address and read the email: subject and body must say R2NETTE and never
TAKATAK. Then request one on takatak.ca: it must read as before.

## Known limit

The sender line (`TAKATAK <noreply@mimt.ca>`) is one project-wide SMTP setting, so the *content* changes per site but
the *From name* does not. Removing TAKATAK from the sender line of R2NETTE's codes needs a Send Email Hook (an edge
function that picks sender and wording per site) and a mail-sending account; that is separate work.
