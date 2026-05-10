import { Router } from 'express';
import {
  db,
  type AssignmentRow,
  type CourseRow,
  type QuestionRow,
  type RegradeRequestRow,
  type RegradeSubmissionLogRow,
  type RubricItemRow,
} from '../db.js';

export const coursesRouter = Router();

coursesRouter.get('/courses', (_req, res) => {
  const rows = db
    .prepare(`SELECT * FROM courses ORDER BY short_name ASC`)
    .all() as CourseRow[];
  res.json(rows);
});

coursesRouter.get('/courses/:id/assignments', (req, res) => {
  const rows = db
    .prepare(
      `SELECT * FROM assignments
        WHERE course_id = ?
        ORDER BY synced_at DESC, id DESC`,
    )
    .all(req.params.id) as AssignmentRow[];
  res.json(rows);
});

coursesRouter.get('/assignments/:id', (req, res) => {
  const assignment = db
    .prepare(`SELECT * FROM assignments WHERE id = ?`)
    .get(req.params.id) as AssignmentRow | undefined;
  if (!assignment) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const questions = db
    .prepare(
      `SELECT * FROM questions
        WHERE assignment_id = ?
        ORDER BY display_order ASC`,
    )
    .all(req.params.id) as QuestionRow[];
  const rubricItems = db
    .prepare(
      `SELECT r.* FROM rubric_items r
         JOIN questions q ON q.id = r.question_id
        WHERE q.assignment_id = ?
        ORDER BY r.question_id, r.display_order`,
    )
    .all(req.params.id) as RubricItemRow[];
  const regradeRequests = db
    .prepare(`SELECT * FROM regrade_requests WHERE assignment_id = ?`)
    .all(req.params.id) as RegradeRequestRow[];
  // Latest log row per analysis — surfaces the failure reason on `failed`
  // cards and the success metadata on `submitted` cards.
  const submissionLog = db
    .prepare(
      `SELECT l.* FROM regrade_submission_log l
        WHERE l.assignment_id = ?
          AND l.submitted_at = (
            SELECT MAX(l2.submitted_at) FROM regrade_submission_log l2
             WHERE l2.analysis_id = l.analysis_id
          )
        ORDER BY l.submitted_at DESC`,
    )
    .all(req.params.id) as RegradeSubmissionLogRow[];
  res.json({
    assignment,
    questions,
    rubricItems,
    regradeRequests,
    submissionLog,
  });
});
