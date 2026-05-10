/**
 * Headed inspection of Gradescope's regrade-request UI.
 *
 * Phase 3 needs to drive the React form that files a regrade. Class names and
 * widget shapes can't be inferred from the JSON endpoint, so we open a real
 * browser window, let YOU click into the regrade form on a real submission
 * with `regrade_requests_open: true`, and dump the resulting DOM so we can
 * write reliable selectors for `gradescopeRegrade.ts`.
 *
 * Usage:
 *   1. Make sure backend/data/gs-session.json or the gs_sessions DB row holds
 *      a fresh login (run `npm run dev` and use the Connect button, or run
 *      `npx tsx scripts/gs-login.ts`).
 *   2. Find a graded submission whose JSON shows `regrade_requests_open: true`
 *      and where you have NOT already filed a regrade for the question you'll
 *      poke at.
 *   3. Run:
 *        npx tsx scripts/gs-inspect-regrade.ts <submission_url>
 *      e.g.
 *        npx tsx scripts/gs-inspect-regrade.ts \
 *          https://www.gradescope.com/courses/1233533/assignments/7750050/submissions/393529875
 *   4. The Chromium window opens. Navigate to a question, click "Request
 *      Regrade", and STOP at the textarea — DO NOT submit. Then come back to
 *      the terminal and press Enter.
 *   5. The script captures the DOM as it currently looks (with the form
 *      open), writes HTML/probe/screenshot to backend/data/gs-inspect/, and
 *      closes the browser. Inspect `regrade-form.json` to find the textarea
 *      selector, the submit button, and any data attributes on the parent
 *      dialog.
 *
 * The script intentionally does NOT submit — that's a side effect we don't
 * want to cause from an inspection tool. Submission lives in the real
 * service.
 */
import { chromium, type Cookie } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { loadCookies } from '../src/services/gradescopeSession.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_PATH = path.resolve(__dirname, '../data/gs-session.json');
const OUT_DIR = path.resolve(__dirname, '../data/gs-inspect');

async function loadCookiesFromAnywhere(): Promise<Cookie[]> {
  const dbCookies = loadCookies();
  if (dbCookies && dbCookies.length > 0) {
    return dbCookies as Cookie[];
  }
  try {
    const session = JSON.parse(await fs.readFile(SESSION_PATH, 'utf8'));
    if (Array.isArray(session.cookies) && session.cookies.length > 0) {
      return session.cookies as Cookie[];
    }
  } catch {
    // fall through
  }
  throw new Error(
    'No saved Gradescope session found. Run the Connect flow or scripts/gs-login.ts first.',
  );
}

function waitForEnter(prompt: string): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

const PROBE_FN_SRC = `
  (function probe() {
    function dump(sel, max) {
      return Array.from(document.querySelectorAll(sel)).slice(0, max ?? 40).map(function (el) {
        return {
          tag: el.tagName.toLowerCase(),
          id: el.id || undefined,
          name: el.getAttribute('name') || undefined,
          type: el.getAttribute('type') || undefined,
          role: el.getAttribute('role') || undefined,
          ariaLabel: el.getAttribute('aria-label') || undefined,
          classes: typeof el.className === 'string'
            ? el.className.split(/\\s+/).filter(Boolean).slice(0, 12)
            : undefined,
          dataKeys: Object.keys(el.dataset || {}),
          text: (el.textContent || '').trim().slice(0, 140),
          visible: !!(el.offsetParent || el.getClientRects().length),
        };
      });
    }
    function ancestorChain(el) {
      var chain = [];
      var cur = el;
      while (cur && cur !== document.body && chain.length < 8) {
        chain.push({
          tag: cur.tagName ? cur.tagName.toLowerCase() : null,
          id: cur.id || undefined,
          classes: typeof cur.className === 'string'
            ? cur.className.split(/\\s+/).filter(Boolean).slice(0, 8)
            : undefined,
          dataKeys: Object.keys(cur.dataset || {}),
        });
        cur = cur.parentElement;
      }
      return chain;
    }
    var textareas = Array.from(document.querySelectorAll('textarea')).map(function (t) {
      return {
        id: t.id || undefined,
        name: t.getAttribute('name') || undefined,
        placeholder: t.getAttribute('placeholder') || undefined,
        ariaLabel: t.getAttribute('aria-label') || undefined,
        classes: typeof t.className === 'string'
          ? t.className.split(/\\s+/).filter(Boolean).slice(0, 12)
          : undefined,
        ancestors: ancestorChain(t),
      };
    });
    var dialogs = Array.from(document.querySelectorAll('[role=dialog], dialog, .modal, [aria-modal=true]')).map(function (d) {
      return {
        tag: d.tagName.toLowerCase(),
        role: d.getAttribute('role') || undefined,
        ariaModal: d.getAttribute('aria-modal') || undefined,
        ariaLabel: d.getAttribute('aria-label') || undefined,
        id: d.id || undefined,
        classes: typeof d.className === 'string'
          ? d.className.split(/\\s+/).filter(Boolean).slice(0, 12)
          : undefined,
        text: (d.textContent || '').trim().slice(0, 200),
      };
    });
    var forms = Array.from(document.querySelectorAll('form')).map(function (f) {
      return {
        action: f.getAttribute('action'),
        method: f.getAttribute('method'),
        id: f.id || undefined,
        classes: typeof f.className === 'string'
          ? f.className.split(/\\s+/).filter(Boolean).slice(0, 12)
          : undefined,
        inputs: Array.from(f.querySelectorAll('input, textarea, select')).map(function (i) {
          return {
            tag: i.tagName.toLowerCase(),
            name: i.getAttribute('name') || undefined,
            type: i.getAttribute('type') || undefined,
            value: i.tagName === 'INPUT' && i.getAttribute('type') === 'hidden'
              ? (i.getAttribute('value') || '').slice(0, 60)
              : undefined,
          };
        }),
      };
    });
    return {
      title: document.title,
      url: location.href,
      csrfToken: (document.querySelector('meta[name="csrf-token"]') || {}).content,
      csrfParam: (document.querySelector('meta[name="csrf-param"]') || {}).content,
      regradeButtons: dump('button, a', 60).filter(function (b) {
        return /regrade/i.test(b.text || '');
      }),
      submitButtons: dump('button[type=submit], input[type=submit], button', 60).filter(function (b) {
        return /submit|send|file|request/i.test(b.text || '');
      }),
      textareas: textareas,
      dialogs: dialogs,
      forms: forms,
      reactRoots: Array.from(document.querySelectorAll('[data-react-class]')).slice(0, 30).map(function (el) {
        return {
          cls: el.getAttribute('data-react-class'),
          propsLen: (el.getAttribute('data-react-props') || '').length,
        };
      }),
    };
  })();
`;

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error('usage: tsx scripts/gs-inspect-regrade.ts <submission_url>');
    process.exit(2);
  }

  const cookies = await loadCookiesFromAnywhere();

  await fs.mkdir(OUT_DIR, { recursive: true });

  console.log('[gs-inspect-regrade] launching headed Chromium…');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  await context.addCookies(cookies);
  const page = await context.newPage();

  console.log(`[gs-inspect-regrade] navigating to ${url}`);
  await page.goto(url, { waitUntil: 'networkidle' });

  if (page.url().includes('/login')) {
    console.error('[gs-inspect-regrade] redirected to /login — session expired');
    await browser.close();
    process.exit(1);
  }

  console.log(
    '\n[gs-inspect-regrade] In the browser:\n' +
      '  1. Scroll to a question with the regrade window open.\n' +
      '  2. Click "Request Regrade" so the textarea is visible.\n' +
      '  3. (Optional) Type a few characters into the textarea.\n' +
      '  4. DO NOT click the final submit button.\n' +
      '\nWhen the form is open and ready, come back here and press Enter.\n',
  );
  await waitForEnter('press Enter to capture the page → ');

  const slug = 'regrade-form';
  const html = await page.content();
  await fs.writeFile(path.join(OUT_DIR, `${slug}.html`), html);
  console.log(`[gs-inspect-regrade] wrote ${slug}.html (${html.length} bytes)`);

  const probe = await page.evaluate(PROBE_FN_SRC);
  await fs.writeFile(
    path.join(OUT_DIR, `${slug}.json`),
    JSON.stringify(probe, null, 2),
  );
  console.log(`[gs-inspect-regrade] wrote ${slug}.json`);

  await page.screenshot({
    path: path.join(OUT_DIR, `${slug}.png`),
    fullPage: true,
  });
  console.log(`[gs-inspect-regrade] wrote ${slug}.png`);

  await browser.close();
  console.log(
    '\n[gs-inspect-regrade] done. Inspect:\n' +
      `  ${path.join(OUT_DIR, slug + '.json')}\n` +
      'for the textarea / dialog / submit-button selectors and update\n' +
      'backend/src/services/gradescopeRegrade.ts accordingly.',
  );
}

main().catch((err) => {
  console.error('[gs-inspect-regrade] error:', err);
  process.exit(1);
});
