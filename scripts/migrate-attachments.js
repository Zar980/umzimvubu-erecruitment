'use strict';

/* ==========================================================================
   scripts/migrate-attachments.js

   One-time migration:
     1. Moves every candidate's existing `cover_letter_path` into the new
        `candidate_documents` table as a typed row (doc_type = 'cover_letter').
     2. Re-runs the full ATS pipeline (CV + every attachment) on every
        candidate so `cv_text`, `cv_parsed`, and the FTS index are fresh.

   Safe to re-run — it only inserts a document row if one doesn't already
   exist for that candidate/type, and re-parsing overwrites cleanly.
   ========================================================================== */

require('dotenv').config();

const db = require('../db');
const ats = require('../ats');

(async () => {
  console.log('');
  console.log('[migrate] starting attachment migration…');

  /* 1. Ensure the candidate_documents table exists. */
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='candidate_documents'"
  ).all();
  if (!tables.length) {
    console.error('[migrate] FATAL: candidate_documents table does not exist.');
    console.error('[migrate] Restart the server once so db.js can run its migration.');
    process.exit(1);
  }

  /* 2. Move every cover_letter_path into candidate_documents. */
  const cands = db.prepare(`
    SELECT id, email, cv_path, cover_letter_path FROM candidates
  `).all();

  console.log(`[migrate] ${cands.length} candidate(s) to process.`);

  let movedCoverLetters = 0;
  for (const c of cands) {
    if (!c.cover_letter_path) continue;

    const exists = db.prepare(
      "SELECT id FROM candidate_documents WHERE candidate_id = ? AND doc_type = 'cover_letter'"
    ).get(c.id);
    if (exists) continue;

    db.prepare(`
      INSERT INTO candidate_documents (candidate_id, doc_type, filename)
      VALUES (?, 'cover_letter', ?)
    `).run(c.id, c.cover_letter_path);

    movedCoverLetters++;
  }

  console.log(`[migrate] moved ${movedCoverLetters} cover letter(s) into candidate_documents.`);

  /* 3. Re-run the full ATS pipeline for every candidate. */
  console.log('');
  console.log('[migrate] re-parsing CVs and attachments…');

  let ok = 0;
  for (const c of cands) {
    try {
      const res = await ats.processCandidateWithDocuments(db, c.id);
      const docCount = res.totalDocuments;
      const cvChars = res.cv?.method ? '(cv ok)' : '(cv missing)';
      console.log(`  #${c.id} ${c.email}: cv ${cvChars}, ${docCount} attachment(s)`);
      ok++;
    } catch (e) {
      console.error(`  #${c.id} ${c.email} FAILED:`, e.message);
    }
  }

  console.log('');
  console.log(`[migrate] done. ${ok}/${cands.length} candidates re-processed successfully.`);
  console.log('');

  /* 4. Report what ended up in the documents table. */
  const byType = db.prepare(`
    SELECT doc_type, COUNT(*) AS n FROM candidate_documents GROUP BY doc_type ORDER BY doc_type
  `).all();

  if (byType.length) {
    console.log('[migrate] documents by type:');
    byType.forEach((r) => console.log(`   ${r.doc_type.padEnd(20)} ${r.n}`));
  } else {
    console.log('[migrate] no documents on file yet.');
    console.log('[migrate] Candidates can upload them next time they sign in.');
  }
  console.log('');
})().catch((err) => {
  console.error('[migrate] fatal:', err);
  process.exit(1);
});