## Current customer-growth work — 2026-10-22

- Gmail source inventory and bilingual marketing preferences: branch `feat/customer-source-inventory-20261022`; local extraction/HTTP tests and frontend build pass, GitHub CI required.
- Imported correspondence is review-only, with source references and unknown marketing eligibility. Wave/Setmore exports and live CRM data are still outstanding.
- Deployment remains blocked: latest full image attempt #38952711773 failed ENOSPC after PR #39 merged. Obtain server disk inspection/recovery before a new full roll.

# R2NETTE — Task queue

Reviewed: **2026-10-16**. Continue from `AGENTS.md`, `WORKLOG.md` and `docs/AGENT_HANDOFF.md`; no fake provider readiness.

| Priority | Work | State | Acceptance |
| --- | --- | --- | --- |
| P0 | Contabo disk full; restore safe image deployment | PR #39 P0 ACTIVE | Reclaim old R2NETTE SHA images only, preserve current/rollback, other apps and all volumes; verify actual roll |
| P1 | PostgreSQL dump PGDMP header/size guard | PR #38 OPEN, CI green, do not merge before disk recovery | Both manual and scheduled archive validation before off-host upload or retention |
| P0 | Real Stripe keys and signed webhook | BLOCKED: protected provider configuration | Server amount + tax, idempotent signed event, real state and refund end-to-end |
| P0 | Off-host S3 account, alerts and recovery | BLOCKED: provider choice/secure credentials | Actual PUT/HEAD/GET digest, object retention, scratch restore with FIELD_ENCRYPTION_KEY, alert receipt |
| P0 | Twilio/Supabase real phone authentication | BLOCKED: provider setup | Verified OTP delivery and auth, no production bypass |
| P0 | TAKATAK signed receiver and tenant-scoped sync | BLOCKED: receiver PR #175 and operational approval | HMAC invalid rejected; signed events accepted, receiver deployed; then enable sender |
| P1 | Google Maps + verified dispatch origin | BLOCKED: production key/coordinates | Real address and dispatch behaviors with failure handling |
| P1 | Customer, staff, recurrence, booking and payment smoke | TODO: controlled real-provider acceptance | FR/EN mobile/desktop, quote and slot, access scopes, cancel/reschedule, payments, workers |
| P1 | Verify operational alerting, worker history and recovery key custody | TODO: operator live test | Owner receives test incident and sees actual worker successes/failures |
| P2 | Review historical PR #17 | OPEN, unrelated 2026-10-08 rollout notes | Retain history without replacing newer evidence |
| P2 | Keep five agent docs and WORKLOG current | ONGOING | Correct latest SHA, non-skipped deployment proof and next action |

| P1 | Bound database dump upload memory for large PostgreSQL backups | IN PROGRESS: chatgpt/s3-stream-upload-20261016 | Signed two-pass streamed PUT, 5 GiB single-PUT limit and streaming regression tests; CI/roll pending |

## Completed and deployed

- PR #34 S3 streamed remote SHA-256 verification, CI #38853348818, Deploy #38853464615 (`02b0653c`).
- PR #35 safe local fallback retention after fresh dump even on off-host failure, CI #38853881854, Deploy #38853994829 (`46fa61d3`).
- PR #36 bounded alert webhook timeout, CI #38854383066, Deploy #38854525800 (`56cde1b6`).
- PR #33 pg_dump argv secret protection; #32 fail-closed backup and one-per-day failed attempts; #30 trusted-proxy client throttling; #29 Docker bounded retries; #28 structured HTTP errors; #27 private draft storage; #26 Unicode ICS.

**Never claim operational completion from green code CI alone; provider provisioning and real acceptance remain blocked until actual proof.**
