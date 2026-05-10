import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../data/regrader.db');

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS gs_sessions (
    id          TEXT PRIMARY KEY,
    cookies     TEXT NOT NULL,
    saved_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS courses (
    id          TEXT PRIMARY KEY,
    short_name  TEXT NOT NULL,
    full_name   TEXT,
    synced_at   INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS assignments (
    id                       TEXT PRIMARY KEY,
    course_id                TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    title                    TEXT NOT NULL,
    status                   TEXT NOT NULL,
    submission_id            TEXT,
    score                    REAL,
    max_score                REAL,
    pdf_url                  TEXT,
    pdf_local_path           TEXT,
    page_count               INTEGER,
    regrade_requests_open    INTEGER NOT NULL DEFAULT 0,
    regrade_request_end      TEXT,
    raw_props_path           TEXT,
    synced_at                INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_assignments_course ON assignments(course_id);

  CREATE TABLE IF NOT EXISTS questions (
    id              TEXT PRIMARY KEY,
    assignment_id   TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
    question_submission_id TEXT,
    label           TEXT NOT NULL,
    title           TEXT,
    weight          REAL NOT NULL,
    points_awarded  REAL,
    scoring_type    TEXT NOT NULL,
    anchor          TEXT,
    crop_page       INTEGER,
    crop_x1         REAL,
    crop_y1         REAL,
    crop_x2         REAL,
    crop_y2         REAL,
    crop_image_path TEXT,
    display_order   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_questions_assignment ON questions(assignment_id);

  CREATE TABLE IF NOT EXISTS rubric_items (
    id              TEXT PRIMARY KEY,
    question_id     TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    description     TEXT NOT NULL,
    weight          REAL NOT NULL,
    applied         INTEGER NOT NULL,
    group_id        TEXT,
    group_description TEXT,
    display_order   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_rubric_items_question ON rubric_items(question_id);

  CREATE TABLE IF NOT EXISTS regrade_requests (
    id                     TEXT PRIMARY KEY,
    question_submission_id TEXT NOT NULL,
    assignment_id          TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
    student_comment        TEXT,
    staff_comment          TEXT,
    completed              INTEGER NOT NULL,
    created_at             TEXT,
    updated_at             TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_regrade_question_submission ON regrade_requests(question_submission_id);

  CREATE TABLE IF NOT EXISTS analyses (
    id              TEXT PRIMARY KEY,
    question_id     TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    points_missed   REAL,
    confidence      TEXT NOT NULL,
    justification   TEXT NOT NULL,
    draft           TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    created_at      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_analyses_question ON analyses(question_id);

  CREATE TABLE IF NOT EXISTS regrade_submission_log (
    id                       TEXT PRIMARY KEY,
    analysis_id              TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
    question_id              TEXT NOT NULL,
    question_submission_id   TEXT,
    assignment_id            TEXT NOT NULL,
    submitted_at             INTEGER NOT NULL,
    comment                  TEXT NOT NULL,
    success                  INTEGER NOT NULL,
    gradescope_regrade_id    TEXT,
    error                    TEXT,
    stage                    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_log_analysis ON regrade_submission_log(analysis_id);
  CREATE INDEX IF NOT EXISTS idx_log_assignment ON regrade_submission_log(assignment_id);
`);

// Idempotent migrations for columns added after the table was first created.
const questionCols = db
  .prepare(`PRAGMA table_info(questions)`)
  .all() as Array<{ name: string }>;
if (!questionCols.some((c) => c.name === 'anchor')) {
  db.exec(`ALTER TABLE questions ADD COLUMN anchor TEXT`);
}

export type CourseRow = {
  id: string;
  short_name: string;
  full_name: string | null;
  synced_at: number;
};

export type AssignmentRow = {
  id: string;
  course_id: string;
  title: string;
  status: string;
  submission_id: string | null;
  score: number | null;
  max_score: number | null;
  pdf_url: string | null;
  pdf_local_path: string | null;
  page_count: number | null;
  regrade_requests_open: number;
  regrade_request_end: string | null;
  raw_props_path: string | null;
  synced_at: number | null;
};

export type QuestionRow = {
  id: string;
  assignment_id: string;
  question_submission_id: string | null;
  label: string;
  title: string | null;
  weight: number;
  points_awarded: number | null;
  scoring_type: string;
  anchor: string | null;
  crop_page: number | null;
  crop_x1: number | null;
  crop_y1: number | null;
  crop_x2: number | null;
  crop_y2: number | null;
  crop_image_path: string | null;
  display_order: number;
};

export type RubricItemRow = {
  id: string;
  question_id: string;
  description: string;
  weight: number;
  applied: number;
  group_id: string | null;
  group_description: string | null;
  display_order: number;
};

export type RegradeRequestRow = {
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

export type AnalysisRow = {
  id: string;
  question_id: string;
  points_missed: number | null;
  confidence: 'high' | 'medium' | 'low';
  justification: string;
  draft: string;
  status: AnalysisStatus;
  created_at: number;
};

export type RegradeSubmissionLogRow = {
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
