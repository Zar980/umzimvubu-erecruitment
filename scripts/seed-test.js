'use strict';

/* ==========================================================================
   scripts/seed-test.js
   Creates the EPWP: Law Enforcement Warden job + 100 test applicants.
   Run once:  node scripts/seed-test.js
   ========================================================================== */

const fs = require('fs');
const path = require('path');
const db = require('../db');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* --------------------------------------------------------------------------
   Deterministic PRNG so re-running produces the same 100 applicants.
   -------------------------------------------------------------------------- */
let seed = 20260215;
function rnd() {
  seed = (seed * 9301 + 49297) % 233280;
  return seed / 233280;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

/* --------------------------------------------------------------------------
   Job description — matches the real advert.
   -------------------------------------------------------------------------- */
const JOB = {
  title: 'EPWP: LAW ENFORCEMENT WARDEN',
  category: 'CITIZENS & COMMUNITY SERVICES',
  description:
    'Beneficiaries: 04 · Contract: 24 Months Fixed Contract · Stipend: R 3,388 per month. ' +
    'Make sure traffic, monitoring, and parking bylaws and regulations are followed; report parking ' +
    'offences and issue fixed penalty notices to offenders; monitor the use of parking meters, ' +
    'controlled parking zones, and one-way systems; check infringements on waiting restrictions ' +
    'and on the loading/unloading of goods; check that vehicles display up-to-date motor vehicle ' +
    'license discs; arrange breakdowns for towing away wrongly parked vehicles; patrol given areas ' +
    'as directed and enforce road traffic regulations; act as a visible representative of the ULM ' +
    'Law Enforcement Division; attend court as required.',
  requirements:
    'Minimum Requirements: Grade 12 certificate, certified ID copy, Traffic Diploma, Driving Licence, ' +
    'Certificate of no criminal record (SAPS clearance certificate), Recent medical report certificate ' +
    'that proves the applicant exercises, Proof from Ward Councillor.',
  closing_date: '2026-10-14' // already past → master list can run
};

/* --------------------------------------------------------------------------
   Name pools — realistic South African candidates.
   -------------------------------------------------------------------------- */
const FIRST_NAMES_M = ['Sipho','Thabo','Mandla','Bongani','Lungile','Sibusiso','Themba','Andile','Kagiso','Lwazi','Tshepo','Mpho','Vusi','Jabulani','Katlego','Nkosinathi','Dumisani','Musa','Sifiso','Nhlanhla','Siyabonga','Tebogo','Menzi','Sanele','Ayanda'];
const FIRST_NAMES_F = ['Nomsa','Thandi','Zanele','Lindiwe','Nokuthula','Precious','Busisiwe','Nomvula','Nosipho','Palesa','Lerato','Khanyisile','Andile','Sibongile','Ntombi','Refilwe','Zodwa','Ayanda','Nolwazi','Hlengiwe','Fikile','Mahlatse','Bontle','Palesa','Yolanda'];
const LAST_NAMES = ['Mkhize','Dlamini','Nkosi','Mthembu','Zulu','Sithole','Ngcobo','Khumalo','Mahlangu','Mokoena','Ndlovu','Mabaso','Buthelezi','Cele','Jali','Radebe','Maseko','Mnguni','Ntuli','Sibiya','Zwane','Shabalala','Nzimande','Meyer','Botha','Van Wyk','Naidoo','Pillay','Jacobs','Adams'];

const MUNICIPALITIES = ['Mount Frere','Mount Ayliff','Bizana','Flagstaff','Lusikisiki','Ntabankulu'];

/* --------------------------------------------------------------------------
   CV text generator.
   The screening engine reads these strings, so the CV must contain the
   actual keywords the parser looks for.
   -------------------------------------------------------------------------- */
function buildCvText(c) {
  const parts = [];

  parts.push(`${c.first_name} ${c.last_name}`);
  parts.push(`Email: ${c.email}`);
  parts.push(`Phone: ${c.phone_country_code} ${c.phone_number}`);
  parts.push(`Address: ${c.suburb}, ${c.city}`);
  parts.push('');

  parts.push('PROFILE');
  parts.push('Motivated, disciplined candidate seeking a law enforcement role within Umzimvubu Local Municipality.');
  parts.push('');

  parts.push('EDUCATION');
  c.education.forEach((e) => {
    const span = [e.startMonth, e.startYear].filter(Boolean).join(' ') + ' – ' +
                 [e.endMonth, e.endYear].filter(Boolean).join(' ');
    parts.push(`${e.degree}${e.major ? ' in ' + e.major : ''} — ${e.school} (${span})`);
  });
  parts.push('');

  parts.push('CERTIFICATES & CLEARANCES');
  if (c.hasGrade12) parts.push('National Senior Certificate (Grade 12 / Matric)');
  if (c.hasTrafficDiploma) parts.push('Traffic Diploma — National Traffic College');
  if (c.hasBtechInstead) parts.push('B-Tech: Traffic Management — Tshwane University of Technology');
  if (c.hasDriversLicence) parts.push(`Drivers Licence Code ${c.licenceCode}`);
  else parts.push('No driver’s licence.');
  if (c.hasSapsClearance) parts.push('SAPS Clearance Certificate — no criminal record');
  if (c.hasMedical) parts.push('Medical Fitness Certificate — fit for physical duties');
  if (c.hasWardProof) parts.push('Proof of Residence & Ward Councillor Confirmation Letter');
  parts.push('');

  parts.push('EMPLOYMENT HISTORY');
  c.experience.forEach((e) => {
    const span = [e.startMonth, e.startYear].filter(Boolean).join(' ') + ' – ' +
                 (e.isCurrent ? 'Present' : [e.endMonth, e.endYear].filter(Boolean).join(' '));
    parts.push(`${e.jobTitle} @ ${e.employerName} (${span})`);
    if (e.responsibilities) parts.push(`  ${e.responsibilities}`);
  });
  parts.push('');

  parts.push('DECLARATION');
  parts.push('I declare that the information above is accurate.');

  return parts.join('\n');
}

/* --------------------------------------------------------------------------
   Candidate generator.
   Every candidate returns an object with a `qualified` flag we set here so
   the script tells us exactly which bucket they belong to. The reason strings
   are the ones the master list will surface.
   -------------------------------------------------------------------------- */
function makeCandidate(i, qualified) {
  const isFemale = i % 3 === 0;
  const first = isFemale ? pick(FIRST_NAMES_F) : pick(FIRST_NAMES_M);
  const last  = pick(LAST_NAMES);
  const email = `test.applicant${String(i).padStart(3, '0')}@example.co.za`;
  const city  = pick(MUNICIPALITIES);

  const c = {
    email,
    title: isFemale ? pick(['Ms','Mrs','Miss']) : pick(['Mr']),
    first_name: first,
    middle_name: '',
    last_name: last,
    phone_country_code: '+27',
    phone_number: `7${Math.floor(rnd() * 9)}${String(Math.floor(rnd() * 1e7)).padStart(7, '0')}`,
    gender: isFemale ? 'Female' : 'Male',
    city,
    suburb: city,
    country: 'South Africa',
    preferred_job_category: 'CITIZENS & COMMUNITY SERVICES',
    preferred_job_location: city,
    has_disability: rnd() < 0.08 ? 1 : 0,
    disability_status: '',
    receipt_number: '',
    drivers_licence: 0,
    drivers_licence_code: '',
    education: [],
    experience: [],

    /* Screener flags */
    hasGrade12: true,
    hasTrafficDiploma: false,
    hasBtechInstead: false,
    hasDriversLicence: false,
    licenceCode: '',
    hasSapsClearance: true,
    hasMedical: true,
    hasWardProof: true
  };

  /* ---- Grade 12 (rarely missing) ---- */
  if (!qualified && rnd() < 0.15) {
    c.hasGrade12 = false;
  }

  if (c.hasGrade12) {
    c.education.push({
      degree: 'National Senior Certificate',
      major: 'Grade 12',
      school: 'Umzimvubu Secondary School',
      startMonth: 'January', startYear: '2015',
      endMonth: 'December', endYear: '2019',
      educationLevel: 'NQF 4',
      country: 'South Africa', city,
      averageGrade: String(55 + Math.floor(rnd() * 30)),
      yearAcquired: '2019'
    });
  }

  /* ---- Traffic Diploma vs B-Tech ---- */
  if (qualified) {
    c.hasTrafficDiploma = true;
    c.education.push({
      degree: 'Traffic Diploma',
      major: 'Traffic Management',
      school: 'National Traffic College',
      startMonth: 'January', startYear: '2020',
      endMonth: 'December', endYear: '2021',
      educationLevel: 'NQF 6',
      country: 'South Africa', city: 'Pretoria',
      averageGrade: String(60 + Math.floor(rnd() * 25)),
      yearAcquired: '2021'
    });
  } else {
    const roll = rnd();
    if (roll < 0.25) {
      c.hasTrafficDiploma = false;
    } else if (roll < 0.50) {
      c.hasBtechInstead = true;
      c.education.push({
        degree: 'B-Tech',
        major: 'Traffic Management',
        school: 'Tshwane University of Technology',
        startMonth: 'January', startYear: '2020',
        endMonth: 'December', endYear: '2022',
        educationLevel: 'NQF 7',
        country: 'South Africa', city: 'Pretoria',
        averageGrade: String(60 + Math.floor(rnd() * 20)),
        yearAcquired: '2022'
      });
    } else if (roll < 0.65) {
      c.education.push({
        degree: 'Diploma',
        major: 'Office Administration',
        school: 'King Hintsa TVET College',
        startMonth: 'January', startYear: '2020',
        endMonth: 'December', endYear: '2021',
        educationLevel: 'NQF 5',
        country: 'South Africa', city: 'Butterworth',
        averageGrade: String(55 + Math.floor(rnd() * 20)),
        yearAcquired: '2021'
      });
    }
  }

  /* ---- Drivers licence ---- */
  if (qualified) {
    c.hasDriversLicence = true;
    c.licenceCode = pick(['B', 'EB', 'C1']);
  } else {
    const roll = rnd();
    if (roll < 0.55) {
      c.hasDriversLicence = false;
    } else {
      c.hasDriversLicence = true;
      c.licenceCode = 'B';
    }
  }
  c.drivers_licence = c.hasDriversLicence ? 1 : 0;
  c.drivers_licence_code = c.licenceCode;

  /* ---- Other clearances ---- */
  if (!qualified) {
    if (rnd() < 0.20) c.hasSapsClearance = false;
    if (rnd() < 0.20) c.hasMedical = false;
    if (rnd() < 0.20) c.hasWardProof = false;
  }

  /* ---- Experience ---- */
  if (qualified) {
    c.experience.push({
      employerName: pick(['Umzimvubu Local Municipality','Alfred Nzo District Municipality','SA Police Service — Mount Frere','Local Traffic Department']),
      jobTitle: pick(['Law Enforcement Officer','Traffic Warden','Peace Officer']),
      startMonth: 'February', startYear: '2022',
      endMonth: '', endYear: '',
      isCurrent: true,
      employerCountry: 'South Africa', employerCity: city,
      responsibilities: 'Enforced municipal bylaws and traffic regulations; issued fixed penalty notices; patrolled assigned zones.'
    });
  } else {
    if (rnd() < 0.5) {
      c.experience.push({
        employerName: pick(['Retail Shop','Local Farm','Private Security','Construction Site']),
        jobTitle: pick(['General Worker','Cashier','Security Guard','Cleaner']),
        startMonth: 'March', startYear: '2022',
        endMonth: 'November', endYear: '2023',
        isCurrent: false,
        employerCountry: 'South Africa', employerCity: city,
        responsibilities: 'General duties as assigned.'
      });
    }
  }

  return c;
}

/* --------------------------------------------------------------------------
   Insert helpers
   -------------------------------------------------------------------------- */
const insertCandidate = db.prepare(`
  INSERT INTO candidates (
    email, title, first_name, middle_name, last_name,
    phone_country_code, phone_number,
    preferred_job_category, preferred_job_location,
    country, street_name, suburb, city,
    receive_job_alerts, receive_marketing,
    cv_path, cover_letter_path, verified,
    gender, has_disability, disability_status, drivers_licence, drivers_licence_code
  ) VALUES (
    @email, @title, @first_name, @middle_name, @last_name,
    @phone_country_code, @phone_number,
    @preferred_job_category, @preferred_job_location,
    @country, @suburb, @suburb, @city,
    1, 0,
    @cv_path, NULL, 1,
    @gender, @has_disability, @disability_status, @drivers_licence, @drivers_licence_code
  )
`);

const insertEdu = db.prepare(`
  INSERT INTO education (
    candidate_id, degree, major, school, start_month, start_year,
    end_month, end_year, education_level, country, city,
    average_grade, year_acquired
  ) VALUES (
    @candidate_id, @degree, @major, @school, @startMonth, @startYear,
    @endMonth, @endYear, @educationLevel, @country, @city,
    @averageGrade, @yearAcquired
  )
`);

const insertExp = db.prepare(`
  INSERT INTO experience (
    candidate_id, employer_name, job_title, start_month, start_year,
    end_month, end_year, is_current, employer_country, employer_city,
    responsibilities
  ) VALUES (
    @candidate_id, @employerName, @jobTitle, @startMonth, @startYear,
    @endMonth, @endYear, @isCurrent, @employerCountry, @employerCity,
    @responsibilities
  )
`);

const insertApp = db.prepare(`
  INSERT INTO applications (candidate_id, job_id) VALUES (?, ?)
`);

/* --------------------------------------------------------------------------
   Clean up test data from previous runs (only test.* emails).
   -------------------------------------------------------------------------- */
function cleanPreviousRun() {
  const emails = db.prepare("SELECT id, cv_path FROM candidates WHERE email LIKE 'test.applicant%@example.co.za'").all();
  if (!emails.length) return;

  const ids = emails.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');

  db.prepare(`DELETE FROM applications WHERE candidate_id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM education    WHERE candidate_id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM experience   WHERE candidate_id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM candidates   WHERE id           IN (${placeholders})`).run(...ids);

  emails.forEach((r) => {
    if (r.cv_path) {
      const p = path.join(UPLOAD_DIR, path.basename(r.cv_path));
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
  });

  console.log(`[seed] cleaned ${ids.length} previous test applicants.`);
}

/* --------------------------------------------------------------------------
   Main
   -------------------------------------------------------------------------- */
function main() {
  cleanPreviousRun();

  /* Upsert the job — replace any existing one with the same title. */
  db.prepare("DELETE FROM jobs WHERE title = ?").run(JOB.title);
  const jobInfo = db.prepare(`
    INSERT INTO jobs (title, category, location, description, requirements, closing_date, is_open)
    VALUES (@title, @category, @location, @description, @requirements, @closing_date, 1)
  `).run({
    title: JOB.title,
    category: JOB.category,
    location: 'Umzimvubu, Eastern Cape, South Africa',
    description: JOB.description,
    requirements: JOB.requirements,
    closing_date: JOB.closing_date
  });
  const jobId = jobInfo.lastInsertRowid;
  console.log(`[seed] job #${jobId} created: ${JOB.title}`);

  /* Insert 100 candidates: first 20 qualified, last 80 unqualified. */
  const insertAll = db.transaction(() => {
    for (let i = 1; i <= 100; i++) {
      const qualified = i <= 20;
      const c = makeCandidate(i, qualified);

      /* Save the CV as a real text file so the screener can read it. */
      const cvFilename = `test_cv_${String(i).padStart(3, '0')}_${c.last_name}.txt`;
      const cvAbsolute = path.join(UPLOAD_DIR, cvFilename);
      fs.writeFileSync(cvAbsolute, buildCvText(c), 'utf8');
      c.cv_path = cvFilename;

      /* Insert candidate. */
      const info = insertCandidate.run({
        email: c.email,
        title: c.title,
        first_name: c.first_name,
        middle_name: c.middle_name,
        last_name: c.last_name,
        phone_country_code: c.phone_country_code,
        phone_number: c.phone_number,
        preferred_job_category: c.preferred_job_category,
        preferred_job_location: c.preferred_job_location,
        country: c.country,
        suburb: c.suburb,
        city: c.city,
        cv_path: c.cv_path,
        gender: c.gender,
        has_disability: c.has_disability,
        disability_status: c.disability_status,
        drivers_licence: c.drivers_licence,
        drivers_licence_code: c.drivers_licence_code
      });
      const candidateId = info.lastInsertRowid;

      /* Education rows — coerce every value so SQLite only sees
         numbers, strings, buffers or null (no booleans, no undefined). */
      c.education.forEach((e) => {
        insertEdu.run({
          candidate_id: candidateId,
          degree: e.degree || '',
          major: e.major || '',
          school: e.school || '',
          startMonth: e.startMonth || '',
          startYear: e.startYear || '',
          endMonth: e.endMonth || '',
          endYear: e.endYear || '',
          educationLevel: e.educationLevel || '',
          country: e.country || '',
          city: e.city || '',
          averageGrade: e.averageGrade || '',
          yearAcquired: e.yearAcquired || ''
        });
      });

      /* Experience rows — same treatment. `isCurrent` must be 0 or 1. */
      c.experience.forEach((e) => {
        insertExp.run({
          candidate_id: candidateId,
          employerName: e.employerName || '',
          jobTitle: e.jobTitle || '',
          startMonth: e.startMonth || '',
          startYear: e.startYear || '',
          endMonth: e.endMonth || '',
          endYear: e.endYear || '',
          isCurrent: e.isCurrent ? 1 : 0,
          employerCountry: e.employerCountry || '',
          employerCity: e.employerCity || '',
          responsibilities: e.responsibilities || ''
        });
      });

      /* Application. */
      insertApp.run(candidateId, jobId);
    }
  });

  insertAll();

  /* Report. */
  const count = db.prepare(`
    SELECT COUNT(*) AS c FROM applications WHERE job_id = ?
  `).get(jobId).c;

  const btechCount = db.prepare(`
    SELECT COUNT(*) AS c FROM education
     WHERE degree LIKE 'B-Tech%'
       AND candidate_id IN (
         SELECT candidate_id FROM applications WHERE job_id = ?
       )
  `).get(jobId).c;

  console.log('');
  console.log(`[seed] ${count} applications created for job #${jobId}.`);
  console.log(`[seed] 20 qualified, 80 unqualified (by design).`);
  console.log(`[seed] ${btechCount} candidates hold a B-Tech (should show as "B-Tech, Traffic Management" in the master list).`);
  console.log('');
  console.log('Next:');
  console.log('  1. Open /admin.html and log in.');
  console.log('  2. Click "Master List" on the EPWP job.');
  console.log('  3. Expect 20 qualified and 80 unqualified.');
  console.log('  4. Look for B-Tech mentions in the unqualified column — they should read "B-Tech, Traffic Management, Tshwane University of Technology".');
}

main();