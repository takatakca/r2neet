# Work log

Newest first, one line per piece of work. Rule: `AGENTS.md` › Work log rule.
Format: `YYYY-MM-DD | agent | branch → PR | status | what | next step`

- 2026-10-15 | ChatGPT | chatgpt/api-response-hardening-20261015 → PR pending | active | Fail safely on non-JSON proxy errors and invalid API bodies; preserve typed server errors | review CI, merge, verify deploy

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
