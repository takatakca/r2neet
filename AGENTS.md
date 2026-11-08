# Agent instructions

**Mandatory restart:** read `AGENTS.md`, `docs/AGENT_HANDOFF.md`, `docs/TASK_QUEUE.md`, `docs/PROJECT_STATUS.md`, `docs/DEPLOYMENT.md` and `docs/DECISIONS.md`; then verify that the documented SHA matches the actual GitHub branch and release runs. Continue the next task, not a new implementation. Update the handoff before stopping. Keep `WORKLOG.md` as the short claim ledger.

## Work log rule (every agent: Claude, Codex, Cursor, people)

Cheap to follow: read only what is listed here.

1. **Before you start:** read the top of the log (`head -40 WORKLOG.md`) and the titles of open pull requests (`gh pr list`). If a line for the same work is `active` or has an open PR, do not redo it: continue that branch or pick other work.
2. **Claim it:** add one line at the top of the log with status `active`.
3. **Before you stop:** update your line with the status (`done`, `PR #n`, `blocked: reason`) and the next step. Commit and push it with your work. Never stop with unlogged work.
4. One line per piece of work, newest first. Details go in the PR, not the log.

Line format: `YYYY-MM-DD | agent | branch → PR | status | what | next step`

## Brand rule

Everything visual or written for TAKATAK follows `BRAND.md` (logo, colours, tagline, services). Electric blue on deep navy; never the old gold "TK" logo; green is for status only.

## Signed owner handoff — 2026-10-29, Codex — assistant OpenAI

The owner requires signed, dated notes in GitHub AND the existing Google Drive MAIN → Rapide 2 Nette section for every change. Read its ROBOTS protocol, live journal, work registry and client/platform notes before writing there. Keep provider secrets and private customer data outside this public repository. Record source changes, actual test/CI proof, deployment state, blockers and next action separately. Current premium flow audit: `docs/experience/2026-10-29-premium-audit.md`; PR46 remains blocked on verified protected email-provider activation, not owner permission. Preserve the separate open CRM PR43 and other agents' commits.
