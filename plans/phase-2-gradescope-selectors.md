# Gradescope DOM + JSON endpoints reference

Discovered by running `backend/scripts/gs-inspect.ts` against a real account on 2026-05-09. Source dumps live in `backend/data/gs-inspect/`.

## Top-level finding

**The graded-submission view is one big React component (`AssignmentSubmissionViewer`) whose entire state is exposed both as `data-react-props` on the HTML page AND as a clean JSON endpoint:**

```
GET /courses/<cid>/assignments/<aid>/submissions/<sid>.json?content=react
Cookie: _gradescope_session=...
→ 200 application/json
```

**Confirmed working with a session cookie pulled from a normal browser login.** No anti-bot, no Cloudflare interstitial. ~84KB JSON per submission containing every field the React app renders.

This collapses Phase 2's hardest problem (DOM scraping per question) into "fetch JSON, parse JSON". **Playwright is now only needed for the one-time SSO login** — all subsequent crawling is plain HTTP with the captured cookie.

The two index pages (`/account`, `/courses/<cid>`) don't have JSON equivalents (404 / 500) — those still need HTML parsing, but they're simple semantic HTML.

---

## /account — list of courses

URL: `https://www.gradescope.com/account`. Server-rendered HTML. Title: `Your Courses | Gradescope`.

Each enrolled course is an `<a class="courseBox">`:

```html
<a class="courseBox" href="/courses/1233533">
  <h3 class="courseBox--shortname">CS 170</h3>
  <h4 class="courseBox--name">Efficient Algorithms and Intractable Problems</h4>
  <div>23 assignments</div>
</a>
```

**Crawler:**
- Selector: `a.courseBox[href^="/courses/"]`
- Course id: parse from `href` (`/courses/(\d+)`)
- Short name: `h3.courseBox--shortname`
- Long name: `h4.courseBox--name`

---

## /courses/&lt;cid&gt; — list of assignments

URL: `https://www.gradescope.com/courses/<cid>`. Server-rendered HTML. Title: `<Course> Dashboard | Gradescope`.

Assignments are in a `<table class="table dataTable no-footer">` with header `["Name", "Status", "ReleasedDue (PDT)"]`.

The Name cell is an `<a href="/courses/<cid>/assignments/<aid>/submissions/<sid>">` for assignments where the student has a submission. For unsubmitted assignments the link goes to `/courses/<cid>/assignments/<aid>` (assignment page, not submission).

The Status cell text is one of: `"Graded"`, `"Submitted"`, `"No Submission"`. Filter to `"Graded"` for our purposes.

**Crawler:**
- Table selector: `table.table.dataTable`
- Each `<tr>` after the header
- Submission link: `a[href*="/submissions/"]` inside the row → extract `aid` and `sid` from URL
- Status: text content of the second `<td>`
- Title: text content of the link
- Skip rows where the link doesn't include `/submissions/` (unsubmitted)

---

## /courses/&lt;cid&gt;/assignments/&lt;aid&gt;/submissions/&lt;sid&gt;.json?content=react — the gold mine

The whole submission state. Top-level keys observed:

```
assignment, assignment_level_rubric, assignment_submission, container,
course_members, current_user, grades_visible, hide_email_addresses,
student_hide_email_addresses, image_attachments, inorder_leaf_question_ids,
outline, ownerships, inactive, paths, pdf_attachment, question_submissions,
questions, regrade_requests, rubric_items, rubric_item_groups,
successful_submission_modal, text_files, text_annotations_enabled,
rubric_annotation_association_enabled, quickmarks_enabled,
show_outline_header_message, alerts
```

### `assignment`

```json
{
  "id": 7750050,
  "title": "Midterm 1",
  "total_points": "101.0",
  "submission_format": "fixed_length",
  "regrade_requests_open": false,
  "regrade_request_start": "2026-03-10T12:00:00.000000-07:00",
  "regrade_request_end":   "2026-03-13T23:59:00.000000-07:00",
  "rubric_visibility_setting": "show_all_rubric_items",
  ...
}
```

`regrade_requests_open` is the live flag we should respect — don't draft anything when it's false (the window is closed). `total_points` is a stringified float.

### `assignment_submission`

```json
{
  "id": 393529875,
  "score": "68.0",
  "status": "processed",
  "active": true,
  "created_at": "...",
  ...
}
```

### `questions[]`

```json
{
  "id": 67014688,
  "type": "FreeResponseQuestion",
  "title": "Mining",
  "index": 1,
  "weight": "25.0",
  "full_index": "1",
  "numbered_title": "1: Mining",
  "anchor": "Question_1",
  "scoring_type": "positive",
  "parameters": {
    "crop_rect_list": [
      { "x1": 17.6, "x2": 86.2, "y1": 28.2, "y2": 88.8, "page_number": 3 }
    ]
  },
  "content": []
}
```

- `weight` is the question's max points (string).
- `crop_rect_list` is the **PDF region for the answer** in **percentage coordinates** (0–100) of the page. Combined with `pdf_attachment.url` and `crop_rect_list[].page_number`, we can render the exact image of the student's answer for that question.
- `content: []` for FreeResponseQuestion means the prompt is not in the JSON — it lives only on the PDF (or on the assignment page). For `MultipleChoiceQuestion` and friends we'd expect content to be populated; we'll handle those types as they come up.

### `rubric_items[]` — the actual rubric

```json
{
  "id": 259192447,
  "description": "Correctly runs algorithm until the queue is completely empty (not just returning the first time $$t$$ is seen) and returns $$d(t)$$.",
  "weight": "5.0",
  "question_id": 67014690,
  "position": 2,
  "group_id": 4449902,
  "present": false,
  "source_id": null
}
```

**`present` is the key field — `true` means the grader applied this item to your submission.** For `scoring_type: "positive"` questions, applied items add their `weight`; for `"negative"` questions, applied items subtract. (We'll verify this against the totals during implementation.)

`description` contains LaTeX in `$$...$$` delimiters which we'll either render or strip when sending to the LLM.

### `rubric_item_groups[]`

```json
{
  "id": 4440019,
  "description": "Part (a)",
  "position": 0,
  "question_id": 67014688,
  "mutually_exclusive": false
}
```

Groups rubric items into sub-parts. `mutually_exclusive: true` means at most one item in the group can be applied (radio-button semantics).

### `question_submissions[]`

```json
{
  "id": 3722680898,
  "question_id": 67014690,
  "score": "0.0",
  "active": true,
  "data": {},
  "answers": {},
  "evaluations": [],
  "annotations": [],
  "grade_path": "/courses/.../questions/.../submissions/.../grade"
}
```

For PDF assignments (`submission_format: "fixed_length"`), `data` and `answers` are empty — the answer IS the PDF region. For typed assignments, `answers` would contain the typed text.

### `regrade_requests[]` — already-filed requests

```json
{
  "id": 7498128,
  "question_submission_id": 3722680607,
  "student_comment": "I think I should get +3 points for rubric item Runtime Analysis ...",
  "staff_comment": "The solution indicates that the total runtime is O(n), not O(n) for each subproblem",
  "completed": true,
  "created_at": "2026-03-13T23:37:56.121371-07:00",
  "updated_at": "2026-03-15T13:50:17.225265-07:00",
  "assignment_id": 7750050,
  "staff_id": 3999752
}
```

Two implications:
1. **Skip questions with an existing regrade request** — don't draft duplicates. Match by `question_submission_id`.
2. **Phase 3 will need to POST to** `paths.regrade_requests_path` with `{question_submission_id, student_comment}` (shape TBD by intercepting a real submission).

### `pdf_attachment`

```json
{
  "id": ...,
  "filename": "Midterm 1.pdf",
  "page_count": 9,
  "status_string": "...",
  "url": "https://production-gradescope-uploads.s3-...",
  "pages": [...]
}
```

The S3 URL is pre-signed (10800s = 3h). We download it on demand to extract per-question crops.

### `paths`

```json
{
  "course_path": "/courses/1233533",
  "submission_path": ".../submissions/393529875",
  "submission_react_path": ".../submissions/393529875.json?content=react",
  "graded_pdf_path": ".../submissions/393529875.pdf",
  "regrade_requests_path": ".../submissions/393529875/regrade_requests",
  "original_file_path": "https://production-gradescope-uploads.s3-...",
  ...
}
```

`regrade_requests_path` is what Phase 3 POSTs to.

---

## Things confirmed NOT to exist (don't bother)

- `/account.json` → 404
- `/courses/<cid>.json` → 500
- `/courses/<cid>/assignments.json` → not tested but likely doesn't exist either

The two index pages must be HTML-parsed.

---

## Crawler architecture (revised based on findings)

```
gradescopeAuth.ts       — Playwright headed login → save cookies (one-time)
gradescopeHttp.ts       — fetch wrapper that injects cookies + handles 401→reconnect
gradescopeCrawler.ts    — uses gradescopeHttp:
   listCourses()        → GET /account, parse a.courseBox
   listAssignments(cid) → GET /courses/<cid>, parse table.dataTable
   getSubmission(...)   → GET ...submissions/<sid>.json?content=react, parse JSON
gradescopePdf.ts        — download graded PDF, render per-question crops using crop_rect_list
```

Dependencies needed (beyond what we have): `cheerio` for the two HTML pages. That's it. **We do NOT need `pdf-to-png-converter` anymore for the new flow** (we'll render PDF crops with the existing pdfjs path, just cropped per-question).

Per-question normalized record fed to the LLM:

```ts
{
  question_label: string,        // from `numbered_title` or `full_index`
  title: string,                 // from `title`
  max_points: number,            // from `weight`
  points_awarded: number,        // from question_submission.score
  rubric_items: Array<{
    description: string,         // strip $$...$$ for now
    weight: number,
    applied: boolean,            // from `present`
    group_description: string,   // from rubric_item_groups
  }>,
  answer_image_path: string,     // path to cropped PDF region PNG
  has_existing_regrade: boolean, // skip these
}
```

This is exactly the input the per-question analyzer needs. Everything Phase 2 promised, with about 1/3 the code we'd need for actual DOM scraping.
