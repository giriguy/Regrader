import { Router } from 'express';
import { nanoid } from 'nanoid';
import {
  db,
  type AnalysisRow,
  type AssignmentRow,
  type CourseRow,
  type QuestionRow,
  type RegradeRequestRow,
  type RubricItemRow,
} from '../db.js';
import { analyzeQuestion } from '../services/llmAnalyzer.js';
import {
  submitRegrade,
  type RegradeSubmitResult,
} from '../services/gradescopeRegrade.js';
import { syncAssignmentDetails } from '../services/gradescopeSync.js';
import {
  NoSessionError,
  SessionExpiredError,
} from '../services/gradescopeHttp.js';

export const analysesRouter = Router();

analysesRouter.get('/assignments/:id/analyses', (req, res) => {
  const rows = db
    .prepare(
      `SELECT a.* FROM analyses a
         JOIN questions q ON q.id = a.question_id
        WHERE q.assignment_id = ?
        ORDER BY q.display_order`,
    )
    .all(req.params.id) as AnalysisRow[];
  res.json(rows);
});

analysesRouter.post('/assignments/:id/analyze', async (req, res, next) => {
  try {
    const assignment = db
      .prepare(`SELECT * FROM assignments WHERE id = ?`)
      .get(req.params.id) as AssignmentRow | undefined;
    if (!assignment) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const course = db
      .prepare(`SELECT * FROM courses WHERE id = ?`)
      .get(assignment.course_id) as CourseRow | undefined;
    const questions = db
      .prepare(
        `SELECT * FROM questions WHERE assignment_id = ? ORDER BY display_order`,
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

    const rubricByQuestion = new Map<string, RubricItemRow[]>();
    for (const r of rubricItems) {
      const list = rubricByQuestion.get(r.question_id) ?? [];
      list.push(r);
      rubricByQuestion.set(r.question_id, list);
    }
    const regradeBySub = new Set(
      regradeRequests.map((r) => r.question_submission_id),
    );

    db.prepare(
      `DELETE FROM analyses
        WHERE question_id IN (SELECT id FROM questions WHERE assignment_id = ?)`,
    ).run(req.params.id);

    const insert = db.prepare(
      `INSERT INTO analyses
         (id, question_id, points_missed, confidence, justification, draft, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    );

    const results: AnalysisRow[] = [];
    const now = Date.now();

    for (const q of questions) {
      // Skip questions already filed for regrade
      if (q.question_submission_id && regradeBySub.has(q.question_submission_id)) {
        continue;
      }
      // Skip zero-weight non-graded questions (Comments/Concerns etc.)
      if (q.weight <= 0) continue;
      // Skip full-credit questions
      if (q.points_awarded != null && q.points_awarded >= q.weight) continue;

      const items = (rubricByQuestion.get(q.id) ?? []).map((r) => ({
        description: r.description,
        weight: r.weight,
        applied: r.applied === 1,
        group_description: r.group_description,
      }));

      const analyzed = await analyzeQuestion({
        course_short_name: course?.short_name ?? '',
        assignment_title: assignment.title,
        question_label: q.label,
        question_title: q.title ?? '',
        max_points: q.weight,
        points_awarded: q.points_awarded ?? 0,
        scoring_type: q.scoring_type as 'positive' | 'negative',
        rubric_items: items,
        answer_image_path: q.crop_image_path,
      });

      if (!analyzed.should_regrade) continue;

      const id = nanoid(12);
      insert.run(
        id,
        q.id,
        analyzed.points_missed,
        analyzed.confidence,
        analyzed.justification,
        analyzed.draft_request,
        now,
      );
      results.push({
        id,
        question_id: q.id,
        points_missed: analyzed.points_missed,
        confidence: analyzed.confidence,
        justification: analyzed.justification,
        draft: analyzed.draft_request,
        status: 'pending',
        created_at: now,
      });
    }

    res.json(results);
  } catch (err) {
    next(err);
  }
});

analysesRouter.patch('/analyses/:id', (req, res) => {
  // PATCH only allows the user-driven statuses. 'submitted' / 'failed' are
  // owned by the submit endpoint below.
  const allowedStatus = new Set(['pending', 'approved', 'edited', 'skipped']);
  const updates: string[] = [];
  const values: unknown[] = [];

  if (typeof req.body.draft === 'string') {
    updates.push('draft = ?');
    values.push(req.body.draft);
  }
  if (typeof req.body.status === 'string' && allowedStatus.has(req.body.status)) {
    updates.push('status = ?');
    values.push(req.body.status);
  }
  if (updates.length === 0) {
    res.status(400).json({ error: 'no valid fields to update' });
    return;
  }
  values.push(req.params.id);
  db.prepare(`UPDATE analyses SET ${updates.join(', ')} WHERE id = ?`).run(
    ...values,
  );
  const row = db
    .prepare(`SELECT * FROM analyses WHERE id = ?`)
    .get(req.params.id) as AnalysisRow | undefined;
  if (!row) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(row);
});

type SubmitContext = {
  analysis: AnalysisRow;
  question: QuestionRow;
  assignment: AssignmentRow;
  course: CourseRow;
};

type GuardFailure = { code: number; error: string };

function loadSubmitContext(
  analysisId: string,
): SubmitContext | { notFound: true } {
  const analysis = db
    .prepare(`SELECT * FROM analyses WHERE id = ?`)
    .get(analysisId) as AnalysisRow | undefined;
  if (!analysis) return { notFound: true };
  const question = db
    .prepare(`SELECT * FROM questions WHERE id = ?`)
    .get(analysis.question_id) as QuestionRow | undefined;
  if (!question) return { notFound: true };
  const assignment = db
    .prepare(`SELECT * FROM assignments WHERE id = ?`)
    .get(question.assignment_id) as AssignmentRow | undefined;
  if (!assignment) return { notFound: true };
  const course = db
    .prepare(`SELECT * FROM courses WHERE id = ?`)
    .get(assignment.course_id) as CourseRow | undefined;
  if (!course) return { notFound: true };
  return { analysis, question, assignment, course };
}

function checkSubmitGuards(ctx: SubmitContext): GuardFailure | null {
  const { analysis, question, assignment } = ctx;
  if (!assignment.regrade_requests_open) {
    return { code: 409, error: 'window_closed' };
  }
  if (!assignment.submission_id) {
    return { code: 409, error: 'no_submission' };
  }
  if (!question.question_submission_id) {
    return { code: 409, error: 'no_question_submission' };
  }
  if (!question.anchor) {
    return { code: 409, error: 'no_anchor' };
  }
  if (analysis.status !== 'approved' && analysis.status !== 'edited') {
    return { code: 409, error: 'not_approved' };
  }
  const existing = db
    .prepare(
      `SELECT 1 FROM regrade_requests WHERE question_submission_id = ?`,
    )
    .get(question.question_submission_id);
  if (existing) {
    return { code: 409, error: 'already_submitted' };
  }
  return null;
}

async function submitOne(
  ctx: SubmitContext,
): Promise<{
  analysis: AnalysisRow;
  result: RegradeSubmitResult;
}> {
  const { analysis, question, assignment, course } = ctx;
  const submissionId = assignment.submission_id!;
  const result = await submitRegrade({
    courseId: course.id,
    assignmentId: assignment.id,
    submissionId,
    questionAnchor: question.anchor!,
    questionLabel: question.label,
    comment: analysis.draft,
  });

  const logId = nanoid(12);
  const now = Date.now();
  if (result.ok) {
    db.prepare(
      `INSERT INTO regrade_submission_log
         (id, analysis_id, question_id, question_submission_id, assignment_id,
          submitted_at, comment, success, gradescope_regrade_id, error, stage)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, NULL)`,
    ).run(
      logId,
      analysis.id,
      question.id,
      question.question_submission_id,
      assignment.id,
      now,
      analysis.draft,
      result.gradescopeRegradeId,
    );
    db.prepare(`UPDATE analyses SET status = 'submitted' WHERE id = ?`).run(
      analysis.id,
    );
    // Re-sync so the regrade_requests table picks up the new entry.
    try {
      await syncAssignmentDetails(course.id, assignment.id);
    } catch (err) {
      console.warn(
        '[regrader] post-submit re-sync failed (non-fatal):',
        err instanceof Error ? err.message : err,
      );
    }
  } else {
    db.prepare(
      `INSERT INTO regrade_submission_log
         (id, analysis_id, question_id, question_submission_id, assignment_id,
          submitted_at, comment, success, gradescope_regrade_id, error, stage)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
    ).run(
      logId,
      analysis.id,
      question.id,
      question.question_submission_id,
      assignment.id,
      now,
      analysis.draft,
      result.error,
      result.stage,
    );
    db.prepare(`UPDATE analyses SET status = 'failed' WHERE id = ?`).run(
      analysis.id,
    );
  }

  const updated = db
    .prepare(`SELECT * FROM analyses WHERE id = ?`)
    .get(analysis.id) as AnalysisRow;
  return { analysis: updated, result };
}

analysesRouter.post('/analyses/:id/submit', async (req, res, next) => {
  try {
    const ctx = loadSubmitContext(req.params.id);
    if ('notFound' in ctx) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const guard = checkSubmitGuards(ctx);
    if (guard) {
      res.status(guard.code).json({ error: guard.error });
      return;
    }
    const { analysis, result } = await submitOne(ctx);
    if (result.ok) {
      res.json({ ok: true, analysis, gradescopeRegradeId: result.gradescopeRegradeId });
    } else {
      res
        .status(502)
        .json({ ok: false, analysis, stage: result.stage, error: result.error });
    }
  } catch (err) {
    next(err);
  }
});

analysesRouter.post(
  '/assignments/:id/submit-approved',
  async (req, res, next) => {
    try {
      const assignment = db
        .prepare(`SELECT * FROM assignments WHERE id = ?`)
        .get(req.params.id) as AssignmentRow | undefined;
      if (!assignment) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      if (!assignment.regrade_requests_open) {
        res.status(409).json({ error: 'window_closed' });
        return;
      }

      const candidates = db
        .prepare(
          `SELECT a.id AS analysis_id
             FROM analyses a
             JOIN questions q ON q.id = a.question_id
            WHERE q.assignment_id = ?
              AND a.status IN ('approved', 'edited')`,
        )
        .all(req.params.id) as Array<{ analysis_id: string }>;

      const submitted: AnalysisRow[] = [];
      const failed: Array<{
        analysis_id: string;
        stage?: string;
        error: string;
      }> = [];
      const skipped: Array<{ analysis_id: string; reason: string }> = [];

      for (const { analysis_id } of candidates) {
        const ctx = loadSubmitContext(analysis_id);
        if ('notFound' in ctx) {
          failed.push({ analysis_id, error: 'not_found' });
          continue;
        }
        const guard = checkSubmitGuards(ctx);
        if (guard) {
          skipped.push({ analysis_id, reason: guard.error });
          continue;
        }
        const { analysis, result } = await submitOne(ctx);
        if (result.ok) {
          submitted.push(analysis);
        } else {
          failed.push({
            analysis_id,
            stage: result.stage,
            error: result.error,
          });
        }
      }

      res.json({ submitted, failed, skipped });
    } catch (err) {
      next(err);
    }
  },
);

// Translate session errors to 401 so the frontend can bounce to Connect.
analysesRouter.use(
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
