# ATS integration

Optional installs (OCR for scanned PDFs, .odt support):

```
npm i tesseract.js adm-zip
```

## 1. db.js — run the migration (end of `init()`)

```js
require('./ats').migrate(db);   // adds cv_* columns + cv_fts FTS5 table
```
`ats.js` only uses the `db` argument, so there is no circular import as long as you call it after `init()`:
put it right after `init();` as `require('./ats').migrate(db);`.

## 2. server.js

```js
const ats = require('./ats');
```

### a) Profile upload: parse + index the CV, tell the candidate about problems
Make the handler `async` and replace the final `res.json({ ok: true, created });`:

```js
app.post('/api/profile', upload.fields([...]), async (req, res) => {   // <- async
  ...
  let cv = null;
  if (cvBasename) {
    try { cv = await ats.processCandidateCv(db, findCandidateByEmail.get(email).id); }
    catch (e) { console.error('[ats] parse failed:', e.message); }
  }
  res.json({ ok: true, created, cvQuality: cv?.quality ?? null, cvWarnings: cv?.warnings ?? [] });
});
```

### b) Keep the index clean when candidates are deleted
In `DELETE /api/admin/candidates`, after `db.prepare('DELETE FROM candidates ...')`:

```js
ats.removeFromIndex(db, victims.map((v) => v.id));
```

### c) New admin routes (add above `GET /api/admin/candidates/:id`)

```js
/* Boolean keyword search, e.g.  "Python" AND ("SQL" OR "Data Analysis") NOT intern */
app.get('/api/admin/ats/search', requireAdmin, (req, res) => {
  try {
    const results = ats.search(db, { q: req.query.q, jobId: req.query.jobId, limit: req.query.limit });
    res.json({ ok: true, count: results.length, results });
  } catch (err) {
    if (err.code === 'BAD_QUERY') return res.status(400).json({ ok: false, code: 'BAD_QUERY', error: err.message });
    console.error('[ats/search]', err);
    res.status(500).json({ ok: false, error: 'Search failed.' });
  }
});

/* Re-parse every stored CV (run once after deploying; also after parser upgrades) */
app.post('/api/admin/ats/reindex', requireAdmin, async (req, res) => {
  const r = await ats.reindexAll(db);
  audit(req.admin.id, 'ats.reindex', `${r.indexed}/${r.total}`, req);
  res.json({ ok: true, ...r });
});
```

In `GET /api/admin/candidates/:id`, return the parsed fields too:

```js
const parsed = candidate.cv_parsed ? JSON.parse(candidate.cv_parsed) : null;
delete candidate.cv_text;                       // keep the payload small
res.json({ ok: true, candidate, education, experience, applications, cvParsed: parsed });
```

## 3. screening.js — use the shared extractor and fix the years bug

Replace `extractCvText` with a delegate:

```js
const ats = require('./ats');
const extractCvText = async (filePath) => (await ats.extractText(filePath)).text;
```

`estimateYearsOfExperience` has a bug (`ranges.index` is undefined on an array, so the start year is
never found). Replace the whole function with date ranges parsed from the Experience section; overlapping
jobs are merged, not double-counted:

```js
function estimateYearsOfExperience(cvText) {
  return require('./ats').parseCv(cvText).years;
}
```

## 4. masterlist.js — use cached text, add the ATS score

Add `'cv_text'` to `candFields`, then inside the loop:

```js
const ats = require('./ats');
...
const cvText = row.cv_text || await screening.extractCvText(cvAbsolute);
const match  = ats.scoreAgainstJob(cvText, `${job.title}\n${job.requirements || ''}`);
...
record.atsScore = match.score;
record.matchedKeywords = match.matched.join(', ');
record.missingKeywords = match.missing.join(', ');
```

Sort qualified candidates by `atsScore` as a tie-breaker:
`qualified.sort((a, b) => b.score - a.score || b.atsScore - a.atsScore);`

Add to `COLUMNS`:

```js
{ key: 'atsScore',        label: 'Keyword Match %' },
{ key: 'missingKeywords', label: 'Missing Keywords' },
```

## 5. signup.js — show parse warnings after upload

In `submitProfile`, after the success `setMessage(...)`:

```js
if (data.cvWarnings?.length) {
  setMessage(message, 'Profile saved. CV tips: ' + data.cvWarnings.join(' '), MSG_CLASS.SUCCESS);
}
```
and increase the redirect delay (2000 -> 6000 ms) when warnings exist.

## 6. admin.html / admin.js — search box

admin.html, above "Post a Job":

```html
<h2 style="margin-top:40px">CV Search</h2>
<div class="form-card active">
  <label>Boolean query</label>
  <input id="atsQuery" placeholder='"Python" AND ("SQL" OR "data analysis") NOT intern' />
  <button class="btn-primary" onclick="runAtsSearch()">Search CVs</button>
  <button class="btn-secondary" onclick="reindexCvs()">Re-parse all CVs</button>
  <div id="atsMsg" class="msg"></div>
  <div id="atsResults"></div>
</div>
```

admin.js:

```js
async function runAtsSearch() {
  const q = $('atsQuery').value.trim();
  setMsg('atsMsg', '');
  if (!q) { setMsg('atsMsg', 'Enter a query.'); return; }
  const data = await api('/api/admin/ats/search?q=' + encodeURIComponent(q));
  if (!data.ok) { setMsg('atsMsg', data.error || 'Search failed.'); return; }
  setMsg('atsMsg', `${data.count} match(es), best first.`, true);
  $('atsResults').innerHTML = data.results.map((r) => `
    <div class="master-row">
      <div class="master-row-head">
        <strong>${esc([r.first_name, r.last_name].filter(Boolean).join(' ') || r.email)}</strong>
        <span>${esc(r.email)}</span>
      </div>
      <small class="master-row-notes">${esc(r.snippet)} · relevance ${esc(r.relevance)}</small>
    </div>`).join('') || '<p class="empty">No matches.</p>';
}

async function reindexCvs() {
  if (!confirm('Re-parse every stored CV?')) return;
  const d = await post('/api/admin/ats/reindex');
  setMsg('atsMsg', d.ok ? `Indexed ${d.indexed} of ${d.total} CVs.` : (d.error || 'Failed.'), d.ok);
}
```

Run **Re-parse all CVs** once after deploying so existing candidates are indexed.

## How the three requirements map to the code

| Requirement | Where |
|---|---|
| Linear reading order | `extractText` reads in document order; `layoutWarnings` flags columns/tables/text boxes and tells the candidate |
| Clean text layer | `cleanText` (ligatures, soft hyphens, bullets, page furniture); DOCX/PDF/RTF/ODT/TXT supported |
| OCR | `ocrPdf` fallback when a PDF has under 100 characters of text (needs `tesseract.js` + pdf-parse v2) |
| Field categorisation | `splitSections` (header aliases) -> `parseExperience` / `parseEducation` / `parseSkills`, stored in `cv_parsed` |
| Searchable database | `cv_fts` FTS5 table, weighted columns (skills 3x, experience 2x, education 1.5x) |
| Boolean queries | `buildFtsQuery`: AND / OR / NOT, parentheses, quoted phrases |
| Scoring and ranking | FTS5 `bm25` for search; `scoreAgainstJob` for per-job 0-100 match |
| Acronyms and full terms | `SYNONYM_GROUPS`: indexed both ways and expanded in every query (`R&D` <-> `research and development`) |

## Notes
- Quote terms containing parentheses: `"CA(SA)"`.
- Extend `SYNONYM_GROUPS` with your own municipal acronyms.
- `getScreenshot` in pdf-parse v2 is used for OCR; check its return shape against your installed version.
- CV text is now stored in the database (`cv_text`). It contains personal information, so treat it under your POPIA obligations (retention, deletion on candidate removal is already covered by the `ON DELETE`/`removeFromIndex` step).
