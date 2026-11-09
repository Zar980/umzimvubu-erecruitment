'use strict';

/* ==========================================================================
   scripts/add-perfect-candidate.js

   Adds the "perfect" test candidate (test_perfect_candidate.docx) to the
   most recent LAW ENFORCEMENT WARDEN job and runs the ATS pipeline on the
   CV. The CV file must already be present in /uploads.

   Safe to run repeatedly: removes any previous copy of the candidate first.
   ========================================================================== */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const db = require('../db');
const ats = require('../ats');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const CV_FILE = 'test_perfect_candidate.docx';
const EMAIL = 'perfect.candidate@example.co.za';

(async () => {
  /* 1. Verify the CV file exists. */
  const cvPath = path.join(UPLOAD_DIR, CV_FILE);
  if (!fs.existsSync(cvPath)) {
    console.error(`[perfect] CV file not found: ${cvPath}`);
    console.error('[perfect] Save the CV as .docx with that exact name into /uploads.');
    process.exit(1);
  }
  console.log(`[perfect] CV found: ${CV_FILE}`);

  /* 2. Find the most recent LAW ENFORCEMENT WARDEN job. */
  const job = db.prepare(
    "SELECT id, title FROM jobs WHERE title LIKE '%LAW ENFORCEMENT%' ORDER BY id DESC LIMIT 1"
  ).get();

  if (!job) {
    console.error('[perfect] No LAW ENFORCEMENT job found. Run scripts/seed-warden-job.js first.');
    process.exit(1);
  }
  console.log(`[perfect] target job: #${job.id} ${job.title}`);

  /* 3. Clean any previous copy of this candidate. */
  const existing = db.prepare('SELECT id FROM candidates WHERE email = ?').get(EMAIL);
  if (existing) {
    db.prepare('DELETE FROM applications WHERE candidate_id = ?').run(existing.id);
    db.prepare('DELETE FROM education    WHERE candidate_id = ?').run(existing.id);
    db.prepare('DELETE FROM experience   WHERE candidate_id = ?').run(existing.id);
    db.prepare('DELETE FROM candidates   WHERE id = ?').run(existing.id);
    try { db.prepare('DELETE FROM cv_fts WHERE candidate_id = ?').run(existing.id); } catch { /* ignore */ }
    console.log(`[perfect] removed previous candidate #${existing.id}`);
  }

  /* 4. Create the candidate. */
  const info = db.prepare(`
    INSERT INTO candidates (
      email, title, first_name, last_name,
      phone_country_code, phone_number,
      preferred_job_category, preferred_job_location,
      country, city, suburb,
      cv_path, verified
    ) VALUES (
      @email, 'Mr', 'Perfect', 'Candidate',
      '+27', '820000000',
      'CITIZENS & COMMUNITY SERVICES', 'Mount Frere',
      'South Africa', 'Mount Frere', 'Mount Frere',
      @cvPath, 1
    )
  `).run({ email: EMAIL, cvPath: CV_FILE });

  const candidateId = info.lastInsertRowid;
  console.log(`[perfect] created candidate #${candidateId}`);

  /* 5. Apply them to the job. */
  db.prepare('INSERT INTO applications (candidate_id, job_id) VALUES (?, ?)')
    .run(candidateId, job.id);
  console.log(`[perfect] applied to job #${job.id}`);

  /* 6. Run the ATS pipeline on the CV. */
  try {
    const r = await ats.processCandidateCv(db, candidateId);
    console.log(`[perfect] ATS parse → quality ${r.quality}, method ${r.method}`);
    if (r.warnings?.length) r.warnings.forEach((w) => console.log(`[perfect]   · ${w}`));
  } catch (e) {
    console.error(`[perfect] ATS failed:`, e.message);
  }

  /* 7. Preview the stored text so we can confirm it was read from the file. */
  const stored = db.prepare('SELECT cv_text FROM candidates WHERE id = ?').get(candidateId);
  console.log('');
  console.log('[perfect] stored CV text preview:');
  console.log('   ' + (stored.cv_text || '(empty)').slice(0, 160).replace(/\s+/g, ' '));
  console.log('');
  console.log('Next:');
  console.log('  1. Restart the server (Ctrl + C, then node server.js).');
  console.log('  2. Hard-refresh /admin.html (Ctrl + Shift + R).');
  console.log('  3. Click "Master List" on LAW ENFORCEMENT WARDEN.');
  console.log('  4. Expect "Perfect Candidate" at the top of Qualified with ATS ~100%.');
  console.log('');
})().catch((err) => {
  console.error('[perfect] fatal:', err);
  process.exit(1);
});