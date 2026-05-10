# Regrader — Build Plan

## Context

Goal: a personal web app that takes graded Gradescope submissions, uses Claude to identify questions where points were unfairly deducted, and drafts regrade requests for human review before sending.

The original overview proposes a 4-phase build. This plan details **Phase 1** (manual PDF upload, no scraping) end-to-end and outlines Phases 2–4 just enough to make sure the Phase 1 architecture leaves room for them. Phases 2–4 will be re-planned in their own files when Phase 1 ships, since the right shape for the scraper and submission flow will be much clearer once we've seen real Claude outputs and built the review UI.

**Key decisions locked in (from clarifying questions):**
- **Localhost, single-user** — no auth, no Redis, no Docker. `npm run dev` and go.
- **Claude vision directly, no OCR step** — Sonnet 4.6 reads handwriting natively. Pass the question/answer/rubric pages straight to Claude. Drops a whole subsystem (Tesseract + transcription review UI).
- **Model: `claude-sonnet-4-6`** — latest Sonnet, vision-capable. The overview's `claude-sonnet-4-20250514` is an older snapshot; 4.6 is strictly better.
- **Phase 1 detailed; Phases 2–4 outlined.**

**Important constraint to flag now:** Gradescope's per-assignment PDF export typically shows the student's submission with grader annotations and per-question score deductions, but does **not** always include the full rubric (i.e. the unapplied items). For Phase 1 we'll let the user upload the rubric separately (text paste or screenshot) when they want a deeper analysis. This is a known limitation we accept for the MVP, and it's exactly what Phase 2's scraper will fix.

---

## Phase 1 — PDF upload + AI analysis + review UI

### Repo structure

Single repo, two top-level packages, run concurrently in dev:

```
Regrader/
  package.json              # root, holds `npm run dev` -> concurrently runs both
  backend/
    package.json
    src/
      server.ts             # Express bootstrap
      routes/
        submissions.ts      # POST /api/submissions (upload), GET /api/submissions
        analyses.ts         # POST /api/submissions/:id/analyze, GET analyses
      services/
        pdfStore.ts         # save uploaded PDF to ./data/uploads/, return id
        pdfPages.ts         # split PDF -> per-page PNGs (pdfjs-dist + sharp/canvas)
        claudeAnalyzer.ts   # build prompt, call Anthropic SDK with vision, parse JSON
      db.ts                 # better-sqlite3 connection + schema migration
    data/
      regrader.db           # sqlite file
      uploads/              # raw PDFs
      pages/                # rendered page PNGs
  frontend/
    package.json
    vite.config.ts
    src/
      App.tsx
      pages/
        Upload.tsx          # drag-drop PDF upload + optional rubric input
        Review.tsx          # per-question card list with Claude analysis
      components/
        QuestionCard.tsx    # answer image + rubric + analysis + draft editor
        ConfidenceBadge.tsx # 🟢🟡🔴
      api.ts                # typed fetch wrappers
```

### Backend

**Stack:** Node.js + TypeScript + Express + `@anthropic-ai/sdk` + `better-sqlite3` + `pdfjs-dist` (page rendering) + `multer` (uploads).

**SQLite schema** (single user, no accounts):
```sql
submissions (id TEXT PK, filename, course, assignment, uploaded_at, page_count)
analyses    (id TEXT PK, submission_id FK, question_label, points_missed,
             confidence, justification, draft, status, created_at)
            -- status: 'pending' | 'approved' | 'edited' | 'skipped'
```

**Endpoints:**
- `POST /api/submissions` — multipart upload of one graded PDF + optional `rubric_text` and `rubric_images[]`. Saves PDF, renders each page to PNG, returns `{id, pages: [...]}`.
- `GET  /api/submissions` — list for sidebar.
- `GET  /api/submissions/:id` — metadata + page image URLs.
- `POST /api/submissions/:id/analyze` — kicks off Claude analysis (synchronous for MVP — single user, fine to wait 10–30s with a loading state). Inserts one `analyses` row per question Claude flags.
- `GET  /api/submissions/:id/analyses` — list for review UI.
- `PATCH /api/analyses/:id` — update `draft` and `status` from the review UI.

**Claude integration (`claudeAnalyzer.ts`):**

Single call per submission, not per question — Sonnet 4.6 handles a multi-page exam in one shot and it's much cheaper than N calls.

```
System: "You are reviewing a graded exam submission for the student.
For each question where points were deducted, decide whether the
deduction is defensible. Output JSON only."

User content:
  - All page images of the graded submission (image blocks)
  - If rubric provided: rubric text and/or rubric image blocks
  - Instruction: "Return JSON: { questions: [{label, points_missed,
    confidence: 'high'|'medium'|'low', justification, draft_request}] }
    Only include questions worth requesting a regrade on (skip
    obviously correct deductions). Be conservative — false positives
    waste a professor's time."
```

Use the SDK's structured output (JSON mode via `response_format` or explicit instruction + JSON.parse with retry on parse failure). **Enable prompt caching** on the system prompt and rubric content — re-analyzing the same submission with edits will hit cache and cost ~10% of a fresh call.

**Confidence gating:** store all results, but the UI defaults to hiding `low`. User can toggle "show low confidence" if they want to see everything.

### Frontend

**Stack:** Vite + React + TypeScript + Tailwind. No router needed for v1 — two views toggled by app state (`upload` / `review`).

**Upload view:**
- Drag-drop a graded PDF.
- Optional collapsed section: "Add rubric" — paste text or drop rubric screenshots.
- Submit → POST → redirect to Review view with new submission selected.

**Review view:**
- Left sidebar: list of submissions (most recent first), click to switch.
- Main panel: vertical stack of `QuestionCard`s, one per Claude analysis row.
- Each card shows:
  - Question label + points missed + confidence badge.
  - The relevant page image (cropped if Claude returned a region; otherwise full page).
  - Claude's justification.
  - Editable textarea pre-filled with the draft regrade request.
  - Action buttons: **Approve** (status=approved), **Edit** (just save draft), **Skip** (status=skipped).
- Footer: "Submit all approved" — disabled in Phase 1 (Phase 3 wires it to Playwright). For now it just exports approved drafts as a markdown file the user can copy-paste into Gradescope manually.

### Phase 1 critical files (to be created)

- `backend/src/server.ts` — Express bootstrap, CORS for Vite dev port.
- `backend/src/services/claudeAnalyzer.ts` — the prompt and SDK call. **The single most important file in the project** — quality of the whole app rides on this prompt.
- `backend/src/services/pdfPages.ts` — PDF → PNG. Use `pdfjs-dist` rendering API.
- `backend/src/db.ts` — SQLite schema + migrations.
- `frontend/src/components/QuestionCard.tsx` — review UX.
- `.env.example` — `ANTHROPIC_API_KEY=`. Document in README that the user supplies their own key.

---

## Phase 2 — Playwright crawler (outlined)

Drop-in replacement for manual PDF upload. New service `gradescopeCrawler.ts` using `playwright` (headless Chromium):

1. New endpoint `POST /api/gradescope/login` accepts credentials, launches a Playwright context, logs in, stores `BrowserContext` cookies in memory (keyed by a session id returned to frontend). Credentials never persisted.
2. `POST /api/gradescope/sync` walks `/account` → courses → assignments → graded submissions. For each graded submission, scrapes the rubric (now visible in DOM, fixing Phase 1's rubric-input gap) and the answer regions. Inserts `submissions` and `analyses` rows just like the upload path.
3. Rate-limit: 1–2s delay between page navigations, randomized. Single concurrent page.

ToS note belongs in README — recommend the user only run against their own account, run sparingly, and consider whether the school's policies permit it.

## Phase 3 — Automated regrade submission (outlined)

Adds `POST /api/analyses/:id/submit` that uses the Phase 2 Playwright session to navigate to the regrade form for that question and submit the draft. Confirmation modal in the UI showing exact text being sent. Logs every submission to a new `submissions_log` table. The "Submit all approved" button in the Phase 1 footer becomes live.

## Phase 4 — Study mode (outlined)

New service `studyGenerator.ts`: takes a set of past graded submissions for a course, prompts Claude to generate practice questions in the style of the course's exams (using the rubric and question patterns it's seen). New `Practice` view in the frontend with question/answer flow and Claude grading. Reuses the Claude vision pipeline from Phase 1.

---

## Verification — how to know Phase 1 works

End-to-end smoke test (manual, since this is a personal tool):

1. `npm run dev` from repo root → backend on `:3001`, frontend on `:5173`.
2. Open frontend, drop in a real graded Gradescope PDF (one you've already gotten back, with deductions you actually disagree with).
3. Click Analyze → wait for spinner → cards appear.
4. **Sanity-check the output:** does Claude flag the questions you'd flag yourself? Are the drafts something you'd actually send a professor? Are confidence ratings reasonable (no `high` confidence on a deduction that's clearly correct)?
5. Edit one draft, approve another, skip a third. Reload the page → state persists from SQLite.
6. Click "Submit all approved" → markdown file downloads with the approved drafts.

**Iterate on the prompt** in `claudeAnalyzer.ts` until step 4 produces useful output on 2–3 different real submissions before declaring Phase 1 done. This is the gate — UI polish is irrelevant if the analysis is bad.

Automated tests are not worth writing for Phase 1 — the only logic worth testing (the Claude prompt) can only be evaluated by reading outputs.

---

## Open items to revisit when implementing

- **PDF page → image format and resolution.** Claude vision works best with reasonably high-res images but charges per-token. Start at 150 DPI PNG and tune.
- **Token budget per analysis call.** A 20-page exam is ~20 image blocks; check pricing before committing to single-call architecture. If too expensive, fall back to per-question calls with a cheap "page → questions" routing pass first.
- **Where the question text comes from.** Gradescope PDFs sometimes show only the answer, not the original question. May need to ask user to upload the blank exam alongside the graded submission.
