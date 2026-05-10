import { Router } from 'express';
import { loginInteractive } from '../services/gradescopeAuth.js';
import {
  loadCookies,
  clearCookies,
} from '../services/gradescopeSession.js';
import {
  syncCourses,
  syncCourseAssignments,
  syncAssignmentDetails,
} from '../services/gradescopeSync.js';
import { NoSessionError, SessionExpiredError } from '../services/gradescopeHttp.js';

export const gradescopeRouter = Router();

type LoginState = {
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  cookieCount: number | null;
};

let activeLogin: LoginState | null = null;

function cookieCount(): number {
  return loadCookies()?.length ?? 0;
}

gradescopeRouter.get('/status', (_req, res) => {
  const count = cookieCount();
  res.json({
    connected: count > 0,
    cookieCount: count,
    inProgress: activeLogin != null && activeLogin.finishedAt == null,
    lastError:
      activeLogin && activeLogin.error
        ? activeLogin.error
        : null,
  });
});

gradescopeRouter.post('/connect', (_req, res) => {
  // If there's already a login in flight, don't launch a second browser.
  if (activeLogin && activeLogin.finishedAt == null) {
    res.status(202).json({ ok: true, alreadyInProgress: true });
    return;
  }

  // Start a fresh attempt; the response returns immediately so the HTTP
  // request isn't held open for the full SSO flow. The frontend polls
  // /status to know when it completes.
  activeLogin = {
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
    cookieCount: null,
  };
  const state = activeLogin;

  loginInteractive({
    onLog: (m) => console.log('[gs-auth]', m),
  })
    .then((result) => {
      state.cookieCount = result.cookieCount;
    })
    .catch((err: Error) => {
      state.error = err.message;
      console.error('[gs-auth] login failed:', err.message);
    })
    .finally(() => {
      state.finishedAt = Date.now();
    });

  res.status(202).json({ ok: true, started: true });
});

gradescopeRouter.post('/disconnect', (_req, res) => {
  clearCookies();
  // Clear stale login bookkeeping too so the UI doesn't keep showing an
  // old error.
  activeLogin = null;
  res.json({ ok: true });
});

gradescopeRouter.post('/sync/courses', async (_req, res, next) => {
  try {
    await syncCourses((p) => console.log('[gs-sync]', p));
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

gradescopeRouter.post('/sync/courses/:courseId/assignments', async (req, res, next) => {
  try {
    await syncCourseAssignments(req.params.courseId, (p) =>
      console.log('[gs-sync]', p),
    );
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

gradescopeRouter.post(
  '/sync/courses/:courseId/assignments/:assignmentId',
  async (req, res, next) => {
    try {
      await syncAssignmentDetails(
        req.params.courseId,
        req.params.assignmentId,
        (p) => console.log('[gs-sync]', p),
      );
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  },
);

// Translate session errors to a clean 401
gradescopeRouter.use(
  (err: Error, _req: any, res: any, next: any) => {
    if (err instanceof NoSessionError) {
      res.status(401).json({ error: 'no_session' });
      return;
    }
    if (err instanceof SessionExpiredError) {
      res.status(401).json({ error: 'session_expired' });
      return;
    }
    next(err);
  },
);
