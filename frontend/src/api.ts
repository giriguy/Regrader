export type Course = {
  id: string;
  short_name: string;
  full_name: string | null;
  synced_at: number;
};

export type Assignment = {
  id: string;
  course_id: string;
  title: string;
  status: 'graded' | 'submitted' | 'not_submitted';
  submission_id: string | null;
  score: number | null;
  max_score: number | null;
  pdf_url: string | null;
  pdf_local_path: string | null;
  page_count: number | null;
  regrade_requests_open: number;
  regrade_request_end: string | null;
  synced_at: number | null;
};

export type Question = {
  id: string;
  assignment_id: string;
  question_submission_id: string | null;
  label: string;
  title: string | null;
  weight: number;
  points_awarded: number | null;
  scoring_type: string;
  anchor: string | null;
  crop_image_path: string | null;
  display_order: number;
};

export type RubricItem = {
  id: string;
  question_id: string;
  description: string;
  weight: number;
  applied: number;
  group_id: string | null;
  group_description: string | null;
  display_order: number;
};

export type RegradeRequest = {
  id: string;
  question_submission_id: string;
  assignment_id: string;
  student_comment: string | null;
  staff_comment: string | null;
  completed: number;
  created_at: string | null;
  updated_at: string | null;
};

export type AnalysisStatus =
  | 'pending'
  | 'approved'
  | 'edited'
  | 'skipped'
  | 'submitted'
  | 'failed';

export type Analysis = {
  id: string;
  question_id: string;
  points_missed: number | null;
  confidence: 'high' | 'medium' | 'low';
  justification: string;
  draft: string;
  status: AnalysisStatus;
  created_at: number;
};

export type SubmissionLogEntry = {
  id: string;
  analysis_id: string;
  question_id: string;
  question_submission_id: string | null;
  assignment_id: string;
  submitted_at: number;
  comment: string;
  success: number;
  gradescope_regrade_id: string | null;
  error: string | null;
  stage: string | null;
};

export type AssignmentDetail = {
  assignment: Assignment;
  questions: Question[];
  rubricItems: RubricItem[];
  regradeRequests: RegradeRequest[];
  submissionLog: SubmissionLogEntry[];
};

export type SubmitOneResponse =
  | { ok: true; analysis: Analysis; gradescopeRegradeId: string | null }
  | { ok: false; analysis: Analysis; stage: string; error: string };

export type SubmitApprovedResponse = {
  submitted: Analysis[];
  failed: Array<{ analysis_id: string; stage?: string; error: string }>;
  skipped: Array<{ analysis_id: string; reason: string }>;
};

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json() as Promise<T>;
}

/** Like jsonOrThrow but returns the parsed body even on 4xx/5xx so callers
 *  can read the typed error payload (used by submitAnalysis). */
async function jsonAlways<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text) {
    throw new Error(`${res.status} ${res.statusText}: empty response`);
  }
  return JSON.parse(text) as T;
}

export const api = {
  status: () =>
    fetch('/api/gradescope/status').then(
      jsonOrThrow<{
        connected: boolean;
        cookieCount: number;
        inProgress: boolean;
        lastError: string | null;
      }>,
    ),
  connect: () =>
    fetch('/api/gradescope/connect', { method: 'POST' }).then(
      jsonOrThrow<{ ok: boolean; started?: boolean; alreadyInProgress?: boolean }>,
    ),
  disconnect: () =>
    fetch('/api/gradescope/disconnect', { method: 'POST' }).then(
      jsonOrThrow<{ ok: boolean }>,
    ),
  syncCourses: () =>
    fetch('/api/gradescope/sync/courses', { method: 'POST' }).then(
      jsonOrThrow<{ ok: boolean }>,
    ),
  syncAssignments: (courseId: string) =>
    fetch(`/api/gradescope/sync/courses/${courseId}/assignments`, {
      method: 'POST',
    }).then(jsonOrThrow<{ ok: boolean }>),
  syncAssignmentDetails: (courseId: string, assignmentId: string) =>
    fetch(
      `/api/gradescope/sync/courses/${courseId}/assignments/${assignmentId}`,
      { method: 'POST' },
    ).then(jsonOrThrow<{ ok: boolean }>),

  listCourses: () => fetch('/api/courses').then(jsonOrThrow<Course[]>),
  listAssignments: (courseId: string) =>
    fetch(`/api/courses/${courseId}/assignments`).then(
      jsonOrThrow<Assignment[]>,
    ),
  getAssignment: (assignmentId: string) =>
    fetch(`/api/assignments/${assignmentId}`).then(
      jsonOrThrow<AssignmentDetail>,
    ),
  listAnalyses: (assignmentId: string) =>
    fetch(`/api/assignments/${assignmentId}/analyses`).then(
      jsonOrThrow<Analysis[]>,
    ),
  analyze: (assignmentId: string) =>
    fetch(`/api/assignments/${assignmentId}/analyze`, { method: 'POST' }).then(
      jsonOrThrow<Analysis[]>,
    ),
  updateAnalysis: (
    id: string,
    updates: Partial<Pick<Analysis, 'draft' | 'status'>>,
  ) =>
    fetch(`/api/analyses/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    }).then(jsonOrThrow<Analysis>),
  submitAnalysis: (id: string) =>
    fetch(`/api/analyses/${id}/submit`, { method: 'POST' }).then(
      jsonAlways<SubmitOneResponse>,
    ),
  submitApproved: (assignmentId: string) =>
    fetch(`/api/assignments/${assignmentId}/submit-approved`, {
      method: 'POST',
    }).then(jsonOrThrow<SubmitApprovedResponse>),

  cropUrl: (cropImagePath: string | null) => {
    if (!cropImagePath) return null;
    const filename = cropImagePath.split('/').pop();
    return filename ? `/api/crops/${filename}` : null;
  },
};
