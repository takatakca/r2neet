# R2NETTE — Task queue

Last reviewed: 2026-10-16. Do not reset completed work. Respect `AGENTS.md` claims and open PRs.

| Priority | Work | State / owner | Acceptance |
| --- | --- | --- | --- |
| P0 | Activate Stripe server configuration + signed webhook | BLOCKED: secure production values | Controlled test verifies amount, idempotency, webhooks, refund and booking state; no card details stored |
| P0 | Fail closed on local-only backups; prevent minute-by-minute failed daily attempts | DONE: PR #32; deployed aa51fd30 | Scheduler failure backoff + missing-target alert + failure persistence with regression tests; CI #38848882332 and non-skipped Deploy #38849030331 verified |
| P1 | Prevent PostgreSQL backup passwords leaking into process arguments | DONE: PR #33; deployed 1c140ac1 | Password removed from pg_dump argv, PGPASSWORD provided to child; regression tests and exact-SHA deployment verified |
| P0 | Verify actual S3 off-host backup content, not only HEAD length | IN PROGRESS: chatgpt/s3-verified-backup-digest-20261016 | PUT → HEAD → streamed GET SHA-256 matches local digest, rejects same-size tampering and short GET; CI then exact-SHA deploy |
| P0 | Add off-host backup and alert destination | BLOCKED: provider choice and protected credentials | Scheduled backup verified by HEAD, off-host restore drill, matching encryption key and alert receipt |
| P0 | Configure phone/voice/SMS and verify identity | BLOCKED: Twilio/Supabase provider setup | OTP delivery and verification, no production mock/guest bypass, approved message routing |
| P0 | TAKATAK synchronization | BLOCKED: takatak-v1 PR #175, receiver deployment and signed tests | Rejects invalid HMAC; test events accepted, tenant scoped; only then enable sender |
| P1 | Google Maps/business origin | BLOCKED: key and confirmed coordinates | Address/dispatch and provider-failure paths verified |
| P0 | Stabilize Docker image build on transient npm ECONNRESET | DONE: PR #29 and deployed 6a7f192e | Bounded npm ci retries in Dockerfile, Docker CI pass, non-skipped deployment verifies new image |
| P0 | Protect OTP/auth rate limits against X-Forwarded-For spoofing | DONE: PR #30, deployed a46849b5 (CI and probes green) | Verify trusted proxy one-hop IP selection, reject spoofed per-client changes, CI and rollout |
| P1 | Handle malformed and non-JSON API/proxy responses | DONE: PR #28, CI green | Structured non-leaky failures, retain official error codes and reprice payload; CI passes |
| P1 | Privacy-safe booking draft and legacy browser-storage cleanup | DONE: PR #27, CI #38775267147 passed | Never persist address ID/text, identity, notes or hold; resume safely, clear confirmed bookings; CI regression tests |
| P1 | Calendar export UTF-8 line folding | DONE: [PR #26](https://github.com/takatakca/r2neet/pull/26), CI green | RFC 5545 75-octet physical lines, Unicode round trip and event injection regression proven by CI |
| P1 | Full booking/customer/crew/payment browser smoke | TODO, blocked on provider readiness | FR+EN, mobile, quote total from server, confirmed slot, staff scopes, cancel/reschedule/recurrence |
| P1 | Verify production alerting, scheduled worker history and key-recovery documentation | TODO | Owner sees verified worker successes and actual incident alerts |
| P2 | Reconcile open production-roll documentation PR #17 | TODO: check proposed text before merging | Accurate release evidence; avoid resurrecting stale claims |
| P2 | Keep five agent handoff/status documents current | PR #31 merged (b845e0f1); ONGOING after each release | Update SHA and real deployment/worker statuses after every release |

Each task needs implementation **and** passing required checks; statuses must change only on evidence. For blocked work, continue independent tasks and record the exact dependency. Do not put credentials in git, issues, CI logs or handoffs.

