# Work log

Newest first, one line per piece of work. Rule: `AGENTS.md` › Work log rule.
Format: `YYYY-MM-DD | agent | branch → PR | status | what | next step`

- 2026-10-19 | Cursor | fix/phone-otp-entry-20261019 → PR #41 | active | Format numbers typed without a leading 1 as (514) 825-2825 on the running login page, without pulling a new image | Manual login-format workflow; full image deploy still blocked by Contabo disk
- 2026-10-16 | ChatGPT | chatgpt/contabo-disk-recovery-20261016 → PR #39 | active/P0 | Fix VPS ENOSPC image pulls with R2NETTE-only pre-pull cleanup; do not touch running/rollback, other sites or volumes | CI, merge, verify non-skipped deployment
- 2026-10-16 | ChatGPT | chatgpt/pgdump-artifact-validation-20261016 → PR #38 | green CI, pending merge | Validate PostgreSQL custom dump before S3 upload or fallback purge | after recovery
- 2026-10-16 | ChatGPT | chatgpt/s3-stream-upload-20261016 → PR #37 | merged, DEPLOY FAILED ENOSPC | Stream signed S3 PUT; main CI #38950346352 green, Deploy #38950594071 failed | recover disk safely, then deploy

- 2026-10-16 | ChatGPT | chatgpt/s3-stream-upload-20261016 → PR pending | active | Stream S3 backup uploads in bounded memory with two-pass SigV4 hashing, reject single PUT >5 GiB; add tests | PR CI → green merge → non-skipped Contabo deploy; S3 credentials/restore still blocked

- 2026-10-16 | ChatGPT | chatgpt/alert-webhook-deadline-20261016 → PR #36 | done | 10-second alert webhook deadline prevents indefinite worker stall | PR CI #38854212430, main CI #38854383066, non-skipped Deploy #38854525800 verified 56cde1b6
- 2026-10-16 | ChatGPT | chatgpt/backup-local-retention-20261016 → PR #35 | done | Retain safe fresh dump; prune expired local fallback files even when S3 fails | PR CI #38853550724, main CI #38853881854, non-skipped Deploy #38853994829 verified 46fa61d3
- 2026-10-16 | ChatGPT | chatgpt/s3-verified-backup-digest-20261016 → PR #34 | done | Remote signed GET SHA-256 verifies S3 backup content; fixed historical test mock | PR CI #38853224241, main CI #38853348818, non-skipped Deploy #38853464615 verified 02b0653c

- 2026-10-16 | ChatGPT | chatgpt/backup-pg-cli-secret-protection-20261015 → PR #33 | done | Strip database password from pg_dump argv and use child PGPASSWORD; regression tests | PR CI #38849124573, main CI #38849296051, Deploy #38849434426 all green; 1c140ac1 verified
- 2026-10-16 | ChatGPT | chatgpt/backup-daily-failure-hardening-20261015 → PR #32 | done | Once-a-day retry after failed daily backup; local-only backup FAILS and opens incident | PR CI #38848750100, main CI #38848882332, Deploy #38849030331 verified aa51fd30


- 2026-10-15 | ChatGPT | main | done | Verified CI #38778348493 and actual non-skipped Contabo deploy #38778654257 for 2ca571af with /healthz and /readyz OK | next: issue #25 provider setup and real end-to-end acceptance

- 2026-10-15 | ChatGPT | chatgpt/finalize-handoff-20261015 → PR #31 | done | Reconcile real CI/deploy SHAs for privacy, API resilience, Docker and trusted-proxy releases in five status files | a46849b5 deployment verified, PR CI #38778002480 green; merged as b845e0f1

- 2026-10-15 | ChatGPT | chatgpt/trusted-proxy-rate-limits-20261015 → PR #30 | done | Block X-Forwarded-For spoofing from bypassing SMS/auth request throttling | PR CI #38776981777 and main CI #38777285346 green; merged a46849b5; Deploy #38777515485 verified /healthz and /readyz

- 2026-10-15 | ChatGPT | chatgpt/docker-npm-network-recovery-20261015 → PR #29 | done | Harden Docker npm ci against bounded ECONNRESET retry; failed Deploy #38775849037 at npm ci | PR CI #38776351883 green, merged as 6a7f192e; main CI #38776617739 + Deploy #38776842943 verified 6a7f192e, health and readiness OK

- 2026-10-15 | ChatGPT | chatgpt/api-response-hardening-20261015 → PR #28 | done | Fail safely on non-JSON proxy errors and invalid API bodies; preserve typed server errors | PR CI #38775884609 passed; merged as ce8eb68d; main CI #38776160520 + Deploy #38776393992 verified ce8eb68d, health and readiness OK

- 2026-10-15 | ChatGPT | chatgpt/privacy-safe-booking-draft-20261015 → PR #27 | done | Remove sensitive address/slot context from browser draft, migrate legacy storage, avoid resurrecting confirmed booking | PR CI #38775267147 passed; merged as c7a47233; main deployment pending

- 2026-10-14 | ChatGPT | chatgpt/r2nette-handoff-ics-20261014 → PR #26 | done | Fold RFC5545 UTF-8 ICS lines + regression test; added five durable agent files and corrected TAKATAK gate | PR CI #38612761806 passed; merged to main as 39e10d16, verify matching main deployment

- 2026-10-14 | ChatGPT | main (docs) | done | Replaced outdated phase-1 README with current platform features, deployment and configuration boundaries | continue configuring optional live integrations and verifying end-to-end flows

- 2026-10-14 | ChatGPT | chatgpt/deploy-skip-stale-20261014 → PR #24 | done | Protect Contabo Deploy from queued obsolete commits and last-minute main changes | PR CI passed; merged to main as 3ff24c9d

- 2026-10-14 | ChatGPT | chatgpt/ics-export-hardening-20261014 → PR #23 | done | Escape RFC5545 calendar text and guard against injected ICS lines, add regression test | CI passed; merged to main in 6d1ea234

- 2026-10-14 | ChatGPT | main (CI unblock) | done | Correct frontend booking fixture after nullable serviceDetails contract change; restore TypeScript CI gate for production rollout | CI and Deploy #38609851341 passed, including /healthz and /readyz

- 2026-10-14 | codex | codex/booking-product-catalogue-20261014 → PR pending | ready to merge | Product options/prices and frequency savings are now server-driven; stale incompatible product drafts clear automatically | merge to main, continue auditing booking for client/backend drift
- 2026-10-14 | codex | codex/booking-service-context-20261014 → PR pending | ready to merge | Made property/contact fields operational: correct rental model, additive booking serviceDetails, real profile save, safe usual-clean reuse, crew context | review diff then merge to main and continue booking UX
- 2026-10-14 | codex | codex/booking-extras-20261014 → PR pending | ready to merge | Connected active backend add-ons to booking catalogue, draft, quote payload, live summary and bilingual premium quantity UI | merge to main and continue property/short-term-rental booking polish
- 2026-10-14 | codex | codex/booking-experience-phase2-20261014 → PR pending | ready to merge | Booking UX phase 2: live desktop/mobile booking summary with direct edit links and stronger continuity across the flow | open/merge PR to main; production stays protected by existing CI/deploy gate; TAKATAK sync remains disabled
- 2026-10-14 | codex | codex/r2nette-takatak-outbox-20261013 → PR #18 | active / booking UX pushed | Added durable TAKATAK bridge (disabled by default) plus premium bilingual booking shell, guided progress, service/property/address/availability/details/checkout/confirmation UX | continue section-by-section booking polish, then merge to main when repo protections permit; automatic R2NETTE deploy follows main
- 2026-10-08 | claude (owner setup) | default branch | done | Added the work log rule, this log and the stop reminder | every agent follows AGENTS.md › Work log rule
