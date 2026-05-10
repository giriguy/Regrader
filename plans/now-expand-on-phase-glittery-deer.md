# Phase 3 — Automated regrade submission

## Context

Phase 2 ships a working pipeline that fetches Gradescope submissions, drafts
per-question regrade requests with the local LLM, and lets the user
review/edit/approve them. The last mile — actually sending the approved drafts
back to Gradescope — is still manual: the user clicks **Export approved as
Markdown**, opens Gradescope in a real browser, and pastes each draft into the
regrade form by hand. Phase 3 closes that loop.

**Decisions locked in (from clarifying questions):**

- **Submission via Playwright headless automation.** A new headless context
  (using the saved cookies from `gs_sessions`) navigates to the submission,
  locates the right question's regrade button, fills the textarea, and
  submits. No HTTP body-shape reverse-engineering — the real React form
  handles CSRF and field serialization. Slower (~3-5s per submission) but
  zero discovery cost on the request shape.
- **Per-card submit + footer batch.** Each `QuestionCard` gets a "Submit to
  Gradescope" action (only after Approve, only when the regrade window is
  open). The footer's "Export approved as Markdown" becomes "Submit all
  approved" — opens a confirmation modal listing every draft, then runs them
  sequentially through the same backend endpoint with a rate-limit delay.
- **Markdown export removed.** Single source of truth for sending.

**Important constraints:**

- **One submit at a time.** The backend serializes Playwright submissions
  through a single in-process mutex; concurrent regrades would race the
  shared browser context and Gradescope's session.
- **Selector fragility.** The "Request Regrade" button + textarea are inside
  Gradescope's React app. Class names will drift; the implementation needs a
  recorded reference dump (the discovery script below) and an explicit
  failure mode that surfaces "selector mismatch" so we don't silently submit
  wrong text.
- **Stop early on bad state.** Reject before launching the browser when the
  regrade window is closed, when the analysis isn't `approved`/`edited`, or
  when an existing `regrade_requests` row already covers this
  `question_submission_id`.

---

## Architecture

### Submission flow (per analysis)

```
POST /api/analyses/:id/submit
  → look up analysis → question → assignment → course
  → guard: regrade_requests_open, status, no existing regrade
  → take submitMutex
    → submitRegrade({course, assignment, submission, questionSubmissionId, comment})
      → playwright headless, addCookies(gs_sessions row)
      → goto /courses/<cid>/assignments/<aid>/submissions/<sid>
      → wait for React render
      → click question's "Request Regrade" button
      → fill textarea with comment
      → click submit, wait for success signal
      → close browser
    → log to regrade_submission_log
    → set analysis.status = 'submitted' (or 'failed')
    → trigger background syncAssignmentDetails to re-pull regrade_requests
  → release mutex
  → respond { ok, gradescope_regrade_id?, error? }
```

### Discovery script (one-time, before implementation)

`backend/scripts/gs-inspect-regrade.ts` (modeled on the existing
`gs-inspect.ts` at `backend/scripts/gs-inspect.ts:1`). Takes a submission URL
where `regrade_requests_open: true`. Opens **headed** Chromium with the saved
cookies, lets the user click into the regrade form so the React state is
materialized, then dumps:
- The full HTML at that point.
- A probe of every visible button + textarea + form (extending the existing
  `probeFnSrc` pattern at `gs-inspect.ts:64-111` — already captures
  `formInputs`, `buttons`, and `reactComponents`).
- A screenshot.

This lets us write the actual selectors for `gradescopeRegrade.ts` from real
DOM rather than guessing.

### New service: `gradescopeRegrade.ts`

```ts
// backend/src/services/gradescopeRegrade.ts
export type RegradeSubmitInput = {
  courseId: string;
  assignmentId: string;
  submissionId: string;
  questionAnchor: string;          // e.g. "Question_1" — from gs JSON
  questionLabel: string;           // for logging/error messages
  comment: string;
};

export type RegradeSubmitResult = {
  ok: true;
  gradescopeRegradeId?: string;    // best-effort, parsed from response if visible
} | {
  ok: false;
  error: string;
  stage: 'launch' | 'navigate' | 'find-button' | 'fill' | 'submit' | 'verify';
};

// One submit at a time across the process.
let activeSubmit: Promise<unknown> | null = null;
export async function submitRegrade(input: RegradeSubmitInput): Promise<RegradeSubmitResult> { ... }
```

Internally:
1. Load cookies from `gs_sessions`, abort if missing.
2. `chromium.launch({ headless: true })`, `context.addCookies(...)`.
3. Goto `/courses/<cid>/assignments/<aid>/submissions/<sid>`,
   `waitForLoadState('networkidle')`.
4. Locate the question (by `anchor` / `data-question-id` / nearby
   "Request Regrade" button — exact selector from the discovery dump).
5. Click → wait for textarea/dialog → `.fill(comment)` → click submit.
6. Wait for success signal (success toast, modal close, network response on
   `/regrade_requests`). Each stage that fails returns a typed error so the
   route can surface a useful message.
7. `browser.close()` in `finally`.

### Mutex

A simple module-level `Promise` chain (no external dep) — every call awaits
the previous one before launching its own browser. Phase 2's
`gradescopeSync.ts` already does sequential rate-limited work; this is the
same idea.

---

## Data model changes

### Extend `analyses.status` enum

Currently `'pending' | 'approved' | 'edited' | 'skipped'` at
`backend/src/db.ts:171`. Add `'submitted'` and `'failed'`. The PATCH route at
`backend/src/routes/analyses.ts:140-169` uses an `allowedStatus` set that
needs the same two values added (only for internal use — the frontend won't
PATCH to these directly; the submit route owns transitions to them).

### New table: `regrade_submission_log`

```sql
CREATE TABLE IF NOT EXISTS regrade_submission_log (
  id                       TEXT PRIMARY KEY,
  analysis_id              TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  question_id              TEXT NOT NULL,
  question_submission_id   TEXT,
  assignment_id            TEXT NOT NULL,
  submitted_at             INTEGER NOT NULL,
  comment                  TEXT NOT NULL,        -- exact text sent
  success                  INTEGER NOT NULL,     -- 0 / 1
  gradescope_regrade_id    TEXT,                 -- filled in after re-sync, when matched
  error                    TEXT,                 -- when success = 0
  stage                    TEXT                  -- when success = 0: which Playwright step failed
);
CREATE INDEX IF NOT EXISTS idx_log_analysis ON regrade_submission_log(analysis_id);
```

This is intentionally separate from `regrade_requests` (which mirrors
Gradescope state). Our log is an audit trail of what Regrader sent locally.

### No new column on `assignments`

We can construct `paths.regrade_requests_path` from `(course_id,
assignment_id, submission_id)` — all already stored. No schema change needed.

---

## Backend changes

### `backend/src/services/gradescopeRegrade.ts` (new)

See above.

### `backend/src/routes/analyses.ts` (modify)

- Add `POST /api/analyses/:id/submit`:
  - Joins analysis → question → assignment → course.
  - Loads `inorder_leaf_question_ids` / question anchor: easiest is to add
    `anchor` to the `questions` table (small migration) or look it up from
    the question's `id` + a query against the JSON dump. **Cleaner: store
    `anchor` on `questions`** — extend `gradescopeSync.ts:170-186` to pass
    `q.anchor` into the existing insert. Add `anchor TEXT` to the schema in
    `db.ts:44-60`.
  - Guards (return 4xx with explicit codes):
    - `regrade_requests_open !== 1` → 409 `{error: 'window_closed'}`
    - analysis status not in `{approved, edited}` → 409
      `{error: 'not_approved'}`
    - `regrade_requests` row exists for the question_submission_id → 409
      `{error: 'already_submitted'}`
  - Calls `submitRegrade(...)`, writes a `regrade_submission_log` row, sets
    `analyses.status = 'submitted'` on success / `'failed'` on failure.
  - On success, `await syncAssignmentDetails(courseId, assignmentId)` so the
    `regrade_requests` table picks up the new entry from Gradescope (same
    code path used by `POST /api/gradescope/sync/courses/:cid/assignments/:aid`
    today).
  - Maps `NoSessionError` / `SessionExpiredError` to `401` to trigger the
    frontend's reconnect path (already wired at
    `backend/src/routes/gradescope.ts:77-89`).

- Add `POST /api/assignments/:id/submit-approved`:
  - Iterates `analyses` rows with status in `{approved, edited}` for this
    assignment, calls the per-analysis submit logic sequentially, returns
    `{ submitted: number, failed: Array<{analysis_id, error}> }`.
  - Same mutex applies — running them through the per-analysis function
    naturally serializes them.

### `backend/src/services/gradescopeSync.ts` (modify)

- Persist `q.anchor` into the `questions` insert at lines 170-186 (after
  adding the column).

### `backend/src/db.ts` (modify)

- Add `anchor TEXT` to `questions` (and to `QuestionRow`).
- Add `regrade_submission_log` table + `RegradeSubmissionLogRow` type.
- Update `AnalysisRow.status` union to include `'submitted' | 'failed'`.

### `backend/src/routes/courses.ts` (modify)

- Include the latest `regrade_submission_log` rows for the assignment in the
  `GET /api/assignments/:id` response (so the frontend can render error
  details on `failed` cards).

---

## Frontend changes

### New: `frontend/src/components/ConfirmSubmitModal.tsx`

Lightweight modal (no router, no portal — overlay div + dialog div, like the
existing inline patterns in `Browse.tsx`). Props:

```ts
{
  drafts: Array<{ questionLabel: string; questionTitle: string; draft: string }>;
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
}
```

Renders a scrollable list of `Q1: title — <draft>` blocks, a "Cancel" and
"Submit N regrade requests" button, and a small note that submissions run
sequentially with a delay.

### `frontend/src/components/QuestionCard.tsx` (modify)

- Render two new statuses on the existing `STATUS_BADGE` map at lines 19-24:
  `submitted: 'bg-blue-100 text-blue-700'`, `failed: 'bg-red-100 text-red-700'`.
- After Approve/Save edit/Skip footer (lines 192-214), add a primary
  "Submit to Gradescope" button. Visibility/enabled rules:
  - Hidden if `analysis.status !== 'approved' && analysis.status !== 'edited'`.
  - Hidden if the assignment's `regrade_requests_open` is false.
  - Hidden if there's already a `regradeRequest` for this question.
  - Disabled while a submit is in flight.
- On click, show inline "Confirm submit / Cancel" buttons (no full modal —
  the per-card UX should be tight). On confirm, call `api.submitAnalysis(id)`,
  then `onAnalysisChange(updatedRow)`. On `failed`, render the error message
  from the latest `regrade_submission_log` row beneath the buttons.

### `frontend/src/pages/Browse.tsx` (modify)

- Drop `exportApproved()` (lines 133-159) and the related Markdown helpers.
- Footer button at lines 306-312 becomes "Submit all approved":
  - Disabled when assignment isn't loaded, regrade window closed, or no
    approved analyses.
  - Click → opens `ConfirmSubmitModal` populated from
    `analyses.filter(a => a.status === 'approved' || a.status === 'edited')`.
  - On confirm, calls `api.submitApproved(assignmentId)` and shows progress
    (e.g., a small running counter `submitting 3 / 7…`). The endpoint's
    response refreshes `analyses` and `detail` (since `regrade_requests` will
    have changed).
- Subscribe to `submission_log` rows from the `getAssignment` response so
  failed cards can show `failed: <stage> — <error>`.

### `frontend/src/api.ts` (modify)

- Add `regradeSubmissionLog` to the `Assignment` detail response type.
- Add:
  - `submitAnalysis(id) → POST /api/analyses/:id/submit`
  - `submitApproved(assignmentId) → POST /api/assignments/:id/submit-approved`

---

## Files to add / change

### New
- `backend/scripts/gs-inspect-regrade.ts` — discovery dump for the regrade UI.
- `backend/src/services/gradescopeRegrade.ts` — Playwright submit service.
- `frontend/src/components/ConfirmSubmitModal.tsx` — batch confirm UI.

### Modified
- `backend/src/db.ts` — `anchor` on `questions`, `regrade_submission_log`
  table, extended status enum.
- `backend/src/services/gradescopeSync.ts` — persist `q.anchor`.
- `backend/src/routes/analyses.ts` — `/submit` endpoints, status guards.
- `backend/src/routes/courses.ts` — include log rows in detail response.
- `frontend/src/api.ts` — new endpoints + types.
- `frontend/src/components/QuestionCard.tsx` — submit button + new statuses.
- `frontend/src/pages/Browse.tsx` — replace export footer with submit
  footer + modal wiring.

### Removed
- The `exportApproved` helper inside `Browse.tsx`.

---

## Phased build order within Phase 3

1. **Run the discovery script.** Use it on a real submission with the
   regrade window open, save the dump under `backend/data/gs-inspect/`. This
   gates everything else — selectors come from real DOM.
2. **Schema + sync changes.** Add `anchor` column and `regrade_submission_log`
   table; backfill `anchor` by re-syncing one assignment.
3. **Build `gradescopeRegrade.ts` end-to-end against one real question.**
   No HTTP route yet — just a small `npx tsx` script that invokes the
   service. Iterate selectors until a real regrade is filed successfully.
4. **Backend route.** `POST /api/analyses/:id/submit`, with all guards and
   the post-submit re-sync. Test by hand against the same question (will
   409 on the second call thanks to the duplicate guard).
5. **Batch endpoint.** `POST /api/assignments/:id/submit-approved`.
6. **Frontend per-card submit.** Inline confirm + status rendering.
7. **Frontend batch submit.** `ConfirmSubmitModal` + footer wiring.
8. **Cleanup.** Remove `exportApproved`, update README, document the
   discovery script.

Steps 1-3 are research-heavy; once selectors are nailed, 4-8 are mechanical.

---

## Verification

1. **Discovery dump.** `gs-inspect-regrade.ts` dump exists for at least one
   real open-window submission and shows the regrade button + textarea
   selectors clearly.
2. **Single submission.** With the dev stack running, click into an
   approved-status question on a real graded assignment with an open regrade
   window, click "Submit to Gradescope", confirm. The card flips to
   `submitted`, and the existing-regrade banner appears underneath after the
   re-sync completes. Verify on Gradescope itself that the regrade was filed
   with the exact draft text.
3. **Guards trigger correctly.**
   - Closed regrade window → button hidden, direct API call returns 409.
   - Already-submitted question → button hidden, direct API call returns 409.
   - Stale `pending` analysis → API call returns 409.
4. **Batch submit.** Approve 3 questions, click "Submit all approved",
   confirm. The progress counter advances; all three end as `submitted`;
   `regrade_submission_log` has 3 success rows; rate-limit gap is visible
   between requests.
5. **Failure path.** Force a failure (e.g. submit twice without the dedupe
   guard, or rename a selector mid-test) and verify the card shows `failed`
   with a stage + error message, and the log row records the failure.
6. **Session expiry.** Manually delete the `gs_sessions` row, click submit
   → backend returns 401, frontend bounces to the Connect view.
7. **No regression.** Phase 2 sync + analyze still works end-to-end.

No automated tests — same reasoning as Phase 1/2: the load-bearing logic
(Playwright selectors and the prompt) can only be evaluated by running it.

---

## Open items / things we won't know until we try

- **Selector stability.** The React form for regrade requests probably
  changes less often than the surrounding page, but it WILL change. Plan to
  re-run the discovery script when a submission silently fails.
- **Gradescope's success signal.** Whether the form returns a JSON response,
  closes a modal, or just navigates — we'll know after the discovery dump.
  The verification check should be specific (e.g., wait for a `[data-...]`
  attribute or a network response on `/regrade_requests`), not just "no
  error".
- **Multi-rect / multi-part questions.** Some questions have parts (a, b, c)
  that file separate regrade requests. The current Phase 2 schema treats
  each leaf question independently, so this should "just work" — but worth
  verifying with a multi-part question in step 2.
- **Browser reuse.** Currently every submission launches a new Chromium.
  With a real batch (10+ questions) that's 30s+ of overhead. If it's
  painful, hold one browser open for the duration of `submit-approved`.
  Don't optimize until the basic flow ships.
- **Group submissions.** Already flagged as a Phase 2 caveat — same caveat
  here. Don't auto-submit group regrades without explicit confirmation.
- **Phase 4 hook.** `regrade_submission_log` gives us the data Phase 4's
  study mode would want for "questions you've successfully challenged"
  cohort filtering. No work needed now, just don't drop the table.
