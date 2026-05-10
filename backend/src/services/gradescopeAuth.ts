import { chromium } from 'playwright';
import { saveCookies, type GsCookie } from './gradescopeSession.js';

const LOGIN_URL = 'https://www.gradescope.com/login';
const SESSION_COOKIE_NAME = '_gradescope_session';
const SUCCESS_URL_RE = /gradescope\.com\/account(?:\?|$|\/)/;
const POLL_INTERVAL_MS = 1000;
const TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Launches a headed Chromium window. Resolves once the user has completed
 * login and Gradescope has issued the session cookie. Saves the cookies to
 * the gs_sessions table.
 */
export async function loginInteractive(
  options: { onLog?: (msg: string) => void } = {},
): Promise<{ cookieCount: number }> {
  const log = options.onLog ?? (() => {});
  log('launching browser...');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  log(`navigating to ${LOGIN_URL}`);
  await page.goto(LOGIN_URL);
  log('waiting for login (complete SSO in the window)...');

  const start = Date.now();
  let success = false;
  let cancelled = false;
  while (Date.now() - start < TIMEOUT_MS) {
    if (page.isClosed()) {
      cancelled = true;
      break;
    }
    let cookies;
    try {
      cookies = await context.cookies('https://www.gradescope.com');
    } catch {
      // Browser context can disappear out from under us if the user closes
      // the window mid-poll; treat as cancel.
      cancelled = true;
      break;
    }
    const sessionCookie = cookies.find((c) => c.name === SESSION_COOKIE_NAME);
    if (sessionCookie && SUCCESS_URL_RE.test(page.url())) {
      success = true;
      break;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  if (!success) {
    try {
      await browser.close();
    } catch {
      // already closed by user — fine
    }
    if (cancelled) {
      log('login cancelled (window closed before SSO finished)');
      throw new Error('login cancelled — close the connect screen and try again');
    }
    throw new Error(
      'login timed out — finish SSO faster or check your network',
    );
  }

  const finalCookies = (await context.cookies(
    'https://www.gradescope.com',
  )) as GsCookie[];
  saveCookies(finalCookies);
  log(`saved ${finalCookies.length} cookies`);

  try {
    await browser.close();
  } catch {
    // user may have already closed the window
  }
  return { cookieCount: finalCookies.length };
}
