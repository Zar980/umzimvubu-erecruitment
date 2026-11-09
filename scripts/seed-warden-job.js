'use strict';

/* ==========================================================================
   scripts/seed-warden-job.js

   Recreates the LAW ENFORCEMENT WARDEN job (closing date = 15 Oct 2026,
   yesterday) and screens every candidate already in the database against it.

   The script does NOT contain any CV text. It points to CV files that are
   already in /uploads and runs the real ATS pipeline (ats.processCandidateCv)
   on each one. That pipeline is the same code the production upload route
   uses, so the result here is the result you would get in production.

   For candidates already in the DB (David, Thabo), it re-applies them to
   the new job and re-runs the ATS on their existing CV files.

   For the two extra test candidates (Sipho, Nomsa), their CV files must be
   dropped in /uploads first — the script will error clearly if they're
   missing.
   ========================================================================== */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const db = require('../db');
const ats = require('../ats');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

/* --------------------------------------------------------------------------
   The job
   -------------------------------------------------------------------------- */
const JOB = {
  title: 'LAW ENFORCEMENT WARDEN',
  category: 'CITIZENS & COMMUNITY SERVICES',
  location: 'Umzimvubu, Eastern Cape, South Africa',
  description:
    'EPWP - Beneficiaries: 04. Contract: 24 Months Fixed Contract. ' +
    'Stipend: R 3,388 per month. ' +
    'Key Performance Areas: Make sure traffic, monitoring, and parking bylaws ' +
    'and regulations are followed; report parking offences and issue fixed ' +
    'penalty notices to offenders; monitor the use of parking meters, ' +
    'controlled parking zones, and one-way systems; check infringements on ' +
    'waiting restrictions and on the loading/unloading of goods; check that ' +
    'vehicles display up-to-date motor vehicle license discs; arrange ' +
    'breakdowns for towing away wrongly parked vehicles; patrol given areas ' +
    'as directed and enforce road traffic regulations; act as a visible ' +
    'representative of the ULM Law Enforcement Division; attend court as required.',
  requirements:
    'Minimum Requirements: Grade 12 certificate, certified ID copy, Traffic ' +
    'Diploma, Driving Licence, Certificate of no criminal record (SAPS ' +
    'clearance certificate), Recent medical report certificate that proves ' +
    'the applicant exercises, Proof from Ward Councillor.',
  closing_date: '2026-10-15'
};

/* --------------------------------------------------------------------------
   Candidates

   - "byEmail": the candidate already exists in the DB. We just add an
     application row to the new job and re-run the ATS on their existing CV.
   - "create": the candidate doesn't exist yet. We create them and give them
     a CV path pointing at a file the user dropped in /uploads.
   -------------------------------------------------------------------------- */
const EXISTING_CANDIDATES = [
  { email: 'davidpeters@gmail.com' },     // David Peters - No Traffic Diploma
  { email: 'tmolefe@gmail.com' }          // Thabo Molefe - has Traffic Diploma
];

const NEW_CANDIDATES = [
  {
    email: 'sipho.mkhize@example.co.za',
    title: 'Mr',
    first_name: 'Sipho',
    last_name: 'Mkhize',
    phone_country_code: '+27',
    phone_number: '823456789',
    city: 'Mount Frere',
    cv_filename: 'test_sipho_mkhize_warden.docx'
  },
  {
    email: 'nomsa.dlamini@example.co.za',
    title: 'Ms',
    first_name: 'Nomsa',
    last_name: 'Dlamini',
    phone_country_code: '+27',
    phone_number: '734567890',
    city: 'Bizana',
    cv_filename: 'test_nomsa_dlamini_warden.docx'
  }
];

/* --------------------------------------------------------------------------
   Helpers
   -------------------------------------------------------------------------- */
function deleteJobAndApplicationsByTitle(title) {
  const jobs = db.prepare('SELECT id FROM jobs WHERE title = ?').all(title);
  if (!jobs.length) return 0;
  const ids = jobs.map((j) => j.id);
  const ph = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM applications WHERE job_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM jobs         WHERE id     IN (${ph})`).run(...ids);
  return jobs.length;
}

function deleteCandidateByEmail(email) {
  const row = db.prepare('SELECT id FROM candidates WHERE email = ?').get(email);
  if (!row) return null;
  db.prepare('DELETE FROM applications WHERE candidate_id = ?').run(row.id);
  db.prepare('DELETE FROM education    WHERE candidate_id = ?').run(row.id);
  db.prepare('DELETE FROM experience   WHERE candidate_id = ?').run(row.id);
  db.prepare('DELETE FROM candidates   WHERE id = ?').run(row.id);
  try { db.prepare('DELETE FROM cv_fts WHERE candidate_id = ?').run(row.id); } catch { /* ignore */ }
  return row.id;
}

function createCandidate(c, cvFilename) {
  const info = db.prepare(`
    INSERT INTO candidates (
      email, title, first_name, last_name,
      phone_country_code, phone_number,
      preferred_job_category, preferred_job_location,
      country, city, suburb,
      cv_path, verified
    ) VALUES (
      @email, @title, @firstName, @lastName,
      @phoneCC, @phoneNumber,
      @prefCat, @prefLoc,
      'South Africa', @city, @city,
      @cvPath, 1
    )
  `).run({
    email: c.email,
    title: c.title,
    firstName: c.first_name,
    lastName: c.last_name,
    phoneCC: c.phone_country_code,
    phoneNumber: c.phone_number,
    prefCat: 'CITIZENS & COMMUNITY SERVICES',
    prefLoc: c.city,
    city: c.city,
    cvPath: cvFilename
  });
  return info.lastInsertRowid;
}

/* --------------------------------------------------------------------------
   Main
   -------------------------------------------------------------------------- */
(async () => {
  console.log('');

  /* 1. Verify the two new CV files exist. */
  const missing = NEW_CANDIDATES.filter((c) =>
    !fs.existsSync(path.join(UPLOAD_DIR, c.cv_filename))
  );
  if (missing.length) {
    console.error('[seed] These CV files are missing from /uploads:');
    missing.forEach((c) => console.error(`         ${c.cv_filename}`));
    console.error(`\nSave the two CVs as .docx files into: ${UPLOAD_DIR}\n`);
    process.exit(1);
  }
  console.log('[seed] both new CV files are present.');

  /* 2. Wipe and recreate the job. */
  const removed = deleteJobAndApplicationsByTitle(JOB.title);
  if (removed) console.log(`[seed] removed ${removed} previous copy of the job.`);

  const jobInfo = db.prepare(`
    INSERT INTO jobs (title, category, location, description, requirements, closing_date, is_open)
    VALUES (@title, @category, @location, @description, @requirements, @closing, 1)
  `).run({
    title: JOB.title,
    category: JOB.category,
    location: JOB.location,
    description: JOB.description,
    requirements: JOB.requirements,
    closing: JOB.closing_date
  });
  const jobId = jobInfo.lastInsertRowid;
  console.log(`[seed] job #${jobId} created (closing ${JOB.closing_date}).`);

  /* 3. Register the existing candidates against the new job. */
  for (const c of EXISTING_CANDIDATES) {
    const row = db.prepare('SELECT id, first_name, last_name, cv_path FROM candidates WHERE email = ?').get(c.email);
    if (!row) {
      console.warn(`[seed] WARNING: no candidate with email ${c.email} — skipped.`);
      continue;
    }
    db.prepare('INSERT INTO applications (candidate_id, job_id) VALUES (?, ?)')
      .run(row.id, jobId);
    console.log(`[seed] existing candidate #${row.id} ${row.first_name} ${row.last_name} applied (cv: ${row.cv_path})`);

    /* Re-run the ATS on their existing CV so cv_text and the FTS index are fresh. */
    try {
      const r = await ats.processCandidateCv(db, row.id);
      console.log(`[seed]   ATS → quality ${r.quality}, method ${r.method}`);
    } catch (e) {
      console.error(`[seed]   ATS FAILED:`, e.message);
    }
  }

  /* 4. Create the two new candidates and apply them. */
  for (const c of NEW_CANDIDATES) {
    /* Remove previous run of the same email if it exists. */
    deleteCandidateByEmail(c.email);

    const candId = createCandidate(c, c.cv_filename);
    db.prepare('INSERT INTO applications (candidate_id, job_id) VALUES (?, ?)')
      .run(candId, jobId);
    console.log(`[seed] new candidate #${candId} ${c.first_name} ${c.last_name} created and applied`);

    try {
      const r = await ats.processCandidateCv(db, candId);
      console.log(`[seed]   ATS → quality ${r.quality}, method ${r.method}`);
    } catch (e) {
      console.error(`[seed]   ATS FAILED:`, e.message);
    }
  }

  /* 5. Verification — print the first 120 chars of the stored cv_text for each
        candidate, to prove the text came from the file on disk. */
  console.log('');
  console.log('[seed] stored CV text previews (first 120 chars, from the files):');
  const rows = db.prepare(`
    SELECT c.id, c.first_name, c.last_name, c.cv_path, c.cv_text
      FROM candidates c
      JOIN applications a ON a.candidate_id = c.id
     WHERE a.job_id = ?
     ORDER BY c.id
  `).all(jobId);

  for (const r of rows) {
    const preview = (r.cv_text || '').slice(0, 120).replace(/\s+/g, ' ');
    console.log(`[seed]   #${r.id} ${r.first_name} ${r.last_name} (${r.cv_path}):`);
    console.log(`[seed]      ${preview || '(EMPTY — extraction failed)'}`);
  }

  const count = db.prepare('SELECT COUNT(*) AS c FROM applications WHERE job_id = ?').get(jobId).c;
  console.log('');
  console.log(`[seed] job #${jobId} has ${count} application(s).`);
  console.log('');
  console.log('Next:');
  console.log('  1. Restart the server (Ctrl + C, then node server.js).');
  console.log('  2. Open /admin.html, log in.');
  console.log('  3. Click "Master List" on LAW ENFORCEMENT WARDEN.');
  console.log('');
})().catch((err) => {
  console.error('[seed] fatal:', err);
  process.exit(1);
});