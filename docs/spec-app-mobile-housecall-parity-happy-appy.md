# SPEC A–Z — R2NETTE MOBILE APP — FULL FEATURE PARITY WITH HOUSECALL PRO
## Mission order for the developer agent **Happy APPY** — issued by Taktak (boss, coordination) on behalf of Matt, owner, Groupe TAKATAK
**Date:** 2026-10-31 · **Project:** Rapide 2 Nette (R2NETTE.CA) — home-services engine company of Groupe TAKATAK
**Repo:** github.com/takatakca/r2neet · **Drive:** folder « Rapide 2 Nette » (MAIN) · **Site live:** r2nette.ca
**Signed:** Taktak

---

## 0. THE ORDER (Matt, 2026-10-31 06:01–06:04)

Matt personally walked the entire Housecall Pro mobile app on his phone and sent **49 screenshots** covering it end to end. His order, verbatim in substance:

> « This is for R2NETTE.CA. R2net in GitHub. The mobile app they building must be the exact same as in here features. […] You give all specs from A to Z, from top to bottom, from left to right, from menu to menu, from item to item, from line to line, from image to image, from UX to UI design, to upgrading, to optimizing, to connecting with what we already have, and to after actually take this to the next level when it's time. […] This person is going to handle this job, he's going to be called **Happy APPY**. »

**Happy APPY — that is you.** You own the R2NETTE mobile app build. Taktak is your boss: you report to Taktak, you escalate blockers to Taktak only, and your first act (see §11) is to **reply and stamp your name** before writing code.

**What "exact same" means, precisely:** every screen, menu, field, toggle, flow and feature Matt captured in Housecall Pro must exist and work in our app, in the same order and with the same behaviour — rebuilt as **our own original code and design** under the TAKATAK/R2N brand (BRAND.md tokens, §6). We clone the *feature set, structure and UX patterns*; we never copy Housecall Pro's name, logo, graphics, texts or assets.

---

## 1. NOTE D'AVANT — ÉTAT LU (read before building; do not re-ask Matt for any of this)

### 1.1 What already exists and must be connected, not reinvented
- **Repo `takatakca/r2neet`** (TypeScript): Express 5 API (`src/api/server.ts`), Prisma 6 + PostgreSQL, Stripe SDK v22, Vite builds (incl. `build:single`), Vitest + Playwright, Dockerfile + Coolify compose files. Root files already present: `AGENTS.md`, `BRAND.md`, `README.md`, `RUN.md`, `WORKLOG.md`, `booking.html`, `prisma/`, `src/`, `web/`, `tests/`, `scripts/`.
- **Workers already coded:** `worker:recurrence` (recurring jobs), `worker:billing`, `worker:membership`, plus loop scripts for billing/scheduler/backup, `staff:create`, and **`migrate:setmore` (`scripts/import-setmore.ts`)** — a Setmore data import already exists.
- **Site r2nette.ca is LIVE** (SPA): sections `#book`, `#howItWorks`, `#reviewsSection`, `/auth`; checkout + recurring already in code; the product promise is **exact price with taxes shown before confirmation** — the app must honour the same promise everywhere.
- **Pricing engine:** the package is literally named `@r2nette/pricing` — "authoritative reservation pricing & quote engine". The app consumes this engine/API; it never re-implements pricing.
- **Stripe:** connector is connected; products/prices and live activation are configured on the platform project (not your blocker unless Taktak says so).
- **Facebook:** developer app « Rapide 2 Nette — Int. TAKATAK » **ID 29183148337978023** (Facebook Login for Business added), Page **1044118655779183**, portfolio **290660949663703**, ad account **738101160929754**. App Review is pending business verification — outside your scope; build against the app as-is.
- **Deployment reality:** hosting runs on Coolify/Contabo; the host `vmi3621936` is currently DOWN (ticket 16240531435, restore in progress, **no reinstall, no data wipe**). Build and test locally/in-repo; deploy when Taktak confirms the host is back. Never report the servers as restored without a live check.

### 1.2 Canonical Rapide 2 Nette data (use exactly; « lire avant de saisir » — read live before entering anywhere)
- Business name: **Rapide 2 Nette** · Email: **r2nette.ca@gmail.com** · Website: **https://r2nette.ca**
- Reservations phone (public): **+1 514-444-8578** · General business phone (as entered in the Housecall Pro profile): **(514) 458-4587**
- Profile as entered by Matt in Housecall Pro: First « Rapide », Last « 2 Nette »; address **4625 rue Fairway**; postal code **H8T 1B7**; time zone **(GMT-04:00) Eastern Time — Toronto**. Treat the address/postal code as *as-entered reference only* — confirm with Taktak before publishing them anywhere public.
- Coverage: Montréal + Laval + Rive-Sud · Booking online 24/7 · **Everything bilingual FR/EN** (Canadian French).
- Taxes (Québec): **TPS 5 % + TVQ 9,975 %** — the tax-rate presets the app must ship with.

### 1.3 State of the Housecall Pro account Matt captured (2026-10-31, app version 2026.10.13 (933), Android OS 16)
- Brand-new/empty account: **Invoices $0.00 (Collected $0 / Uncollected $0)**, **Estimates $0.00 (Won $0 / Created $0)**, **Price book EMPTY** (no services, no materials), **Tax rates: NONE configured**, **Payments NOT activated** (the setup flow stops at the manual bank-connection screen — bank details are Matt's gesture alone, never enter or ask for them in code, chat or notes beyond this mention).
- Conclusion: parity target = **the feature set and flows**, not their data. There is nothing to migrate from Housecall Pro.

### 1.4 Decisions already made — do not reopen
- **Setmore is FINISHED** (Matt, 2026-10-21/22: « Setmore, c'est FINI » — removed everywhere; our own platform replaces it). Matt also captured Setmore screens on 2026-10-31 (booking page, services & classes, customers, calendar, settings tree, Reviews module, Pro trial prompts). Those captures are **feature reference only** for the booking side (§5.19) — Setmore itself is never reconnected, no Pro trial is ever started, and existing Setmore data comes in only through the repo's `import-setmore.ts` script if Taktak orders it.
- **Golden Rule nº 12 (notes + signature):** read and analyse BEFORE, write notes DURING (each step, before → after), write AFTER (verified result). Every note, report and deliverable is **signed with your agent name: Happy APPY**. « Si ce n'est pas noté, ce n'est pas fait. »
- **Golden Rule nº 13 (screen recording):** record your screen for every work session (video if possible, otherwise screenshots at every key step). Every clip/capture goes into a named file (**date — agent — platform — brand — subject**) saved and uploaded to Google Drive (brand folder + central clip library) immediately. Objective across the group: 30,000 clips.
- **30-minute re-read:** every 30 minutes, re-read your last 30 minutes of work and conversation; catch and fix omissions immediately.
- Prices come only from the authoritative pricing engine/posters — never invent a price, an hour, or a service.
- No purchase, subscription, paid upgrade or trial activation without Matt's explicit word. No irreversible deletion. Access changes are add-only.

---

## 2. PRODUCT SHAPE

- **One app, three faces, one API:** (a) **Business app** (owner + staff/technicians) = the Housecall Pro parity surface specified in §3–§5; (b) **Client face** = booking, memberships, invoices, payment, reviews (the Setmore-reference module, §5.19, delivered inside r2nette.ca `#book` and the same app in client mode); (c) **Admin** = existing r2neet back office.
- Build as a **mobile-first PWA / installable app** on the existing Vite/TypeScript stack in `takatakca/r2neet` unless the repo's own `AGENTS.md`/`RUN.md` dictate otherwise — read them first and follow them; if you judge a wrapper (e.g. Capacitor) necessary for push notifications and store presence, propose it in your stamped reply with reasons, and wait for Taktak's GO.
- Every business-app screen below must work **offline-first** (see §5.10) and sync when back online, exactly like the reference app.

---

## 3. GLOBAL SHELL (present on every screen — from the captures)

1. **Top bar:** dark charcoal bar, white screen title, left control = back arrow (←) for pushed screens or ✕ for modal flows, right control where applicable = ✓ (save) or a blue chat/help bubble icon.
2. **Bottom navigation** (Android pattern in the captures): system back / home / recents below an in-app bottom area; in-app primary creation action = **green circular FAB « + »** bottom-right (Price book, Tax rates).
3. **Account panel (hamburger/account home):** business name header « Rapide 2 Nette », entries in this order: **Preferences · My Money · Price book · Company setup · Chat & help center · Listen to Pro Tips · Upgrade · About**.
4. **Dashboard home:** two money cards on top — **Invoices** ($ total, Collected / Uncollected) and **Estimates** ($ total, Won / Created); an **« Activate payments »** card until payments are live (« Take cards, Apple Pay, and Google Pay »); an **upgrade banner card** (« Complete business tools, not just invoices — Upgrade for full features ») until the full plan is active; a first-run **notification-permission prompt** (« Get updates on when you're paid », Cancel / Allow).
5. **Search pattern:** magnifier + « Search » field at the top of list screens (Price book, Customers).
6. **Empty-state pattern:** centred line icon + instruction text, e.g. « This category is empty. Tap "+" below to create a new item. » and « CLICK + TO ADD A TAX RATE ». Every list in the app ships with its empty state.
7. **Bottom-sheet pattern:** selectors slide up as a sheet (country picker « Where is your business located? — United States / Canada »; « Create new — Service / Material » two-tile sheet).
8. **Form pattern:** light-grey filled fields stacked full-width (label above or placeholder inside), dropdown fields with ▾, currency fields pre-filled `$0.00`, toggle switches right-aligned, blue text button « Add image », « Save » in blue at top-right of creation forms.

---

## 4. MODULE-BY-MODULE SPEC — BUSINESS APP (Housecall Pro parity)

### 4.1 Sign-in
- Email field + continue; **« Continue with Google »** button (the account Matt uses is Google-connected).
- Session persists; signing in lands on the dashboard (§3.4). Staff accounts are created via the existing `staff:create` script/roles — owner, staff/technician, client roles must map to it.

### 4.2 Jobs & scheduling
- Job list + job detail (client, address, services/materials from the Price book, schedule, status, photos, notes, invoice link).
- Calendar with **Agenda / Day / 3-Day** views; week view shows jobs and income (« This week's income » pattern from the booking reference).
- **Recurring jobs** are first-class: weekly recurring cleanings (Matt's canonical example: every Thursday, 4-hour blocks) — powered by the existing `worker:recurrence`; memberships (§4.13) generate their jobs automatically.
- **Job Inbox** (their help centre carries 11 articles on it): inbound requests from the booking page, Facebook forms and pop-ups land here for acceptance → job conversion.

### 4.3 Customers (CRM)
- Customer list, alphabetical with search (the reference account already shows a populated A–Z list — our list comes from r2neet's existing customer base/booking data).
- Customer file: contact info, addresses, job history, invoices/estimates, notes, review history (link §4.14).

### 4.4 Estimates
- Create estimate from Price book services/materials; totals with taxes (TPS/TVQ) computed by the pricing engine.
- Pipeline states: **Created → Won** (and lost/open), dashboard card aggregates Won/Created dollars.
- One-tap conversion: estimate → job → invoice.

### 4.5 Invoices
- Create invoice from a job or from scratch (services + materials lines); logo appears on invoices, estimates and emails (§4.11.2).
- States and dashboard aggregates: **Collected / Uncollected** dollars; payment recording (card via Stripe, cash, etc.); send by email/SMS; exact total with taxes shown before any client confirmation — same promise as the site.

### 4.6 Price book (menu: account panel → « Price book »)
- Category list + Search; empty-category state (§3.6); green « + » opens the **« Create new » sheet: Service | Material**.
- **New service form — every field, in order:** Name · Description · Task code · Category (dropdown) · Service cost ($0.00) · Service price ($0.00) · Unit (dropdown) · **Taxable** (toggle) · **Online booking** (toggle) · **Add image** (button) · Save (top-right).
- **New material form — every field, in order:** Name · Description · Part number · Category (dropdown) · Cost per unit ($0.00) · Price per unit ($0.00) · Unit (dropdown) · **Taxable** (toggle) · **Add image** (button) · Save.
- Seed the price book from Rapide's real service catalogue (ménage régulier, grand ménage, options/produits, promos prix fixe) via the pricing engine data — never invent prices; if a price is missing, flag it to Taktak, do not fill it in.

### 4.7 My Money / Payout settings (payments)
- Entry screen, exactly as captured: illustration + « **Payments with Housecall Pro** » → ours: « **Payments with Rapide 2 Nette** », sub-line « Activate full payment functionality built into every part of the platform. », primary button « **Set up payments** ».
- Setup flow: (1) bottom-sheet country picker « Where is your business located? » — **Canada** preselected for us; (2) connect the payout bank account (instant connect + **manual fallback form**: Account number · Re-enter account number · Routing number — for Canada capture transit + institution + account in the Canadian format); (3) the reference app recommends a **$1 test charge** and confirming arrival before taking customer payments — reproduce this guidance in our flow (with Stripe, use Stripe's own verification/test-mode equivalent and say so in the UI copy).
- Implementation = **Stripe** (our processor — SDK already in the repo): cards, **Apple Pay, Google Pay**, tips at checkout (the live site's checkout pattern), payouts settings screen, payment status notifications (« Get updates on when you're paid »).
- **Hard rule:** bank credentials/details are entered by Matt alone in the live flow. You build the screens and the Stripe wiring; you never handle, store or request real bank numbers.

### 4.8 Company setup (menu, in this order)
**Company profile · Company logo · Payout settings · Tax rates · Delete my data**
- **4.8.1 Company profile (Business form) — every field, in order:** Business Name (« Rapide 2 Nette ») · Business Street Address · Business Postal Code (« H8T 1B7 » as entered) · Business Phone (« (514) 458-4587 ») · Time zone (« (GMT-04:00) Eastern Time — Toronto ») · Tax ID ##-######### (optional) · Contractor License (where required) · then a **« Business Profile »** section below the form. Save = ✓ top-right.
- **4.8.2 Company logo:** copy pattern « Your company logo will appear on invoices, estimates and emails. » + « **Update company logo** » button; the logo is the official R2N/TAKATAK brand file from `knowledgeAI/brand/` (never a redrawn copy — BRAND.md).
- **4.8.3 Payout settings:** routes to §4.7 state (not set up / set up + bank on file masked / test-charge status).
- **4.8.4 Tax rates:** list screen; empty state with bank icon + « CLICK + TO ADD A TAX RATE »; green « + » adds a rate (name + %); **ship TPS 5 % and TVQ 9,975 % as the Québec presets**; rates are applied via the Taxable toggles on services/materials and the pricing engine.
- **4.8.5 Delete my data:** « Request removal of your account » — a request flow (Loi 25 / PIPEDA pattern): submit request → confirmation → processing state. Build the flow; **never execute a real deletion** without Matt via Taktak.

### 4.9 Preferences (account panel → « Preferences »)
- **Offline mode** — with « No sync date » state shown until first sync; offline changes queue and sync automatically (see §5.10).
- **App language** — follows the device language; app is fully FR/EN bilingual regardless.
- **Photo upload settings** — three radio options, exactly as captured: **Fast upload** (« Faster uploads, smaller image size ») · **Balanced (recommended)** (« Balances image quality and upload speed ») — *the reference account's current selection* · **High detail** (« Best quality, may take longer to upload without a strong network connection »).

### 4.10 About
- Version screen pattern: **App Version** (theirs: 2026.10.13 (933)) + **OS** (theirs: 16) — ours shows our build number, device OS, and a « check for updates » state (upgrade path, §7).

### 4.11 Chat & help center
- In-app chat entry + a structured Help Center whose **topic tree mirrors the reference** (article counts from their index show the expected depth): Jobs/Invoices/Estimates (63) · Marketing Center (46) · Price Book (23) · Service Plans (22) · Tech Support Tips (22) · Reporting (19) · Payroll (19) · Voice of the Customer Features (15) · Job Inbox (11) · QuickBooks Online (10) · Voice (10) · Scheduling (10) · Invoicing (8) · Twilio 10DLC Registration (2) · … Our articles are **our own writing** (TAKATAK Academy produces them, §8); the tree and findability are the parity target.

### 4.12 Listen to Pro Tips
- In-app audio list (episodes 1–6 in the reference, incl. nº 6 « Let Your Customers Brag About You » — review generation). Ours: short audio/video tips for owners and techs, fed from TAKATAK Academy content; same list-and-play UX.

### 4.13 Service Plans = MEMBERSHIPS (core R2N revenue — treat as P0)
- The reference sells « Service Plans »; Rapide's model is stronger and already decided by Matt: **annual contracts, weekly recurring cleanings (e.g. Thursdays, 4 h blocks), fixed-price promos, products & options** — sold on r2nette.ca, billed by the existing `worker:billing` + `worker:recurrence`, visible and manageable in the app (client: plan, next visits, pause/resume per rules; business: members list, plan states, revenue).
- Stripe subscriptions power billing; plan changes/cancellations follow the site's published terms.

### 4.14 Voice of the Customer / Reviews
- Review requests after completed jobs (timing, email/SMS, reminders) and review monitoring/reply — **implemented through TAKATAK Review** (our own review system: email alert on every new review, reply from inside, platform sync). Follow the TAKATAK Review instruction set in GitHub `takatakca/TAKATAKREVIEW` and Drive; the Birdeye study (2026-10-31) feeds the same spec — ask Taktak for the latest instruction file before building this module.
- **Absolute rule: no fake reviews, ever, for any reason** (refused permanently by Taktak on Matt's own instruction history — platform rules + Competition Act). Real-client review campaigns only.

### 4.15 Marketing Center
- Campaign module (46 help articles in the reference = depth target): offers + a clickable link, **never prices in posts/ads** (standing TAKATAK rule); triggers and consent per the push-notification spec (§8, mission M-29).

### 4.16 Reporting · Payroll · Voice · QuickBooks
- **Reporting:** revenue, collected/uncollected, estimates won rate, jobs by period, per-service and per-tech views.
- **Payroll:** staff hours from jobs → payroll view (build the screens; pay rules confirmed by Taktak before activation).
- **Voice:** business phone inside the app (calls on the reservations/general numbers) — integrate via Twilio when Taktak activates it (10DLC registration topics exist in the reference help tree for a reason: SMS sender registration is part of the setup).
- **QuickBooks Online:** connect + sync invoices/payments (the accounting direction of the group is 4CCOUNTING — see §8; build the QBO connector as an export/sync bridge, do not duplicate the ledger).

### 4.17 Upgrade (in-app plans)
- « Upgrade » entry + full-screen upsell pattern (« Complete business tools, not just invoices »). Our tiers and prices are set by Taktak/Matt when the time comes — build the paywall plumbing (feature flags by plan), **never invent tier prices**, and never activate a paid plan on any external platform.

---

## 5. CLIENT FACE + BOOKING REFERENCE (from Matt's Setmore captures — features to own, platform to drop)

19 screens of reference, mapped to our modules:
- **Booking Page + « Share Booking Page »** → r2nette.ca `#book` + shareable booking links per service/tech; the app exposes the same share action.
- **Services & classes, « View and share services by team member »** → services carry the assigned team members; booking can be per team member.
- **Customers** → same CRM as §4.3 (one database).
- **Calendar: Agenda / Day / 3-Day; week strip; « Nothing planned » empty days; « This week's income $0 »** → §4.2 calendar parity, including the income line.
- **Settings tree** → Your brand · Team · Payments · Promotions · Branded mobile app · Reviews · Activity · Integrations · Share Booking Page / Calendar · Booking preferences · Notifications · Security · General settings / Billing. Map 1:1 into our settings: **Promotions** = fixed-price promos (offer + link, no price in ads), **Branded mobile app** = this app's branding controls, **Reviews** = §4.14, **Integrations** = §8 list, **Activity** = audit log of account actions, **Security** = sessions/2FA, **Notifications** = §5.10 push/email/SMS matrix.
- **« Start 14-day free trial » banners everywhere in their app** → pattern noted (persistent upsell), **never** activate any trial anywhere.

### 5.10 Notifications & offline (cross-cutting)
- Push categories with per-category consent (law: a refused category is never solicited — M-29 board of consent with « Tout sélectionner » or granular choices).
- Payment-received push, job reminders, review alerts, membership renewals.
- SMS codes must **pop on their own** (WebOTP format: SMS ends `@domain #code`; field `autocomplete="one-time-code"`) — standing Matt requirement, applies to client login/verification in the app.
- Offline mode: full read/write on jobs/customers/invoices on-device, visible sync state and last-sync date, conflict-safe merge on reconnect.

---

## 6. UX / UI DESIGN SPEC (from the captures, line by line)

- **Layout grammar:** white/light-grey screens; dark charcoal top bar with white bold title; cards with soft shadow on light background; generous white space; one primary action per screen.
- **Buttons:** primary = full-width blue pill (their blue ≈ our **Brand blue on light `#1565D8`** with white text, per BRAND.md); creation = green circular FAB « + » bottom-right (keep the green FAB as the *action* colour only — BRAND.md: green is a status/action accent, never the brand ground); text buttons in blue (« Add image », « Save », « Set up payments » is the filled variant).
- **Type:** bold black headings (their « Payments with Housecall Pro » treatment → Montserrat ExtraBold per BRAND.md), grey secondary text for sub-lines, small grey labels above form values, wide-spaced caps for small labels (« GROUPE », « DIGITAL SOLUTIONS » style).
- **Brand skin (ours, mandatory):** TAKATAK tokens — Navy `#060D1F`, Midnight `#0B1B3D`, Electric blue `#1F8BFF`, Cyan `#29C3FF`, White `#F5F8FC`, Silver `#B8C4D3`; official logo files from `knowledgeAI/brand/` on dark backgrounds; never recolour/stretch the mark. Every screen must be recognisably *the same app* as r2nette.ca and recognisably *ours* — while its structure, order and behaviour match the reference screen-for-screen.
- **Imagery:** real photos only, never modified; before/after job photos use the client's own job photos with consent; item/service images carry no text overlays in the price book.
- **Micro-copy:** reproduce the *patterns* (empty states, helper lines under fields, « (recommended) » tags, « (where required) » / « (optional) » field suffixes) with our own wording in FR + EN.
- **Accessibility & motion:** touch targets ≥ 48 dp, contrast per BRAND.md (white on `#1565D8` passes), no essential information by colour alone, sheet/modal transitions consistent with §3.7–3.8.

## 7. UPGRADING & OPTIMIZING (built into the plan, not afterthoughts)
- Feature flags per plan from day one (§4.17) so upgrades never need a rebuild.
- Version screen + in-app « what's new » (§4.10); staged rollout; the repo's existing CI (`tsc` + build + vitest) must stay green; Playwright coverage for every parity screen.
- Performance budgets: cold start and list scrolling on mid-range Android are acceptance criteria, not wishes; photo pipeline honours §4.9 quality settings.
- Analytics events on the funnel that matters: booking started/completed, estimate won, invoice collected, membership started — connected to the TAKATAK dashboard/app analytics (Facebook app analytics + site analytics already on the platform project).

## 8. CONNECTIONS TO WHAT WE ALREADY HAVE (integration map)
| System | Connection |
| --- | --- |
| r2nette.ca site (`#book`, `/auth`, checkout/recurring) | Same API + same accounts; app bookings appear on the site and vice versa |
| Pricing engine `@r2nette/pricing` | Single source of prices/taxes; app never computes its own totals |
| Stripe | Payments, payouts, subscriptions (memberships), tips; test mode first, $1-test guidance in UI |
| Facebook app 29183148337978023 + Page 1044118655779183 | Service requests/inscriptions from Page forms & ads land in Job Inbox (§4.2) |
| TAKATAK Review | §4.14 reviews engine (alerts, replies, sync) |
| Push notifications spec M-29 (Drive + issue qmaps nº 9) | Consent board + merchant-triggered campaigns (~30 min before closing, 30–60 min before meals, dead-time detection) — offer + link, never a price |
| QMAPS merchant dashboard | Same merchant-side patterns (Yelp-for-Business-feel reference, issue qmaps nº 8) where the app exposes merchant settings |
| TAKATAK Academy | Help-center articles (§4.11) + Pro Tips content (§4.12) are produced/taught there |
| 4CCOUNTING / QuickBooks Online | §4.16 accounting bridge |
| Twilio | SMS (WebOTP format), Voice, 10DLC registration — activation by Taktak/Matt only |
| Google Drive + GitHub | Every deliverable, note and clip filed the moment it exists (Rules nº 1, 12, 13) |

## 9. NEXT LEVEL (Phase 2 — build parity first; Taktak will call the moment)
AI concierge inside booking (already coded on the platform — surface it in-app) · before/after photo stories feeding Tac Attack/TAKATAK social content (Rule nº 13 clip library + Runway pipeline) · ETA/GPS « your pro is on the way » texts · smart dead-time offers via M-29 triggers · review-velocity dashboard per TAKATAK Review · membership upsell at invoice time · multi-business switcher for the whole TAKATAK group (the same app shell serving the other brands later).

## 10. YOUR DELIVERABLES & ACCEPTANCE
1. **Stamped reply** (§11) — before code.
2. A **parity checklist** in the repo (`docs/parity-checklist.md`): every screen/field/flow in §3–§5, one line each, state: todo / built / verified-live. Nothing is « done » without live verification.
3. The app, in `takatakca/r2neet`, CI green, with Playwright proof per screen.
4. Notes avant–pendant–après in GitHub (issue + WORKLOG) **and** Drive (Rapide 2 Nette folder), signed Happy APPY; screen recordings per Rule nº 13 filed in Drive the same day.
5. A short « what's left / blockers » list in every report — blockers go to **Taktak**, never directly to Matt, and never sit silent.

## 11. REPLY TO ME — STAMP YOUR NAME (first action, before anything else)
Reply **in the GitHub issue that carries this mission** (repo `takatakca/r2neet`) **and in the agents' daily thread**, opening with your name stamp, in this form:

> **Happy APPY** — mission reçue / received, 2026-10-31. Spec A–Z lue au complet. Plan: [your first three steps]. Blocages connus: [list or « aucun »]. — Happy APPY

Then start with §4.6 Price book + §4.8 Company setup (the screens Matt captured last and clearest), and report every 30-minute re-read cycle per Rule nº 12.

**— Taktak (boss, coordination), 2026-10-31. Bonne construction, Happy APPY.**
