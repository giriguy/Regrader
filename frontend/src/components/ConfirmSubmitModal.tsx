type Draft = {
  questionLabel: string;
  questionTitle: string | null;
  draft: string;
};

type Props = {
  drafts: Draft[];
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
  progress: { done: number; total: number } | null;
  errorSummary: string | null;
};

export function ConfirmSubmitModal({
  drafts,
  onCancel,
  onConfirm,
  busy,
  progress,
  errorSummary,
}: Props) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-white shadow-xl">
        <header className="border-b border-slate-200 px-5 py-4">
          <h2 className="text-lg font-semibold text-slate-900">
            Submit {drafts.length} regrade request
            {drafts.length === 1 ? '' : 's'}?
          </h2>
          <p className="mt-1 text-xs text-slate-600">
            Each one is sent to Gradescope sequentially via a real browser. The
            text below is exactly what your professor will see — review it
            carefully.
          </p>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-3">
          {drafts.length === 0 ? (
            <p className="text-sm text-slate-500">
              Nothing to submit — approve at least one draft first.
            </p>
          ) : (
            <ul className="space-y-3">
              {drafts.map((d, i) => (
                <li
                  key={i}
                  className="rounded border border-slate-200 bg-slate-50 p-3"
                >
                  <div className="text-xs font-semibold text-slate-700">
                    Q{d.questionLabel}
                    {d.questionTitle ? ` — ${d.questionTitle}` : ''}
                  </div>
                  <p className="mt-1 whitespace-pre-wrap font-mono text-xs text-slate-800">
                    {d.draft}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-5 py-3">
          <div className="text-xs text-slate-600">
            {progress ? (
              <span>
                Sending {progress.done}/{progress.total}…
              </span>
            ) : errorSummary ? (
              <span className="text-red-700">{errorSummary}</span>
            ) : (
              <span>Submissions are rate-limited by Gradescope's UI.</span>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={onCancel}
              disabled={busy}
              className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              disabled={busy || drafts.length === 0}
              className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {busy ? 'Submitting…' : `Submit ${drafts.length}`}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
