/**
 * Drive Gradescope's regrade-request form via Playwright.
 *
 * Phase 3's only "real-DOM" surface. We can't use the JSON endpoint to file a
 * regrade — there isn't one — so we open a headless Chromium with the saved
 * session cookies, navigate to the submission, click "Request Regrade" on the
 * target question, fill the textarea, submit, and wait for a confirmation
 * signal.
 *
 * Selectors here are best-effort defaults. When Gradescope's React app
 * changes them, run `backend/scripts/gs-inspect-regrade.ts` against a real
 * submission with the regrade window open, inspect
 * `backend/data/gs-inspect/regrade-form.json`, and update the constants
 * below. Each stage throws a typed error so the failing step is obvious in
 * the response and the audit log.
 */
import { chromium, type BrowserContext, type Page } from 'playwright';
import { loadCookies, type GsCookie } from './gradescopeSession.js';
import {
  NoSessionError,
  SessionExpiredError,
} from './gradescopeHttp.js';

const BASE_URL = 'https://www.gradescope.com';
const NAV_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 10_000;
const SUBMIT_RESPONSE_TIMEOUT_MS = 20_000;

export type RegradeSubmitInput = {
  courseId: string;
  assignmentId: string;
  submissionId: string;
  /** Gradescope question anchor (e.g. "Question_1") used to find the right card. */
  questionAnchor: string;
  /** Used only in error messages. */
  questionLabel: string;
  comment: string;
};

export type RegradeStage =
  | 'launch'
  | 'navigate'
  | 'find-question'
  | 'open-form'
  | 'fill'
  | 'submit'
  | 'verify';

export type RegradeSubmitResult =
  | { ok: true; gradescopeRegradeId: string | null }
  | { ok: false; stage: RegradeStage; error: string };

class StageError extends Error {
  constructor(public stage: RegradeStage, msg: string) {
    super(msg);
  }
}

// Module-level mutex: only one Playwright submit at a time across the process.
let chain: Promise<unknown> = Promise.resolve();

export function submitRegrade(
  input: RegradeSubmitInput,
): Promise<RegradeSubmitResult> {
  const next = chain.then(() => doSubmit(input));
  chain = next.catch(() => {});
  return next;
}

async function doSubmit(
  input: RegradeSubmitInput,
): Promise<RegradeSubmitResult> {
  const cookies = loadCookies();
  if (!cookies || cookies.length === 0) throw new NoSessionError();

  let context: BrowserContext | null = null;
  try {
    const browser = await chromium.launch({ headless: true });
    try {
      context = await browser.newContext();
      await context.addCookies(cookies as GsCookie[] as never);
      const page = await context.newPage();
      page.setDefaultTimeout(ACTION_TIMEOUT_MS);
      page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

      const submissionUrl = `${BASE_URL}/courses/${input.courseId}/assignments/${input.assignmentId}/submissions/${input.submissionId}`;
      try {
        await page.goto(submissionUrl, { waitUntil: 'networkidle' });
      } catch (e) {
        throw new StageError(
          'navigate',
          `failed to open ${submissionUrl}: ${msg(e)}`,
        );
      }
      if (page.url().includes('/login')) {
        throw new SessionExpiredError();
      }

      const id = await tryEachStage(input, page);
      return { ok: true, gradescopeRegradeId: id };
    } finally {
      try {
        await context?.close();
      } catch {
        // ignore
      }
      try {
        await browser.close();
      } catch {
        // ignore
      }
    }
  } catch (e) {
    if (e instanceof SessionExpiredError) throw e;
    if (e instanceof StageError) {
      return { ok: false, stage: e.stage, error: e.message };
    }
    return { ok: false, stage: 'launch', error: msg(e) };
  }
}

async function tryEachStage(
  input: RegradeSubmitInput,
  page: Page,
): Promise<string | null> {
  // Stage: find-question. Scroll the target question into view.
  // Gradescope renders an anchor like `<a name="Question_1">` near each
  // question card. We scroll to it, then look for a "Request Regrade"
  // control inside the question's container.
  let questionScope;
  try {
    const anchor = page
      .locator(`a[name="${input.questionAnchor}"], #${input.questionAnchor}`)
      .first();
    await anchor.waitFor({ state: 'attached', timeout: ACTION_TIMEOUT_MS });
    await anchor.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
    // Walk up to the nearest plausible "question card" container; if we can't
    // identify one, fall back to a window after the anchor.
    questionScope = anchor.locator(
      'xpath=ancestor-or-self::*[contains(@class, "question") or contains(@class, "Question") or @data-react-class][1]',
    );
    if ((await questionScope.count()) === 0) {
      questionScope = anchor.locator('xpath=parent::*');
    }
  } catch (e) {
    throw new StageError(
      'find-question',
      `couldn't locate anchor "${input.questionAnchor}" for ${input.questionLabel}: ${msg(e)}`,
    );
  }

  // Stage: open-form. Click the "Request Regrade" button inside the question.
  try {
    const regradeButton = questionScope
      .getByRole('button', { name: /request\s+regrade/i })
      .first();
    if ((await regradeButton.count()) === 0) {
      // Some Gradescope variants use a link rather than a button.
      const regradeLink = questionScope
        .locator('a, button')
        .filter({ hasText: /request\s+regrade/i })
        .first();
      await regradeLink.click({ timeout: ACTION_TIMEOUT_MS });
    } else {
      await regradeButton.click({ timeout: ACTION_TIMEOUT_MS });
    }
  } catch (e) {
    throw new StageError(
      'open-form',
      `Request Regrade control not found or not clickable for ${input.questionLabel}: ${msg(e)}`,
    );
  }

  // Stage: fill. Wait for the textarea (typically inside a dialog) and type.
  try {
    const textarea = page
      .locator(
        '[role="dialog"] textarea, dialog textarea, .modal textarea, textarea[name*="comment"], textarea[name*="regrade"], textarea',
      )
      .first();
    await textarea.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
    await textarea.fill(input.comment);
  } catch (e) {
    throw new StageError(
      'fill',
      `regrade textarea did not appear or could not be filled: ${msg(e)}`,
    );
  }

  // Stage: submit. Click the form's submit/send button and wait for the
  // POST to /regrade_requests so we know the request actually went out.
  let regradeId: string | null = null;
  try {
    const responsePromise = page
      .waitForResponse(
        (r) =>
          /\/regrade_requests(\?|$|\b)/.test(r.url()) &&
          r.request().method() === 'POST',
        { timeout: SUBMIT_RESPONSE_TIMEOUT_MS },
      )
      .catch(() => null);

    const submitButton = page
      .locator('[role="dialog"], dialog, .modal, body')
      .first()
      .getByRole('button', {
        name: /submit\s*(request|regrade)?|file\s+regrade|send\s+request/i,
      })
      .last();
    await submitButton.waitFor({
      state: 'visible',
      timeout: ACTION_TIMEOUT_MS,
    });
    await submitButton.click({ timeout: ACTION_TIMEOUT_MS });

    const response = await responsePromise;
    if (response) {
      const status = response.status();
      if (status >= 400) {
        throw new StageError(
          'verify',
          `regrade POST returned ${status} ${response.statusText()}`,
        );
      }
      // Best-effort: pull a regrade id out of the response body if it's JSON.
      try {
        const body = await response.json();
        if (body && typeof body === 'object') {
          const rid =
            (body as Record<string, unknown>).id ??
            ((body as Record<string, unknown>).regrade_request as
              | { id?: unknown }
              | undefined)?.id;
          if (typeof rid === 'string' || typeof rid === 'number') {
            regradeId = String(rid);
          }
        }
      } catch {
        // not JSON; that's fine
      }
    }
  } catch (e) {
    if (e instanceof StageError) throw e;
    throw new StageError(
      'submit',
      `failed to submit regrade form: ${msg(e)}`,
    );
  }

  // Stage: verify. We already verified the response code above when a
  // response was captured. As a fallback, wait briefly for the form to close.
  try {
    await page
      .locator('[role="dialog"]')
      .first()
      .waitFor({ state: 'hidden', timeout: 3_000 })
      .catch(() => {});
  } catch {
    // non-fatal
  }
  return regradeId;
}

function msg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
