import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  type Analysis,
  type AssignmentDetail,
  type Course,
  type RegradeRequest,
  type SubmissionLogEntry,
} from '../api';
import { CourseTree } from '../components/CourseTree';
import { QuestionCard } from '../components/QuestionCard';
import { ConfirmSubmitModal } from '../components/ConfirmSubmitModal';

type Props = {
  onDisconnected: () => void;
};

export function Browse({ onDisconnected }: Props) {
  const [courses, setCourses] = useState<Course[]>([]);
  const [selectedCourseId, setSelectedCourseId] = useState<string | null>(null);
  const [selectedAssignmentId, setSelectedAssignmentId] = useState<
    string | null
  >(null);
  const [detail, setDetail] = useState<AssignmentDetail | null>(null);
  const [analyses, setAnalyses] = useState<Analysis[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [syncingDetail, setSyncingDetail] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchSummary, setBatchSummary] = useState<string | null>(null);

  const refreshCourses = useCallback(async () => {
    const list = await api.listCourses();
    setCourses(list);
  }, []);

  useEffect(() => {
    refreshCourses();
  }, [refreshCourses]);

  const loadAssignment = useCallback(async (assignmentId: string) => {
    setLoadingDetail(true);
    setError(null);
    try {
      const [d, a] = await Promise.all([
        api.getAssignment(assignmentId),
        api.listAnalyses(assignmentId),
      ]);
      setDetail(d);
      setAnalyses(a);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  useEffect(() => {
    if (selectedAssignmentId) {
      loadAssignment(selectedAssignmentId);
    } else {
      setDetail(null);
      setAnalyses([]);
    }
  }, [selectedAssignmentId, loadAssignment]);

  const onSelectAssignment = (courseId: string, assignmentId: string) => {
    setSelectedCourseId(courseId);
    setSelectedAssignmentId(assignmentId);
  };

  const onSyncDetail = async () => {
    if (!selectedCourseId || !selectedAssignmentId) return;
    setSyncingDetail(true);
    setError(null);
    try {
      await api.syncAssignmentDetails(selectedCourseId, selectedAssignmentId);
      await loadAssignment(selectedAssignmentId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('401') || msg.includes('session')) {
        onDisconnected();
        return;
      }
      setError(msg);
    } finally {
      setSyncingDetail(false);
    }
  };

  const onAnalyze = async () => {
    if (!selectedAssignmentId) return;
    setAnalyzing(true);
    setError(null);
    try {
      const next = await api.analyze(selectedAssignmentId);
      setAnalyses(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAnalyzing(false);
    }
  };

  const onAnalysisChange = (next: Analysis) => {
    setAnalyses((prev) => prev.map((a) => (a.id === next.id ? next : a)));
  };

  const onCardSubmitted = useCallback(() => {
    if (selectedAssignmentId) loadAssignment(selectedAssignmentId);
  }, [selectedAssignmentId, loadAssignment]);

  const disconnect = async () => {
    await api.disconnect();
    onDisconnected();
  };

  const analysesByQuestion = useMemo(() => {
    const m = new Map<string, Analysis>();
    for (const a of analyses) m.set(a.question_id, a);
    return m;
  }, [analyses]);

  const regradeBySubId = useMemo(() => {
    const m = new Map<string, RegradeRequest>();
    if (!detail) return m;
    for (const r of detail.regradeRequests) m.set(r.question_submission_id, r);
    return m;
  }, [detail]);

  const submissionLogByAnalysis = useMemo(() => {
    const m = new Map<string, SubmissionLogEntry>();
    if (!detail) return m;
    for (const l of detail.submissionLog) m.set(l.analysis_id, l);
    return m;
  }, [detail]);

  const sendable = useMemo(() => {
    if (!detail) return [] as Array<{ analysis: Analysis; label: string; title: string | null }>;
    const out: Array<{ analysis: Analysis; label: string; title: string | null }> = [];
    for (const a of analyses) {
      if (a.status !== 'approved' && a.status !== 'edited') continue;
      const q = detail.questions.find((x) => x.id === a.question_id);
      if (!q) continue;
      if (q.question_submission_id && regradeBySubId.has(q.question_submission_id)) continue;
      if (!q.anchor) continue;
      out.push({ analysis: a, label: q.label, title: q.title });
    }
    return out;
  }, [analyses, detail, regradeBySubId]);

  const onSubmitAll = async () => {
    if (!selectedAssignmentId) return;
    setBatchBusy(true);
    setBatchSummary(null);
    try {
      const result = await api.submitApproved(selectedAssignmentId);
      const parts = [
        `${result.submitted.length} submitted`,
        result.failed.length ? `${result.failed.length} failed` : '',
        result.skipped.length ? `${result.skipped.length} skipped` : '',
      ].filter(Boolean);
      setBatchSummary(parts.join(' · '));
      await loadAssignment(selectedAssignmentId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('401') || msg.includes('session')) {
        onDisconnected();
        return;
      }
      setBatchSummary(`Error: ${msg}`);
    } finally {
      setBatchBusy(false);
    }
  };

  const flaggedCount = analyses.length;
  const approvedCount = analyses.filter(
    (a) => a.status === 'approved' || a.status === 'edited',
  ).length;
  const submittedCount = analyses.filter((a) => a.status === 'submitted').length;
  const detailIsStale = detail && detail.questions.length === 0;

  return (
    <div className="flex h-screen bg-slate-50">
      <CourseTree
        courses={courses}
        selectedAssignmentId={selectedAssignmentId}
        onSelectAssignment={onSelectAssignment}
        onCoursesRefreshed={refreshCourses}
      />

      <main className="flex flex-1 flex-col overflow-hidden">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-5 py-3">
          <h1 className="text-lg font-semibold">Regrader</h1>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-emerald-700">● connected</span>
            <button
              onClick={disconnect}
              className="rounded border border-slate-300 px-2 py-1 font-medium text-slate-700 hover:bg-slate-100"
            >
              Disconnect
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-6">
          {!selectedAssignmentId && (
            <p className="text-sm text-slate-500">
              Select an assignment from the sidebar.
            </p>
          )}

          {selectedAssignmentId && loadingDetail && !detail && (
            <p className="text-sm text-slate-500">Loading…</p>
          )}

          {error && (
            <div className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              {error}
            </div>
          )}

          {detail && (
            <div className="mx-auto max-w-4xl">
              <section className="mb-5 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-xl font-semibold">
                      {detail.assignment.title}
                    </h2>
                    <p className="mt-1 text-sm text-slate-600">
                      {detail.assignment.score != null &&
                      detail.assignment.max_score != null
                        ? `${detail.assignment.score} / ${detail.assignment.max_score} pts`
                        : 'no score yet'}
                      {' · '}
                      {detail.assignment.regrade_requests_open
                        ? 'regrade window open'
                        : 'regrade window closed'}
                      {detail.assignment.regrade_request_end && (
                        <span className="ml-1 text-slate-400">
                          (ends{' '}
                          {new Date(
                            detail.assignment.regrade_request_end,
                          ).toLocaleString()}
                          )
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={onSyncDetail}
                      disabled={syncingDetail}
                      className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                    >
                      {syncingDetail
                        ? 'Syncing…'
                        : detail.questions.length === 0
                          ? 'Sync details'
                          : 'Re-sync'}
                    </button>
                    <button
                      onClick={onAnalyze}
                      disabled={
                        analyzing ||
                        detail.questions.length === 0 ||
                        !detail.assignment.regrade_requests_open
                      }
                      title={
                        !detail.assignment.regrade_requests_open
                          ? 'Regrade window is closed for this assignment'
                          : ''
                      }
                      className="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                    >
                      {analyzing ? 'Analyzing…' : 'Analyze'}
                    </button>
                  </div>
                </div>
                {detailIsStale && (
                  <p className="mt-3 rounded bg-amber-50 p-2 text-xs text-amber-800">
                    No questions synced yet — click <strong>Sync details</strong>{' '}
                    to fetch the rubric and render question crops.
                  </p>
                )}
                {!detail.assignment.regrade_requests_open &&
                  detail.questions.length > 0 && (
                    <p className="mt-3 rounded bg-slate-50 p-2 text-xs text-slate-600">
                      The regrade window is closed for this assignment. You can
                      still re-sync, but the analyzer and submit are disabled.
                    </p>
                  )}
              </section>

              {detail.questions.length > 0 && (
                <div className="space-y-4">
                  {detail.questions.map((q) => {
                    const items = detail.rubricItems.filter(
                      (r) => r.question_id === q.id,
                    );
                    const regrade = q.question_submission_id
                      ? (regradeBySubId.get(q.question_submission_id) ?? null)
                      : null;
                    const analysis = analysesByQuestion.get(q.id) ?? null;
                    const log = analysis
                      ? (submissionLogByAnalysis.get(analysis.id) ?? null)
                      : null;
                    return (
                      <QuestionCard
                        key={q.id}
                        question={q}
                        rubricItems={items}
                        regradeRequest={regrade}
                        analysis={analysis}
                        submissionLog={log}
                        regradeWindowOpen={
                          detail.assignment.regrade_requests_open === 1
                        }
                        onAnalysisChange={onAnalysisChange}
                        onSubmitted={onCardSubmitted}
                      />
                    );
                  })}
                </div>
              )}

              {analyses.length > 0 && (
                <footer className="sticky bottom-0 mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
                  <span className="text-sm text-slate-600">
                    {flaggedCount} flagged · {approvedCount} ready · {submittedCount} submitted
                    {batchSummary && (
                      <span className="ml-2 text-slate-500">— {batchSummary}</span>
                    )}
                  </span>
                  <button
                    onClick={() => {
                      setBatchSummary(null);
                      setConfirmOpen(true);
                    }}
                    disabled={
                      sendable.length === 0 ||
                      !detail.assignment.regrade_requests_open ||
                      batchBusy
                    }
                    className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                  >
                    {batchBusy
                      ? 'Submitting…'
                      : `Submit all approved (${sendable.length})`}
                  </button>
                </footer>
              )}
            </div>
          )}
        </div>
      </main>

      {confirmOpen && (
        <ConfirmSubmitModal
          drafts={sendable.map((s) => ({
            questionLabel: s.label,
            questionTitle: s.title,
            draft: s.analysis.draft,
          }))}
          busy={batchBusy}
          progress={null}
          errorSummary={null}
          onCancel={() => {
            if (!batchBusy) setConfirmOpen(false);
          }}
          onConfirm={async () => {
            await onSubmitAll();
            setConfirmOpen(false);
          }}
        />
      )}
    </div>
  );
}
