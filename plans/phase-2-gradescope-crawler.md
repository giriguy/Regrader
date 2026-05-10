# Phase 2 — Gradescope Crawler

> **2026-05-09 update — DOM reconnaissance complete.** Real selectors and a much better data path are documented in `phase-2-gradescope-selectors.md`. **Key finding: graded submissions have a JSON endpoint** (`...submissions/<sid>.json?content=react`) returning the entire submission state — every rubric item with an `applied` flag, every score, every existing regrade request — as ~84KB of clean JSON. **Playwright is now only needed for the one-time SSO login**; all subsequent crawling is plain `fetch()` with the captured cookie. Sections below that talk about DOM scraping per submission are obsolete; the index pages (`/account`, `/courses/<cid>`) still need cheerio HTML parsing.

## Context

Phase 1 ships a working pipeline (PDF upload → Tesseract OCR → local LLM → drafts), but the input side is tedious: you have to download each graded PDF from Gradescope, paste the rubric into a textarea by hand, and the LLM has to reverse-engineer question structure from noisy OCR text.

Phase 2 replaces that input layer entirely. Headed Chromium opens once for SSO login; from then on Playwright walks your courses, assignments, and graded submissions, scraping the structured data Gradescope already has — question text, rubric items, applied items, per-question student answers, and grader comments. The LLM analyzer is rewritten to operate on one question at a time with a tight, focused prompt.

**Decisions locked in (from clarifying questions):**
- **Auth: SSO via headed-browser-once.** Open a real Chromium window, you log into your school's SSO (Shibboleth/SAML/Microsoft/Google), Playwright captures the `_gradescope_session` cookie, all subsequent crawls use that cookie in a headless context. Pure email-password is the unhappy path that we'll only hit if Gradescope ever changes the form.
- **Per-question LLM analyzer.** One LLM call per disputable question with a focused prompt referencing the actual rubric items by text. Higher quality, parallelizable, much smaller per-call context. `llmAnalyzer.ts` gets refactored.
- **Replace manual upload entirely.** The Phase 1 upload UI, OCR pipeline, and `pages` table go away. PDF rendering survives (we may still want to display a question's PDF region). Tesseract.js dependency is removed.

**Important constraints to flag now:**
- **Gradescope ToS.** Automated scraping of your own account, at human-paced rates, for personal use, is the gray-zone good case. This will sit in the README with strong warnings: don't share the tool, don't run it concurrently, don't scrape other people's data.
- **No regrade-submission yet.** Phase 3 wires Playwright into the regrade form. Phase 2 still ends with "export approved as Markdown" and you paste into Gradescope manually.
- **Reference implementations are read-only.** Two well-maintained Python libraries — [`nyuoss/gradescope-api`](https://github.com/nyuoss/gradescope-api) (38⭐, active) and [`apozharski/gradescope-api`](https://github.com/apozharski/gradescope-api) (35⭐) — give us URL patterns and DOM selectors but neither does regrade requests, so Phase 3 is greenfield.

---

## Architecture

### High-level flow

```
   ┌─ Frontend ─────────────────────────────────────────────────┐
   │  [Connect Gradescope] → opens headed window → user logs in │
   │  [Sync] → progress bar → tree of courses+assignments       │
   │  [Click assignment] → per-question cards (same UI as P1)   │
   └────────────────────────────────────────────────────────────┘
                                ↕
   ┌─ Backend (Express) ────────────────────────────────────────┐
   │  POST /api/gradescope/connect   → launches headed browser  │
   │  GET  /api/gradescope/status    → SSE: login progress      │
   │  POST /api/gradescope/sync      → kicks off crawl          │
   │  GET  /api/gradescope/sync/:id  → SSE: crawl progress      │
   │  GET  /api/courses              → tree for sidebar         │
   │  GET  /api/assignments/:id      → questions + analyses     │
   │  POST /api/assignments/:id/analyze → per-question LLM      │
   └────────────────────────────────────────────────────────────┘
                                ↕
   ┌─ Services ─────────────────────────────────────────────────┐
   │  gradescopeAuth.ts    — headed login, cookie capture       │
   │  gradescopeSession.ts — cookie persistence, refresh        │
   │  gradescopeCrawler.ts — walk courses → assignments → Qs    │
   │  llmAnalyzer.ts       — REWRITTEN: per-question prompts    │
   │  dflashClient.ts      — extracted HTTP client (reused)     │
   └────────────────────────────────────────────────────────────┘
                                ↕
   ┌─ SQLite ───────────────────────────────────────────────────┐
   │  gs_sessions, courses, assignments, questions,             │
   │  rubric_items, applied_items, analyses                     │
   └────────────────────────────────────────────────────────────┘
```

### Auth flow (the only piece that's actually hard)

Gradescope's `/login` page has an email/password form, a Google OAuth button, and a "School Credentials" link to `/saml`. The SAML flow redirects to your school's IdP, which may require MFA, captchas, or device-trust prompts. None of this is automatable safely.

**The flow:**

1. User clicks **Connect Gradescope** in the frontend.
2. Backend launches Playwright in **headed** mode (`headless: false`), opens `https://www.gradescope.com/login` in a fresh `BrowserContext` (no profile, no shared cookies with your real Chrome).
3. The window is yours — log in however your school does it.
4. Backend polls the page in a tight loop for the cookie `_gradescope_session` to appear AND a successful navigation to `/account` (the post-login destination). When both fire, we have a valid session.
5. Cookie is saved to SQLite (`gs_sessions` table) along with expiry. Browser closes.
6. All subsequent crawler runs spin up a headless context, inject the cookie, and proceed.
7. If the cookie expires (Gradescope's session is ~14 days IIRC) the next crawl detects the redirect to `/login` and tells the user to reconnect.

**Why a fresh context** (not user data dir): we want the Gradescope session isolated from the user's actual browsing — no risk of leaking other accounts, easier to clean up.

**Why poll for cookie + URL** (not a "click here when done" button): the login flow can take 30s of clicks (SSO → MFA → device trust). Auto-detecting completion is nicer UX than a manual "I'm done" button, and avoids race conditions if the user closes the window early.

### Crawler

Playwright headless with the saved session cookie. Sequential page navigation, **1.5s ± 500ms randomized delay** between requests, single concurrent page (no parallelism). Hard cap of one full sync per 5 minutes to avoid burning your bandwidth + their server budget.

**Pages walked, in order:**

1. `https://www.gradescope.com/account` — list of enrolled courses. Each course is a `<a class="courseBox">` (per nyuoss reference) with `href="/courses/<id>"` and the course name in a child element.
2. For each course: `https://www.gradescope.com/courses/<id>` — list of assignments. Table rows with class `assignments-student-table` or `<th>` cells with assignment titles. Status column tells us which are graded.
3. For each graded assignment: `https://www.gradescope.com/courses/<id>/assignments/<aid>/submissions/<sid>` — the actual graded submission view. This is where the rubric lives.
4. The submission page is a single React app; we wait for `networkidle` then scrape the rubric panel (DOM structure varies by assignment type — see "Per-question scraping" below).

**Per-question scraping** is the gnarly part because Gradescope has three submission types:
- **PDF assignments** (handwritten/scanned exams): each question is a region of a PDF page; rubric items are in a side panel; applied items have a checkmark icon. We extract the PDF region as a cropped PNG (Playwright's `elementHandle.screenshot()`) for display.
- **Online assignments** (typed): each question's answer is HTML inside `.question-prompt` / `.student-answer` divs.
- **Programming assignments**: code answers in `<pre>` blocks plus autograder output.

For Phase 2 we ship **PDF assignments only** (the most common exam case). Online and programming assignments error out with "not yet supported" and remain on the roadmap.

**Selectors to find from a real session** (these change — finalize during implementation by inspecting your actual account):
- Course list: `a[href^="/courses/"]` filtered to current term
- Assignment status: cells containing "Graded" / "Submitted" / "Not submitted"
- Rubric panel: typically `.rubricItemGroup` or `[data-react-class*="Rubric"]`
- Applied items: rubric items with class `selected` or aria-pressed=true
- Question regions on PDF: `[data-react-class="ImageOverlay"]` or similar canvas elements

This list is a starting point — the **first implementation task is to inspect a real submission page and write down the actual selectors**, not to trust this document.

### Per-question analyzer

`llmAnalyzer.ts` is rewritten to operate on one question at a time. Same dflash HTTP client, totally different prompt:

```
System: "You are reviewing a single graded exam question on behalf of the
student. Decide whether the deduction is defensible and, if not, draft a
regrade request. Return strict JSON."

User:
  Question prompt: "<text>"
  Question worth: <N> points
  Score given: <M> / <N>
  Rubric items:
    - [APPLIED]   "<rubric item text>" (-2 pts)
    - [APPLIED]   "<rubric item text>" (-1 pts)
    - [NOT APPLIED] "<rubric item text>" (+1 pt) — these are credit-positive items
                                                    the student did NOT receive
  Grader comments: "<text>" (if any)
  Student answer: "<text or OCR'd region or ‘see attached image’>"
  [Optional: image block if PDF region]

Return: { should_regrade, confidence, justification, draft_request }
```

Per-question calls run sequentially (dflash on M3 Pro is fast but not multi-tenant). Total time for a 10-question exam: ~10–15s, in line with Phase 1.

**Key win over Phase 1:** the model sees the EXACT rubric items the grader didn't apply. It can write drafts like "Rubric item 'shows correct integration by parts' was not awarded, but my work on lines 3-5 demonstrates exactly that." That's the kind of specificity that makes professors take a regrade seriously.

---

## Data model changes

Drop `pages` (no more OCR). Add:

```sql
CREATE TABLE gs_sessions (
  id          TEXT PRIMARY KEY,        -- single row, id='default'
  cookie      TEXT NOT NULL,           -- _gradescope_session value
  email       TEXT,                    -- captured for display only
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER                  -- best-guess from cookie
);

CREATE TABLE courses (
  id          TEXT PRIMARY KEY,        -- gradescope course id
  name        TEXT NOT NULL,
  term        TEXT,
  synced_at   INTEGER NOT NULL
);

CREATE TABLE assignments (
  id          TEXT PRIMARY KEY,        -- gradescope assignment id
  course_id   TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL,           -- 'graded' | 'submitted' | 'not_submitted'
  score       REAL,
  max_score   REAL,
  submission_url TEXT NOT NULL,
  synced_at   INTEGER NOT NULL
);

CREATE TABLE questions (
  id              TEXT PRIMARY KEY,
  assignment_id   TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  question_label  TEXT NOT NULL,       -- '1', '2a', 'Problem 3'
  question_text   TEXT,                -- the prompt, when scrapeable
  max_points      REAL,
  points_awarded  REAL,
  grader_comment  TEXT,
  answer_text     TEXT,                -- typed answer text, if any
  region_png_path TEXT,                -- path to cropped image of PDF region
  display_order   INTEGER NOT NULL
);

CREATE TABLE rubric_items (
  id            TEXT PRIMARY KEY,
  question_id   TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  item_text     TEXT NOT NULL,
  point_delta   REAL NOT NULL,         -- negative = penalty, positive = credit
  applied       INTEGER NOT NULL,      -- 0 or 1
  display_order INTEGER NOT NULL
);

-- analyses table changes:
--   submission_id → question_id (FK to questions, not submissions)
--   keep all other columns (confidence, justification, draft, status, ...)
```

The Phase 1 `submissions` and `pages` tables are dropped. Migration: just delete `regrader.db` — there's no production data to preserve.

---

## Files to add / change

### New
- `backend/src/services/gradescopeAuth.ts` — headed login, cookie capture
- `backend/src/services/gradescopeSession.ts` — cookie persistence + refresh detection
- `backend/src/services/gradescopeCrawler.ts` — walks courses → assignments → questions, populates DB
- `backend/src/services/dflashClient.ts` — extracted HTTP client (reused by analyzer)
- `backend/src/routes/gradescope.ts` — `/connect`, `/status`, `/sync`, `/sync/:id` (SSE for progress)
- `backend/src/routes/courses.ts` — `/courses`, `/assignments/:id`
- `frontend/src/pages/Connect.tsx` — initial onboarding
- `frontend/src/pages/Browse.tsx` — course/assignment tree + per-assignment view
- `frontend/src/components/CourseTree.tsx` — sidebar navigation

### Rewritten
- `backend/src/services/llmAnalyzer.ts` — per-question prompt, takes structured input
- `backend/src/db.ts` — new schema (drop `pages`, add the 5 new tables)
- `backend/src/routes/analyses.ts` — analyze keyed off question_id, not submission_id
- `frontend/src/App.tsx` — view router for connect / browse / question-detail
- `frontend/src/api.ts` — new endpoints, drop upload

### Deleted
- `backend/src/services/ocr.ts` (and Tesseract.js dep from package.json)
- `backend/src/services/pdfPages.ts` and `pdfStore.ts` (we still might want PDF region rendering — see "Open" below)
- `backend/src/routes/submissions.ts`
- `frontend/src/pages/Upload.tsx`

---

## Phased build order within Phase 2

Don't try to ship this all at once — each step gates the next.

1. **Auth happy path.** Standalone script: open headed Chromium, navigate to login, wait for cookie + `/account` redirect, print the cookie. No DB, no Express. Confirms SSO works on your school's setup before any other code is written.
2. **Persist + reuse cookie.** Wire auth into Express + SQLite. Add a `/connect` endpoint and a "Connect Gradescope" button. Use a separate test route to verify the saved cookie can fetch `/account` headlessly.
3. **Crawl one course manually.** Hardcode a course ID, scrape its assignment list, dump JSON. Verify selectors. Iterate until clean.
4. **Crawl one graded submission.** Hardcode an assignment ID, extract questions + rubric items + applied state. Dump JSON. **This is where the real selector work happens** — expect a day of inspecting Gradescope DOM.
5. **Persist crawl results.** Wire steps 3+4 into the new schema. Add `/sync` endpoint with SSE progress.
6. **Per-question analyzer rewrite.** Refactor `llmAnalyzer.ts`, run it against one persisted question, eyeball the output. **This is where the quality win shows up.**
7. **New frontend.** Browse view replacing the upload flow. Reuse `QuestionCard` from Phase 1 with minor tweaks (now shows applied/unapplied rubric items).
8. **Cleanup.** Delete Phase 1 upload code, drop Tesseract.js + pdf-to-png-converter deps, update README.

Steps 1–4 are research-heavy (validating the selectors against real Gradescope DOM). Steps 5–8 are mechanical once the scraping works.

---

## Verification

1. **SSO login.** Click Connect, complete your school's SSO, confirm `gs_sessions` row is created and the headless test fetch of `/account` returns 200 with course list HTML.
2. **Sync one term.** Click Sync, watch the progress bar walk one of your real courses, verify courses + assignments + questions + rubric items all populated correctly in SQLite (`sqlite3 backend/data/regrader.db`).
3. **Per-question analysis.** Click into an assignment you actually got a deduction on, click Analyze, sanity-check the output. The wins to look for vs Phase 1: more specific drafts (cite rubric items by text), no false positives on questions where OCR was the issue.
4. **Session expiry recovery.** Manually delete the cookie row, click Sync, confirm the UI prompts to reconnect.
5. **Rate limit.** Run a sync, watch the network tab — confirm requests are spaced ~1.5s apart, not bursted.

No automated tests. Same reasoning as Phase 1: the only logic worth testing (DOM selectors, prompt quality) can only be evaluated by running it.

---

## Open items / things we won't know until we try

- **Selector stability.** Gradescope is a Rails + React app; class names like `rubricItemGroup` are reasonably stable but not contract. Plan to update them when they break.
- **PDF region extraction quality.** Playwright `screenshot({clip: ...})` works but the coordinates Gradescope's React app uses might be in PDF space, not viewport space. May need to load the original PDF and crop server-side.
- **Question-text extraction.** The original question prompt isn't always on the submission page — sometimes it's only in the source PDF the instructor uploaded. May need to fall back to "no question text available, work from the rubric" in those cases.
- **Multi-version assignments.** Some exams have multiple versions per student. The crawler needs to pick the version that matches the logged-in user.
- **Group submissions.** If you're in a group on a problem set, "your" submission is the group's. Make sure the analyzer doesn't draft on behalf of the group without confirming.
- **Captcha during SSO.** If your school's IdP throws a captcha, the headed browser flow handles it (you solve it). Captchas on Gradescope itself would block us — unlikely but worth flagging.
- **Phase 3 prep.** The regrade-request form structure isn't documented anywhere we can find. While crawling, keep an eye on the "Request Regrade" button — if we can record a manual regrade submission's network calls, Phase 3 gets much easier.
