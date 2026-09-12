# Staff authentication

## What replaced the shared token

`ADMIN_TOKEN` is gone. A single shared secret could not be revoked for one
person, could not tell a dispatcher from a cleaner, and left an audit trail
where every action looked identical. It also travelled in a `?token=` query
string, which lands in server logs and browser history.

Each operator now has their own account, their own session, and their own
audit entries.

## Passwords

scrypt (N=16384, 64-byte key) with a per-user random salt, compared with
`timingSafeEqual`. Stored as `scrypt$N$salt$hash` — never plaintext, never an
unsalted digest.

Enforced, not suggested: 12+ characters, mixed case, a digit, and no common
words or the business name. Reusing the current password is rejected.

A wrong email and a wrong password return the same message, the same code, and
comparable timing — the endpoint burns a hash even for an unknown account, so
it cannot be used to discover which staff emails exist.

Five failures locks the account for 15 minutes. A successful sign-in clears
the counter.

## Sessions

A 32-byte random token in an HttpOnly, SameSite=Lax cookie (Secure in
production). Only its SHA-256 is stored, so a database dump does not grant
operator access. Twelve-hour lifetime — about one shift.

Changing a password revokes every other session but keeps the current one, so
an operator who suspects a shared password can lock everyone else out from the
device in their hand.

Deactivating a `StaffUser` kills access immediately without deleting their
history.

## Roles

Explicit permission allowlists, not a numeric level. A cleaner is not a weaker
admin; they have a different, narrow job.

| | OWNER | DISPATCHER | CLEANER |
|---|---|---|---|
| dashboard, dispatch, assign | ✓ | ✓ | |
| callbacks view + act | ✓ | ✓ | |
| reviews view | ✓ | ✓ | |
| reviews moderate | ✓ | | |
| integrations, cutover | ✓ | | |
| staff management | ✓ | | |
| own jobs (crew app) | ✓ | ✓ | ✓ |

Permission is checked **per action on the server**, not per page in the
browser. Hiding a nav item is a courtesy; the 403 is the control. Tests assert
a dispatcher gets 403 on review moderation and that the review stays PENDING.

## Cleaner scoping

`GET /crew/jobs` derives `staffId` from the signed-in account. For a CLEANER
the query parameter is ignored entirely, so `?staffId=<colleague>` cannot read
someone else's day. Status transitions check that the booking is actually
assigned to that cleaner and return 403 otherwise.

## Creating accounts

```bash
npm run staff:create -- --email you@r2nette.ca --name "Your Name" --role OWNER
npm run staff:create -- --email alice@r2nette.ca --name "Alice" \
  --role CLEANER --staffId <staff-row-id>
```

The password is generated and printed **once**. There is no recovery, only a
reset — the hash cannot be reversed. Every new account starts with
`mustChangePassword`.

## Audit

`STAFF_LOGIN`, `STAFF_LOGIN_FAILED` and `STAFF_PASSWORD_CHANGED` are written
with `actorType: STAFF` and the actor's id. Every privileged action is
attributable to a person.

## Still to do before public exposure

- HTTPS everywhere (the Secure cookie flag depends on it)
- Rate limiting at the edge, in front of the app
- Optional second factor for OWNER accounts
