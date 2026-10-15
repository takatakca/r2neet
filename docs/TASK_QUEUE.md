# R2NETTE — Task queue

Last reviewed: 2026-10-15. Do not reset completed work. Respect `AGENTS.md` claims and open PRs.

| Priority | Work | State / owner | Acceptance |
| --- | --- | --- | --- |
| P0 | Activate Stripe server configuration + signed webhook | BLOCKED: secure production values | Controlled test verifies amount, idempotency, webhooks, refund and booking state; no card details stored |
| P0 | Add off-host backup and alert destination | BLOCKED: provider choice and protected credentials | Scheduled backup verified by HEAD, off-host restore drill, matching encryption key and alert receipt |
| P0 | Configure phone/voice/SMS and verify identity | BLOCKED: Twilio/Supabase provider setup | OTP delivery and verification, no production mock/guest bypass, approved message routing |
| P0 | TAKATAK synchronization | BLOCKED: takatak-v1 PR #175, receiver deployment and signed tests | Rejects invalid HMAC; test events accepted, tenant scoped; only then enable sender |
| P1 | Google Maps/business origin | BLOCKED: key and confirmed coordinates | Address/dispatch and provider-failure paths verified |
| P0 | Stabilize Docker image build on transient npm ECONNRESET | DONE: PR #29 (CI green), production proof pending | Bounded npm ci retries in Dockerfile, Docker CI pass, non-skipped deployment verifies new image |
| P0 | Protect OTP/auth rate limits against X-Forwarded-For spoofing | IN PROGRESS: `chatgpt/trusted-proxy-rate-limits-20261015` | Verify trusted proxy one-hop IP selection, reject spoofed per-client changes, CI and rollout |
| P1 | Handle malformed and non-JSON API/proxy responses | DONE: PR #28, CI green | Structured non-leaky failures, retain official error codes and reprice payload; CI passes |
| P1 | Privacy-safe booking draft and legacy browser-storage cleanup | DONE: PR #27, CI #38775267147 passed | Never persist address ID/text, identity, notes or hold; resume safely, clear confirmed bookings; CI regression tests |
| P1 | Calendar export UTF-8 line folding | DONE: [PR #26](https://github.com/takatakca/r2neet/pull/26), CI green | RFC 5545 75-octet physical lines, Unicode round trip and event injection regression proven by CI |
| P1 | Full booking/customer/crew/payment browser smoke | TODO, blocked on provider readiness | FR+EN, mobile, quote total from server, confirmed slot, staff scopes, cancel/reschedule/recurrence |
| P1 | Verify production alerting, scheduled worker history and key-recovery documentation | TODO | Owner sees verified worker successes and actual incident alerts |
| P2 | Reconcile open production-roll documentation PR #17 | TODO: check proposed text before merging | Accurate release evidence; avoid resurrecting stale claims |
| P2 | Keep five agent handoff/status documents current | IMPLEMENTED, ONGOING | Update SHA and real deployment/worker statuses after every release |

Each task needs implementation **and** passing required checks; statuses must change only on evidence. For blocked work, continue independent tasks and record the exact dependency. Do not put credentials in git, issues, CI logs or handoffs.

