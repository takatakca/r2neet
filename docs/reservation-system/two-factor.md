# Two-step verification for operators

## The property that matters

**A correct owner password alone does not authenticate anyone.** Verified in a
real browser, not just in unit tests:

```
SECOND_STEP_SHOWN: true | CONSOLE_STILL_HIDDEN: true
SESSION_COOKIE_SET: false
ADMIN_API_BEFORE_2FA: 401
ADMIN_API_AFTER_2FA:  200
```

Password success produces a **challenge**, not a session. The challenge is
stored under a different hash prefix, so presenting it as a session cookie
simply does not resolve — asserted by test. It expires in five minutes and is
revoked the moment it is spent.

## What is and is not hand-written

Node's `crypto` does all the cryptography: `createHmac` for HMAC-SHA1,
`randomBytes` for secrets and recovery codes, `timingSafeEqual` for
comparison, `createCipheriv`/`createDecipheriv` for AES-256-GCM.

What this repository implements is the **non-cryptographic** parts of
RFC 6238: base32 framing, the counter encoding, and RFC 4226 §5.4 dynamic
truncation. Those are pinned by the published RFC 6238 vectors — step 1 gives
`287082`, step 37037036 gives `081804` — plus the RFC 4648 base32 vectors.

SHA-1, 6 digits, 30-second period, ±1 step accepted. SHA-1 because every
authenticator app supports it and it is used here as an HMAC key derivation,
not for collision resistance.

## Secrets at rest

A TOTP secret cannot be hashed — verifying a code needs the plaintext. So it
is **encrypted** with AES-256-GCM under `FIELD_ENCRYPTION_KEY`, which lives
outside the database. A dump alone does not let anyone generate valid codes.

A test asserts the stored value is neither equal to nor contains the secret.
Wrong key fails as an authentication error rather than returning garbage;
tampering with the ciphertext is rejected by the GCM tag.

Rows written before encryption was enabled still work and are re-encrypted on
next write, so turning it on locks nobody out.

**Losing this key locks out every 2FA account.** Store it with your other
secrets.

## Replay protection

The accepted time-step is recorded per account, so the same code cannot be
used twice. This surfaced in QA: a second sign-in inside the same 30-second
window was correctly rejected, and the capture script had to use a separate
account. That is the control working.

## Recovery

Eight single-use codes, shown once, stored only as hashes. Formatted in two
groups with `I`, `O`, `0` and `1` removed, since these get read over the
phone. Using one consumes it; regenerating invalidates the rest.

Turning 2FA off requires the password, so a hijacked session cannot do it.

Without recovery codes, a lost phone means a lost account. There is
deliberately no email-based bypass — that would reduce two factors to one.

## Enrolment

Begin → secret stored but **not active** → confirm with a live code → enabled,
and recovery codes issued once. A half-finished enrolment cannot lock anyone
out, which is asserted by test.

Owners see a recommendation on the security page; other roles may enrol but
are not prompted.

## Configuration

```
FIELD_ENCRYPTION_KEY=   # 32+ chars
# node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Production startup warns when it is missing rather than silently storing
plaintext.
