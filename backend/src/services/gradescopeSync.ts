import { db } from '../db.js';
import {
  fetchSubmission,
  listAssignments,
  listCourses,
} from './gradescopeCrawler.js';
import {
  downloadGradedPdf,
  renderQuestionCrop,
  clearRenderCache,
} from './gradescopePdf.js';

const REQUEST_DELAY_MS = 1500; // 1.5s between Gradescope requests

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type SyncProgress = {
  phase: 'courses' | 'assignments' | 'submission' | 'crops' | 'done';
  message: string;
  current?: number;
  total?: number;
};

export async function syncCourses(
  onProgress: (p: SyncProgress) => void = () => {},
): Promise<void> {
  onProgress({ phase: 'courses', message: 'fetching course list…' });
  const courses = await listCourses();
  const upsertCourse = db.prepare(
    `INSERT INTO courses (id, short_name, full_name, synced_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET short_name=excluded.short_name, full_name=excluded.full_name, synced_at=excluded.synced_at`,
  );
  for (const c of courses) {
    upsertCourse.run(c.id, c.shortName, c.fullName, Date.now());
  }
  onProgress({
    phase: 'done',
    message: `synced ${courses.length} courses`,
  });
}

export async function syncCourseAssignments(
  courseId: string,
  onProgress: (p: SyncProgress) => void = () => {},
): Promise<void> {
  onProgress({
    phase: 'assignments',
    message: `fetching assignments for course ${courseId}…`,
  });
  const assignments = await listAssignments(courseId);

  const upsert = db.prepare(
    `INSERT INTO assignments
       (id, course_id, title, status, submission_id, score, max_score, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title=excluded.title, status=excluded.status,
       submission_id=excluded.submission_id, score=excluded.score,
       max_score=excluded.max_score, synced_at=excluded.synced_at`,
  );
  for (const a of assignments) {
    upsert.run(
      a.id,
      courseId,
      a.title,
      a.status,
      a.submissionId,
      a.score,
      a.maxScore,
      Date.now(),
    );
  }
  onProgress({
    phase: 'done',
    message: `synced ${assignments.length} assignments`,
  });
}

/**
 * Fetch the structured submission JSON for a single graded assignment, persist
 * questions/rubric_items/regrade_requests, and render per-question PDF crops.
 */
export async function syncAssignmentDetails(
  courseId: string,
  assignmentId: string,
  onProgress: (p: SyncProgress) => void = () => {},
): Promise<void> {
  const assignmentRow = db
    .prepare(`SELECT submission_id FROM assignments WHERE id = ?`)
    .get(assignmentId) as { submission_id: string | null } | undefined;
  if (!assignmentRow?.submission_id) {
    throw new Error(`assignment ${assignmentId} has no submission_id`);
  }
  const submissionId = assignmentRow.submission_id;

  onProgress({
    phase: 'submission',
    message: `fetching submission JSON…`,
  });
  const sub = await fetchSubmission(courseId, assignmentId, submissionId);

  await sleep(REQUEST_DELAY_MS);

  // PDF download (cached after first run)
  let pdfPath: string | null = null;
  if (sub.pdf_attachment?.url) {
    onProgress({
      phase: 'submission',
      message: `downloading graded PDF (${sub.pdf_attachment.page_count}p)…`,
    });
    pdfPath = await downloadGradedPdf(sub.pdf_attachment.url, assignmentId);
  }

  // Persist assignment-level updates
  db.prepare(
    `UPDATE assignments SET
       pdf_url = ?, pdf_local_path = ?, page_count = ?,
       max_score = ?, score = ?,
       regrade_requests_open = ?, regrade_request_end = ?
     WHERE id = ?`,
  ).run(
    sub.pdf_attachment?.url ?? null,
    pdfPath,
    sub.pdf_attachment?.page_count ?? null,
    Number(sub.assignment.total_points),
    Number(sub.assignment_submission.score),
    sub.assignment.regrade_requests_open ? 1 : 0,
    sub.assignment.regrade_request_end,
    assignmentId,
  );

  // Replace question/rubric/regrade rows for this assignment
  db.prepare(
    `DELETE FROM questions WHERE assignment_id = ?`,
  ).run(assignmentId);
  db.prepare(
    `DELETE FROM regrade_requests WHERE assignment_id = ?`,
  ).run(assignmentId);

  const insertQuestion = db.prepare(
    `INSERT INTO questions
       (id, assignment_id, question_submission_id, label, title, weight,
        points_awarded, scoring_type, anchor, crop_page, crop_x1, crop_y1, crop_x2, crop_y2,
        display_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertRubric = db.prepare(
    `INSERT INTO rubric_items
       (id, question_id, description, weight, applied, group_id, group_description, display_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertRegrade = db.prepare(
    `INSERT INTO regrade_requests
       (id, question_submission_id, assignment_id, student_comment, staff_comment,
        completed, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const groupById = new Map(
    sub.rubric_item_groups.map((g) => [g.id, g] as const),
  );
  const qsubById = new Map(
    sub.question_submissions.map((s) => [s.question_id, s] as const),
  );

  const tx = db.transaction(() => {
    for (let i = 0; i < sub.questions.length; i++) {
      const q = sub.questions[i];
      const rect = q.parameters?.crop_rect_list?.[0];
      const qsub = qsubById.get(q.id);
      insertQuestion.run(
        String(q.id),
        assignmentId,
        qsub ? String(qsub.id) : null,
        q.full_index,
        q.title,
        Number(q.weight),
        qsub ? Number(qsub.score) : null,
        q.scoring_type,
        q.anchor ?? null,
        rect?.page_number ?? null,
        rect?.x1 ?? null,
        rect?.y1 ?? null,
        rect?.x2 ?? null,
        rect?.y2 ?? null,
        i,
      );

      const items = sub.rubric_items
        .filter((r) => r.question_id === q.id)
        .sort((a, b) => a.position - b.position);
      for (let j = 0; j < items.length; j++) {
        const r = items[j];
        const grp = r.group_id != null ? groupById.get(r.group_id) : null;
        insertRubric.run(
          String(r.id),
          String(q.id),
          r.description,
          Number(r.weight),
          r.present ? 1 : 0,
          grp ? String(grp.id) : null,
          grp?.description ?? null,
          j,
        );
      }
    }

    for (const rr of sub.regrade_requests) {
      insertRegrade.run(
        String(rr.id),
        String(rr.question_submission_id),
        assignmentId,
        rr.student_comment,
        rr.staff_comment,
        rr.completed ? 1 : 0,
        rr.created_at,
        rr.updated_at,
      );
    }
  });
  tx();

  // Render per-question crops (only for questions with a crop rect AND a PDF)
  if (pdfPath) {
    const questionsToCrop = sub.questions.filter(
      (q) => q.parameters?.crop_rect_list?.length,
    );
    onProgress({
      phase: 'crops',
      message: `rendering ${questionsToCrop.length} question crops…`,
      total: questionsToCrop.length,
    });
    let rendered = 0;
    for (const q of questionsToCrop) {
      const cropPath = await renderQuestionCrop(
        pdfPath,
        assignmentId,
        String(q.id),
        q.parameters!.crop_rect_list!,
      );
      db.prepare(`UPDATE questions SET crop_image_path = ? WHERE id = ?`).run(
        cropPath,
        String(q.id),
      );
      rendered++;
      onProgress({
        phase: 'crops',
        message: `rendered ${rendered}/${questionsToCrop.length}`,
        current: rendered,
        total: questionsToCrop.length,
      });
    }
    clearRenderCache();
  }

  onProgress({ phase: 'done', message: 'assignment synced' });
}
