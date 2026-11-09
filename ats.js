'use strict';

/* ==========================================================================
   ats.js — ATS pipeline for CVs and typed attachments.
   ========================================================================== */

const fs = require('fs');
const path = require('path');

const UPLOAD_DIR = path.join(__dirname, 'uploads');

/* --------------------------------------------------------------------------
   Optional parser loading
   -------------------------------------------------------------------------- */
let pdfParse = null, PDFParseV2 = null, mammoth = null, Tesseract = null, AdmZip = null;

try {
  const mod = require('pdf-parse');
  if (typeof mod === 'function') pdfParse = mod;
  else if (typeof mod?.default === 'function') pdfParse = mod.default;
  else if (typeof mod?.PDFParse === 'function') PDFParseV2 = mod.PDFParse;
  else if (typeof mod?.default?.PDFParse === 'function') PDFParseV2 = mod.default.PDFParse;
} catch (e) { console.warn('[ats] pdf-parse not loaded:', e.message); }
try { mammoth = require('mammoth'); } catch (e) { console.warn('[ats] mammoth not loaded:', e.message); }
try { Tesseract = require('tesseract.js'); } catch { /* optional */ }
try { AdmZip = require('adm-zip'); } catch { /* optional */ }

/* --------------------------------------------------------------------------
   Text extraction
   -------------------------------------------------------------------------- */
function cleanText(raw) {
  return String(raw || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u200B-\u200D\uFEFF\u00AD]/g, '')
    .replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl').replace(/ﬀ/g, 'ff')
    .replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
    .replace(/[\u2022\u25AA\u25CF\u25E6\u2023\u2043\uF0B7\uF0A7]/g, '•')
    .replace(/(\w)-\n([a-z])/g, '$1$2')
    .replace(/^\s*(page\s+\d+(\s+of\s+\d+)?|\d+\s*\/\s*\d+)\s*$/gim, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function layoutWarnings(rawText) {
  const warnings = [];
  const lines = String(rawText || '').split('\n').filter((l) => l.trim());
  if (!lines.length) return warnings;

  const spaced = lines.filter((l) => /\S( {3,}|\t)\S/.test(l)).length;
  if (spaced / lines.length > 0.25) {
    warnings.push('This file appears to use columns, tables or text boxes. Use a single-column layout so every system reads it in the right order.');
  }
  const short = lines.filter((l) => l.trim().length < 12).length;
  if (lines.length > 30 && short / lines.length > 0.5) {
    warnings.push('This file is heavily fragmented, which usually means a design-tool layout.');
  }
  return warnings;
}

async function ocrPdf(buffer) {
  if (!Tesseract || !PDFParseV2) return '';
  const parser = new PDFParseV2({ data: buffer });
  try {
    const shots = await parser.getScreenshot({ scale: 2 });
    let out = '';
    for (const p of (shots?.pages || []).slice(0, 6)) {
      if (!p?.data) continue;
      const { data } = await Tesseract.recognize(Buffer.from(p.data), 'eng');
      out += data.text + '\n';
    }
    return out;
  } catch (e) {
    console.warn('[ats] OCR failed:', e.message);
    return '';
  } finally {
    try { await parser.destroy?.(); } catch { /* ignore */ }
  }
}

function stripRtf(rtf) {
  return rtf
    .replace(/\\par[d]?/g, '\n').replace(/\\tab/g, ' ')
    .replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\{\\\*[^{}]*\}/g, '')
    .replace(/\\[a-z]+-?\d* ?/gi, '')
    .replace(/[{}]/g, '');
}

async function extractText(filePath) {
  const result = { text: '', method: 'none', warnings: [] };
  if (!filePath || !fs.existsSync(filePath)) { result.warnings.push('File not found.'); return result; }

  const ext = path.extname(filePath).toLowerCase();
  let raw = '';

  try {
    if (ext === '.pdf') {
      const buffer = fs.readFileSync(filePath);
      result.method = 'pdf-text';

      if (PDFParseV2) {
        const parser = new PDFParseV2({ data: buffer });
        try {
          const r = await parser.getText();
          raw = r?.text ?? r?.pages?.map((p) => p.text).join('\n') ?? '';
        } finally { try { await parser.destroy?.(); } catch { /* ignore */ } }
      } else if (pdfParse) {
        raw = (await pdfParse(buffer))?.text || '';
      } else {
        result.warnings.push('No PDF parser installed.');
      }

      if (raw.replace(/\s/g, '').length < 100) {
        const ocr = await ocrPdf(buffer);
        if (ocr.replace(/\s/g, '').length > raw.replace(/\s/g, '').length) {
          raw = ocr; result.method = 'ocr';
          result.warnings.push('Image-based PDF: OCR was used. Accuracy may be lower.');
        } else {
          result.warnings.push('PDF contains no readable text (looks scanned). Upload a text PDF or Word document.');
        }
      }
    } else if (ext === '.docx' || ext === '.docm' || ext === '.dotx' || ext === '.doc' || ext === '.dot') {
      result.method = 'docx';
      if (!mammoth) result.warnings.push('No DOCX parser installed.');
      else raw = (await mammoth.extractRawText({ path: filePath }))?.value || '';
      if (!raw && (ext === '.doc' || ext === '.dot')) {
        result.warnings.push('Legacy .doc files cannot be read reliably. Save as .docx or PDF.');
      }
    } else if (ext === '.rtf') {
      result.method = 'rtf';
      raw = stripRtf(fs.readFileSync(filePath, 'latin1'));
    } else if (ext === '.odt') {
      result.method = 'odt';
      if (!AdmZip) result.warnings.push('ODT support needs "npm i adm-zip".');
      else {
        const xml = new AdmZip(filePath).readAsText('content.xml');
        raw = xml.replace(/<\/text:(p|h)>/g, '\n').replace(/<text:tab\/>/g, ' ').replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      }
    } else if (ext === '.txt') {
      result.method = 'txt';
      raw = fs.readFileSync(filePath, 'utf8');
    }
  } catch (err) {
    console.error(`[ats] extract failed for ${filePath}:`, err.message);
    result.warnings.push('Could not read this file. It may be corrupt or password-protected.');
  }

  result.warnings.push(...layoutWarnings(raw));
  result.text = cleanText(raw);
  return result;
}

/* --------------------------------------------------------------------------
   Section parsing
   -------------------------------------------------------------------------- */
const HEADER_ALIASES = {
  summary: ['summary', 'profile', 'professional summary', 'personal statement', 'objective', 'career objective', 'about me'],
  experience: ['experience', 'work experience', 'employment history', 'work history', 'professional experience', 'career history', 'employment', 'relevant experience'],
  education: ['education', 'education and training', 'academic qualifications', 'qualifications', 'academic background', 'formal qualifications', 'educational background'],
  skills: ['skills', 'key skills', 'technical skills', 'core competencies', 'competencies', 'computer skills', 'skills and competencies'],
  certifications: ['certifications', 'certificates', 'licences', 'licenses', 'courses', 'training', 'other certificates', 'other qualifications'],
  languages: ['languages', 'language proficiency'],
  references: ['references', 'referees'],
  personal: ['personal details', 'personal information', 'personal particulars', 'personal data']
};

const HEADER_LOOKUP = new Map();
for (const [section, names] of Object.entries(HEADER_ALIASES)) {
  names.forEach((n) => HEADER_LOOKUP.set(n, section));
}

function headerSection(line) {
  const t = line.trim();
  if (!t || t.length > 40) return null;
  const clean = t.toLowerCase().replace(/&/g, 'and').replace(/[:\-–—_•*#|]+/g, ' ').replace(/\s+/g, ' ').trim();
  return HEADER_LOOKUP.get(clean) || null;
}

function splitSections(text) {
  const sections = { contact: [] };
  let current = 'contact';
  for (const line of text.split('\n')) {
    const sec = headerSection(line);
    if (sec) { current = sec; sections[current] = sections[current] || []; continue; }
    (sections[current] = sections[current] || []).push(line);
  }
  return sections;
}

const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const MONTH_IDX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const DATE_RANGE = new RegExp(
  `(?:(${MONTHS})[a-z]*\\.?,?\\s+|\\d{1,2}[/.]\\s*)?((?:19|20)\\d{2})\\s*(?:-|–|—|to|until|till)\\s*` +
  `(?:(?:(${MONTHS})[a-z]*\\.?,?\\s+|\\d{1,2}[/.]\\s*)?((?:19|20)\\d{2})|(present|current|date|now|ongoing))`, 'i');

const monthFrac = (m) => (m ? (MONTH_IDX[m.slice(0, 3).toLowerCase()] ?? 0) / 12 : 0);
const nowFrac = () => { const d = new Date(); return d.getFullYear() + d.getMonth() / 12; };
const BULLET = /^[•\-*▪◦·]\s*/;

function parseExperience(lines) {
  const entries = [];
  let cur = null;
  let pending = '';

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const isBullet = BULLET.test(line);
    const m = !isBullet && line.match(DATE_RANGE);

    if (m) {
      const remainder = line.replace(m[0], '').replace(/^[\s|,(–—-]+|[\s|,)–—-]+$/g, '').trim();
      const isCurrent = Boolean(m[5]);
      cur = {
        title: remainder || pending, employer: '', dates: m[0].trim(),
        start: Number(m[2]) + monthFrac(m[1]),
        end: isCurrent ? nowFrac() : Number(m[4]) + monthFrac(m[3]),
        isCurrent, details: []
      };
      entries.push(cur);
      pending = '';
    } else if (cur && (isBullet || line.length > 80)) {
      cur.details.push(line.replace(BULLET, ''));
    } else if (cur && !cur.details.length && !cur.employer) {
      cur.employer = line;
    } else {
      pending = line;
    }
  }
  return entries.filter((e) => e.end >= e.start && e.end - e.start <= 45);
}

function yearsFromEntries(entries) {
  const spans = entries.map((e) => [e.start, e.end]).sort((a, b) => a[0] - b[0]);
  let total = 0, curS = null, curE = null;
  for (const [s, e] of spans) {
    if (curS === null) { curS = s; curE = e; }
    else if (s <= curE) curE = Math.max(curE, e);
    else { total += curE - curS; curS = s; curE = e; }
  }
  if (curS !== null) total += curE - curS;
  return Math.round(total * 10) / 10;
}

const EDU_RE = /\b(diploma|degree|bachelor|b\.?\s?sc|b\.?\s?com|b\.?\s?tech|master|m\.?\s?sc|honou?rs|phd|certificate|grade\s*12|matric|national senior certificate|nqf\s*\d+)\b/i;

function parseEducation(lines) {
  return lines.map((l) => l.trim()).filter((l) => l && EDU_RE.test(l)).map((l) => ({
    text: l.replace(BULLET, ''),
    year: (l.match(/\b(?:19|20)\d{2}\b/g) || []).pop() || ''
  }));
}

function parseSkills(lines) {
  const out = new Set();
  for (const l of lines) {
    l.split(/[,;|•·]|\s{2,}/).map((s) => s.replace(BULLET, '').trim())
      .filter((s) => s.length >= 2 && s.length <= 40).forEach((s) => out.add(s));
  }
  return [...out];
}

function parseCv(text, extraWarnings = []) {
  const sections = splitSections(text);
  const allLines = text.split('\n');

  const expLines = sections.experience?.length ? sections.experience : allLines;
  const experience = parseExperience(expLines);
  const education = parseEducation(sections.education?.length ? sections.education : allLines);
  const skills = parseSkills(sections.skills || []);
  const certifications = (sections.certifications || []).map((l) => l.trim().replace(BULLET, '')).filter(Boolean);

  const warnings = [...extraWarnings];
  let quality = 100;
  if (text.length < 200) { quality -= 50; warnings.push('Very little text could be extracted.'); }
  if (warnings.some((w) => /columns|fragmented/.test(w))) quality -= 20;
  if (!sections.experience?.length) { quality -= 20; warnings.push('No "Experience" heading found.'); }
  if (!sections.education?.length) { quality -= 15; warnings.push('No "Education" heading found.'); }
  if (!sections.skills?.length) { quality -= 10; warnings.push('No "Skills" heading found.'); }

  return {
    sections: {
      summary: (sections.summary || []).join(' ').slice(0, 600),
      headersFound: Object.keys(sections).filter((k) => k !== 'contact' && sections[k].length)
    },
    experience, education, skills, certifications,
    years: yearsFromEntries(experience),
    quality: Math.max(0, quality),
    warnings
  };
}

/* --------------------------------------------------------------------------
   Keyword index
   -------------------------------------------------------------------------- */
const SYNONYM_GROUPS = [
  ['R&D', 'research and development'],
  ['HR', 'human resources'],
  ['SCM', 'supply chain management'],
  ['ICT', 'information and communication technology'],
  ['MFMA', 'municipal finance management act'],
  ['IDP', 'integrated development plan'],
  ['SDBIP', 'service delivery and budget implementation plan'],
  ['EPWP', 'expanded public works programme'],
  ['CPMD', 'certificate programme in management development'],
  ['GIS', 'geographic information system'],
  ['ECSA', 'engineering council of south africa'],
  ['OHS', 'occupational health and safety'],
  ['WSP', 'workplace skills plan'],
  ['PMP', 'project management professional'],
  ['BSc', 'bachelor of science'],
  ['BCom', 'bachelor of commerce'],
  ['BTech', 'bachelor of technology'],
  ['CA(SA)', 'chartered accountant'],
  ['ND', 'national diploma']
];

const normTerm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const GROUPS = SYNONYM_GROUPS.map((g) => g.map(normTerm));
const SYN_MAP = new Map();
GROUPS.forEach((g) => g.forEach((v) => SYN_MAP.set(v, g)));

function expandTerm(term) {
  const n = normTerm(term);
  if (!n) return [];
  return SYN_MAP.get(n) ? [...SYN_MAP.get(n)] : [n];
}

function withSynonyms(text) {
  const hay = ` ${normTerm(text)} `;
  const extra = [];
  for (const g of GROUPS) {
    if (g.some((v) => hay.includes(` ${v} `))) extra.push(...g);
  }
  return extra.length ? `${text}\n${extra.join(' ')}` : String(text || '');
}

/* --------------------------------------------------------------------------
   Schema
   -------------------------------------------------------------------------- */
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(candidates)').all().map((c) => c.name);
  const add = (name, ddl) => { if (!cols.includes(name)) db.exec(`ALTER TABLE candidates ADD COLUMN ${ddl}`); };
  add('cv_text', 'cv_text TEXT');
  add('cv_parsed', 'cv_parsed TEXT');
  add('cv_quality', 'cv_quality INTEGER');
  add('cv_warnings', 'cv_warnings TEXT');
  add('cv_parse_method', 'cv_parse_method TEXT');
  add('cv_parsed_at', 'cv_parsed_at INTEGER');

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS cv_fts USING fts5(
      content, skills, experience, education,
      candidate_id UNINDEXED,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);
}

/* --------------------------------------------------------------------------
   Index + process
   -------------------------------------------------------------------------- */
function indexCandidate(db, candidateId, fullText, parsed) {
  const skills = (parsed?.skills || []).join(' ; ');
  const exp = (parsed?.experience || []).map((e) => [e.title, e.employer, ...e.details].join(' ')).join('\n');
  const edu = (parsed?.education || []).map((e) => e.text).join('\n');

  db.transaction(() => {
    db.prepare('DELETE FROM cv_fts WHERE candidate_id = ?').run(candidateId);
    db.prepare('INSERT INTO cv_fts (content, skills, experience, education, candidate_id) VALUES (?,?,?,?,?)')
      .run(withSynonyms(fullText), withSynonyms(skills), withSynonyms(exp), withSynonyms(edu), candidateId);
  })();
}

function removeFromIndex(db, ids) {
  const del = db.prepare('DELETE FROM cv_fts WHERE candidate_id = ?');
  db.transaction(() => ids.forEach((id) => del.run(id)))();
}

/** Process the CV: extract text, parse sections, store on candidates, index. */
async function processCandidateCv(db, candidateId) {
  const cand = db.prepare('SELECT id, cv_path FROM candidates WHERE id = ?').get(candidateId);
  if (!cand?.cv_path) return { quality: 0, warnings: ['No CV on file.'] };

  const ext = await extractText(path.join(UPLOAD_DIR, path.basename(cand.cv_path)));
  const parsed = parseCv(ext.text, ext.warnings);

  db.prepare(`
    UPDATE candidates
       SET cv_text = ?, cv_parsed = ?, cv_quality = ?, cv_warnings = ?, cv_parse_method = ?,
           cv_parsed_at = strftime('%s','now')
     WHERE id = ?
  `).run(ext.text, JSON.stringify(parsed), parsed.quality, JSON.stringify(parsed.warnings), ext.method, cand.id);

  indexCandidate(db, cand.id, ext.text, parsed);
  return { quality: parsed.quality, warnings: parsed.warnings, method: ext.method };
}

/** Process one attachment row. */
async function processDocument(db, docId) {
  const doc = db.prepare('SELECT id, candidate_id, filename, doc_type FROM candidate_documents WHERE id = ?').get(docId);
  if (!doc) return { ok: false, error: 'Document not found' };

  const ext = await extractText(path.join(UPLOAD_DIR, path.basename(doc.filename)));
  const parsed = parseCv(ext.text, ext.warnings);

  db.prepare(`
    UPDATE candidate_documents SET text = ?, parsed = ?, indexed_at = strftime('%s','now')
     WHERE id = ?
  `).run(ext.text, JSON.stringify(parsed), doc.id);

  return { ok: true, candidateId: doc.candidate_id, docType: doc.doc_type, method: ext.method, chars: ext.text.length };
}

/** Process the CV + every attachment for a candidate. */
async function processCandidateWithDocuments(db, candidateId) {
  const cvResult = await processCandidateCv(db, candidateId);

  const docs = db.prepare('SELECT id FROM candidate_documents WHERE candidate_id = ?').all(candidateId);
  const docResults = [];
  for (const d of docs) {
    try { docResults.push(await processDocument(db, d.id)); }
    catch (e) { console.warn(`[ats] doc ${d.id} failed:`, e.message); }
  }

  return { cv: cvResult, documents: docResults, totalDocuments: docs.length };
}

async function reindexAll(db) {
  const ids = db.prepare('SELECT id FROM candidates WHERE cv_path IS NOT NULL').all();
  let ok = 0;
  for (const { id } of ids) {
    try { await processCandidateWithDocuments(db, id); ok++; }
    catch (e) { console.error('[ats] reindex', id, e.message); }
  }
  return { total: ids.length, indexed: ok };
}

/* --------------------------------------------------------------------------
   Boolean query → FTS5
   -------------------------------------------------------------------------- */
function badQuery(msg) { const e = new Error(msg); e.code = 'BAD_QUERY'; return e; }

function tokenizeQuery(q) {
  const out = [];
  const re = /"([^"]+)"|(\()|(\))|([^\s()"]+)/g;
  let m;
  while ((m = re.exec(q))) {
    if (m[1] !== undefined) out.push({ t: 'term', v: m[1] });
    else if (m[2]) out.push({ t: '(' });
    else if (m[3]) out.push({ t: ')' });
    else {
      const up = m[4].toUpperCase();
      out.push(['AND', 'OR', 'NOT'].includes(up) ? { t: up } : { t: 'term', v: m[4] });
    }
  }
  return out;
}

function buildFtsQuery(q) {
  const toks = tokenizeQuery(String(q || ''));
  if (!toks.length) throw badQuery('Enter a search query.');
  let i = 0;
  const peek = () => toks[i]?.t;

  const atom = () => {
    const tok = toks[i++];
    if (!tok) throw badQuery('Unexpected end of query.');
    if (tok.t === '(') {
      const e = parseOr();
      if (toks[i++]?.t !== ')') throw badQuery('Missing closing parenthesis.');
      return e;
    }
    if (tok.t === 'term') {
      const v = expandTerm(tok.v).map((x) => `"${x}"`);
      if (!v.length) throw badQuery(`Cannot search for "${tok.v}".`);
      return v.length > 1 ? `(${v.join(' OR ')})` : v[0];
    }
    throw badQuery(`Unexpected "${tok.t}".`);
  };

  const parseAnd = () => {
    const pos = [], neg = [];
    while (i < toks.length && peek() !== ')' && peek() !== 'OR') {
      if (peek() === 'AND') { i++; continue; }
      if (peek() === 'NOT') { i++; neg.push(atom()); continue; }
      pos.push(atom());
    }
    if (!pos.length) throw badQuery('A query needs at least one positive term.');
    let s = pos.join(' AND ');
    if (neg.length) s = `(${s}) NOT (${neg.join(' OR ')})`;
    return pos.length > 1 || neg.length ? `(${s})` : s;
  };

  function parseOr() {
    const parts = [parseAnd()];
    while (peek() === 'OR') { i++; parts.push(parseAnd()); }
    return parts.length > 1 ? `(${parts.join(' OR ')})` : parts[0];
  }

  const out = parseOr();
  if (i < toks.length) throw badQuery('Unbalanced parentheses.');
  return out;
}

function search(db, { q, jobId = null, limit = 50 }) {
  const fts = buildFtsQuery(q);
  const params = [fts];
  let jobFilter = '';
  if (jobId) {
    jobFilter = 'AND candidate_id IN (SELECT candidate_id FROM applications WHERE job_id = ?)';
    params.push(Number(jobId));
  }
  params.push(Math.min(Number(limit) || 50, 200));

  const hits = db.prepare(`
    SELECT candidate_id, bm25(cv_fts, 1.0, 3.0, 2.0, 1.5) AS rank,
           snippet(cv_fts, 0, '[', ']', '…', 14) AS snippet
      FROM cv_fts
     WHERE cv_fts MATCH ? ${jobFilter}
     ORDER BY rank
     LIMIT ?
  `).all(...params);

  const get = db.prepare(`
    SELECT id, first_name, last_name, email, city, cv_quality
      FROM candidates WHERE id = ?
  `);

  return hits.map((h) => ({ ...get.get(h.candidate_id), relevance: Math.round(-h.rank * 100) / 100, snippet: h.snippet }));
}

/* --------------------------------------------------------------------------
   Job matching score (kept for compatibility)
   -------------------------------------------------------------------------- */
const STOP = new Set(('the and for with from that this have has are was were will shall must may can able ' +
  'minimum least year years experience required requirement requirements applicant applicants candidate candidates ' +
  'preferred advantage added advantageous desirable recommended relevant related field good sound valid ' +
  'knowledge understanding ability skills skill working work including such other any all each per not but ' +
  'plus into out our their they who which where when also than then well').split(' '));

function extractJobKeywords(jobText) {
  const map = new Map();
  const bump = (kw, w) => {
    const e = map.get(kw) || { w: 0, n: 0 };
    e.w = Math.max(e.w, w); e.n += 1; map.set(kw, e);
  };

  for (const sentence of String(jobText || '').split(/[.;\n]/)) {
    const w = /advantag|prefer|desirab|recommend/i.test(sentence) ? 0.5 : 1;
    const words = normTerm(sentence).split(' ');
    const ok = (x) => x && x.length >= 3 && !STOP.has(x) && !/^\d/.test(x);
    words.forEach((x, idx) => {
      if (!ok(x)) return;
      bump(x, w);
      if (ok(words[idx + 1])) bump(`${x} ${words[idx + 1]}`, w);
    });
  }

  const all = [...map.entries()].map(([kw, v]) => ({ kw, ...v }));
  const inBigram = new Set(all.filter((k) => k.kw.includes(' ')).flatMap((k) => k.kw.split(' ')));
  return all
    .filter((k) => k.kw.includes(' ') || !inBigram.has(k.kw))
    .sort((a, b) => b.w - a.w || b.n - a.n || b.kw.length - a.kw.length)
    .slice(0, 30);
}

function scoreAgainstJob(cvText, jobText, parsed = null) {
  const p = parsed || parseCv(cvText);
  const kws = extractJobKeywords(jobText);
  if (!kws.length || !cvText) return { score: 0, matched: [], missing: [], keywords: kws.length };

  const strongRaw = [p.skills.join(' '), ...p.experience.map((e) => [e.title, e.employer, ...e.details].join(' '))].join(' ');
  const strong = ` ${normTerm(withSynonyms(strongRaw))} `;
  const full = ` ${normTerm(withSynonyms(cvText))} `;
  const has = (hay, variants) => variants.some((v) => hay.includes(` ${v} `));

  let got = 0, max = 0;
  const matched = [], missing = [];
  for (const { kw, w } of kws) {
    const variants = expandTerm(kw);
    max += w;
    if (has(strong, variants)) { got += w; matched.push(kw); }
    else if (has(full, variants)) { got += w * 0.6; matched.push(kw); }
    else missing.push(kw);
  }
  return { score: Math.round((got / max) * 100), matched, missing, keywords: kws.length };
}

/* --------------------------------------------------------------------------
   Exports
   -------------------------------------------------------------------------- */
module.exports = {
  extractText, cleanText, parseCv, yearsFromEntries,
  migrate, indexCandidate, removeFromIndex, processCandidateCv,
  processDocument, processCandidateWithDocuments, reindexAll,
  buildFtsQuery, search, expandTerm, withSynonyms,
  extractJobKeywords, scoreAgainstJob
};