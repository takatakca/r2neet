# Work log

Newest first, one line per piece of work. Rule: `AGENTS.md` › Work log rule.
Format: `YYYY-MM-DD | agent | branch → PR | status | what | next step`

- 2026-10-14 | codex | codex/booking-extras-20261014 → PR pending | active | Connect existing backend add-ons to customer booking with authoritative server pricing and simple quantity controls | expose active add-ons, wire quote payload, premium extras UI, push to main
- 2026-10-14 | codex | codex/booking-experience-phase2-20261014 → PR pending | ready to merge | Booking UX phase 2: live desktop/mobile booking summary with direct edit links and stronger continuity across the flow | open/merge PR to main; production stays protected by existing CI/deploy gate; TAKATAK sync remains disabled
- 2026-10-14 | codex | codex/r2nette-takatak-outbox-20261013 → PR #18 | active / booking UX pushed | Added durable TAKATAK bridge (disabled by default) plus premium bilingual booking shell, guided progress, service/property/address/availability/details/checkout/confirmation UX | continue section-by-section booking polish, then merge to main when repo protections permit; automatic R2NETTE deploy follows main
- 2026-10-08 | claude (owner setup) | default branch | done | Added the work log rule, this log and the stop reminder | every agent follows AGENTS.md › Work log rule
