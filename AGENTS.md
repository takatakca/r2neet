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

## Owner documentation requirement — 2026-10-24

The owner requests organized, dated, signed agent notes. Use `docs/dossier-client-r2nette/INDEX.md` as the current technical handoff index and `06-regles-des-notes-agent.md` for the note format. Read the owner-designated OneDrive instructions when the connection makes them accessible; do not claim to have read inaccessible notes. Continue independent work and record that access limitation. Preserve prior notes, attribute only your own intervention, and keep private customer inventories and credentials out of this public repository.

Recorded by Codex — OpenAI assistant, 2026-10-24 (America/New_York), from the owner's instruction in this conversation.
