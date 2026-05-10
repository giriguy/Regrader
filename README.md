# Regrader

Personal web app that crawls your Gradescope account, identifies graded
questions where points may have been deducted unfairly, and drafts polite
regrade requests for your review.

100% local — no calls to OpenAI / Anthropic / any cloud service. The LLM runs
on Apple Silicon via [`z-lab/dflash`](https://github.com/z-lab/dflash) wrapped
in a tiny FastAPI server (in `.dflash/server.py`). DFlash uses
[block-diffusion speculative decoding](https://arxiv.org/abs/2602.06036) for
fast inference.

## Phase 3 status

- One-time SSO login via headed Chromium → cookie persisted to local SQLite
- Crawler walks your courses → assignments → graded submissions
- Submission state pulled from Gradescope's React JSON endpoint
  (`.../submissions/<sid>.json?content=react`) — questions, full rubric (with
  applied flags), grader comments, and existing regrade requests all in one
  payload
- Per-question PDF region rendered as a PNG so you can see exactly what was
  graded
- Per-question LLM call: tight prompt that references the actual rubric items
  the grader applied (or didn't) and decides whether each deduction is
  defensible
- **Automated regrade submission** — approved drafts are POSTed to
  Gradescope's regrade form via a headless Playwright session reusing the
  saved cookie. Per-card "Submit to Gradescope" with inline confirm, plus a
  footer "Submit all approved" that batches them sequentially. Every send is
  logged to `regrade_submission_log` with the exact text + outcome.

Phase 4 (study mode) is sketched in
[`plans/overview-a-web-app-lucky-hopper.md`](plans/overview-a-web-app-lucky-hopper.md).

## ToS / responsible use

Automating your *own* Gradescope account at human-paced rates for personal
review is the gray-zone good case. Don't share the tool, don't run it
concurrently against the same account, don't scrape other people's data, and
check whether your school's policies are stricter than Gradescope's.

## Setup

### 1. Install and run the local LLM server

The `.dflash/` directory holds a clone of
[`z-lab/dflash`](https://github.com/z-lab/dflash) and a small FastAPI wrapper
(`.dflash/server.py`) that exposes an OpenAI-compatible
`/v1/chat/completions` endpoint.

One-time setup:

```bash
cd .dflash/dflash
uv venv --python 3.11 .venv
source .venv/bin/activate
uv pip install -e ".[mlx]"
uv pip install fastapi uvicorn reportlab
```

**Verified working pair on M3 Pro 36GB** (uses pre-quantized MLX target +
small DFlash draft — ~6GB cached + ~1GB to download):

```bash
source .dflash/dflash/.venv/bin/activate
python .dflash/server.py \
  --target mlx-community/Qwen3.5-9B-MLX-4bit \
  --draft  z-lab/Qwen3.5-9B-DFlash \
  --port 8000
```

Why this pair: speculative decoding only requires matching tokenizers, not
matching weight precision. The 4-bit quantized target loads in ~3s and
generates ~30 tok/s on M3 Pro; the BF16 DFlash draft is only 537MB. Together
they need about 6GB of RAM at runtime.

To override the HuggingFace cache location:

```bash
HF_HOME=/Users/adithyagiri/Downloads/Models python .dflash/server.py ...
```

### 2. Install the app

```bash
npm run install:all
npx playwright install chromium    # one-time, for the Gradescope login window
cp .env.example .env
```

### 3. Run

```bash
npm run dev
```

- Backend: `http://localhost:3001`
- Frontend: `http://localhost:5173` (open this)

## How it works

1. Click **Connect Gradescope**. A Chromium window opens; complete your
   school's SSO. The window closes once the `_gradescope_session` cookie is
   issued, and the cookie is saved to SQLite.
2. Click **Sync courses** in the sidebar. The crawler hits `/account` and
   lists every enrolled course.
3. Expand a course and click ↻ to sync its assignments. Pick a graded one.
4. Click **Sync details**. The crawler fetches
   `submissions/<sid>.json?content=react`, persists every question + rubric
   item (with applied flags) + existing regrade request, and renders a
   per-question PNG by cropping the graded PDF to the rect Gradescope itself
   uses for that question.
5. Click **Analyze**. For every question that lost points and isn't already
   under regrade, the local LLM gets a focused prompt: max points, score, the
   full rubric (each item tagged APPLIED or NOT APPLIED), and the cropped
   answer. It decides whether to flag a regrade and drafts the request.
6. Review the cards. Edit drafts, **Approve** the ones you want to send.
7. Send them — either **Submit to Gradescope** on a single card, or **Submit
   all approved** in the footer. Each submission spins up a brief headless
   Chromium session (using your saved cookie), drives the regrade form, and
   verifies the request landed by watching for the POST response. The card
   flips to `submitted` and the existing-regrade banner appears underneath
   after the post-submit re-sync.

If a Gradescope UI change breaks the selectors, the failing card surfaces
the exact stage that failed (`open-form`, `fill`, `submit`, `verify`). Re-run
`npx tsx backend/scripts/gs-inspect-regrade.ts <submission_url>` against a
real submission with the regrade window open to dump the form's current DOM
and update `backend/src/services/gradescopeRegrade.ts` accordingly.

## Known limitations (Phase 3)

- **PDF assignments only.** Online and programming submission types are
  ignored. The JSON shape we'd need is there; we just haven't built the
  prompt path for them.
- **Closed regrade windows are read-only.** When `regrade_requests_open` is
  false, the analyze and submit buttons are disabled.
- **One submit at a time.** The backend serializes regrade submissions
  through a process-level mutex; concurrent sends would race the shared
  Playwright session.
- **Selector fragility.** The regrade form is React-rendered. When
  Gradescope ships a redesign, submissions will fail at one of the named
  stages — re-run the discovery script and update the selectors.
- **First-token latency.** dflash-mlx loads the model on first request (~30s
  for 9B). Subsequent analyses are fast.

## Stack

| Layer | Choice |
| --- | --- |
| Frontend | Vite + React + Tailwind |
| Backend | Node.js + Express + better-sqlite3 |
| Auth flow | Playwright (headed) for one-time SSO login |
| Crawl transport | Plain `fetch` with the captured session cookie |
| Regrade submission | Playwright (headless) driving the real React form |
| HTML parsing | Cheerio (only for `/account` and course pages) |
| PDF crop rendering | `pdf-to-png-converter` + `sharp` |
| LLM | dflash-mlx (DFlash speculative decoding on Apple Silicon) |
| LLM transport | OpenAI SDK pointed at the local dflash server |
