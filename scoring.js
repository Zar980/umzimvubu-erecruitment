'use strict';

/* ==========================================================================
   scoring.js — granular, per-requirement CV scoring for any municipal post.
   ========================================================================== */

const ats = require('./ats');

/* --------------------------------------------------------------------------
   Build the full advert text from any job row.
   -------------------------------------------------------------------------- */
function buildAdvertText(job) {
  if (!job) return '';
  const parts = [
    job.title,
    job.category,
    job.location,
    job.description,
    job.requirements,
    job.closing_date
  ];
  return parts.filter(Boolean).map((s) => String(s).trim()).join('\n');
}

/* --------------------------------------------------------------------------
   Synonym groups
   -------------------------------------------------------------------------- */
const EXTRA_SYNONYMS = [
  ['MFMA', 'municipal finance management act'],
  ['GRAP', 'generally recognised accounting practice', 'generally recognized accounting practice'],
  ['National Treasury Regulations', 'treasury regulations', 'nt regulations'],
  ['CPMD', 'certificate programme in management development'],
  ['Munsoft', 'munsoft financial system', 'munsoft system'],
  ['SCM', 'supply chain management'],
  ['IDP', 'integrated development plan'],
  ['SDBIP', 'service delivery and budget implementation plan'],
  ['MSCOA', 'municipal standard chart of accounts'],
  ['EPWP', 'expanded public works programme'],
  ['OHS', 'occupational health and safety'],
  ['GIS', 'geographic information system'],
  ['PMP', 'project management professional'],
  ['ECSA', 'engineering council of south africa'],
  ['CA(SA)', 'chartered accountant'],
  ['BCom', 'bachelor of commerce'],
  ['BTech', 'bachelor of technology'],
  ['ND', 'national diploma'],
  ['Purchasing', 'procurement', 'buying'],
  ['Finance', 'financial management', 'financial administration']
];

const SYN_MAP = new Map();
EXTRA_SYNONYMS.forEach((group) => {
  const norm = group.map((t) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
  norm.forEach((t) => SYN_MAP.set(t, norm));
});

function normTerm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function variants(term) {
  const n = normTerm(term);
  if (!n) return [];
  return SYN_MAP.get(n) ? [...new Set(SYN_MAP.get(n))] : [n];
}

/* --------------------------------------------------------------------------
   Document-type mapping
   -------------------------------------------------------------------------- */
const DOCUMENT_MATCH_MAP = {
  id_copy:           ['certified id copy', 'id copy', 'id document', 'identity document'],
  proof_of_residence:['proof from ward councillor', 'ward councillor', 'proof of residence', 'ward proof'],
  grade_12:          ['grade 12', 'matric', 'senior certificate', 'national senior certificate'],
  diploma:           ['traffic diploma', 'national diploma', 'bachelor', 'degree', 'btech', 'diploma'],
  saps:              ['saps', 'saps clearance', 'clearance certificate', 'criminal record', 'police clearance'],
  medical:           ['medical', 'medical report', 'medical certificate', 'medical fitness', 'fit for duty', 'fit for physical'],
  drivers_licence:   ['driver s licence', 'drivers licence', 'driver licence', 'driving licence', 'driving license', 'code b', 'code eb', 'code c1', 'valid driver'],
  qualification:     ['traffic diploma', 'national diploma', 'bachelor', 'degree', 'btech', 'diploma']
};

function matchingDocTypes(label) {
  const n = normTerm(label);
  const hits = [];
  for (const [type, keywords] of Object.entries(DOCUMENT_MATCH_MAP)) {
    if (keywords.some((kw) => n.includes(normTerm(kw)))) hits.push(type);
  }
  return hits;
}

/* --------------------------------------------------------------------------
   Advert parser
   -------------------------------------------------------------------------- */
function parseAdvert(jobText) {
  const text = String(jobText || '');
  const lower = text.toLowerCase();

  const checks = [];

  /* 1. Grade 12 */
  if (/\bgrade\s*12\b|\bmatric\b|\bsenior certificate\b|\bnational senior certificate\b/.test(lower)) {
    checks.push({
      label: 'Grade 12 / Matric',
      type: 'hard',
      weight: 15,
      keywords: ['grade 12', 'matric', 'senior certificate', 'national senior certificate'],
      docType: 'grade_12'
    });
  }

  /* 2. Named qualification */
  const qualPatterns = [
    [/traffic\s+diploma/i, 'Traffic Diploma'],
    [/national\s+diploma\s+in\s+([A-Za-z][A-Za-z\s,&/()\-]{2,60})/i, null],
    [/bachelor'?s?\s+degree\s+in\s+([A-Za-z][A-Za-z\s,&/()\-]{2,60})/i, null],
    [/b\.?sc\s+([A-Za-z][A-Za-z\s,&/()\-]{2,60})/i, null],
    [/b\.?com\s+([A-Za-z][A-Za-z\s,&/()\-]{2,60})/i, null],
    [/b\.?tech\s+([A-Za-z][A-Za-z\s,&/()\-]{2,60})/i, null],
    [/degree\s+in\s+([A-Za-z][A-Za-z\s,&/()\-]{2,60})/i, null]
  ];
  for (const [re, fixed] of qualPatterns) {
    const m = text.match(re);
    if (!m) continue;
    const phrase = fixed || m[0].trim();
    checks.push({
      label: phrase,
      type: 'hard',
      weight: 20,
      keywords: [phrase.toLowerCase(), ...variants(phrase)],
      acceptEquivalent: /or equivalent/i.test(lower),
      docType: 'diploma'
    });
    break;
  }
  if (!checks.some((c) => c.type === 'hard' && c.label !== 'Grade 12 / Matric')) {
    if (/\bdegree\b|\bdiploma\b|\bbachelor\b|\bbtech\b|\bnational diploma\b/.test(lower)) {
      checks.push({
        label: 'Relevant degree / diploma',
        type: 'hard',
        weight: 20,
        keywords: ['degree', 'diploma', 'bachelor', 'btech', 'b tech', 'national diploma', 'nqf 6', 'nqf 7'],
        docType: 'diploma'
      });
    }
  }

  /* 3. Years of experience */
  const yearsMatch =
    lower.match(/(?:minimum\s+of|at\s+least)\s+(\w+)\s*\(?\s*(\d{1,2})\s*\)?\s*years?/i) ||
    lower.match(/(\d{1,2})\s*\+?\s*years?.*?experience/i);
  if (yearsMatch) {
    const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    let n = 0;
    for (let i = yearsMatch.length - 1; i >= 1; i--) {
      const tok = yearsMatch[i];
      if (!tok) continue;
      if (/^\d+$/.test(tok)) { n = Number(tok); break; }
      if (words[tok.toLowerCase()]) { n = words[tok.toLowerCase()]; break; }
    }
    if (n > 0) {
      checks.push({
        label: `Minimum ${n} year(s) relevant experience`,
        type: 'hard',
        weight: 15,
        minYears: n
      });
    }
  }

  /* 4. Driver's licence */
  if (/\bdriver'?s?\s*licen[cs]e\b|\bdriving\s+licen[cs]e\b|\bvalid\s+driver\b|\bcode\s*(8|10|eb|b)\b/.test(lower)) {
    checks.push({
      label: "Valid Driver's Licence",
      type: 'hard',
      weight: 15,
      keywords: [
        'driver s licence', 'drivers licence', 'driver licence',
        'driving licence', 'driving license',
        'code b', 'code eb', 'code c1', 'valid driver'
      ],
      docType: 'drivers_licence'
    });
  }

  /* 4b. Certified ID copy */
  if (/\bcertified\s+id\s+copy\b|\bcertified\s+copy\s+of\s+id\b|\bid\s+(?:copy|document)\b/i.test(text)) {
    checks.push({
      label: 'Certified ID copy',
      type: 'hard',
      weight: 5,
      keywords: ['certified id', 'id copy', 'id document', 'identity document'],
      docType: 'id_copy'
    });
  }

  /* 4c. SAPS clearance */
  if (/\bsaps\b|criminal\s+record|clearance\s+certificate|police\s+clearance|no\s+criminal\s+record/i.test(text)) {
    checks.push({
      label: 'Certificate of no criminal record (SAPS clearance)',
      type: 'hard',
      weight: 10,
      keywords: ['saps', 'saps clearance', 'clearance certificate', 'criminal record', 'police clearance'],
      docType: 'saps',
      inverted: true
    });
  }

  /* 4d. Medical / fitness */
  if (/\bmedical\s+(?:report|fitness|certificate)\b|\bfit(?:ness)?\s+for\s+(?:duty|physical)/i.test(text)) {
    checks.push({
      label: 'Recent medical report certificate',
      type: 'hard',
      weight: 10,
      keywords: ['medical', 'medical report', 'medical certificate', 'medical fitness', 'fit for duty', 'fit for physical'],
      docType: 'medical'
    });
  }

  /* 4e. Ward Councillor proof */
  if (/\bward\s+councillor\b|\bproof\s+of\s+residence\b|\bward\s+proof\b/i.test(text)) {
    checks.push({
      label: 'Proof from Ward Councillor',
      type: 'soft',
      weight: 5,
      keywords: ['ward councillor', 'ward proof', 'proof of residence', 'councillor'],
      docType: 'proof_of_residence'
    });
  }

  /* 5. Knowledge areas */
  const knowledgeRegex = /knowledge\s+(?:and\s+understanding\s+)?of\s+([^.;\n]+)/gi;
  let km;
  const seenKnowledge = new Set();
  while ((km = knowledgeRegex.exec(text)) !== null) {
    const phrase = km[1].trim();
    phrase.split(/\s*,\s*|\s+and\s+/i).forEach((part) => {
      const clean = part.trim().replace(/\s+/g, ' ').replace(/^and\s+/i, '');
      if (clean.length < 3 || clean.length > 90) return;
      const key = normTerm(clean);
      if (seenKnowledge.has(key)) return;
      seenKnowledge.add(key);
      checks.push({
        label: clean,
        type: 'hard',
        weight: 10,
        keywords: [clean.toLowerCase(), ...variants(clean)]
      });
    });
  }

  /* 6. Added-advantage items */
  const advRegex = /([A-Za-z][A-Za-z0-9\s./\-&]{2,60}?)\s+(?:will\s+be\s+)?(?:an?\s+)?added\s+advantage/gi;
  let am;
  const seenAdv = new Set();
  while ((am = advRegex.exec(text)) !== null) {
    const clean = am[1].trim().replace(/^and\s+/i, '');
    if (clean.length < 3) continue;
    const key = normTerm(clean);
    if (seenAdv.has(key)) continue;
    seenAdv.add(key);
    checks.push({
      label: clean,
      type: 'advantage',
      weight: 5,
      keywords: [clean.toLowerCase(), ...variants(clean)]
    });
  }

  /* 7. Soft skills */
  const softSkillPatterns = [
    [/report\s+(?:and\s+)?writing\s+skills?/i, 'Report and writing skills'],
    [/good\s+communication\s+skills?/i, 'Communication skills'],
    [/presentation\s+and\s+interpersonal\s+skills?/i, 'Presentation and interpersonal skills'],
    [/analytical\s+skills?/i, 'Analytical skills'],
    [/attention\s+to\s+detail/i, 'Attention to detail'],
    [/problem[\s-]solving/i, 'Problem-solving'],
    [/ability\s+to\s+work\s+under\s+pressure/i, 'Ability to work under pressure'],
    [/computer\s+literacy|computer\s+literate/i, 'Computer literate'],
    [/project\s+management/i, 'Project management']
  ];
  softSkillPatterns.forEach(([re, label]) => {
    if (!re.test(text)) return;
    if (checks.some((c) => normTerm(c.label) === normTerm(label))) return;
    checks.push({
      label,
      type: 'soft',
      weight: 5,
      keywords: [label.toLowerCase(), ...variants(label)]
    });
  });

  /* 8. KPA-style phrases */
  const kpaPatterns = [
    [/traffic[, ]+monitoring[, ]+and\s+parking\s+bylaws/i, 'Traffic, monitoring and parking bylaws', ['traffic', 'parking bylaws', 'bylaws']],
    [/issue\s+fixed\s+penalty\s+notices?/i, 'Issue fixed penalty notices', ['fixed penalty', 'penalty notices', 'penalty notice']],
    [/parking\s+meters?.*?(?:controlled parking zones?|one-way)/i, 'Parking meters and controlled zones', ['parking meter', 'controlled parking', 'one-way', 'one way']],
    [/motor\s+vehicle\s+licen[cs]e\s+discs?/i, 'Vehicle licence disc verification', ['licence disc', 'license disc', 'licence discs', 'license discs']],
    [/tow(?:ing)?\s+away\s+wrongly\s+parked\s+vehicles?/i, 'Towing coordination', ['towing', 'tow away', 'towed', 'breakdown']],
    [/patrol\s+given\s+areas?/i, 'Patrol assigned areas', ['patrol', 'patrolled', 'patrolling']],
    [/attend\s+court\s+as\s+required/i, 'Attend court', ['court']],
    [/troubleshooting|problem\s+solving/i, 'Troubleshooting and problem solving', ['troubleshooting', 'problem solving', 'troubleshoot']],
    [/website\s+management/i, 'Website management', ['website management', 'website', 'web content']],
    [/e-?government|e-?governance/i, 'E-Government services', ['e-government', 'egoverment', 'e governance', 'e governance services']],
    [/install\s+new\s+software|software\s+install/i, 'Install new software and hardware', ['install new software', 'software installation', 'hardware installation']],
    [/capacitate\s+end-?user|end-?user\s+training/i, 'Capacitate end users on applications', ['end user training', 'end-user', 'capacitate', 'user training']]
  ];
  kpaPatterns.forEach(([re, label, keywords]) => {
    if (!re.test(text)) return;
    if (checks.some((c) => normTerm(c.label) === normTerm(label))) return;
    checks.push({
      label,
      type: 'soft',
      weight: 3,
      keywords: keywords.map((k) => k.toLowerCase())
    });
  });

  return checks;
}

/* --------------------------------------------------------------------------
   Years from text
   -------------------------------------------------------------------------- */
function roughYearsFromText(cvText) {
  const now = new Date().getFullYear();
  const re = /\b((?:19|20)\d{2})\s*(?:-|–|—|to|until)\s*((?:19|20)\d{2}|present|current|date|now|ongoing)\b/gi;
  const ranges = [];
  let m;
  while ((m = re.exec(cvText)) !== null) {
    const start = Number(m[1]);
    const end = /present|current|date|now|ongoing/i.test(m[2]) ? now : Number(m[2]);
    if (end >= start && end - start <= 45) ranges.push([start, end]);
  }
  if (!ranges.length) return 0;

  ranges.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [curS, curE] = ranges[0];
  for (let i = 1; i < ranges.length; i++) {
    const [s, e] = ranges[i];
    if (s <= curE) curE = Math.max(curE, e);
    else { total += curE - curS; curS = s; curE = e; }
  }
  total += curE - curS;
  return Math.round(total * 10) / 10;
}

/* --------------------------------------------------------------------------
   Score one CV (+ attachments) against the parsed advert
   -------------------------------------------------------------------------- */
function scoreCv(cvText, jobText, parsed, documentsByType) {
  const p = parsed || ats.parseCv(cvText);
  const cvLower = normTerm(cvText);
  const docs = documentsByType || {};

  const strongRaw = [
    p.skills.join(' '),
    ...p.experience.map((e) => [e.title, e.employer, ...e.details].join(' ')),
    ...p.education.map((e) => e.text)
  ].join(' ');
  const strongLower = normTerm(strongRaw);

  const checks = parseAdvert(jobText);

  if (!checks.length) {
    return {
      score: 0,
      hard:      { required: 0, met: 0, checks: [] },
      soft:      { required: 0, met: 0, checks: [] },
      advantage: { required: 0, met: 0, checks: [] },
      matched: [],
      missing: [],
      warnings: ['Advert text did not contain any recognisable requirements.']
    };
  }

  let weightTotal = 0;
  let weightMet = 0;

  const buckets = {
    hard:      { required: 0, met: 0, checks: [] },
    soft:      { required: 0, met: 0, checks: [] },
    advantage: { required: 0, met: 0, checks: [] }
  };

  for (const check of checks) {
    weightTotal += check.weight;
    buckets[check.type].required += 1;

    let met = false;
    let evidence = '';
    let credit = 0;

    /* Years-of-experience arithmetic. */
    if (typeof check.minYears === 'number') {
      let years = p.years || 0;
      if (years === 0) years = roughYearsFromText(cvText);
      met = years >= check.minYears;
      evidence = met
        ? `~${years} year(s) detected (needs ${check.minYears})`
        : `Only ~${years} year(s) detected (needs ${check.minYears})`;
      credit = met ? 1 : 0;
    } else {
      const kw = (check.keywords || []).map((k) => normTerm(k)).filter(Boolean);

      let inStrong = kw.some((k) =>
        strongLower.includes(` ${k} `) ||
        strongLower.startsWith(`${k} `) ||
        strongLower.endsWith(` ${k}`)
      );
      const inFull = kw.some((k) =>
        cvLower.includes(` ${k} `) ||
        cvLower.startsWith(`${k} `) ||
        cvLower.endsWith(` ${k}`)
      );

      let explicitMiss = false;

      if (check.inverted) {
        const cleanRe = /\b(?:no|clean|clear)\s+(?:criminal\s+record|criminal\s+history|record)\b|\bclean\s+record\b|\bsaps\s+clearance\b/i;
        if (cleanRe.test(cvText)) inStrong = true;
      } else {
        const kwAlt = kw.map((k) => k.replace(/ /g, '\\s+')).join('|');
        if (kwAlt) {
          const negRe = new RegExp(
            `\\b(?:no|without|missing|lacks?|do(?:es)?\\s+not\\s+(?:have|possess)|not\\s+(?:have|possess|obtained))\\b` +
            `(?:\\s+(?:a|an|the|any|valid|current|recent|relevant|formal|trace\\s+of))?` +
            `\\s{0,3}(?:${kwAlt})`,
            'i'
          );
          explicitMiss = negRe.test(cvLower);
        }
      }

      /* Attachment check. */
      let attachmentHit = null;
      if (check.docType && docs[check.docType]) {
        const docText = normTerm(docs[check.docType]);
        attachmentHit = docText.length > 0
          ? `Attachment on file (${check.docType}, text extracted)`
          : `Attachment on file (${check.docType}, scanned)`;
      } else {
        const types = matchingDocTypes(check.label);
        for (const t of types) {
          if (docs[t]) {
            const docText = normTerm(docs[t]);
            attachmentHit = docText.length > 0
              ? `Attachment on file (${t})`
              : `Attachment on file (${t}, scanned)`;
            break;
          }
        }
      }

      if (attachmentHit) {
        met = true; credit = 1;
        evidence = attachmentHit;
      } else if (inStrong && !explicitMiss) {
        met = true; credit = 1;
        evidence = 'Mentioned in Skills / Experience / Education';
      } else if (inFull && !explicitMiss) {
        met = true; credit = 0.6;
        evidence = 'Mentioned elsewhere in CV';
      } else if (explicitMiss) {
        met = false; credit = 0;
        evidence = 'CV explicitly states this is missing';
      } else {
        met = false; credit = 0;
        evidence = 'Not mentioned';
      }
    }

    weightMet += check.weight * credit;
    if (credit >= 0.6) buckets[check.type].met += 1;

    buckets[check.type].checks.push({
      label: check.label,
      met,
      partial: credit === 0.6,
      evidence,
      weight: check.weight
    });
  }

  const score = weightTotal ? Math.round((weightMet / weightTotal) * 100) : 0;

  const matched = [];
  const missing = [];
  ['hard', 'soft', 'advantage'].forEach((b) => {
    buckets[b].checks.forEach((c) => {
      if (c.met) matched.push(c.label);
      else missing.push(c.label);
    });
  });

  return { score, ...buckets, matched, missing, warnings: [] };
}

module.exports = { parseAdvert, scoreCv, buildAdvertText, variants, normTerm, matchingDocTypes };