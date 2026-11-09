'use strict';

/* ==========================================================================
   scripts/reset-masterlist.js

   Prepares a job so its master list can be built for testing:
     1. Finds the job by title (case-insensitive, partial match).
     2. Sets its closing date to yesterday (so the master list gate opens).
     3. Clears any frozen snapshot so the next "Master List" click rebuilds.

   Usage:
     node scripts/reset-masterlist.js
     node scripts/reset-masterlist.js "LAW ENFORCEMENT WARDEN"
   ========================================================================== */

const db = require('../db');

/* The default title matches exactly what the admin table shows. */
const DEFAULT_QUERY = 'LAW ENFORCEMENT WARDEN';
const wanted = String(process.argv[2] || DEFAULT_QUERY).trim();

/* ------------------------------------------------------------------ */
/* Find the job. Try exact title first, then a LIKE match, then a      */
/* description match as a last resort.                                */
/* ------------------------------------------------------------------ */
let job = db.prepare(
  'SELECT id, title, category, closing_date, is_open FROM jobs WHERE title = ?'
).get(wanted);

if (!job) {
  job = db.prepare(
    'SELECT id, title, category, closing_date, is_open FROM jobs WHERE title LIKE ? ORDER BY id DESC LIMIT 1'
  ).get(`%${wanted}%`);
}

if (!job) {
  job = db.prepare(
    'SELECT id, title, category, closing_date, is_open FROM jobs WHERE description LIKE ? ORDER BY id DESC LIMIT 1'
  ).get(`%${wanted}%`);
}

if (!job) {
  /* Nothing matched — show what's in the table so the next run can be exact. */
  console.error(`[reset] No job matched "${wanted}".`);
  console.error('');
  console.error('Jobs currently in the database:');
  const rows = db.prepare('SELECT id, title, category, closing_date, is_open FROM jobs ORDER BY id').all();
  if (!rows.length) {
    console.error('  (none)');
  } else {
    for (const r of rows) {
      console.error(`  #${r.id}  ${r.title}  [${r.category || '—'}]  closing=${r.closing_date || '—'}  open=${r.is_open}`);
    }
  }
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* Compute yesterday's date as YYYY-MM-DD.                            */
/* ------------------------------------------------------------------ */
const yesterday = new Date();
yesterday.setDate(yesterday.getDate() - 1);
const yyyy = yesterday.getFullYear();
const mm = String(yesterday.getMonth() + 1).padStart(2, '0');
const dd = String(yesterday.getDate()).padStart(2, '0');
const ymd = `${yyyy}-${mm}-${dd}`;

/* ------------------------------------------------------------------ */
/* Apply the change.                                                  */
/* ------------------------------------------------------------------ */
const hasMasterlistColumn = db
  .prepare('PRAGMA table_info(jobs)')
  .all()
  .map((c) => c.name)
  .includes('masterlist_json');

if (hasMasterlistColumn) {
  db.prepare(`
    UPDATE jobs
       SET closing_date = ?,
           is_open      = 1,
           masterlist_json     = NULL,
           masterlist_built_at = NULL
     WHERE id = ?
  `).run(ymd, job.id);
} else {
  /* Older schema without the cache columns. */
  db.prepare(`
    UPDATE jobs
       SET closing_date = ?,
           is_open      = 1
     WHERE id = ?
  `).run(ymd, job.id);
}

const after = db.prepare(
  'SELECT id, title, category, closing_date, is_open FROM jobs WHERE id = ?'
).get(job.id);

console.log('[reset] Job updated:');
console.log(`  id            : ${after.id}`);
console.log(`  title         : ${after.title}`);
console.log(`  category      : ${after.category || '—'}`);
console.log(`  closing_date  : ${after.closing_date}  (set to yesterday so screening can run)`);
console.log(`  is_open       : ${after.is_open}`);
console.log('');
console.log('Next:');
console.log('  1. Restart the server if it is running (Ctrl + C, then node server.js).');
console.log('  2. Open /admin.html and click "Master List" on this job.');
console.log('  3. Expect one qualified and one unqualified row.');
console.log('');
console.log('If you want a different job, pass its title:');
console.log('  node scripts/reset-masterlist.js "OTHER JOB TITLE"');