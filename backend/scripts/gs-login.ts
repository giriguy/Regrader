/**
 * Headed Gradescope login. Opens a real Chromium window, waits for the user
 * to complete login (including SSO), captures the session cookie, saves to
 * data/gs-session.json, closes browser.
 *
 * Run: npx tsx scripts/gs-login.ts
 */
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_PATH = path.resolve(__dirname, '../data/gs-session.json');

const SESSION_COOKIE_NAME = '_gradescope_session';
const LOGIN_URL = 'https://www.gradescope.com/login';
const SUCCESS_URL_RE = /gradescope\.com\/account(?:\?|$|\/)/;
const POLL_INTERVAL_MS = 1000;
const TIMEOUT_MS = 10 * 60 * 1000;

async function main() {
  console.log('[gs-login] launching headed Chromium…');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log(`[gs-login] navigating to ${LOGIN_URL}`);
  console.log('[gs-login] please complete login (SSO is fine — take your time).');
  await page.goto(LOGIN_URL);

  const start = Date.now();
  let session: string | null = null;

  while (Date.now() - start < TIMEOUT_MS) {
    const cookies = await context.cookies('https://www.gradescope.com');
    const cookie = cookies.find((c) => c.name === SESSION_COOKIE_NAME);
    const url = page.url();

    if (cookie && SUCCESS_URL_RE.test(url)) {
      session = cookie.value;
      console.log(`[gs-login] success — landed on ${url}`);
      break;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  if (!session) {
    console.error('[gs-login] timed out without seeing /account redirect.');
    await browser.close();
    process.exit(1);
  }

  const cookies = await context.cookies('https://www.gradescope.com');
  await fs.mkdir(path.dirname(SESSION_PATH), { recursive: true });
  await fs.writeFile(
    SESSION_PATH,
    JSON.stringify({ cookies, savedAt: Date.now() }, null, 2),
  );
  console.log(`[gs-login] saved ${cookies.length} cookies to ${SESSION_PATH}`);

  await browser.close();
}

main().catch((err) => {
  console.error('[gs-login] error:', err);
  process.exit(1);
});
