'use strict';

/* ==========================================================================
   scripts/diagnose-requirements.js
   Shows exactly what the parser reads from a job, and what it extracts.
   ========================================================================== */

require('dotenv').config();

const db = require('../db');
const scoring = require('../scoring');

const job = db.prepare(
  "SELECT * FROM jobs WHERE title LIKE '%LAW ENFORCEMENT%' ORDER BY id DESC LIMIT 1"
).get();

if (!job) { console.error('No LAW ENFORCEMENT WARDEN job found.'); process.exit(1); }

console.log('');
console.log(`Job #${job.id} — ${job.title}`);
console.log('');

/* --- Raw field lengths --- */
console.log('Raw job fields:');
console.log(`  title        (${String(job.title || '').length} chars): ${(job.title || '').slice(0, 80)}`);
console.log(`  category     (${String(job.category || '').length} chars): ${(job.category || '').slice(0, 80)}`);
console.log(`  location     (${String(job.location || '').length} chars): ${(job.location || '').slice(0, 80)}`);
console.log(`  description  (${String(job.description || '').length} chars): ${(job.description || '').slice(0, 80)}`);
console.log(`  requirements (${String(job.requirements || '').length} chars): ${(job.requirements || '').slice(0, 80)}`);
console.log(`  closing_date (${String(job.closing_date || '').length} chars): ${job.closing_date || ''}`);
console.log('');

/* --- Combined advert text via buildAdvertText --- */
const advertText = scoring.buildAdvertText(job);
console.log(`Combined advert text: ${advertText.length} chars`);
console.log('  Preview:', advertText.slice(0, 200).replace(/\s+/g, ' '));
console.log('');

/* --- Parsed checks --- */
const checks = scoring.parseAdvert(advertText);
console.log(`Parsed ${checks.length} checks from the advert:`);
checks.forEach((c, i) => {
  console.log(`  ${String(i + 1).padStart(2)}. [${c.type.padEnd(9)}] ${c.label}  (weight ${c.weight})`);
});
console.log('');

/* --- Candidates --- */
const rows = db.prepare(`
  SELECT c.id, c.first_name, c.last_name, c.email, c.cv_path, c.cv_text, c.cv_parsed
    FROM candidates c
    JOIN applications a ON a.candidate_id = c.id
   WHERE a.job_id = ?
   ORDER BY c.id
`).all(job.id);

console.log(`Screening ${rows.length} candidate(s):`);
for (const r of rows) {
  const cvText = r.cv_text || '';
  let parsed = null;
  try { parsed = r.cv_parsed ? JSON.parse(r.cv_parsed) : null; } catch { parsed = null; }

  const result = scoring.scoreCv(cvText, advertText, parsed);

  console.log('');
  console.log(`  #${r.id} ${r.first_name} ${r.last_name} <${r.email}>`);
  console.log(`     cv_text length: ${cvText.length}`);
  console.log(`     score: ${result.score}%   hard met: ${result.hard.met}/${result.hard.required}`);

  result.hard.checks.forEach((c) => {
    const marker = c.met ? (c.partial ? '~' : '✓') : '✗';
    console.log(`       ${marker} ${c.label} — ${c.evidence}`);
  });
  result.soft.checks.forEach((c) => {
    const marker = c.met ? (c.partial ? '~' : '✓') : '✗';
    console.log(`       ${marker} [soft] ${c.label} — ${c.evidence}`);
  });
}

console.log('');
//stable version 2