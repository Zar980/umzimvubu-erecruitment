'use strict';

require('dotenv').config();

const path = require('path');
const db = require('../db');
const screening = require('../screening');
const llm = require('../llm-screen');

const [, , emailArg, jobArg] = process.argv;

if (!emailArg || !jobArg) {
  console.error('Usage: node scripts/screen-one.js <candidateEmail> <jobTitleFragment>');
  process.exit(1);
}

(async () => {
  const candidate = db.prepare(
    'SELECT id, first_name, last_name, email, cv_path FROM candidates WHERE email = ?'
  ).get(String(emailArg).toLowerCase());

  if (!candidate) {
    console.error(`No candidate found with email "${emailArg}".`);
    process.exit(1);
  }

  const job = db.prepare(
    'SELECT id, title, description, requirements FROM jobs WHERE title LIKE ? ORDER BY id DESC LIMIT 1'
  ).get(`%${jobArg}%`);

  if (!job) {
    console.error(`No job found matching "${jobArg}".`);
    process.exit(1);
  }

  console.log('');
  console.log('Candidate :', `${candidate.first_name} ${candidate.last_name}`, `<${candidate.email}>`);
  console.log('Job       :', job.title);
  console.log('CV file   :', candidate.cv_path);
  console.log('');

  const uploads = path.join(__dirname, '..', 'uploads');
  const cvAbsolute = path.join(uploads, path.basename(candidate.cv_path || ''));
  const cvText = await screening.extractCvText(cvAbsolute);
  console.log(`Extracted ${cvText.length} characters from the CV.`);
  console.log('');

  if (!cvText) {
    console.error('Could not extract any text — check the file is not a scanned image.');
    process.exit(1);
  }

  const rules = screening.parseRequirements(job.requirements || job.description || '');
  const ruleResult = screening.evaluateCandidate(candidate, rules, cvText);

  console.log('--- RULE-BASED VERDICT ---');
  console.log('Qualified  :', ruleResult.qualified);
  console.log('Score      :', ruleResult.score);
  console.log('Reasons    :');
  for (const r of ruleResult.reasons) console.log('   •', r);
  if (ruleResult.flags.length) {
    console.log('Flags      :');
    for (const f of ruleResult.flags) console.log('   •', f);
  }
  console.log('');

  console.log(`--- ASKING ${llm.OLLAMA_MODEL} (${llm.USE_CLOUD ? 'OLLAMA CLOUD' : 'local'}) ---`);
  const ok = await llm.isAvailable();
  if (!ok) {
    console.error('Ollama is not reachable.');
    if (llm.USE_CLOUD) {
      console.error('Check that OLLAMA_API_KEY is set and valid.');
    } else {
      console.error('Start local Ollama and run: ollama pull', llm.OLLAMA_MODEL);
    }
    process.exit(2);
  }

  const started = Date.now();
  const llmResult = await llm.screenCv(job.title, job.requirements || job.description || '', cvText);
  const elapsed = Date.now() - started;

  if (!llmResult) {
    console.error('The LLM returned nothing usable.');
    process.exit(3);
  }

  console.log(`Responded in ${elapsed} ms (reported ${llmResult.elapsedMs} ms).`);
  console.log('');
  console.log(JSON.stringify(llmResult, null, 2));
  console.log('');
})();