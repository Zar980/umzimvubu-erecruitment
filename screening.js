'use strict';

/* ==========================================================================
   screening.js — rule-based + ATS hybrid screening.
   Includes Gemini AI integration for smart matching (synonyms & context).
   ========================================================================== */

const ats = require('./ats');
const { evaluateWithGemini } = require('./ai-screener');

/* --------------------------------------------------------------------------
   Text extraction — one shared extractor
   -------------------------------------------------------------------------- */
async function extractCvText(filePath) {
  const r = await ats.extractText(filePath);
  return r.text || '';
}

/* --------------------------------------------------------------------------
   Requirement parsing
   -------------------------------------------------------------------------- */
function extractRequiredQualification(text) {
  const patterns = [
    /(traffic\s+diploma)/i,
    /(national\s+diploma\s+in\s+[A-Za-z][A-Za-z\s,&/()\-]{2,60})/i,
    /(bachelor'?s?\s+degree\s+in\s+[A-Za-z][A-Za-z\s,&/()\-]{2,60})/i,
    /(b\.?sc\s+[A-Za-z][A-Za-z\s,&/()\-]{2,60})/i,
    /(b\.?com\s+[A-Za-z][A-Za-z\s,&/()\-]{2,60})/i,
    /(b\.?tech\s+[A-Za-z][A-Za-z\s,&/()\-]{2,60})/i,
    /(degree\s+in\s+[A-Za-z][A-Za-z\s,&/()\-]{2,60})/i
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1].replace(/\s+/g, ' ').trim();
  }
  return '';
}

function parseRequirements(rawText) {
  const text = String(rawText || '');
  const lower = text.toLowerCase();

  return {
    raw: text,
    needsGrade12: /\bgrade\s*12\b|\bmatric\b|\bsenior certificate\b/.test(lower),
    needsDegree: /\bdegree\b|\bbachelor\b|\bnational diploma\b|\bdiploma\b|\bbtech\b|\bb\.?tech\b|\bnqf\s*[67]\b/.test(lower),
    requiredQualification: extractRequiredQualification(text),
    needsDriversLicence: /\bdriver'?s?\s*licen[cs]e\b|\bcode\s*(8|10|eb|b)\b|\bvalid\s+driver\b/.test(lower),
    needsCpmd: /\bcpmd\b/.test(lower),
    needsMunsoft: /\bmunsoft\b/.test(lower),
    minYearsExperience: extractMinYears(lower),
    fieldsOfStudy: extractFieldsOfStudy(text),
    knowledgeAreas: extractKnowledgeAreas(text),
    advantageKeywords: extractAdvantageKeywords(text)
  };
}

function extractMinYears(lower) {
  const wordNumbers = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10 };

  const patterns = [
    /minimum\s+of\s+(\w+)\s*\(?\s*(\d{1,2})\s*\)?\s*years?/i,
    /minimum\s+of\s+(\d{1,2})\s*years?/i,
    /at\s+least\s+(\w+)\s*\(?\s*(\d{1,2})\s*\)?\s*years?/i,
    /at\s+least\s+(\d{1,2})\s*years?/i,
    /(\d{1,2})\s*\+?\s*years?.*?experience/i,
    /(\w+)\s*\(?\s*(\d{1,2})\s*\)?\s*years?.*?experience/i
  ];

  for (const re of patterns) {
    const m = lower.match(re);
    if (!m) continue;
    for (let i = m.length - 1; i >= 1; i--) {
      const token = m[i];
      if (!token) continue;
      if (/^\d+$/.test(token)) return Number(token);
      if (wordNumbers[token.toLowerCase()]) return wordNumbers[token.toLowerCase()];
    }
  }
  return 0;
}

function extractFieldsOfStudy(text) {
  const match = text.match(
    /(?:degree|diploma|bachelor|btech|b\.?tech)\s*(?:in|of)?\s*([A-Za-z][A-Za-z\s,&/()\-]{3,80})/i
  );
  if (!match) return [];
  return match[1]
    .split(/[,/]|\band\b|\bor\b/i)
    .map(s => s.replace(/[()]/g, '').trim())
    .filter(s => s.length > 2 && s.length < 60);
}

function extractKnowledgeAreas(text) {
  const areas = [];
  const re = /knowledge\s+(?:and\s+understanding\s+)?of\s+([^.;\n]+)/gi;
  let m;
  while ((m = re.exec(text)) !== null) areas.push(m[1].trim());
  return areas;
}

function extractAdvantageKeywords(text) {
  const out = [];
  const re = /([A-Za-z][A-Za-z0-9\s./\-&]{2,60}?)\s+(?:will\s+be\s+)?(?:an?\s+)?added\s+advantage/gi;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1].trim());
  return out;
}

/* --------------------------------------------------------------------------
   Negative-phrase detection
   -------------------------------------------------------------------------- */
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cvExplicitlyLacksQualification(cvLower, requiredLower) {
  const phrase = escapeRegex(requiredLower);
  const re = new RegExp(
    `\\b(?:no|not|without|missing|lacks?|lack(?:ing)?(?:\\s+of)?|do(?:es)?\\s+not\\s+(?:have|possess)|never\\s+(?:obtained|completed|earned))\\b` +
    `[\\s\\S]{0,60}?` +
    phrase,
    'i'
  );
  return re.test(cvLower);
}

/* --------------------------------------------------------------------------
   Rule-based evaluation
   -------------------------------------------------------------------------- */
function evaluateCandidate(candidate, rules, cvText) {
  const reasons = [];
  const flags = [];
  const haystack = cvText.toLowerCase();

  const cvRead = cvText.length > 40;
  if (!cvRead) flags.push('CV text could not be read — manual review');

  let score = 0;
  let fails = 0;

  /* Grade 12 */
  if (rules.needsGrade12) {
    if (/\bgrade\s*12\b|\bmatric\b|\bsenior certificate\b/.test(haystack)) {
      score += 1;
      reasons.push('Grade 12 / Matric found');
    } else {
      fails++;
      reasons.push('Grade 12 not found in CV');
    }
  }

  /* Degree / Diploma / specific qualification */
  if (rules.needsDegree || rules.requiredQualification) {
    if (rules.requiredQualification) {
      const required = rules.requiredQualification.toLowerCase();
      const explicitMiss = cvExplicitlyLacksQualification(haystack, required);

      let cleanedHaystack = haystack;
      if (explicitMiss) {
        const removal = new RegExp(
          `\\b(?:no|not|without|missing|lacks?|lack(?:ing)?(?:\\s+of)?|do(?:es)?\\s+not\\s+(?:have|possess)|never\\s+(?:obtained|completed|earned))\\b` +
          `[\\s\\S]{0,60}?` +
          escapeRegex(required) +
          `[^.]{0,60}`,
          'gi'
        );
        cleanedHaystack = haystack.replace(removal, ' ');
      }

      const has = cleanedHaystack.includes(required);

      if (has && !explicitMiss) {
        score += 2;
        reasons.push(`Required qualification found: ${rules.requiredQualification}`);
      } else if (explicitMiss) {
        fails++;
        reasons.push(`CV states candidate lacks: ${rules.requiredQualification}`);
      } else {
        fails++;
        reasons.push(`Missing required qualification: ${rules.requiredQualification}`);
      }
    } else {
      const hasQual = /\b(degree|bachelor|b\.?sc|b\.?com|b\.?a\b|btech|b\.?tech|national diploma|diploma|nqf\s*[67])\b/i.test(cvText);
      const fieldOk = rules.fieldsOfStudy.length === 0 ||
        rules.fieldsOfStudy.some(f => haystack.includes(f.toLowerCase()));

      if (hasQual && fieldOk) {
        score += 2;
        reasons.push('Relevant qualification found');
      } else if (hasQual) {
        score += 1;
        flags.push('Qualification found but field of study unclear');
      } else {
        fails++;
        reasons.push('Required qualification not found');
      }
    }
  }

  /* Years of experience via ATS */
  if (rules.minYearsExperience > 0) {
    const years = estimateYearsOfExperience(cvText);
    if (years >= rules.minYearsExperience) {
      score += 2;
      reasons.push(`~${years} years experience (needs ${rules.minYearsExperience})`);
    } else {
      fails++;
      reasons.push(`Only ~${years} years detected (needs ${rules.minYearsExperience})`);
    }
  }

  /* Driver's licence */
  if (rules.needsDriversLicence) {
    if (/\bdriver'?s?\s*licen[cs]e\b|\bcode\s*(8|10|eb|b)\b|\bvalid\s+driver\b/i.test(cvText)) {
      score += 1;
      reasons.push('Driver\'s licence mentioned');
    } else {
      fails++;
      reasons.push('Driver\'s licence not mentioned');
    }
  }

  /* Soft matches */
  rules.knowledgeAreas.forEach(area => {
    const key = area.split(/\s+/).slice(0, 4).join(' ').toLowerCase();
    if (key.length >= 4 && haystack.includes(key)) {
      score += 1;
      reasons.push(`Mentions: ${area}`);
    }
  });

  rules.advantageKeywords.forEach(kw => {
    if (haystack.includes(kw.toLowerCase())) {
      score += 0.5;
      reasons.push(`Advantage: ${kw}`);
    }
  });

  return {
    qualified: fails === 0 && (cvRead || score >= 3),
    score,
    reasons,
    flags,
    cvRead,
    missing: fails
  };
}

/* Delegate to ATS for the years estimate */
function estimateYearsOfExperience(cvText) {
  try { return ats.parseCv(cvText).years; }
  catch { return 0; }
}

/* --------------------------------------------------------------------------
   Hybrid Evaluator (Rules + Gemini AI)
   - If rules PASS → return immediately (fast, free).
   - If rules FAIL → ask Gemini for a smart second opinion.
   -------------------------------------------------------------------------- */
async function evaluateWithLlm(candidate, rules, cvText, jobTitle) {
  // 1. Run the existing rule-based check first
  const ruleResult = evaluateCandidate(candidate, rules, cvText);

  // 2. If rules already qualified, no need to call Gemini
  if (ruleResult.qualified || !cvText || cvText.length < 80) {
    return { ...ruleResult, source: 'rules' };
  }

  // 3. Rules failed → ask Gemini for a smart second opinion
  console.log(`[AI] Triggering Gemini for ${candidate.first_name} ${candidate.last_name}...`);
  
  const aiResult = await evaluateWithGemini(cvText, rules.raw, jobTitle);

  if (!aiResult) {
    console.warn(`[AI] Gemini returned null for ${candidate.first_name}. Falling back to rules.`);
    return { ...ruleResult, source: 'rules' };
  }

  console.log(`[AI] Gemini Result for ${candidate.first_name}:`, JSON.stringify(aiResult));

  // 4. Merge — Gemini gets the final say on qualified=true
  return {
    qualified: aiResult.qualified,
    score: aiResult.score,
    reasons: [
      ...ruleResult.reasons,
      '— AI REVIEW —',
      ...(aiResult.reasons || [])
    ],
    flags: ruleResult.flags,
    cvRead: ruleResult.cvRead,
    missing: (aiResult.missing_requirements || []).length,
    source: 'hybrid-rules+gemini',
    aiDetails: aiResult
  };
}

/* --------------------------------------------------------------------------
   Application reference
   -------------------------------------------------------------------------- */
function makeApplicationRef(jobId, sequence) {
  return `ULM-${String(jobId).padStart(3, '0')}-${String(sequence).padStart(5, '0')}`;
}

/* --------------------------------------------------------------------------
   EXPORTS
   -------------------------------------------------------------------------- */
module.exports = {
  extractCvText,
  parseRequirements,
  evaluateCandidate,
  evaluateWithLlm,
  estimateYearsOfExperience,
  makeApplicationRef
};