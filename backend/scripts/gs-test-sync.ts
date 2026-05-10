/**
 * End-to-end test: sync courses → assignments → submission → crops → analyze.
 * Uses cookies already imported into the DB by gs-test-crawler.ts.
 *
 * Run: npx tsx scripts/gs-test-sync.ts
 */
import {
  syncCourses,
  syncCourseAssignments,
  syncAssignmentDetails,
} from '../src/services/gradescopeSync.js';
import { db } from '../src/db.js';

const CS170 = '1233533';
const MT1 = '7750050';

async function main() {
  console.log('--- syncCourses ---');
  await syncCourses((p) => console.log('  ', p.message));

  console.log('--- syncCourseAssignments(CS170) ---');
  await syncCourseAssignments(CS170, (p) => console.log('  ', p.message));

  console.log('--- syncAssignmentDetails(CS170, MT1) ---');
  console.time('  details');
  await syncAssignmentDetails(CS170, MT1, (p) => console.log('  ', p.message));
  console.timeEnd('  details');

  // Inspect what landed in the DB
  const a = db.prepare(`SELECT * FROM assignments WHERE id = ?`).get(MT1);
  console.log('\nassignment row:', a);

  const qs = db.prepare(`SELECT id, label, title, weight, points_awarded, crop_image_path FROM questions WHERE assignment_id = ? ORDER BY display_order`).all(MT1);
  console.log('\nquestions:');
  for (const q of qs) console.log(' ', q);

  const ri = db.prepare(`SELECT COUNT(*) as n FROM rubric_items r JOIN questions q ON q.id = r.question_id WHERE q.assignment_id = ?`).get(MT1);
  console.log('\nrubric_items count:', ri);

  const rr = db.prepare(`SELECT id, question_submission_id, completed FROM regrade_requests WHERE assignment_id = ?`).all(MT1);
  console.log('regrade_requests:', rr);

  console.log('\n[test-sync] all good ✓');
}

main().catch((e) => {
  console.error('[test-sync] FAILED:', e);
  process.exit(1);
});
