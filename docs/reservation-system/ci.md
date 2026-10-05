# Continuous integration

## The gap this closed

631 tests existed and nothing ran them. The entire quality regime depended on
someone remembering — which is not a regime, it is a habit, and habits lapse
exactly when a release is rushed.

`.github/workflows/ci.yml` runs on every push and every pull request.

## Four jobs, then one gate

**`static`** — typecheck, build all four pages, build the standalone preview.
Fast signal first: a broken commit says so in seconds rather than waiting on a
five-minute test run.

It also enforces a **bundle budget of 400KB** (currently 396KB). A silent size
jump almost always means a server dependency was pulled into the browser by
accident. Page photos are copied into `dist/assets` as well, so they count.

**`test`** — Postgres 16 service container, then:

- `prisma migrate deploy` against an **empty** database. `db push` would hide
  a broken migration until deploy day.
- `prisma migrate diff --exit-code`, which catches a schema edited without a
  matching migration — that passes locally and fails in production.
- the full suite with coverage
- **business invariants**, and **per-directory coverage thresholds**

**`safeguards`** — the invariants that protect money and customer data,
separated so a failure here is unmistakable in the checks list:

| Check | Regression it prevents |
|---|---|
| No live credentials committed | A real key in git history |
| `.env` not tracked | Same, by accident |
| No `ADMIN_TOKEN` in live code | Returning to a shared, unrevocable operator secret |
| `ops.ts` reads no `Authorization` header | Bypassing per-person staff sessions |
| No inline `onclick` in the booking page | The bundling outage that shipped a dead page |

**`container`** — builds the Docker image and asserts that production startup
**refuses** a configuration with a leftover `ADMIN_TOKEN`. Proves a clean
machine can run this, which local success does not.

**`ci`** — a single required check depending on the other four, so branch
protection needs one rule rather than one per job.

## Why there is no minimum test count

There was one — 600 — and it was a bad check.

With 631 tests it silently permitted deleting 31. It could not say *which* 31,
so a failure told you a number had moved rather than what stopped being
verified. And it rewarded padding the suite with trivia, which makes coverage
look better while proving nothing.

It answered "are there enough tests?" when the question is "are the things
that must never break still proven?"

### Business invariants

`tests/invariants.ts` names 34 rules that would cost money, break the law, or
expose customer data if they regressed. Each carries a stable id, and the
proving test embeds that id in its title:

```ts
it('[INV-TAX-01] returns GST $6.75, QST $13.47, total $155.22 without compounding', ...)
```

**The tag is the contract; the sentence is documentation.**

The first version matched a substring of the test name, which was a guess
about prose. Renaming a test silently broke the link, and a loose phrase like
`'replay'` could rebind an invariant to a different, weaker test that happened
to contain the same word — the failure mode where the check reports green
while guaranteeing nothing.

### Verified by falsification

| Change | Result |
|---|---|
| Reword the test, keep the tag | **PASS** — prose is free to change |
| Remove the tag | `MISSING INV-TAX-01` |
| Put the tag on a second, weaker test | `AMBIGUOUS INV-TAX-01` |
| Tag a test with an undeclared id | `ORPHAN INV-AUTH-99` |

The ambiguity check matters: two tests claiming one invariant means neither is
definitively the proof, so it is resolved rather than guessed. The orphan
check catches someone believing a rule is protected when nothing tracks it.

A test that **moves file** is reported as a note, not a failure — the
guarantee still holds, only the declared location is stale.

The old count check would have reported "630 tests, above the floor of 600"
and passed through every one of these.

Adding an invariant is a deliberate act; so is removing one. Removal requires
editing `tests/invariants.ts`, which shows up in review as "we have decided to
stop guaranteeing this" rather than as a number changing.

### Per-directory coverage

Thresholds are set per critical directory in `vitest.config.ts`, not globally.
A single global number lets well-covered UI helpers mask a gap in the pricing
engine.

| Path | Threshold | Actual |
|---|---|---|
| `src/engine` | 90% | 97.2% |
| `src/scheduling` | 80% | 97.2% |
| `src/auth` | 80% | 94.7% |
| `src/promotions` | 80% | 93.2% |
| `src/payments` | 70% | 81.4% |

Coverage still measures whether lines ran, not whether behaviour is correct.
It is the floor; the invariants are the actual guarantee.

## Two safeguards I had to fix before they were useful

Both were correct in intent and wrong in practice:

- The secret scanner flagged `sk_live_x` in test fixtures — deliberately fake
  values in `tests/`. A check that cries wolf gets ignored, which is worse
  than no check. Now it requires realistic key lengths, skips `tests/`, and
  excludes AWS's own documentation example key.
- The `ADMIN_TOKEN` check flagged `hardening.ts`, which reads that variable
  **in order to refuse it** at startup. The production deploy gate does the
  same. Both files are excluded, along with comments; the ban is on code that
  authenticates with one.

Finding these locally is the point. A CI check that fails on correct code
teaches people to ignore CI.

## Weekly restore drill

`.github/workflows/backup-verify.yml` runs `scripts/restore-drill.ts` every
Monday.

The drill previously existed as a throwaway script run once — precisely the
kind of verification that decays. It is now committed and runs on a schedule:

```
PASS  Two-factor secret is encrypted at rest
PASS  Backup produced a dump
PASS  Every table restored with matching counts
PASS  Booking number preserved
PASS  Frozen total preserved — 20121
PASS  GST and QST preserved as separate lines
PASS  Promotion claim still redeemed
PASS  Recurring visit kept its local time — 10:00
PASS  Two-factor still required after restore
PASS  Owner signs in with the CORRECT key
PASS  The WRONG key denies access
11/11 checks passed.
```

It proves the **pair**: restored database plus correct key lets the owner in;
the wrong key does not. The dump alone is not a backup.

## Running the same checks locally

```bash
npm run ci              # typecheck, build, tests
npm run drill:restore   # the full recovery drill
```

## Recommended branch protection

Require the `CI` check on `main`. That single rule covers all four jobs.
