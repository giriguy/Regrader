import { db } from '../db.js';

const SESSION_ID = 'default';

export type GsCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
};

export function loadCookies(): GsCookie[] | null {
  const row = db
    .prepare(`SELECT cookies FROM gs_sessions WHERE id = ?`)
    .get(SESSION_ID) as { cookies: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.cookies) as GsCookie[];
  } catch {
    return null;
  }
}

export function saveCookies(cookies: GsCookie[]): void {
  db.prepare(
    `INSERT INTO gs_sessions (id, cookies, saved_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET cookies = excluded.cookies, saved_at = excluded.saved_at`,
  ).run(SESSION_ID, JSON.stringify(cookies), Date.now());
}

export function clearCookies(): void {
  db.prepare(`DELETE FROM gs_sessions WHERE id = ?`).run(SESSION_ID);
}

export function cookieHeader(cookies: GsCookie[]): string {
  return cookies
    .filter((c) => c.domain.includes('gradescope.com'))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}
