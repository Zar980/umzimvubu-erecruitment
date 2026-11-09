'use strict';

/* ==========================================================================
   scripts/diagnose.js
   Shows, for every candidate that has a CV, whether the file exists on disk
   and whether the screener can extract text from it.
   ========================================================================== */

const fs = require('fs');
const path = require('path');
const db = require('../db');
const screening = require('../screening');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

(async () => {
  console.log('');
  console.log('Upload directory:', UPLOAD_DIR);
  console.log('Files on disk   :', fs.existsSync(UPLOAD_DIR) ? fs.readdirSync(UPLOAD_DIR).length : 0);
  console.log('');

  /* Check optional parsers */
  const hasPdf  = (() => { try { require.resolve('pdf-parse'); return true; } catch { return false; } })();
  const hasDocx = (() => { try { require.resolve('mammoth');   return true; } catch { return false; } })();
  console.log('pdf-parse installed :', hasPdf  ? 'yes' : 'NO  ← install with: npm i pdf-parse');
  console.log('mammoth installed   :', hasDocx ? 'yes' : 'NO  ← install with: npm i mammoth');
  console.log('');

  /* NOTE: SQLite uses single quotes for string literals. Double quotes
     mean "column name", so cv_path <> "" throws a schema error. */
  const rows = db.prepare(
    "SELECT id, first_name, last_name, email, cv_path FROM candidates WHERE cv_path IS NOT NULL AND cv_path <> ''"
  ).all();

  if (!rows.length) {
    console.log('No candidates have a CV stored in the database.');
    return;
  }

  for (const r of rows) {
    const base = path.basename(r.cv_path);
    const full = path.join(UPLOAD_DIR, base);
    const exists = fs.existsSync(full);

    console.log(`#${r.id}  ${r.first_name || ''} ${r.last_name || ''}  <${r.email}>`);
    console.log(`   db cv_path : ${r.cv_path}`);
    console.log(`   resolved   : ${full}`);
    console.log(`   exists     : ${exists ? 'YES' : 'NO'}`);

    if (exists) {
      const stat = fs.statSync(full);
      console.log(`   size       : ${stat.size} bytes`);
      const text = await screening.extractCvText(full);
      console.log(`   extracted  : ${text.length} characters`);
      if (text.length > 0 && text.length < 400) {
        console.log(`   preview    : ${text.slice(0, 200).replace(/\n/g, ' ')}`);
      } else if (text.length === 0) {
        console.log('   → parser returned nothing. Either pdf-parse/mammoth are missing, or the PDF is a scanned image.');
      }
    }
    console.log('');
  }
})();