# Disaster recovery

## Recovery has two halves

A perfect PostgreSQL dump is **not** a complete backup. Two-factor secrets are
encrypted with `FIELD_ENCRYPTION_KEY`, which deliberately lives outside the
database. Restore the data without the key and every owner account is locked
out.

Store them separately, and store them **both**.

## The drill, actually run

```
SECRET_ENCRYPTED_AT_REST:          true
CIPHERTEXT_KEY_ID_MATCHES:         true
COUNTS_MATCH:                      true
BOOKING_NUMBER_PRESERVED:          true
FROZEN_TOTAL_PRESERVED:            true
TAX_LINES_PRESERVED:               true
PROMOTION_CLAIM_PRESERVED:         true
RECURRENCE_LOCAL_TIME_PRESERVED:   true (10:00)
MFA_STILL_REQUIRED_AFTER_RESTORE:  true
OWNER_MFA_WORKS_WITH_CORRECT_KEY:  true
WRONG_KEY_DENIES_ACCESS:           true
```

Dumped, restored into a scratch database, and verified: booking numbers, the
frozen quote total, GST and QST as separate lines, a redeemed promotion claim,
and a weekly series still anchored to 10:00 Montréal time.

Then the part that matters most — the owner signed in against the **restored**
data with password plus TOTP, and was correctly refused when the key was
swapped for a different one.

## Backup

```bash
npm run db:backup
```

Timestamped `pg_dump --format=custom`. Refuses to run against a database whose
name looks like a test scratch database, never prints the connection string,
fails non-zero on a suspiciously small dump, and prints the encryption key
fingerprint so a restore can confirm it has matching key material.

`backups/` and `*.dump` are gitignored.

## Key rotation

Ciphertext is `v2:keyId:iv:tag:data`. The key id is derived from the
passphrase, so a row can find its own key without storing anything sensitive.

```bash
FIELD_ENCRYPTION_KEY=<new> \
FIELD_ENCRYPTION_KEYS_RETIRED=<old> \
npm run security:rotate-key -- --apply
```

Dry run by default. Rows already on the current key are skipped, so it is safe
to interrupt and re-run. The old key stays in `FIELD_ENCRYPTION_KEYS_RETIRED`
until the command reports `remaining: 0` — retiring it early is exactly how
you lock yourself out, so a row whose key is absent fails with
`KEY_NOT_AVAILABLE` and names the missing key id rather than failing vaguely.

The same command re-encrypts any plaintext secrets left over from before
encryption existed.

## What to store where

| | Where | Why |
|---|---|---|
| `pg_dump` output | Object storage, off the database host | The business record |
| `FIELD_ENCRYPTION_KEY` | Secret manager, **not** the database | Unlocks two-factor |
| Retired keys | Secret manager, until rotation completes | Old rows still need them |
| Owner recovery codes | Wherever the owner keeps important paper | Last resort if the phone is lost |

Losing the database loses bookings, prices and payment history — Stripe holds
only the payment side, not the business record. Losing the key loses operator
access.

## Restore

```bash
createdb r2nette_restore
pg_restore --no-owner --no-acl -d "$SCRATCH_URL" r2nette-<timestamp>.dump
```

Restore into a **scratch** database first, every time. Then point a
throwaway application instance at it and confirm an owner can sign in — an
untested backup is a guess.

## Still to arrange

- Automated scheduling of `db:backup` on the deployment platform
- Off-host storage with retention
- An alert when a backup does not complete
