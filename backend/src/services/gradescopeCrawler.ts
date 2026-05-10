import * as cheerio from 'cheerio';
import { fetchHtml, fetchJson } from './gradescopeHttp.js';

export type CourseSummary = {
  id: string;
  shortName: string;
  fullName: string | null;
};

export type AssignmentSummary = {
  id: string;
  title: string;
  status: 'graded' | 'submitted' | 'not_submitted';
  submissionId: string | null;
  score: number | null;
  maxScore: number | null;
};

export type SubmissionData = {
  assignment: {
    id: number;
    title: string;
    total_points: string;
    regrade_requests_open: boolean;
    regrade_request_end: string | null;
  };
  assignment_submission: {
    id: number;
    score: string;
    status: string;
  };
  questions: GsQuestion[];
  question_submissions: GsQuestionSubmission[];
  rubric_items: GsRubricItem[];
  rubric_item_groups: GsRubricItemGroup[];
  regrade_requests: GsRegradeRequest[];
  pdf_attachment: {
    id: number;
    filename: string;
    page_count: number;
    url: string;
  } | null;
  paths: {
    submission_path: string;
    graded_pdf_path: string;
    regrade_requests_path: string;
    submission_react_path: string;
    [k: string]: string;
  };
};

type GsQuestion = {
  id: number;
  type: string;
  title: string;
  index: number;
  weight: string;
  full_index: string;
  numbered_title: string;
  anchor: string;
  scoring_type: 'positive' | 'negative';
  parameters?: {
    crop_rect_list?: Array<{
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      page_number: number;
    }>;
  };
  content: unknown[];
};

type GsQuestionSubmission = {
  id: number;
  question_id: number;
  score: string;
  active: boolean;
};

type GsRubricItem = {
  id: number;
  question_id: number;
  description: string;
  weight: string;
  position: number;
  group_id: number | null;
  present: boolean;
};

type GsRubricItemGroup = {
  id: number;
  question_id: number;
  description: string;
  position: number;
  mutually_exclusive: boolean;
};

type GsRegradeRequest = {
  id: number;
  question_submission_id: number;
  assignment_id: number;
  student_comment: string;
  staff_comment: string | null;
  completed: boolean;
  created_at: string;
  updated_at: string;
};

export async function listCourses(): Promise<CourseSummary[]> {
  const html = await fetchHtml('/account');
  const $ = cheerio.load(html);
  const out: CourseSummary[] = [];
  $('a.courseBox').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const m = href.match(/\/courses\/(\d+)/);
    if (!m) return;
    const shortName = $(el).find('.courseBox--shortname').text().trim();
    const fullName = $(el).find('.courseBox--name').text().trim() || null;
    out.push({ id: m[1], shortName, fullName });
  });
  return out;
}

export async function listAssignments(
  courseId: string,
): Promise<AssignmentSummary[]> {
  const html = await fetchHtml(`/courses/${courseId}`);
  const $ = cheerio.load(html);
  const out: AssignmentSummary[] = [];

  $('table#assignments-student-table tbody tr').each((_, row) => {
    const $row = $(row);
    const link = $row.find('a[href*="/submissions/"]').first();
    let assignmentId: string | null = null;
    let submissionId: string | null = null;
    let title = '';

    if (link.length > 0) {
      const href = link.attr('href') ?? '';
      const m = href.match(/\/assignments\/(\d+)\/submissions\/(\d+)/);
      if (m) {
        assignmentId = m[1];
        submissionId = m[2];
        title = link.text().trim();
      }
    } else {
      const button = $row.find('button[data-assignment-id]').first();
      assignmentId = button.attr('data-assignment-id') ?? null;
      title = (button.attr('data-assignment-title') ?? button.text() ?? '').trim();
    }

    if (!assignmentId) return;

    let score: number | null = null;
    let maxScore: number | null = null;
    const scoreText = $row.find('.submissionStatus--score').first().text().trim();
    if (scoreText) {
      const m = scoreText.match(/([\d.]+)\s*\/\s*([\d.]+)/);
      if (m) {
        score = Number(m[1]);
        maxScore = Number(m[2]);
      }
    }

    let status: AssignmentSummary['status'];
    if (!submissionId) status = 'not_submitted';
    else if (score !== null) status = 'graded';
    else status = 'submitted';

    out.push({ id: assignmentId, title, status, submissionId, score, maxScore });
  });

  return out;
}

export async function fetchSubmission(
  courseId: string,
  assignmentId: string,
  submissionId: string,
): Promise<SubmissionData> {
  return fetchJson<SubmissionData>(
    `/courses/${courseId}/assignments/${assignmentId}/submissions/${submissionId}.json?content=react`,
  );
}
