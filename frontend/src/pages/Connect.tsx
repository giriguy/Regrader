import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

type Phase = 'idle' | 'waiting' | 'error';

type Props = {
  onConnected: () => void;
};

export function Connect({ onConnected }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  // Stop polling whenever this component unmounts.
  useEffect(() => {
    return () => {
      if (pollRef.current != null) window.clearInterval(pollRef.current);
    };
  }, []);

  const poll = () => {
    if (pollRef.current != null) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(async () => {
      try {
        const status = await api.status();
        if (status.connected) {
          if (pollRef.current != null) window.clearInterval(pollRef.current);
          pollRef.current = null;
          onConnected();
          return;
        }
        if (!status.inProgress) {
          if (pollRef.current != null) window.clearInterval(pollRef.current);
          pollRef.current = null;
          setPhase('error');
          setError(status.lastError ?? 'login did not complete');
        }
      } catch (e) {
        // Network blip — keep polling.
        console.warn('[connect] status poll error', e);
      }
    }, 1500);
  };

  const start = async () => {
    setError(null);
    setPhase('waiting');
    try {
      await api.connect();
      poll();
    } catch (e) {
      setPhase('error');
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
      <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-semibold text-slate-900">Regrader</h1>
        <p className="mt-2 text-sm text-slate-600">
          Local tool that scans your Gradescope account for graded
          submissions and drafts regrade requests for you to review.
        </p>

        <h2 className="mt-6 text-sm font-semibold uppercase tracking-wider text-slate-500">
          Step 1 — Connect
        </h2>
        <p className="mt-2 text-sm text-slate-700">
          Click the button below. A Chromium window opens; finish your
          school's SSO login. The window closes automatically once
          Gradescope issues a session cookie.
        </p>

        <button
          onClick={start}
          disabled={phase === 'waiting'}
          className="mt-5 w-full rounded bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {phase === 'waiting'
            ? 'Waiting for login…'
            : phase === 'error'
              ? 'Try again'
              : 'Connect Gradescope'}
        </button>

        {phase === 'waiting' && (
          <p className="mt-3 text-xs text-slate-500">
            Don't close this tab — finish SSO in the Chromium window. If you
            accidentally closed the window, click the button again.
          </p>
        )}

        {error && (
          <p className="mt-3 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800">
            {error}
          </p>
        )}

        <p className="mt-6 text-xs text-slate-500">
          Cookies are stored in a local SQLite file (
          <code className="rounded bg-slate-100 px-1">
            backend/data/regrader.db
          </code>
          ). Nothing leaves your machine.
        </p>
      </div>
    </div>
  );
}
