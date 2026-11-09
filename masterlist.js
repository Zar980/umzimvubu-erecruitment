'use strict';

/* ==========================================================================
   masterlist.js — builds Qualified / Unqualified master lists for a job.
   Columns match the ULM master list layout, split into separate fields,
   with bullets and multi-line formatting preserved for Excel.
   ========================================================================== */

const path = require('path');
const screening = require('./screening');
const scoring = require('./scoring');

/* -------------------------------------------------------------------------- */
function tableColumns(db, table) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name); }
  catch { return []; }
}
function pick(db, table, wanted) {
  const cols = tableColumns(db, table);
  for (const name of wanted) if (cols.includes(name)) return name;
  return null;
}

/* --------------------------------------------------------------------------
   CV enrichment — extract structured data from the CV text
   -------------------------------------------------------------------------- */
function extractIdNumber(cvText) {
  const m = cvText.match(/\b\d{2}\s?\d{2}\s?\d{2}\s?\d{4}\s?\d{3}\b/);
  return m ? m[0].replace(/\s+/g, ' ') : '';
}

function extractLicence(cvText) {
  const m = cvText.match(/\bcode\s*(8|10|b|eb|c1|a|a1)\b/i);
  return m ? { has: true, code: m[1].toUpperCase() } : { has: false, code: '' };
}

function extractGender(cvText) {
  const m = cvText.match(/\b(?:gender\s*[:\-]?\s*)?(male|female)\b/i);
  return m ? m[1].replace(/^./, c => c.toUpperCase()) : '';
}

function extractPhone(cvText) {
  let m = cvText.match(/\+?\s*27[\s-]?\d{2}[\s-]?\d{3}[\s-]?\d{4}\b/);
  if (m) return m[0].replace(/\s+/g, ' ').trim();
  m = cvText.match(/\b0\d{2}[\s-]?\d{3}[\s-]?\d{4}\b/);
  if (m) return m[0].replace(/\s+/g, ' ').trim();
  return '';
}

function extractEmail(cvText) {
  const m = cvText.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
  return m ? m[0] : '';
}

function extractAddress(cvText) {
  const lines = String(cvText || '').split('\n').map(l => l.trim()).filter(Boolean);
  const addressRe = /\b\d{1,5}\s+[A-Za-z][A-Za-z\s]+(street|st\.|avenue|ave\.|road|rd\.|drive|lane|crescent|way|boulevard)\b/i;
  for (const line of lines) {
    if (line.length > 150) continue;
    if (addressRe.test(line)) return line.replace(/\s+/g, ' ');
  }
  for (const line of lines) {
    if (line.length > 150) continue;
    if (/\b\d{4}\b/.test(line) && /[A-Za-z]/.test(line)) return line.replace(/\s+/g, ' ');
  }
  return '';
}

function extractQualificationsFromCv(cvText) {
  const lines = String(cvText || '').split('\n').map(l => l.trim()).filter(Boolean);
  const formal = [];
  const other = [];

  const formalRe = /\b(grade\s*12|matric|national senior certificate|diploma|degree|bachelor|b\.?sc|b\.?com|b\.?tech|btech|national diploma|nqf\s*[4-9])\b/i;
  const otherRe  = /\b(certificate|certification|course|training|workshop|programme|program)\b/i;
  const negationRe = /\b(no|not|without|missing|lack|lacks|lacking)\b/i;

  for (const line of lines) {
    if (line.length > 140) continue;
    if (negationRe.test(line)) continue;
    const clean = line.replace(/^[•\-*▪◦·]\s*/, '').replace(/\s+/g, ' ').slice(0, 120);
    if (formalRe.test(line)) formal.push(clean);
    else if (otherRe.test(line)) other.push(clean);
  }

  return {
    formal: [...new Set(formal)],
    other:  [...new Set(other)]
  };
}

function extractExperienceFromCv(cvText) {
  const lines = String(cvText || '').split('\n').map(l => l.trim()).filter(Boolean);
  const jobs = [];
  let cur = null;

  for (const line of lines) {
    if (line.length > 220) continue;
    const isEmployer = /^employer\s*[:\-]/i.test(line);
    const isPosition = /^position\s*[:\-]/i.test(line);
    const isPeriod   = /^period\s*[:\-]/i.test(line);
    const isCurrent  = /present|current|to\s*date\b/i.test(line);

    if (isEmployer) {
      if (cur) jobs.push(cur);
      cur = {
        employer: line.replace(/^employer\s*[:\-]\s*/i, '').trim(),
        position: '',
        period: '',
        isCurrent: false
      };
    } else if (isPosition && cur) {
      cur.position = line.replace(/^position\s*[:\-]\s*/i, '').trim();
    } else if (isPeriod && cur) {
      cur.period = line.replace(/^period\s*[:\-]\s*/i, '').trim();
      if (isCurrent) cur.isCurrent = true;
    }
  }
  if (cur) jobs.push(cur);

  if (!jobs.length) {
    for (const line of lines) {
      if (line.length > 220) continue;
      if (!/\b(19|20)\d{2}\s*[-–]\s*(present|current|(19|20)\d{2})/i.test(line)) continue;
      if (/grade|diploma|certificate|clearance|medical|ward/i.test(line)) continue;
      jobs.push({
        employer: line.replace(/\s+/g, ' ').slice(0, 120),
        position: '',
        period: '',
        isCurrent: /present|current/i.test(line)
      });
    }
  }

  const previous = jobs.filter(j => !j.isCurrent);
  const current  = jobs.filter(j =>  j.isCurrent);

  const fmt = (j) => {
    const parts = [];
    if (j.employer) parts.push(`Employer: ${j.employer}`);
    if (j.position) parts.push(`Position: ${j.position}`);
    if (j.period)   parts.push(`Period: ${j.period}`);
    return parts.join('\n');
  };

  return {
    previous: previous.map(fmt).join('\n\n'),
    current:  current.map(fmt).join('\n\n')
  };
}

/* --------------------------------------------------------------------------
   ATS proof columns
   -------------------------------------------------------------------------- */
function findCvEvidence(cvText, check) {
  if (!cvText || !check || !check.keywords) return '';

  const lines = String(cvText).split('\n').map(l => l.trim()).filter(Boolean);
  const keywords = check.keywords.map(k => String(k).toLowerCase());
  const negationRe = /\b(no|not|without|missing|lack|lacks|lacking)\b/i;

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (!keywords.some(k => lower.includes(k))) continue;
    if (negationRe.test(line) && !check.inverted) continue;
    return line.replace(/\s+/g, ' ').slice(0, 180);
  }
  return '';
}

function buildApplicantResponse(cvText, documentsByType, allChecks) {
  const docTypes = documentsByType || {};
  const lines = [];

  for (const check of allChecks) {
    const label = check.label;
    let fromDoc = '';
    if (check.docType && docTypes[check.docType]) {
      fromDoc = `Attachment on file (${check.docType})`;
    }
    const evidence = findCvEvidence(cvText, check);

    if (fromDoc && !evidence) {
      lines.push(`${label}: ${fromDoc}`);
    } else if (evidence) {
      lines.push(`${label}: "${evidence}"${fromDoc ? ' + ' + fromDoc : ''}`);
    } else if (check.met) {
      lines.push(`${label}: Matched in CV`);
    } else {
      lines.push(`${label}: Not found`);
    }
  }

  return lines.join('\n');
}

/* --------------------------------------------------------------------------
   Formatting helpers
   -------------------------------------------------------------------------- */

function toBullets(list) {
  const arr = Array.isArray(list) ? list.filter(Boolean) : [];
  if (!arr.length) return 'Not Stated';
  return arr.map(s => `• ${s}`).join('\n');
}

function toExperienceBlock(jobs) {
  if (!jobs || !jobs.length) return 'Not Stated';
  return jobs.map(j => {
    const parts = [];
    if (j.employer) parts.push(`Employer: ${j.employer}`);
    if (j.position) parts.push(`Position: ${j.position}`);
    if (j.period)   parts.push(`Period: ${j.period}`);
    return parts.join('\n');
  }).join('\n\n');
}

/* --------------------------------------------------------------------------
   Build one master list
   -------------------------------------------------------------------------- */
async function buildMasterLists(db, jobId) {
  const job = db.prepare(
    'SELECT id, title, category, location, description, requirements, closing_date, is_open FROM jobs WHERE id = ?'
  ).get(jobId);

  if (!job) {
    const err = new Error('Job not found');
    err.code = 'JOB_NOT_FOUND';
    throw err;
  }

  const appCols = tableColumns(db, 'applications');
  const candCols = tableColumns(db, 'candidates');

  const colAppliedAt = pick(db, 'applications', ['applied_at', 'created_at', 'submitted_at', 'date_applied']);
  const colAppCvPath = appCols.includes('cv_path') ? 'cv_path' : null;
  const colCandCvPath = candCols.includes('cv_path') ? 'cv_path' : (candCols.includes('cv') ? 'cv' : null);

  const selectParts = [
    'a.id AS application_id',
    colAppliedAt ? `a.${colAppliedAt} AS applied_at` : 'NULL AS applied_at',
    colAppCvPath ? `a.${colAppCvPath} AS app_cv_path` : 'NULL AS app_cv_path',
    'c.id AS candidate_id'
  ];

  const candFields = [
    'first_name', 'middle_name', 'last_name', 'email',
    'phone_country_code', 'phone_number',
    'gender', 'disability_status', 'has_disability',
    'drivers_licence', 'drivers_licence_code',
    'receipt_number', 'education', 'experience',
    'street_number', 'complex_name', 'unit_number', 'street_name',
    'suburb', 'city', 'postal_code', 'country',
    'cv_text', 'cv_parsed'
  ];
  for (const f of candFields) {
    if (candCols.includes(f)) selectParts.push(`c.${f} AS ${f}`);
  }
  if (colCandCvPath) selectParts.push(`c.${colCandCvPath} AS cand_cv_path`);

  const orderBy = colAppliedAt ? `a.${colAppliedAt} ASC` : 'a.id ASC';

  const sql = `
    SELECT ${selectParts.join(', ')}
      FROM applications a
      JOIN candidates  c ON c.id = a.candidate_id
     WHERE a.job_id = ?
     ORDER BY ${orderBy}
  `;

  const rows = db.prepare(sql).all(jobId);
  const rules = screening.parseRequirements(job.requirements || job.description || '');
  const advertText = scoring.buildAdvertText(job);

  const parsedChecks = scoring.parseAdvert(advertText);
  const hardCount = parsedChecks.filter(c => c.type === 'hard').length;
  const softCount = parsedChecks.filter(c => c.type === 'soft').length;
  const advCount  = parsedChecks.filter(c => c.type === 'advantage').length;

  const originalListing = advertText.replace(/\s+/g, ' ').trim();

  const qualified = [];
  const unqualified = [];

  console.log(`[masterlist] screening ${rows.length} CV(s) for job #${job.id} (${job.title})…`);
  console.log(`[masterlist] advert parsed into ${parsedChecks.length} checks (${hardCount} hard, ${softCount} soft, ${advCount} advantage).`);

  const docStmt = db.prepare(`SELECT doc_type, text FROM candidate_documents WHERE candidate_id = ?`);

  for (const row of rows) {
    const cvRel = row.app_cv_path || row.cand_cv_path || null;
    const cvAbsolute = resolveCvPath(cvRel);

    let cvText = row.cv_text || '';
    if (!cvText) {
      try { cvText = await screening.extractCvText(cvAbsolute) || ''; }
      catch (e) { console.warn(`[masterlist] extract failed for ${row.email}:`, e.message); }
    }

    const documentsByType = {};
    try {
      const docs = docStmt.all(row.candidate_id);
      for (const d of docs) documentsByType[d.doc_type] = d.text || '';
    } catch (e) { /* ignore */ }
    const docTypes = Object.keys(documentsByType);

    // HYBRID EVALUATION
    const result = await screening.evaluateWithLlm(row, rules, cvText, job.title);

    let scoringResult = {
      score: 0, matched: [], missing: [],
      hard: { required: 0, met: 0, checks: [] },
      soft: { required: 0, met: 0, checks: [] },
      advantage: { required: 0, met: 0, checks: [] }
    };
    try {
      const parsed = row.cv_parsed ? JSON.parse(row.cv_parsed) : null;
      scoringResult = scoring.scoreCv(cvText, advertText, parsed, documentsByType);
    } catch (e) {
      console.warn(`[masterlist] scoring failed for ${row.email}:`, e.message);
    }

    const atsScore = scoringResult.score;
    const ruleQualified = result.qualified;
    const hardTotal = scoringResult.hard.required || 0;
    const hardMet   = scoringResult.hard.met || 0;
    const hardRatio = hardTotal ? hardMet / hardTotal : 1;
    const scoreOk = atsScore >= 40 || hardRatio >= 0.7;

    const finalQualified = result.source === 'hybrid-rules+gemini'
      ? result.qualified
      : (ruleQualified && scoreOk);

    const reasons = [...result.reasons];
    if (ruleQualified && !scoreOk) reasons.push(`ATS score too low: ${atsScore}% (hard met ${hardMet}/${hardTotal})`);
    if (!ruleQualified && scoreOk) reasons.push(`Rule-based check failed (ATS ${atsScore}% however)`);

    console.log(
      `[masterlist] ${row.first_name} ${row.last_name} → ${finalQualified ? 'QUALIFIED' : 'UNQUALIFIED'} ` +
      `(source: ${result.source || 'rules'}, ` +
      `hard: ${hardMet}/${hardTotal}, ats: ${atsScore}%, ` +
      `cv: ${cvText.length} chars, docs: [${docTypes.join(', ')}])`
    );

    const ref = screening.makeApplicationRef(job.id, row.application_id);

    const applicationNo = ref;
    const fullName = [row.first_name, row.middle_name, row.last_name]
      .filter(Boolean).join(' ').trim() || 'Not Stated';

    const dbGender = row.gender || '';
    const cvGender = extractGender(cvText);
    const genderBase = (dbGender || cvGender || '').trim();
    const raceMatch = cvText.match(/\b(African|Coloured|Indian|White)\b/i);
    const race = raceMatch ? raceMatch[1] : '';
    const genderCell = [genderBase, race].filter(Boolean).join('/') || 'Not Stated';

    const hasDisability = row.has_disability === 1 ||
      String(row.disability_status || '').toLowerCase().startsWith('y');
    const disabilityCell = hasDisability
      ? `Disability: ${row.disability_status || 'Yes'}`
      : 'Disability: No';

    const dbPhone = [row.phone_country_code, row.phone_number].filter(Boolean).join(' ').trim();
    const cvPhone = extractPhone(cvText);
    const cellCell = dbPhone || cvPhone || 'Not Stated';

    const dbAddress = [
      row.street_number,
      row.street_name,
      row.complex_name,
      row.unit_number,
      row.suburb,
      row.city,
      row.postal_code
    ].filter(Boolean).join(', ').trim();
    const cvAddress = extractAddress(cvText);
    const addressCell = dbAddress || cvAddress || 'Not Stated';

    const emailCell = row.email || extractEmail(cvText) || 'Not Stated';

    const dbLicence = normaliseLicence(row);
    const cvLicence = extractLicence(cvText);
    const licenceCell = (dbLicence && dbLicence !== 'No')
      ? dbLicence
      : (cvLicence.has ? `Yes (Code ${cvLicence.code})` : 'No');

    const cvQuals = extractQualificationsFromCv(cvText);
    const dbEducation = summariseEducationList(row.education);
    const formalQualifications = toBullets(
      dbEducation && dbEducation.length ? dbEducation : cvQuals.formal
    );

    const otherCertificates = toBullets(cvQuals.other);

    const dbPrev = summariseExperienceList(row.experience, false);
    const dbCurrent = summariseExperienceList(row.experience, true);
    const cvExperience = extractExperienceFromCv(cvText);

    const previousExperience = dbPrev && dbPrev.length
      ? toExperienceBlock(dbPrev)
      : (cvExperience.previous || 'Not Stated');

    const currentExperience = dbCurrent && dbCurrent.length
      ? toExperienceBlock(dbCurrent)
      : (cvExperience.current || 'Not Stated');

    const allChecks = [
      ...(scoringResult.hard?.checks || []),
      ...(scoringResult.soft?.checks || []),
      ...(scoringResult.advantage?.checks || [])
    ];

    const applicantResponse = buildApplicantResponse(cvText, documentsByType, allChecks);

    const record = {
      applicationNo,
      name: fullName,
      gender: genderCell,
      disability: disabilityCell,
      cellNumber: cellCell,
      address: addressCell,
      email: emailCell,
      drivingLicence: licenceCell,
      formalQualifications,
      otherCertificates,
      previousExperience,
      currentExperience,
      originalListing,
      applicantResponse,

      // Front-end display props
      applicationId: row.application_id,
      atsScore,
      atsChecks: allChecks,
      documents: docTypes,
      verdict: finalQualified ? 'Qualified' : 'Unqualified',
      reasons: reasons.join(' | '),
      source: result.source,
      aiReasons: result.aiDetails ? result.aiDetails.reasons : null // <--- ADDED THIS
    };

    if (finalQualified) qualified.push(record);
    else unqualified.push(record);
  }

  qualified.sort((a, b) => (b.atsScore || 0) - (a.atsScore || 0));
  unqualified.sort((a, b) => (b.atsScore || 0) - (a.atsScore || 0));

  return { job, rules, qualified, unqualified, total: rows.length };
}

/* --------------------------------------------------------------------------
   CSV export logic
   -------------------------------------------------------------------------- */
const COLUMNS = [
  { key: 'applicationNo',       label: 'Application No' },
  { key: 'name',                label: 'Name and Surname' },
  { key: 'gender',              label: 'Gender' },
  { key: 'disability',          label: 'Disability Status' },
  { key: 'cellNumber',          label: 'Cell Number' },
  { key: 'address',             label: 'Address' },
  { key: 'email',               label: 'Email' },
  { key: 'drivingLicence',      label: 'Driving Licence' },
  { key: 'formalQualifications',label: 'Formal Qualifications' },
  { key: 'otherCertificates',   label: 'Other Certificates and Qualifications' },
  { key: 'previousExperience',  label: 'Previous Experience' },
  { key: 'currentExperience',   label: 'Current Experience' },
  { key: 'originalListing',     label: 'Original Job Listing' },
  { key: 'applicantResponse',   label: 'Applicant Response (CV extract)' }
];

function toCsv(records, columns = COLUMNS) {
  const BOM = '\uFEFF';
  const head = columns.map(c => csvHeaderCell(c.label)).join(',');
  const body = records.map(rec => columns.map(c => csvCell(rec[c.key])).join(',')).join('\r\n');
  return `${BOM}${head}\r\n${body}\r\n`;
}

function csvHeaderCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function csvCell(value) {
  let s = String(value ?? '');
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  s = s.replace(/\n/g, '\r\n');
  return `"\r\n${s.replace(/"/g, '""')}"`;
}

/* --------------------------------------------------------------------------
   Small formatters
   -------------------------------------------------------------------------- */
function normaliseLicence(row) {
  if (!row.drivers_licence) return 'No';
  const code = row.drivers_licence_code ? ` (Code ${row.drivers_licence_code})` : '';
  return `Yes${code}`;
}

function summariseEducationList(educationJson) {
  const list = safeParse(educationJson);
  if (!list.length) return [];
  return list
    .map(e => [e.degree, e.major, e.school].filter(Boolean).join(', '))
    .filter(Boolean);
}

function summariseExperienceList(experienceJson, currentOnly) {
  const list = safeParse(experienceJson);
  if (!list.length) return [];
  const filtered = list.filter(e => currentOnly ? e.isCurrent === true : e.isCurrent !== true);
  return filtered.map(e => ({
    employer: e.employerName || '',
    position: e.jobTitle || '',
    period: [
      [e.startMonth, e.startYear].filter(Boolean).join(' '),
      e.isCurrent ? 'Present' : [e.endMonth, e.endYear].filter(Boolean).join(' ')
    ].filter(Boolean).join(' – ')
  }));
}

function safeParse(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  try { return JSON.parse(json) || []; } catch { return []; }
}

function resolveCvPath(p) {
  if (!p) return null;
  return path.isAbsolute(p) ? p : path.join(process.cwd(), 'uploads', path.basename(p));
}

module.exports = { buildMasterLists, toCsv, COLUMNS };