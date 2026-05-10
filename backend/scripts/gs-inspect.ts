/**
 * Inspect a Gradescope page using the saved session cookie.
 * Dumps:
 *  - the full HTML to data/gs-inspect/<slug>.html
 *  - a JSON probe report (interactive elements, frames, headings) to <slug>.json
 *  - a screenshot to <slug>.png
 *
 * Usage:
 *   npx tsx scripts/gs-inspect.ts <url> [<slug>]
 *
 * Examples:
 *   npx tsx scripts/gs-inspect.ts https://www.gradescope.com/account account
 *   npx tsx scripts/gs-inspect.ts https://www.gradescope.com/courses/12345 course
 */
import { chromium, type Cookie } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_PATH = path.resolve(__dirname, '../data/gs-session.json');
const OUT_DIR = path.resolve(__dirname, '../data/gs-inspect');

async function main() {
  const url = process.argv[2];
  const slug = process.argv[3] ?? slugFromUrl(url);
  if (!url) {
    console.error('usage: tsx scripts/gs-inspect.ts <url> [<slug>]');
    process.exit(2);
  }

  let session: { cookies: Cookie[] };
  try {
    session = JSON.parse(await fs.readFile(SESSION_PATH, 'utf8'));
  } catch {
    console.error(
      `[gs-inspect] no session at ${SESSION_PATH} — run gs-login.ts first`,
    );
    process.exit(1);
  }

  await fs.mkdir(OUT_DIR, { recursive: true });

  console.log(`[gs-inspect] launching headless Chromium…`);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addCookies(session.cookies);

  const page = await context.newPage();
  console.log(`[gs-inspect] navigating to ${url}`);
  const response = await page.goto(url, { waitUntil: 'networkidle' });
  console.log(`[gs-inspect] status: ${response?.status()}`);

  if (page.url().includes('/login')) {
    console.error('[gs-inspect] redirected to /login — session expired');
    await browser.close();
    process.exit(1);
  }

  const html = await page.content();
  await fs.writeFile(path.join(OUT_DIR, `${slug}.html`), html);
  console.log(`[gs-inspect] wrote ${slug}.html (${html.length} bytes)`);

  const probeFnSrc = `
    (function probe() {
      function dump(sel) {
        return Array.from(document.querySelectorAll(sel)).slice(0, 25).map(function (el) {
          return {
            tag: el.tagName.toLowerCase(),
            id: el.id || undefined,
            classes: el.className && typeof el.className === 'string'
              ? el.className.split(/\\s+/).slice(0, 8) : undefined,
            href: el.href || undefined,
            text: (el.textContent || '').trim().slice(0, 100),
            dataKeys: Object.keys(el.dataset || {}),
          };
        });
      }
      var reactRoots = Array.from(document.querySelectorAll('[data-react-class]')).map(function (el) {
        return {
          cls: el.getAttribute('data-react-class'),
          propsLen: (el.getAttribute('data-react-props') || '').length,
          text: (el.textContent || '').trim().slice(0, 80),
        };
      });
      return {
        title: document.title,
        url: location.href,
        headings: dump('h1, h2, h3'),
        links: dump('a[href]'),
        tables: Array.from(document.querySelectorAll('table')).slice(0, 5).map(function (t) {
          return {
            classes: t.className,
            rowCount: t.rows.length,
            headerCells: Array.from((t.rows[0] && t.rows[0].cells) || []).map(function (c) {
              return (c.textContent || '').trim();
            }),
            firstRowCells: Array.from((t.rows[1] && t.rows[1].cells) || []).map(function (c) {
              return (c.textContent || '').trim().slice(0, 60);
            }),
          };
        }),
        buttons: dump('button'),
        reactComponents: reactRoots,
        formInputs: dump('input, select, textarea'),
        iframes: Array.from(document.querySelectorAll('iframe')).map(function (f) {
          return { src: f.src, id: f.id, name: f.name };
        }),
      };
    })();
  `;
  const probe = await page.evaluate(probeFnSrc);

  await fs.writeFile(
    path.join(OUT_DIR, `${slug}.json`),
    JSON.stringify(probe, null, 2),
  );
  console.log(`[gs-inspect] wrote ${slug}.json`);

  await page.screenshot({
    path: path.join(OUT_DIR, `${slug}.png`),
    fullPage: true,
  });
  console.log(`[gs-inspect] wrote ${slug}.png`);

  await browser.close();
}

function slugFromUrl(url?: string): string {
  if (!url) return 'page';
  return url
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

main().catch((err) => {
  console.error('[gs-inspect] error:', err);
  process.exit(1);
});
