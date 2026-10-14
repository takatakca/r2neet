# R2NETTE — Task queue

Last reviewed: 2026-10-14. Do not reset completed work. Respect `AGENTS.md` claims and open PRs.

| Priority | Work | State / owner | Acceptance |
| --- | --- | --- | --- |
| P0 | Activate Stripe server configuration + signed webhook | BLOCKED: secure production values | Controlled test verifies amount, idempotency, webhooks, refund and booking state; no card details stored |
| P0 | Add off-host backup and alert destination | BLOCKED: provider choice and protected credentials | Scheduled backup verified by HEAD, off-host restore drill, matching encryption key and alert receipt |
| P0 | Configure phone/voice/SMS and verify identity | BLOCKED: Twilio/Supabase provider setup | OTP delivery and verification, no production mock/guest bypass, approved message routing |
| P0 | TAKATAK synchronization | BLOCKED: takatak-v1 PR #175, receiver deployment and signed tests | Rejects invalid HMAC; test events accepted, tenant scoped; only then enable sender |
| P1 | Google Maps/business origin | BLOCKED: key and confirmed coordinates | Address/dispatch and provider-failure paths verified |
| P1 | Calendar export UTF-8 line folding | IN PROGRESS: ChatGPT branch `chatgpt/r2nette-handoff-ics-20261014` | RFC 5545 limit of 75 octets per physical line, accurate Unicode round trip, CI green |
| P1 | Full booking/customer/crew/payment browser smoke | TODO after required providers | FR+EN, mobile, quote total from server, confirmed slot, staff scopes, cancel/reschedule/recurrence |
| P1 | Verify production alerting, scheduled worker history and key-recovery documentation | TODO | Owner sees verified worker successes and actual incident alerts |
| P2 | Reconcile open production-roll documentation PR #17 | TODO: check proposed text before merging | Accurate release evidence; avoid resurrecting stale claims |
| P2 | Keep five agent handoff/status documents current | IN PROGRESS | SHA, deployment, outstanding tasks and next action are precise |

Each task needs implementation **and** passing required checks; statuses must change only on evidence. For blocked work, continue independent tasks and record the exact dependency. Do not put credentials in git, issues, CI logs or handoffs.

