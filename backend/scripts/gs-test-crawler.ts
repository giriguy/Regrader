/**
 * One-off test of the new HTTP crawler. Imports cookies from
 * data/gs-session.json (left over from gs-login.ts) into the DB,
 * then exercises listCourses, listAssignments, fetchSubmission.
 *
 * Run: npx tsx scripts/gs-test-crawler.ts
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveCookies, type GsCookie } from '../src/services/gradescopeSession.js';
import {
  listCourses,
  listAssignments,
  fetchSubmission,
} from '../src/services/gradescopeCrawler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_PATH = path.resolve(__dirname, '../data/gs-session.json');

async function main() {
  // Bootstrap cookies from the standalone-script file into the DB
  const sessionJson = JSON.parse(await fs.readFile(SESSION_PATH, 'utf8'));
  saveCookies(sessionJson.cookies as GsCookie[]);
  console.log(`[test] imported ${sessionJson.cookies.length} cookies into DB`);

  console.log('\n=== listCourses() ===');
  const courses = await listCourses();
  for (const c of courses) {
    console.log(`  ${c.id}  ${c.shortName}  —  ${c.fullName ?? ''}`);
  }

  // Pick CS 170 (we already inspected it)
  const cs170 = courses.find((c) => c.shortName === 'CS 170');
  if (!cs170) throw new Error('CS 170 not found');

  console.log(`\n=== listAssignments(${cs170.id}) ===`);
  const assignments = await listAssignments(cs170.id);
  for (const a of assignments) {
    console.log(
      `  ${a.id}  status=${a.status.padEnd(15)}  sub=${a.submissionId ?? '-'}  ${a.title}`,
    );
  }

  // Find Midterm 1 (we know it has data)
  const mt1 = assignments.find((a) => a.title === 'Midterm 1');
  if (!mt1 || !mt1.submissionId) throw new Error('Midterm 1 submission not found');

  console.log(`\n=== fetchSubmission(${cs170.id}, ${mt1.id}, ${mt1.submissionId}) ===`);
  const sub = await fetchSubmission(cs170.id, mt1.id, mt1.submissionId);
  console.log(`  assignment.title:        ${sub.assignment.title}`);
  console.log(`  assignment.total_points: ${sub.assignment.total_points}`);
  console.log(`  assignment_submission.score: ${sub.assignment_submission.score}`);
  console.log(`  questions.length:        ${sub.questions.length}`);
  console.log(`  rubric_items.length:     ${sub.rubric_items.length}`);
  console.log(`  rubric_item_groups.length: ${sub.rubric_item_groups.length}`);
  console.log(`  regrade_requests.length: ${sub.regrade_requests.length}`);
  console.log(`  pdf_attachment.page_count: ${sub.pdf_attachment?.page_count}`);
  console.log(`  pdf_attachment.url present: ${Boolean(sub.pdf_attachment?.url)}`);

  // Sanity: how many rubric items applied per question
  console.log(`\n=== rubric application per question ===`);
  for (const q of sub.questions) {
    const items = sub.rubric_items.filter((r) => r.question_id === q.id);
    const applied = items.filter((r) => r.present);
    const sumApplied = applied.reduce((s, r) => s + Number(r.weight), 0);
    const qsub = sub.question_submissions.find((s) => s.question_id === q.id);
    console.log(
      `  Q${q.full_index} ${q.title.padEnd(20)}  weight=${q.weight}  scoring=${q.scoring_type.padEnd(8)}  rubric=${items.length}  applied=${applied.length}  sumApplied=${sumApplied.toFixed(1)}  subScore=${qsub?.score ?? '-'}`,
    );
  }

  console.log('\n[test] all good ✓');
}

main().catch((e) => {
  console.error('[test] FAILED:', e);
  process.exit(1);
});
