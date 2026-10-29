# Owner actions — r2nette.ca

Updated 2026-10-29. Hands-on checklist for the hosting move (MochaHost → Coolify). The main file for all sites is in Google Drive › 00 — Opérations TAKATAK: “2026-10-29 — TAKATAK hosting (MochaHost → Coolify) — MAIN FILE — OWNER and CLAUDE actions”. Item numbers are the same everywhere. This repository is public: no secret values and no hosting-account details are written here, only key names, settings and steps; account-level steps are in the private Drive main file.

**Labels**

- 🔧 OWNER — you do it by hand (accounts, keys, payments, approvals, merges, WHM)
- 🤖 CLAUDE — the agent does it; usually waits for an OWNER item
- ✅ DONE — finished and verified

## Where this site runs

- Website: https://r2nette.ca — Contabo vps1, deployed by this repo's GitHub Actions (not a Coolify app); #44 merged and verified (commit 7443452)
- DNS zone and mail: still in the old MochaHost account for r2nette.ca. The main MochaHost account already holds a copy of the zone and the 3 forwarders aide@, evaluation@, recouvrement@ → r2nette.ca@gmail.com
- After O-13 the domain, its DNS and its mail live in the main MochaHost account; its DKIM key then applies, which ends the current DKIM mismatch

## 🔧 OWNER — manual work

### O-01 · 🔧 OWNER · ⬜ TO DO — Merge the open pull requests
- ocarinaspa #3 (removes Lovable; it also contains #2, so #2 closes by itself)
- The notes/fix PRs opened on 2026-10-29: revers-canada-hope (header fix + notes), droneair (revision + health check + notes), mimtcaapp (notes), r2neet (notes)
- mimtcaapp #77 (from another agent: removes the old FTP uploads from the Deploy workflow)

### O-13 · 🔧 OWNER · ⬜ TO DO — Retire the old MochaHost account of this domain
- Only after this site works on Coolify; first download that account's backup
- The exact account, backup file and WHM steps are in the private Drive main file (item O-13)
- *Waits on:* each site working (O-02…O-11)

## 🤖 CLAUDE — agent work

### C-08 · 🤖 CLAUDE · ⏳ WAITING — Test each site end to end after its keys are in
- Restart/redeploy, then forms, emails, Stripe test payment, /readyz; update the GitHub notes and this main file
- *Waits on:* O-02…O-11

### C-10 · 🤖 CLAUDE · ⏳ WAITING — After the old account is retired, check that DNS and mail are served by the main MochaHost account
- Compare the served zone with the prepared copy, re-save it if needed, then check the website and mail
- *Waits on:* O-13

### C-12 · 🤖 CLAUDE · 🔁 ONGOING — Keep the notes current
- docs/OWNER_ACTIONS.md in each repo and this main file

When you finish an OWNER item, tell the agent its number (for example “O-02 done”); the agent then does the CLAUDE items waiting on it and updates this file.
