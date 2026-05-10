import { cookieHeader, loadCookies } from './gradescopeSession.js';

const BASE_URL = 'https://www.gradescope.com';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

export class SessionExpiredError extends Error {
  constructor() {
    super('Gradescope session expired — reconnect required');
    this.name = 'SessionExpiredError';
  }
}

export class NoSessionError extends Error {
  constructor() {
    super('No Gradescope session — connect first');
    this.name = 'NoSessionError';
  }
}

function requireCookieHeader(): string {
  const cookies = loadCookies();
  if (!cookies || cookies.length === 0) throw new NoSessionError();
  return cookieHeader(cookies);
}

async function gsFetch(
  pathOrUrl: string,
  init: RequestInit & { acceptJson?: boolean } = {},
): Promise<Response> {
  const url = pathOrUrl.startsWith('http')
    ? pathOrUrl
    : `${BASE_URL}${pathOrUrl}`;
  const headers = new Headers(init.headers);
  headers.set('Cookie', requireCookieHeader());
  headers.set('User-Agent', USER_AGENT);
  if (init.acceptJson) headers.set('Accept', 'application/json');
  else if (!headers.has('Accept')) headers.set('Accept', 'text/html,application/xhtml+xml');

  const response = await fetch(url, { ...init, headers, redirect: 'follow' });
  if (response.status === 401 || response.url.includes('/login')) {
    throw new SessionExpiredError();
  }
  return response;
}

export async function fetchHtml(path: string): Promise<string> {
  const r = await gsFetch(path);
  if (!r.ok) throw new Error(`GET ${path} → ${r.status} ${r.statusText}`);
  return r.text();
}

export async function fetchJson<T = unknown>(path: string): Promise<T> {
  const r = await gsFetch(path, { acceptJson: true });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status} ${r.statusText}`);
  return r.json() as Promise<T>;
}

export async function fetchBinary(url: string): Promise<Buffer> {
  const r = await gsFetch(url);
  if (!r.ok) throw new Error(`GET ${url} → ${r.status} ${r.statusText}`);
  const arrayBuffer = await r.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
