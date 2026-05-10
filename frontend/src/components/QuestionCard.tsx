import { useState } from 'react';
import {
  api,
  type Analysis,
  type Question,
  type RubricItem,
  type RegradeRequest,
  type SubmissionLogEntry,
} from '../api';
import { ConfidenceBadge } from './ConfidenceBadge';

type Props = {
  question: Question;
  rubricItems: RubricItem[];
  regradeRequest: RegradeRequest | null;
  analysis: Analysis | null;
  submissionLog: SubmissionLogEntry | null;
  regradeWindowOpen: boolean;
  onAnalysisChange: (next: Analysis) => void;
  /** Called after a successful per-card submit so the page can refresh
   *  detail (regrade_requests + submission log change). */
  onSubmitted?: () => void;
};

const STATUS_BADGE: Record<Analysis['status'], string> = {
  pending: 'bg-slate-100 text-slate-700',
  edited: 'bg-blue-100 text-blue-700',
  approved: 'bg-emerald-100 text-emerald-700',
  skipped: 'bg-slate-200 text-slate-500',
  submitted: 'bg-indigo-100 text-indigo-700',
  failed: 'bg-red-100 text-red-700',
};

function stripLatex(s: string): string {
  return s.replace(/\$\$([^$]+)\$\$/g, '$1');
}

export function QuestionCard({
  question: q,
  rubricItems,
  regradeRequest,
  analysis,
  submissionLog,
  regradeWindowOpen,
  onAnalysisChange,
  onSubmitted,
}: Props) {
  const [draft, setDraft] = useState(analysis?.draft ?? '');
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const cropUrl = api.cropUrl(q.crop_image_path);
  const dirty = analysis != null && draft !== analysis.draft;
  const items = rubricItems.filter((r) => r.question_id === q.id);

  const fullCredit = q.points_awarded != null && q.points_awarded >= q.weight;
  const zeroWeight = q.weight <= 0;
  const canSubmit =
    analysis != null &&
    (analysis.status === 'approved' || analysis.status === 'edited') &&
    regradeWindowOpen &&
    !regradeRequest &&
    q.anchor != null;

  const save = async (status?: Analysis['status']) => {
    if (!analysis) return;
    setSaving(true);
    try {
      const updates: Partial<Pick<Analysis, 'draft' | 'status'>> = {};
      if (dirty) updates.draft = draft;
      if (status) updates.status = status;
      if (Object.keys(updates).length === 0) return;
      const updated = await api.updateAnalysis(analysis.id, updates);
      onAnalysisChange(updated);
      setDraft(updated.draft);
    } finally {
      setSaving(false);
    }
  };

  const submit = async () => {
    if (!analysis) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await api.submitAnalysis(analysis.id);
      onAnalysisChange(result.analysis);
      if (!result.ok) {
        setSubmitError(`${result.stage}: ${result.error}`);
      } else {
        setConfirming(false);
        onSubmitted?.();
      }
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <article className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <header className="mb-3 flex flex-wrap items-center gap-3">
        <h3 className="text-lg font-semibold">
          Q{q.label}: {q.title}
        </h3>
        <span className="text-sm text-slate-600">
          {q.points_awarded ?? '-'} / {q.weight} pts
        </span>
        {fullCredit && (
          <span className="rounded bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700 ring-1 ring-emerald-200">
            full credit
          </span>
        )}
        {zeroWeight && (
          <span className="rounded bg-slate-50 px-2 py-0.5 text-xs text-slate-600 ring-1 ring-slate-200">
            ungraded
          </span>
        )}
        {regradeRequest && (
          <span className="rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-700 ring-1 ring-amber-200">
            regrade {regradeRequest.completed ? 'resolved' : 'pending'}
          </span>
        )}
        {analysis && <ConfidenceBadge confidence={analysis.confidence} />}
        {analysis && (
          <span
            className={`ml-auto rounded px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[analysis.status]}`}
          >
            {analysis.status}
          </span>
        )}
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
            Your answer
          </h4>
          {cropUrl ? (
            <img
              src={cropUrl}
              alt={`Q${q.label} answer`}
              className="max-h-96 w-full rounded border border-slate-200 object-contain"
            />
          ) : (
            <div className="rounded border border-dashed border-slate-300 p-4 text-sm text-slate-500">
              no crop available
            </div>
          )}
        </section>

        <section>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
            Rubric
          </h4>
          <ul className="space-y-1 text-sm">
            {items.map((r) => (
              <li
                key={r.id}
                className={`flex gap-2 rounded p-1.5 ${
                  r.applied ? 'bg-slate-100' : 'bg-white'
                }`}
              >
                <span
                  className={`mt-0.5 inline-block h-4 w-4 shrink-0 rounded-sm border ${
                    r.applied
                      ? 'border-slate-700 bg-slate-700 text-white'
                      : 'border-slate-300'
                  }`}
                  aria-label={r.applied ? 'applied' : 'not applied'}
                >
                  {r.applied ? (
                    <svg
                      viewBox="0 0 16 16"
                      className="h-full w-full"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                    >
                      <path d="M3 8l4 4 6-7" />
                    </svg>
                  ) : null}
                </span>
                <span className="flex-1">
                  {r.group_description && (
                    <span className="mr-1 text-xs text-slate-500">
                      [{r.group_description}]
                    </span>
                  )}
                  {stripLatex(r.description)}{' '}
                  <span className="text-xs text-slate-500">
                    ({r.weight >= 0 ? '+' : ''}
                    {r.weight} pts)
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {analysis && (
        <>
          <section className="mt-4">
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
              Why this looks wrong
            </h4>
            <p className="whitespace-pre-wrap text-sm text-slate-800">
              {analysis.justification}
            </p>
          </section>

          <section className="mt-3">
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
              Draft regrade request{' '}
              {analysis.points_missed != null && (
                <span className="text-slate-400">
                  (claims {analysis.points_missed} pts)
                </span>
              )}
            </h4>
            <textarea
              className="w-full min-h-32 resize-y rounded border border-slate-300 p-3 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </section>

          <footer className="mt-3 flex flex-wrap items-center gap-2">
            <button
              onClick={() => save('approved')}
              disabled={saving || submitting}
              className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              Approve
            </button>
            <button
              onClick={() => save(dirty ? 'edited' : undefined)}
              disabled={saving || !dirty || submitting}
              className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
            >
              Save edit
            </button>
            <button
              onClick={() => save('skipped')}
              disabled={saving || submitting}
              className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-100 disabled:opacity-50"
            >
              Skip
            </button>
            {canSubmit && !confirming && (
              <button
                onClick={() => {
                  setConfirming(true);
                  setSubmitError(null);
                }}
                disabled={saving || submitting}
                className="ml-auto rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                Submit to Gradescope
              </button>
            )}
            {canSubmit && confirming && (
              <div className="ml-auto flex items-center gap-2">
                <span className="text-xs text-slate-600">
                  Send this draft to Gradescope?
                </span>
                <button
                  onClick={() => setConfirming(false)}
                  disabled={submitting}
                  className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={submit}
                  disabled={submitting}
                  className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  {submitting ? 'Submitting…' : 'Confirm send'}
                </button>
              </div>
            )}
          </footer>
          {(submitError ||
            (analysis.status === 'failed' && submissionLog?.error)) && (
            <p className="mt-2 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800">
              <span className="font-semibold">
                Submit failed
                {submissionLog?.stage ? ` (${submissionLog.stage})` : ''}:{' '}
              </span>
              {submitError ?? submissionLog?.error}
            </p>
          )}
          {analysis.status === 'submitted' &&
            submissionLog?.success === 1 && (
              <p className="mt-2 rounded border border-indigo-200 bg-indigo-50 p-2 text-xs text-indigo-800">
                Submitted to Gradescope
                {submissionLog.gradescope_regrade_id
                  ? ` (id ${submissionLog.gradescope_regrade_id})`
                  : ''}
                .
              </p>
            )}
        </>
      )}

      {regradeRequest && (
        <section className="mt-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm">
          <div className="font-semibold text-amber-900">
            Existing regrade request
          </div>
          <div className="mt-1">
            <span className="text-xs uppercase tracking-wider text-amber-800">
              You wrote:
            </span>{' '}
            <span className="text-slate-800">
              {regradeRequest.student_comment}
            </span>
          </div>
          {regradeRequest.staff_comment && (
            <div className="mt-1">
              <span className="text-xs uppercase tracking-wider text-amber-800">
                Staff replied:
              </span>{' '}
              <span className="text-slate-800">
                {regradeRequest.staff_comment}
              </span>
            </div>
          )}
        </section>
      )}
    </article>
  );
}
