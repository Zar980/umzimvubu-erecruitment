'use strict';

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const session = require('express-session');
const db = require('./db');
const SqliteSessionStore = require('./session-store');
const mailer = require('./mailer');
const totp = require('./totp');
const masterlist = require('./masterlist');
const screening  = require('./screening');
const ats        = require('./ats');

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

const VERIFICATION_TTL_SECONDS = 15 * 60;

const ADMIN_OTP_TTL_SECONDS = 10 * 60;
const ADMIN_OTP_RESEND_COOLDOWN = 45;
const ADMIN_IDLE_MS = 2 * 60 * 60 * 1000;
const ADMIN_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
const ADMIN_SESSION_SECRET =
  process.env.ADMIN_SESSION_SECRET || process.env.SESSION_SECRET || 'change-me-in-production';

app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* --------------------------------------------------------------------------
   Sessions
   -------------------------------------------------------------------------- */
const candidateSession = session({
  name: 'ulm.sid',
  store: new SqliteSessionStore({ ttlMs: 8 * 60 * 60 * 1000 }),
  secret: process.env.SESSION_SECRET || 'change-me-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 1000 * 60 * 60 * 8 }
});

const adminSession = session({
  name: 'ulm.admin.sid',
  store: new SqliteSessionStore({ ttlMs: ADMIN_IDLE_MS }),
  secret: ADMIN_SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'strict', secure: isProd, maxAge: ADMIN_IDLE_MS, path: '/' }
});

app.use((req, res, next) =>
  req.path.startsWith('/api/admin') ? adminSession(req, res, next) : candidateSession(req, res, next)
);

/* --------------------------------------------------------------------------
   Admin portal hardening
   -------------------------------------------------------------------------- */
const ADMIN_IPS = String(process.env.ADMIN_IP_ALLOWLIST || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

function isAdminPath(req) {
  return req.path.startsWith('/api/admin') || req.path === '/admin.html' || req.path === '/admin';
}

app.use((req, res, next) => {
  if (isAdminPath(req)) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline'; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com data:; " +
      "img-src 'self' data:; " +
      "connect-src 'self'; " +
      "form-action 'self'; base-uri 'self'; frame-ancestors 'none'"
    );
  }
  next();
});

app.use('/api/admin', (req, res, next) => {
  if (!ADMIN_IPS.length) return next();
  const ip = String(req.ip || '').replace(/^::ffff:/, '');
  if (ADMIN_IPS.includes(ip)) return next();
  db.logAudit(null, 'ip.blocked', ip, ip);
  return res.status(403).json({ ok: false, code: 'IP_BLOCKED', error: 'This IP is not allowed to use the admin portal.' });
});

function issueCsrf(req) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  return req.session.csrf;
}

app.use('/api/admin', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const sent = String(req.get('x-csrf-token') || req.body?._csrf || '');
  if (!sent || sent !== req.session.csrf) {
    return res.status(403).json({ ok: false, code: 'CSRF', error: 'Stale form token. Reload the page.' });
  }
  next();
});

/* --------------------------------------------------------------------------
   Auth guards for HTML pages
   -------------------------------------------------------------------------- */
function safeNext(raw) {
  const value = String(raw || '');
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

function requireAuthPage(req, res, next) {
  if (req.session?.candidateId) {
    const candidate = db.prepare('SELECT id, first_name FROM candidates WHERE id = ?').get(req.session.candidateId);
    
    if (candidate) {
      // If they are logged in but haven't completed the mandatory fields, send them to finish
      if (!candidate.first_name) {
        return res.redirect('/signup.html?next=' + encodeURIComponent('/profile.html'));
      }
      return next();
    }
    
    req.session.candidateId = null;
  }
  const loginNext = safeNext(req.originalUrl || '/profile.html');
  return res.redirect('/signup.html?next=' + encodeURIComponent(loginNext));
}

// Allow the admin HTML page to load (so the login screen can be seen)
app.get('/profile.html', requireAuthPage, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'profile.html'));
});

app.get(['/admin.html', '/admin'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

/* --------------------------------------------------------------------------
   File uploads
   -------------------------------------------------------------------------- */
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_EXT = /\.(pdf|doc|docx|docm|dot|dotx|rtf|odt|jpg|jpeg|png)$/i;

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.pdf':  return 'application/pdf';
    case '.doc':  return 'application/msword';
    case '.docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.docm': return 'application/vnd.ms-word.document.macroEnabled.12';
    case '.dot':  return 'application/msword';
    case '.dotx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.template';
    case '.rtf':  return 'application/rtf';
    case '.odt':  return 'application/vnd.oasis.opendocument.text';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.png':  return 'image/png';
    default:      return 'application/octet-stream';
  }
}

app.get('/uploads/:filename', (req, res, next) => {
  const requested = decodeURIComponent(req.params.filename);

  const basename = path.basename(requested);
  if (!basename || basename !== requested) {
    const clean = path.basename(requested.replace(/\\/g, '/'));
    if (clean && clean !== requested) return res.redirect(`/uploads/${encodeURIComponent(clean)}`);
  }

  const absolute = path.join(UPLOAD_DIR, basename);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    return res.status(404).type('text/plain').send('File not found.');
  }

  const type = contentTypeFor(basename);
  res.setHeader('Content-Type', type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');

  if (type === 'application/pdf' || type.startsWith('image/')) {
    res.setHeader('Content-Disposition', `inline; filename="${basename}"`);
  } else {
    res.setHeader('Content-Disposition', `attachment; filename="${basename}"`);
  }

  fs.createReadStream(absolute).pipe(res);
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const original = Buffer.from(file.originalname, 'latin1').toString('utf8');
      const ext = (path.extname(original) || '').toLowerCase();
      const stem = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      cb(null, `${stem}${ext}`);
    }
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const original = Buffer.from(file.originalname, 'latin1').toString('utf8');
    if (ALLOWED_EXT.test(original)) return cb(null, true);
    cb(new Error(
      'Only PDF, Word documents, or images (JPG/PNG) are allowed. ' +
      'Accepted extensions: .pdf, .doc, .docx, .docm, .dot, .dotx, .rtf, .odt, .jpg, .jpeg, .png.'
    ), false);
  }
});

function removeUpload(basename) {
  if (!basename) return;
  try {
    const p = path.join(UPLOAD_DIR, path.basename(basename));
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch { /* ignore */ }
}

/* --------------------------------------------------------------------------
   Helpers
   -------------------------------------------------------------------------- */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normaliseEmail = (value) => String(value || '').trim().toLowerCase();
const isValidEmail = (value) => EMAIL_RE.test(value);
const nowSeconds = () => Math.floor(Date.now() / 1000);

function generateCode() {
  return String(crypto.randomInt(100000, 1000000));
}

async function sendVerificationCode(email, code) {
  console.log(`[verify] code for ${email}: ${code}`);
  try {
    await mailer.sendMail({
      to: email,
      subject: 'Your Umzimvubu Recruitment Verification Code',
      text: `Your verification code is: ${code}\n\nThis code expires in 15 minutes.`,
      html: `<p>Your verification code is: <strong style="font-size: 24px;">${code}</strong></p><p>This code expires in 15 minutes.</p>`
    });
  } catch (err) {
    console.error(`[verify] Failed to send verification email to ${email}:`, err.message);
  }
}

async function issueVerificationCode(candidateId, email) {
  const code = generateCode();
  const expires = nowSeconds() + VERIFICATION_TTL_SECONDS;
  db.prepare(`
    UPDATE candidates SET verification_code = ?, verification_expires = ?, updated_at = strftime('%s','now')
     WHERE id = ?
  `).run(code, expires, candidateId);
  
  await sendVerificationCode(email, code);
  return code;
}

const findCandidateByEmail = db.prepare('SELECT * FROM candidates WHERE email = ?');

function mergeClosingDateTime(date, time) {
  const d = String(date || '').trim();
  const t = String(time || '').trim();
  if (!d) return null;
  if (!t) return d;
  const m = t.match(/^(\d{2}):(\d{2})/);
  return m ? `${d}T${m[1]}:${m[2]}` : d;
}

/* ==========================================================================
   PUBLIC — JOBS
   ========================================================================== */
app.get('/api/jobs', (req, res) => {
  try {
    const search = String(req.query.search || req.query.q || req.query.keyword || '').trim();
    const category = String(req.query.category || req.query.cat || '').trim();

    let sql = `
      SELECT id, title, category, location, description, requirements, closing_date, is_open, archived, created_at
        FROM jobs
       WHERE is_open = 1 AND archived = 0
    `;
    const params = [];

    if (search) {
      sql += ` AND (title LIKE ? OR description LIKE ? OR requirements LIKE ? OR category LIKE ?)`;
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }
    if (category && !['all categories', 'all'].includes(category.toLowerCase())) {
      sql += ` AND category = ?`;
      params.push(category);
    }
    sql += ` ORDER BY created_at DESC`;

    const jobs = db.prepare(sql).all(...params);
    jobs.forEach((j) => db.annotateOpenState(j));

    res.json({ ok: true, jobs, count: jobs.length });
  } catch (err) {
    console.error('[api/jobs] failed:', err);
    res.status(500).json({ ok: false, error: 'Could not load jobs.' });
  }
});

app.get('/api/jobs/:id', (req, res) => {
  try {
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(Number(req.params.id));
    if (!job) return res.status(404).json({ ok: false, error: 'Job not found.' });
    if (Number(job.archived) === 1) {
      return res.status(404).json({ ok: false, error: 'Job not found.' });
    }
    db.annotateOpenState(job);
    res.json({ ok: true, job });
  } catch (err) {
    console.error('[api/jobs/:id] failed:', err);
    res.status(500).json({ ok: false, error: 'Could not load job.' });
  }
});

app.get('/api/categories', (_req, res) => {
  try {
    const rows = db.prepare(`
      SELECT DISTINCT category FROM jobs
       WHERE is_open = 1 AND archived = 0 AND category IS NOT NULL AND category <> ''
       ORDER BY category
    `).all();
    res.json({ ok: true, categories: rows.map((r) => r.category) });
  } catch (err) {
    console.error('[api/categories] failed:', err);
    res.status(500).json({ ok: false, error: 'Could not load categories.' });
  }
});

const escapeHtmlServer = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

app.post('/api/apply', async (req, res) => {
  const email = normaliseEmail(req.body?.email);
  const jobId = Number(req.body?.jobId ?? req.body?.job_id);

  if (!isValidEmail(email)) {
    return res.status(400).json({ ok: false, code: 'BAD_EMAIL', error: 'Please enter a valid email address.' });
  }

  const candidate = findCandidateByEmail.get(email);
  if (!candidate) {
    return res.status(404).json({
      ok: false, code: 'NOT_REGISTERED',
      error: 'That email is not registered with the ULM Talent Community.'
    });
  }
  if (candidate.verified !== 1 || !candidate.first_name) {
    return res.status(403).json({
      ok: false, code: 'PROFILE_INCOMPLETE',
      error: 'Please finish verifying your email and completing your profile before applying.'
    });
  }

  const job = db.prepare('SELECT id, title, closing_date, is_open, archived FROM jobs WHERE id = ?').get(jobId);
  if (!job) return res.status(404).json({ ok: false, code: 'JOB_CLOSED', error: 'Job not found.' });

  if (!db.isEffectivelyOpen(job)) {
    return res.status(410).json({
      ok: false,
      code: 'JOB_CLOSED',
      error: 'This position has closed. Applications are no longer accepted.'
    });
  }

  const existing = db.prepare('SELECT id FROM applications WHERE candidate_id = ? AND job_id = ?')
    .get(candidate.id, jobId);
  if (existing) {
    return res.json({
      ok: true, alreadyApplied: true,
      message: `You have already applied for "${job.title}" with ${email}.`
    });
  }

  const info = db.prepare('INSERT INTO applications (candidate_id, job_id) VALUES (?, ?)')
    .run(candidate.id, jobId);

  const name = [candidate.first_name, candidate.last_name].filter(Boolean).join(' ');
  const ref = `ULM-${String(info.lastInsertRowid).padStart(5, '0')}`;
  const closing = job.closing_date || 'Open until filled';

  let mailResult = { delivered: false, transport: 'none' };
  try {
    mailResult = await mailer.sendMail({
      to: email,
      subject: `Application received — ${job.title} (${ref})`,
      text:
        `Dear ${name},\n\n` +
        `We have received your application for: ${job.title}\n` +
        `Reference: ${ref}\n` +
        `Closing date: ${closing}\n\n` +
        `Your application is linked to ${email}. We will contact you on this address.\n\n` +
        `Umzimvubu Local Municipality\n`,
      html:
        `<p>Dear ${escapeHtmlServer(name)},</p>` +
        `<p>We have received your application for <strong>${escapeHtmlServer(job.title)}</strong>.</p>` +
        `<p>Reference: <strong>${ref}</strong><br>Closing date: ${escapeHtmlServer(closing)}</p>` +
        `<p>Your application is linked to ${escapeHtmlServer(email)}. We will contact you on this address.</p>` +
        `<p>Umzimvubu Local Municipality</p>`
    });
  } catch (err) {
    console.error('[apply] confirmation email failed:', err.message);
  }

  res.json({
    ok: true,
    reference: ref,
    emailedTo: email,
    message: `Applied for "${job.title}" and email sent to ${email}.`,
    devNote: mailResult.transport === 'console'
      ? 'Dev mode: no SMTP configured, so the email was printed in the server terminal.'
      : ''
  });
});

/* ==========================================================================
   SIGNUP / AUTH
   ========================================================================== */
app.post('/api/subscribe', async (req, res) => {
  const email = normaliseEmail(req.body?.email);
  if (!isValidEmail(email)) return res.status(400).json({ ok: false, error: 'Please enter a valid email.' });

  const candidate = findCandidateByEmail.get(email);
  if (candidate) {
    if (candidate.verified === 1 && candidate.first_name) {
      req.session.candidateId = candidate.id;
      return res.json({ ok: true, status: 'profile_exists', hasProfile: true });
    }
    if (candidate.verified === 1) {
      req.session.candidateId = candidate.id;
      return res.json({ ok: true, status: 'registered', registered: true });
    }
    await issueVerificationCode(candidate.id, email);
    return res.json({ ok: true, status: 'new' });
  }

  const info = db.prepare('INSERT INTO candidates (email, verified) VALUES (?, 0)').run(email);
  await issueVerificationCode(info.lastInsertRowid, email);
  res.json({ ok: true, status: 'new' });
});

app.post('/api/verify', (req, res) => {
  const email = normaliseEmail(req.body?.email);
  const code = String(req.body?.code || '').trim();

  const candidate = db
    .prepare('SELECT id, verification_code, verification_expires FROM candidates WHERE email = ?')
    .get(email);

  if (!candidate) return res.status(404).json({ ok: false, error: 'Email not found. Please start again.' });
  if (!code || code !== candidate.verification_code) {
    return res.status(400).json({ ok: false, error: 'Incorrect code. Please try again.' });
  }
  if (candidate.verification_expires && candidate.verification_expires < nowSeconds()) {
    return res.status(400).json({ ok: false, error: 'This code has expired. Please request a new one.' });
  }

  db.prepare(`
    UPDATE candidates SET verified = 1, verification_code = NULL, verification_expires = NULL,
           updated_at = strftime('%s','now')
     WHERE id = ?
  `).run(candidate.id);

  req.session.candidateId = candidate.id;
  res.json({ ok: true });
});

app.post('/api/resend', async (req, res) => {
  const email = normaliseEmail(req.body?.email);
  const candidate = db.prepare('SELECT id FROM candidates WHERE email = ?').get(email);
  if (!candidate) return res.status(404).json({ ok: false, error: 'Email not found. Please start again.' });
  await issueVerificationCode(candidate.id, email);
  res.json({ ok: true });
});

/* ==========================================================================
   CANDIDATE PORTAL (Login / Profile Management)
   ========================================================================== */
app.post('/api/candidate/login', async (req, res) => {
  const email = normaliseEmail(req.body?.email);
  if (!isValidEmail(email)) return res.status(400).json({ ok: false, error: 'Please enter a valid email.' });

  const candidate = findCandidateByEmail.get(email);
  if (!candidate) {
    return res.status(404).json({ ok: false, error: 'Email not found. Please join the Talent Community first.' });
  }

  await issueVerificationCode(candidate.id, email);
  res.json({ ok: true, status: 'code_sent' });
});

app.post('/api/candidate/verify', (req, res) => {
  const email = normaliseEmail(req.body?.email);
  const code = String(req.body?.code || '').trim();

  const candidate = db
    .prepare('SELECT id, verification_code, verification_expires FROM candidates WHERE email = ?')
    .get(email);

  if (!candidate) return res.status(404).json({ ok: false, error: 'Email not found.' });
  if (!code || code !== candidate.verification_code) {
    return res.status(400).json({ ok: false, error: 'Incorrect code. Please try again.' });
  }
  if (candidate.verification_expires && candidate.verification_expires < nowSeconds()) {
    return res.status(400).json({ ok: false, error: 'This code has expired. Please request a new one.' });
  }

  db.prepare(`
    UPDATE candidates SET verified = 1, verification_code = NULL, verification_expires = NULL,
           updated_at = strftime('%s','now')
     WHERE id = ?
  `).run(candidate.id);

  req.session.candidateId = candidate.id;
  res.json({ ok: true, candidateId: candidate.id });
});

app.post('/api/candidate/logout', (req, res) => {
  req.session.candidateId = null;
  res.json({ ok: true });
});

app.get('/api/candidate/profile', (req, res) => {
  if (!req.session?.candidateId) {
    return res.status(401).json({ ok: false, error: 'Not logged in.' });
  }

  const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.session.candidateId);
  if (!candidate) {
    req.session.candidateId = null;
    return res.status(401).json({ ok: false, error: 'Candidate not found.' });
  }

  const education = db.prepare('SELECT * FROM education WHERE candidate_id = ? ORDER BY id').all(candidate.id);
  const experience = db.prepare('SELECT * FROM experience WHERE candidate_id = ? ORDER BY id').all(candidate.id);
  const documents = db.prepare('SELECT id, doc_type, filename, uploaded_at FROM candidate_documents WHERE candidate_id = ? ORDER BY uploaded_at DESC').all(candidate.id);

  delete candidate.verification_code;
  delete candidate.verification_expires;

  res.json({ ok: true, candidate, education, experience, documents });
});

/* ==========================================================================
   PROFILE (Update)
   ========================================================================== */
const DOC_FIELD_NAMES = [
  'cv', 'coverLetter', 'idCopy', 'proofOfResidence', 'grade12',
  'diploma', 'saps', 'medical', 'driversLicence', 'qualification', 'other'
];

const FIELD_TO_DOC_TYPE = {
  coverLetter:      'cover_letter',
  idCopy:           'id_copy',
  proofOfResidence: 'proof_of_residence',
  grade12:          'grade_12',
  diploma:          'diploma',
  saps:             'saps',
  medical:          'medical',
  driversLicence:   'drivers_licence',
  qualification:    'qualification',
  other:            'other'
};

const uploadFields = DOC_FIELD_NAMES.map((name) => ({ name, maxCount: 1 }));

app.post(
  '/api/profile',
  upload.fields(uploadFields),
  async (req, res) => {
    const body = req.body || {};

    if (!req.session?.candidateId) {
      return res.status(401).json({ ok: false, error: 'Not logged in. Please verify your email first.' });
    }

    const existing = db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.session.candidateId);
    if (!existing) {
      req.session.candidateId = null;
      return res.status(401).json({ ok: false, error: 'Candidate not found.' });
    }

    const email = existing.email;

    if (!body.firstName || !body.lastName || !body.phoneNumber) {
      return res.status(400).json({ ok: false, error: 'First name, last name and phone are required.' });
    }

    const cvFile = req.files?.cv?.[0];
    const created = false;

    const cvBasename = cvFile ? path.basename(cvFile.path) : null;

    if (cvBasename && existing?.cv_path && path.basename(existing.cv_path) !== cvBasename) {
      removeUpload(existing.cv_path);
    }

    const upsert = db.prepare(`
      INSERT INTO candidates (
        email, title, first_name, middle_name, last_name, phone_country_code, phone_number,
        preferred_job_category, preferred_job_location, country, street_number, complex_name,
        unit_number, street_name, suburb, city, postal_code, receive_job_alerts, receive_marketing,
        cv_path, verified, updated_at
      ) VALUES (
        @email, @title, @firstName, @middleName, @lastName, @phoneCountryCode, @phoneNumber,
        @preferredJobCategory, @preferredJobLocation, @country, @streetNumber, @complexName,
        @unitNumber, @streetName, @suburb, @city, @postalCode, @receiveJobAlerts, @receiveMarketing,
        @cvPath, 1, strftime('%s','now')
      )
      ON CONFLICT(email) DO UPDATE SET
        title = excluded.title, first_name = excluded.first_name, middle_name = excluded.middle_name,
        last_name = excluded.last_name, phone_country_code = excluded.phone_country_code,
        phone_number = excluded.phone_number, preferred_job_category = excluded.preferred_job_category,
        preferred_job_location = excluded.preferred_job_location, country = excluded.country,
        street_number = excluded.street_number, complex_name = excluded.complex_name,
        unit_number = excluded.unit_number, street_name = excluded.street_name,
        suburb = excluded.suburb, city = excluded.city, postal_code = excluded.postal_code,
        receive_job_alerts = excluded.receive_job_alerts, receive_marketing = excluded.receive_marketing,
        cv_path = COALESCE(excluded.cv_path, candidates.cv_path),
        updated_at = strftime('%s','now')
    `);

    const insertEducation = db.prepare(`
      INSERT INTO education (
        candidate_id, degree, major, school, start_month, start_year, end_month, end_year,
        education_level, country, city, average_grade, year_acquired
      ) VALUES (
        @candidateId, @degree, @major, @school, @startMonth, @startYear, @endMonth, @endYear,
        @educationLevel, @country, @city, @averageGrade, @yearAcquired
      )
    `);

    const insertExperience = db.prepare(`
      INSERT INTO experience (
        candidate_id, employer_name, job_title, start_month, start_year, end_month, end_year,
        is_current, employer_country, employer_city, responsibilities
      ) VALUES (
        @candidateId, @employerName, @jobTitle, @startMonth, @startYear, @endMonth, @endYear,
        @isCurrent, @employerCountry, @employerCity, @responsibilities
      )
    `);

    const insertDoc = db.prepare(`
      INSERT INTO candidate_documents (candidate_id, doc_type, filename)
      VALUES (?, ?, ?)
    `);

    const save = db.transaction(() => {
      upsert.run({
        email,
        title: body.title || '',
        firstName: body.firstName || '',
        middleName: body.middleName || '',
        lastName: body.lastName || '',
        phoneCountryCode: body.phoneCountryCode || '+27',
        phoneNumber: body.phoneNumber || '',
        preferredJobCategory: body.preferredJobCategory || '',
        preferredJobLocation: body.preferredJobLocation || '',
        country: body.country || '',
        streetNumber: body.streetNumber || '',
        complexName: body.complexName || '',
        unitNumber: body.unitNumber || '',
        streetName: body.streetName || '',
        suburb: body.suburb || '',
        city: body.city || '',
        postalCode: body.postalCode || '',
        receiveJobAlerts: body.receiveJobAlerts ? 1 : 0,
        receiveMarketing: body.receiveMarketing ? 1 : 0,
        cvPath: cvBasename
      });

      const candidateId = req.session.candidateId;
      db.prepare('DELETE FROM education  WHERE candidate_id = ?').run(candidateId);
      db.prepare('DELETE FROM experience WHERE candidate_id = ?').run(candidateId);

      let education = [];
      let experience = [];
      try { education = JSON.parse(body.education || '[]'); } catch { /* ignore */ }
      try { experience = JSON.parse(body.experience || '[]'); } catch { /* ignore */ }

      // Safely map education rows so no parameters are missing
      education.forEach((row) => {
        insertEducation.run({
          candidateId,
          degree: row.degree || '',
          major: row.major || '',
          school: row.school || '',
          startMonth: row.startMonth || '',
          startYear: row.startYear || '',
          endMonth: row.endMonth || '',
          endYear: row.endYear || '',
          educationLevel: row.educationLevel || '',
          country: row.country || '',
          city: row.city || '',
          averageGrade: row.averageGrade || '',
          yearAcquired: row.yearAcquired || ''
        });
      });

      // Safely map experience rows so no parameters are missing
      experience.forEach((row) => {
        insertExperience.run({
          candidateId,
          employerName: row.employerName || '',
          jobTitle: row.jobTitle || '',
          startMonth: row.startMonth || '',
          startYear: row.startYear || '',
          endMonth: row.endMonth || '',
          endYear: row.endYear || '',
          isCurrent: row.isCurrent ? 1 : 0,
          employerCountry: row.employerCountry || '',
          employerCity: row.employerCity || '',
          responsibilities: row.responsibilities || ''
        });
      });

      const cleanup = db.prepare('DELETE FROM candidate_documents WHERE candidate_id = ? AND doc_type = ?');
      for (const [field, type] of Object.entries(FIELD_TO_DOC_TYPE)) {
        const file = req.files?.[field]?.[0];
        if (!file) continue;
        cleanup.run(candidateId, type);
        insertDoc.run(candidateId, type, path.basename(file.path));
      }
    });

    try { save(); }
    catch (error) {
      console.error('[profile]', error);
      return res.status(500).json({ ok: false, error: 'Could not save your profile.' });
    }

    let cv = null;
    try {
      cv = await ats.processCandidateWithDocuments(db, req.session.candidateId);
    } catch (e) {
      console.error('[ats] parse failed:', e.message);
    }

    const warnings = cv?.cv?.warnings || [];

    res.json({
      ok: true,
      created: false,
      cvQuality: cv?.cv?.quality ?? null,
      cvWarnings: warnings,
      documentsIndexed: cv?.totalDocuments ?? 0
    });
  }
);

/* ==========================================================================
   ADMIN — shared bits
   ========================================================================== */
const audit = (adminId, event, detail, req) => db.logAudit(adminId, event, detail, req?.ip);

function resolveAdmin(username) {
  return db.getAdminByUsername(username) || db.ensureAdminRow();
}

const adminEmailFor = (admin) => (admin && admin.email) || process.env.ADMIN_EMAIL || '';

function validateNewPassword(admin, password, confirm) {
  const weak = db.checkPasswordStrength(password);
  if (weak) return weak;
  if (password !== confirm) {
    return { code: 'MISMATCH', error: 'The two passwords do not match.' };
  }
  if (db.passwordReused(admin, password)) {
    return { code: 'REUSED', error: 'Choose a password you have not used in your last 3 changes.' };
  }
  return null;
}

function startAdminSession(req, admin) {
  req.session.adminId = admin.id;
  req.session.adminUsername = admin.username;
  req.session.startedAt = Date.now();
  req.session.pendingAdminId = null;
  req.session.pendingTotp = false;
  req.session.resetAdminId = null;
}

/* ==========================================================================
   ADMIN — guard (for API)
   ========================================================================== */
function requireAdmin(req, res, next) {
  if (!req.session?.adminId) {
    return res.status(401).json({ ok: false, code: 'NOT_SIGNED_IN', error: 'Not signed in.' });
  }

  const admin = db.getAdminById(req.session.adminId);
  if (!admin) {
    req.session.adminId = null;
    return res.status(401).json({ ok: false, code: 'NOT_SIGNED_IN', error: 'Not signed in.' });
  }

  if (req.session.startedAt && Date.now() - req.session.startedAt > ADMIN_ABSOLUTE_MS) {
    audit(admin.id, 'session.absolute_expired', null, req);
    req.session.destroy(() => {});
    return res.status(401).json({ ok: false, code: 'SESSION_EXPIRED', error: 'Session expired. Log in again.' });
  }

  if (db.adminStatus(admin).expired) {
    req.session.pendingAdminId = admin.id;
    req.session.adminId = null;
    return res.status(403).json({
      ok: false, code: 'PASSWORD_EXPIRED', error: 'Your password has expired. Set a new one.'
    });
  }

  req.admin = admin;
  next();
}

/* ==========================================================================
   ADMIN — status / setup
   ========================================================================== */
app.get('/api/admin/status', (req, res) => {
  const admin = db.ensureAdminRow();
  const status = db.adminStatus(admin);

  res.json({
    ok: true,
    csrfToken: issueCsrf(req),
    signedIn: Boolean(req.session?.adminId),
    username: admin ? admin.username : db.ADMIN_USERNAME,
    email: mailer.maskEmail(adminEmailFor(admin)),
    hasEmail: Boolean(adminEmailFor(admin)),
    hasPassword: status.hasPassword,
    expired: status.expired,
    daysLeft: status.daysLeft,
    expiresAt: status.expiresAt,
    totpEnabled: Boolean(admin?.totp_enabled),
    minLength: db.PASSWORD_MIN_LENGTH,
    validDays: db.PASSWORD_VALID_DAYS,
    otpTtlMinutes: Math.round(ADMIN_OTP_TTL_SECONDS / 60),
    mailTransport: mailer.transportName,
    ipLocked: ADMIN_IPS.length > 0
  });
});

app.post('/api/admin/setup', (req, res) => {
  const requested = String(req.body?.username || '').trim();
  const email = normaliseEmail(req.body?.email);
  const password = String(req.body?.newPassword ?? '');
  const confirm = String(req.body?.confirmPassword ?? password);

  if (!isValidEmail(email)) {
    return res.status(400).json({ ok: false, code: 'EMAIL', error: 'A valid email is required for PIN resets.' });
  }

  let admin = resolveAdmin(requested);
  if (!admin) admin = db.createAdmin(requested || db.ADMIN_USERNAME, email);

  if (db.adminStatus(admin).hasPassword && req.body?.force !== true) {
    return res.status(409).json({
      ok: false, code: 'PASSWORD_EXISTS', error: 'A password is already set. Please log in instead.'
    });
  }

  if (requested && requested !== admin.username) {
    try { admin = db.renameAdmin(admin.id, requested); }
    catch { return res.status(409).json({ ok: false, code: 'USERNAME_TAKEN', error: 'That username is taken.' }); }
  }

  admin = db.setAdminEmail(admin.id, email);

  const invalid = validateNewPassword(admin, password, confirm);
  if (invalid) return res.status(400).json({ ok: false, ...invalid });

  const info = db.setAdminPassword(admin.id, password);
  startAdminSession(req, admin);
  audit(admin.id, 'password.set', null, req);
  res.json({ ok: true, username: admin.username, ...info });
});

/* ==========================================================================
   ADMIN — login
   ========================================================================== */
app.post('/api/admin/login', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const admin = resolveAdmin(username);

  if (!admin || !db.adminStatus(admin).hasPassword) {
    return res.status(409).json({ ok: false, code: 'NO_PASSWORD', error: 'No password has been set yet.' });
  }

  if (db.isAdminLocked(admin)) {
    const retry = Math.ceil((admin.locked_until - nowSeconds()) / 60);
    audit(admin.id, 'login.locked', null, req);
    return res.status(423).json({
      ok: false, code: 'LOCKED', retryAfterMinutes: retry,
      error: `Too many failed attempts. Try again in ${retry} minute(s).`
    });
  }

  if (!db.verifyAdminPassword(admin, password)) {
    const state = db.recordFailedLogin(admin.id);
    audit(admin.id, 'login.failed', `attempt ${state?.attempts}`, req);
    return res.status(401).json({
      ok: false, code: 'BAD_CREDENTIALS',
      error: state?.lockedUntil
        ? `Invalid credentials. Account locked for ${Math.round(db.LOCKOUT_SECONDS / 60)} minutes.`
        : 'Invalid username or password.'
    });
  }

  if (admin.totp_enabled) {
    req.session.pendingAdminId = admin.id;
    req.session.pendingTotp = true;
    audit(admin.id, 'login.totp_required', null, req);
    return res.status(401).json({ ok: false, code: 'TOTP_REQUIRED', error: 'Enter your 6-digit authenticator code.' });
  }

  const status = db.adminStatus(admin);
  if (status.expired) {
    req.session.pendingAdminId = admin.id;
    req.session.pendingTotp = false;
    audit(admin.id, 'login.password_expired', null, req);
    return res.status(403).json({
      ok: false, code: 'PASSWORD_EXPIRED', error: 'Your password is older than 30 days. Set a new one.'
    });
  }

  db.clearFailedLogins(admin.id);
  db.touchAdminLogin(admin.id);
  startAdminSession(req, admin);
  audit(admin.id, 'login.ok', null, req);
  res.json({ ok: true, username: admin.username, daysLeft: status.daysLeft });
});

app.post('/api/admin/login/totp', (req, res) => {
  const code = String(req.body?.code || '').replace(/\D/g, '');
  const admin = req.session?.pendingAdminId ? db.getAdminById(req.session.pendingAdminId) : null;

  if (!admin || !admin.totp_enabled) {
    return res.status(401).json({ ok: false, code: 'NO_PENDING', error: 'Start the login again.' });
  }

  if (!totp.verifyTotp(admin.totp_secret, code)) {
    db.recordFailedLogin(admin.id);
    audit(admin.id, 'login.totp_failed', null, req);
    return res.status(401).json({ ok: false, code: 'TOTP_INVALID', error: 'That code is not valid. Try the next one.' });
  }

  const status = db.adminStatus(admin);
  if (status.expired) {
    req.session.pendingTotp = false;
    audit(admin.id, 'login.password_expired', null, req);
    return res.status(403).json({
      ok: false, code: 'PASSWORD_EXPIRED', error: 'Your password is older than 30 days. Set a new one.'
    });
  }

  db.clearFailedLogins(admin.id);
  db.touchAdminLogin(admin.id);
  startAdminSession(req, admin);
  audit(admin.id, 'login.ok', 'totp', req);
  res.json({ ok: true, username: admin.username, daysLeft: status.daysLeft });
});

/* ==========================================================================
   ADMIN — password change
   ========================================================================== */
app.post('/api/admin/password', (req, res) => {
  const currentPassword = String(req.body?.currentPassword ?? '');
  const newPassword = String(req.body?.newPassword ?? '');
  const confirm = String(req.body?.confirmPassword ?? newPassword);

  const admin = req.session?.adminId
    ? db.getAdminById(req.session.adminId)
    : req.session?.pendingAdminId
      ? db.getAdminById(req.session.pendingAdminId)
      : null;

  if (!admin) return res.status(401).json({ ok: false, code: 'NOT_SIGNED_IN', error: 'Please log in again.' });

  if (!currentPassword) {
    return res.status(400).json({ ok: false, code: 'CURRENT_REQUIRED', error: 'Enter your current password.' });
  }
  if (!db.verifyAdminPassword(admin, currentPassword)) {
    return res.status(401).json({ ok: false, code: 'BAD_CREDENTIALS', error: 'Current password is incorrect.' });
  }

  const invalid = validateNewPassword(admin, newPassword, confirm);
  if (invalid) return res.status(400).json({ ok: false, ...invalid });

  const info = db.setAdminPassword(admin.id, newPassword);
  startAdminSession(req, admin);
  audit(admin.id, 'password.changed', null, req);
  res.json({ ok: true, username: admin.username, ...info });
});

/* ==========================================================================
   ADMIN — OTP password reset
   ========================================================================== */
app.post('/api/admin/forgot', async (req, res) => {
  const admin = resolveAdmin(req.body?.username);
  if (!admin) return res.status(404).json({ ok: false, error: 'No admin account found.' });

  const email = adminEmailFor(admin);
  const phone = String(process.env.ADMIN_PHONE || '').trim();

  if (!email && !phone && isProd) {
    return res.status(400).json({
      ok: false, code: 'NO_EMAIL',
      error: 'No admin email on file. Set ADMIN_EMAIL in the environment and restart.'
    });
  }

  const existing = db.latestAdminOtp(admin.id, 'reset');
  if (existing && !existing.consumed_at && existing.expires_at > nowSeconds()) {
    const age = nowSeconds() - existing.created_at;
    if (age < ADMIN_OTP_RESEND_COOLDOWN) {
      return res.json({
        ok: true, sent: false,
        email: mailer.maskEmail(email), phone: mailer.maskPhone(phone),
        devMode: !isProd,
        cooldownSeconds: ADMIN_OTP_RESEND_COOLDOWN - age,
        expiresInSeconds: existing.expires_at - nowSeconds()
      });
    }
  }

  const code = generateCode();
  db.createAdminOtp(admin.id, code, 'reset', ADMIN_OTP_TTL_SECONDS);

  const minutes = Math.round(ADMIN_OTP_TTL_SECONDS / 60);
  const subject = 'Umzimvubu admin password reset PIN';
  const text =
    `Your admin password reset PIN is: ${code}\n` +
    `It expires in ${minutes} minutes.\n` +
    `If you did not request this, ignore this message.`;

  const channels = new Set();

  if (email) {
    const r = await mailer.sendMail({
      to: email, subject, text,
      html:
        `<p>Your admin password reset PIN is <strong style="font-size:20px;letter-spacing:3px">${code}</strong></p>` +
        `<p>It expires in ${minutes} minutes.</p>`
    });
    channels.add(r.delivered ? 'email' : 'terminal');
  }

  if (phone) {
    const r = await mailer.sendSms({ to: phone, text: `ULM admin PIN: ${code} (expires in ${minutes} min)` });
    channels.add(r.delivered ? 'sms' : 'terminal');
  }

  if (!email && !phone) {
    mailer.devPrint('admin pin', 'admin (no email/phone on file)', subject, text);
    channels.add('terminal');
  }

  audit(admin.id, 'otp.sent', [...channels].join(','), req);
  res.json({
    ok: true, sent: true,
    email: mailer.maskEmail(email), phone: mailer.maskPhone(phone),
    channels: [...channels],
    devMode: !isProd,
    expiresInSeconds: ADMIN_OTP_TTL_SECONDS
  });
});

app.post('/api/admin/forgot/verify', (req, res) => {
  const admin = resolveAdmin(req.body?.username);
  if (!admin) return res.status(404).json({ ok: false, error: 'No admin account found.' });

  const code = String(req.body?.code || '').replace(/\D/g, '');
  const result = db.verifyAdminOtp(admin.id, code, 'reset');

  if (!result.ok) {
    audit(admin.id, 'otp.failed', result.code, req);
    return res.status(400).json({ ok: false, code: result.code, error: result.error });
  }

  req.session.resetAdminId = admin.id;
  req.session.resetVerifiedAt = Date.now();
  audit(admin.id, 'otp.verified', null, req);
  res.json({ ok: true, username: admin.username });
});

app.post('/api/admin/reset', (req, res) => {
  const admin = req.session?.resetAdminId ? db.getAdminById(req.session.resetAdminId) : null;
  const verifiedAt = req.session?.resetVerifiedAt || 0;

  if (!admin || Date.now() - verifiedAt > ADMIN_OTP_TTL_SECONDS * 1000) {
    req.session.resetAdminId = null;
    return res.status(401).json({ ok: false, code: 'RESET_NOT_VERIFIED', error: 'Verify your PIN first.' });
  }

  const newPassword = String(req.body?.newPassword ?? '');
  const confirm = String(req.body?.confirmPassword ?? newPassword);

  const invalid = validateNewPassword(admin, newPassword, confirm);
  if (invalid) return res.status(400).json({ ok: false, ...invalid });

  const info = db.setAdminPassword(admin.id, newPassword);
  db.clearAdminTotp(admin.id);
  db.clearFailedLogins(admin.id);

  req.session.resetAdminId = null;
  req.session.resetVerifiedAt = null;
  req.session.adminId = null;

  audit(admin.id, 'password.reset', 'otp', req);
  res.json({ ok: true, username: admin.username, ...info, totpCleared: true });
});

app.post('/api/admin/logout', (req, res) => {
  const id = req.session?.adminId;
  if (id) audit(id, 'logout', null, req);
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/admin/me', (req, res) => {
  res.json({ ok: true, signedIn: Boolean(req.session?.adminId) });
});

/* ==========================================================================
   ADMIN — 2FA
   ========================================================================== */
app.get('/api/admin/2fa', requireAdmin, (req, res) => {
  res.json({ ok: true, enabled: Boolean(req.admin.totp_enabled) });
});

app.post('/api/admin/2fa/setup', requireAdmin, (req, res) => {
  const secret = totp.generateSecret();
  req.session.totpPending = secret;

  res.json({
    ok: true,
    secret,
    otpauthUrl: totp.otpauthUrl({
      secret,
      label: req.admin.username,
      issuer: process.env.APP_NAME || 'Umzimvubu eRecruitment'
    })
  });
});

app.post('/api/admin/2fa/enable', requireAdmin, (req, res) => {
  const secret = req.session?.totpPending;
  const code = String(req.body?.code || '').replace(/\D/g, '');

  if (!secret) return res.status(400).json({ ok: false, code: 'NO_SECRET', error: 'Run the setup again.' });
  if (!totp.verifyTotp(secret, code)) {
    return res.status(400).json({ ok: false, code: 'TOTP_INVALID', error: 'That code did not match. Try the next one.' });
  }

  db.setAdminTotp(req.admin.id, secret, true);
  req.session.totpPending = null;
  audit(req.admin.id, 'totp.enabled', null, req);
  res.json({ ok: true });
});

app.post('/api/admin/2fa/disable', requireAdmin, (req, res) => {
  const password = String(req.body?.password || '');
  const code = String(req.body?.code || '').replace(/\D/g, '');

  if (!db.verifyAdminPassword(req.admin, password)) {
    return res.status(401).json({ ok: false, code: 'BAD_CREDENTIALS', error: 'Password is incorrect.' });
  }
  if (req.admin.totp_enabled && !totp.verifyTotp(req.admin.totp_secret, code)) {
    return res.status(400).json({ ok: false, code: 'TOTP_INVALID', error: 'That authenticator code is not valid.' });
  }

  db.clearAdminTotp(req.admin.id);
  audit(req.admin.id, 'totp.disabled', null, req);
  res.json({ ok: true });
});

/* ==========================================================================
   ADMIN — email on file
   ========================================================================== */
app.post('/api/admin/email', requireAdmin, (req, res) => {
  const email = normaliseEmail(req.body?.email);
  const password = String(req.body?.password || '');

  if (!isValidEmail(email)) return res.status(400).json({ ok: false, code: 'EMAIL', error: 'Enter a valid email.' });
  if (!db.verifyAdminPassword(req.admin, password)) {
    return res.status(401).json({ ok: false, code: 'BAD_CREDENTIALS', error: 'Password is incorrect.' });
  }

  db.setAdminEmail(req.admin.id, email);
  audit(req.admin.id, 'email.changed', mailer.maskEmail(email), req);
  res.json({ ok: true, email: mailer.maskEmail(email) });
});

/* ==========================================================================
   ADMIN — audit log
   ========================================================================== */
app.get('/api/admin/audit', requireAdmin, (_req, res) => {
  const events = db.prepare(`
    SELECT id, event, detail, ip, created_at FROM admin_audit ORDER BY id DESC LIMIT 100
  `).all();
  res.json({ ok: true, events });
});

/* ==========================================================================
   ADMIN — data
   ========================================================================== */
app.get('/api/admin/stats', requireAdmin, (_req, res) => {
  const count = (sql) => db.prepare(sql).get().c;
  res.json({
    ok: true,
    stats: {
      jobs: count('SELECT COUNT(*) AS c FROM jobs'),
      openJobs: count('SELECT COUNT(*) AS c FROM jobs WHERE is_open = 1 AND archived = 0'),
      archivedJobs: count('SELECT COUNT(*) AS c FROM jobs WHERE archived = 1'),
      candidates: count('SELECT COUNT(*) AS c FROM candidates'),
      applications: count('SELECT COUNT(*) AS c FROM applications')
    }
  });
});

app.get('/api/admin/llm-status', requireAdmin, async (_req, res) => {
  res.json({ ok: true, available: false, model: 'rules+ats', mode: 'local', url: '' });
});

/* --------------------------------------------------------------------------
   Candidates
   -------------------------------------------------------------------------- */
app.get('/api/admin/candidates', requireAdmin, (_req, res) => {
  const rows = db.prepare(`
    SELECT c.*,
           (SELECT COUNT(*) FROM applications a WHERE a.candidate_id = c.id) AS application_count
      FROM candidates c ORDER BY c.created_at DESC
  `).all();

  const candidates = rows.map((c) => ({
    ...c,
    cv_updated_at: c.cv_path ? new Date((c.updated_at || c.created_at) * 1000).toISOString() : null
  }));

  res.json({ ok: true, candidates, count: candidates.length });
});

app.get('/api/admin/candidates/export.csv', requireAdmin, (req, res) => {
  const rawIds = String(req.query.ids || '').trim();
  const ids = rawIds
    ? rawIds.split(',').map((n) => Number(n.trim())).filter((n) => Number.isInteger(n) && n > 0)
    : [];

  const baseSql = `
    SELECT c.id, c.title, c.first_name, c.middle_name, c.last_name,
           c.email, c.phone_country_code, c.phone_number,
           c.gender, c.city, c.suburb, c.country, c.postal_code,
           c.verified, c.cv_path, c.cover_letter_path, c.created_at, c.updated_at,
           (SELECT COUNT(*) FROM applications a WHERE a.candidate_id = c.id) AS application_count
      FROM candidates c
  `;

  const rows = ids.length
    ? db.prepare(`${baseSql} WHERE c.id IN (${ids.map(() => '?').join(',')}) ORDER BY c.id`).all(...ids)
    : db.prepare(`${baseSql} ORDER BY c.created_at DESC`).all();

  const header = [
    'ID', 'Title', 'First name', 'Middle name', 'Last name',
    'Email', 'Phone', 'Gender', 'City', 'Suburb', 'Country', 'Postal code',
    'Verified', 'Applications', 'CV file', 'CV updated', 'Registered at'
  ];

  const csvCell = (v) => `"${String(v ?? '').replace(/\r?\n/g, ' ').replace(/"/g, '""')}"`;
  const lines = [header.map(csvCell).join(',')];

  rows.forEach((r) => {
    lines.push([
      r.id, r.title || '', r.first_name || '', r.middle_name || '', r.last_name || '',
      r.email || '', [r.phone_country_code, r.phone_number].filter(Boolean).join(' '),
      r.gender || '', r.city || '', r.suburb || '', r.country || '', r.postal_code || '',
      r.verified ? 'Yes' : 'No', r.application_count ?? 0,
      r.cv_path || '',
      r.cv_path ? new Date((r.updated_at || r.created_at) * 1000).toISOString() : '',
      new Date((r.created_at || 0) * 1000).toISOString()
    ].map(csvCell).join(','));
  });

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="candidates_${stamp}.csv"`);
  res.send(lines.join('\r\n') + '\r\n');
});

app.delete('/api/admin/candidates', requireAdmin, (req, res) => {
  const ids = Array.isArray(req.body?.ids)
    ? req.body.ids.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0)
    : [];

  if (!ids.length) return res.status(400).json({ ok: false, error: 'No candidate ids supplied.' });

  const placeholders = ids.map(() => '?').join(',');
  const victims = db.prepare(`SELECT id, cv_path, cover_letter_path FROM candidates WHERE id IN (${placeholders})`).all(...ids);
  const attachments = db.prepare(`SELECT filename FROM candidate_documents WHERE candidate_id IN (${placeholders})`).all(...ids);

  if (!victims.length) return res.json({ ok: true, deleted: 0 });

  db.prepare(`DELETE FROM candidates WHERE id IN (${placeholders})`).run(...ids);
  try { ats.removeFromIndex(db, victims.map((v) => v.id)); } catch { /* ignore */ }

  victims.forEach((v) => {
    removeUpload(v.cv_path);
    removeUpload(v.cover_letter_path);
  });
  attachments.forEach((a) => removeUpload(a.filename));

  audit(req.admin.id, 'candidates.deleted', `${victims.length} candidate(s)`, req);
  res.json({ ok: true, deleted: victims.length });
});

app.get('/api/admin/candidates/:id/applications', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: 'Invalid candidate id.' });
  }

  const candidate = db.prepare('SELECT id, first_name, last_name, email FROM candidates WHERE id = ?').get(id);
  if (!candidate) return res.status(404).json({ ok: false, error: 'Candidate not found.' });

  const appCols = db.prepare('PRAGMA table_info(applications)').all().map((c) => c.name);
  const hasLlmVerdict  = appCols.includes('llm_verdict');
  const hasLlmScreened = appCols.includes('llm_screened_at');

  const select = `
    SELECT a.id AS application_id, a.status AS application_status, a.applied_at,
           j.id AS job_id, j.title AS job_title, j.category AS job_category,
           j.closing_date AS job_closing_date, j.is_open AS job_is_open,
           ${hasLlmVerdict  ? 'a.llm_verdict' : 'NULL AS llm_verdict'},
           ${hasLlmScreened ? 'a.llm_screened_at' : 'NULL AS llm_screened_at'}
      FROM applications a
      JOIN jobs j ON j.id = a.job_id
     WHERE a.candidate_id = ?
     ORDER BY a.applied_at DESC
  `;

  const rows = db.prepare(select).all(id);

  const applications = rows.map((r) => {
    const verdict = r.llm_verdict || null;
    const applicationNo = `ULM-${String(r.job_id).padStart(3, '0')}-${String(r.application_id).padStart(5, '0')}`;
    return {
      applicationId: r.application_id,
      applicationNo,
      status: r.application_status,
      appliedAt: r.applied_at,
      job: {
        id: r.job_id, title: r.job_title, category: r.job_category,
        closing_date: r.job_closing_date, is_open: Number(r.job_is_open) === 1
      },
      verdict,
      screened: Boolean(verdict),
      masterlistBuiltAt: r.llm_screened_at ? new Date(r.llm_screened_at * 1000).toISOString() : null
    };
  });

  res.json({
    ok: true,
    candidate: {
      id: candidate.id,
      name: [candidate.first_name, candidate.last_name].filter(Boolean).join(' '),
      email: candidate.email
    },
    total: applications.length,
    applications
  });
});

app.get('/api/admin/candidates/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: 'Invalid candidate id.' });
  }

  const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
  if (!candidate) return res.status(404).json({ ok: false, error: 'Candidate not found.' });

  const education = db.prepare('SELECT * FROM education  WHERE candidate_id = ? ORDER BY id').all(id);
  const experience = db.prepare('SELECT * FROM experience WHERE candidate_id = ? ORDER BY id').all(id);
  const applications = db.prepare(`
    SELECT a.id, a.status, a.applied_at, j.title AS job_title, j.category AS job_category
      FROM applications a JOIN jobs j ON j.id = a.job_id
     WHERE a.candidate_id = ? ORDER BY a.applied_at DESC
  `).all(id);
  const documents = db.prepare('SELECT id, doc_type, filename, uploaded_at, indexed_at FROM candidate_documents WHERE candidate_id = ? ORDER BY uploaded_at DESC').all(id);

  const parsed = candidate.cv_parsed ? JSON.parse(candidate.cv_parsed) : null;
  delete candidate.cv_text;

  res.json({ ok: true, candidate, education, experience, applications, documents, cvParsed: parsed });
});

app.get('/api/admin/applications', requireAdmin, (_req, res) => {
  const applications = db.prepare(`
    SELECT a.id, a.status, a.applied_at,
           c.id AS candidate_id, c.first_name, c.last_name, c.email, c.phone_number, c.cv_path,
           j.id AS job_id, j.title AS job_title, j.category AS job_category
      FROM applications a
      JOIN candidates c ON c.id = a.candidate_id
      JOIN jobs       j ON j.id = a.job_id
     ORDER BY a.applied_at DESC
  `).all();
  res.json({ ok: true, applications, count: applications.length });
});

app.patch('/api/admin/applications/:id', requireAdmin, (req, res) => {
  const status = String(req.body?.status || '').trim();
  if (!status) return res.status(400).json({ ok: false, error: 'Status is required.' });

  const info = db.prepare('UPDATE applications SET status = ? WHERE id = ?')
    .run(status, Number(req.params.id));
  if (!info.changes) return res.status(404).json({ ok: false, error: 'Application not found.' });
  res.json({ ok: true });
});

/* --------------------------------------------------------------------------
   Admin — jobs
   -------------------------------------------------------------------------- */
app.get('/api/admin/jobs', requireAdmin, (req, res) => {
  try {
    const includeArchived = String(req.query.includeArchived || '') === '1';

    const sql = includeArchived
      ? 'SELECT * FROM jobs ORDER BY archived ASC, created_at DESC'
      : 'SELECT * FROM jobs WHERE archived = 0 ORDER BY created_at DESC';

    const jobs = db.prepare(sql).all();
    jobs.forEach((j) => db.annotateOpenState(j));

    const archivedCount = db.prepare('SELECT COUNT(*) AS c FROM jobs WHERE archived = 1').get().c;

    res.json({ ok: true, jobs, count: jobs.length, archivedCount, includeArchived });
  } catch (err) {
    console.error('[api/admin/jobs] failed:', err);
    res.status(500).json({ ok: false, error: 'Could not load jobs.' });
  }
});

app.post('/api/admin/jobs', requireAdmin, (req, res) => {
  const b = req.body || {};
  if (!b.title) return res.status(400).json({ ok: false, error: 'Title is required.' });

  const closing = mergeClosingDateTime(
    b.closingDate || b.closing_date,
    b.closingTime || b.closing_time
  );

  const info = db.prepare(`
    INSERT INTO jobs (title, category, location, description, requirements, closing_date, is_open, archived)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    b.title, b.category || '', b.location || 'Umzimvubu, Eastern Cape, South Africa',
    b.description || '', b.requirements || '', closing,
    b.isOpen === false || b.is_open === 0 ? 0 : 1
  );

  audit(req.admin.id, 'job.created', `#${info.lastInsertRowid} ${b.title}`, req);
  res.json({ ok: true, id: info.lastInsertRowid, closing });
});

app.put('/api/admin/jobs/:id', requireAdmin, (req, res) => {
  const b = req.body || {};
  const job = db.prepare('SELECT id FROM jobs WHERE id = ?').get(Number(req.params.id));
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found.' });

  let closingProvided = false;
  let closingValue = null;
  if (b.closingDate !== undefined || b.closing_date !== undefined
      || b.closingTime !== undefined || b.closing_time !== undefined) {
    closingProvided = true;
    closingValue = mergeClosingDateTime(
      b.closingDate ?? b.closing_date,
      b.closingTime ?? b.closing_time
    );
  }

  if (closingProvided) {
    db.prepare(`
      UPDATE jobs
         SET title = COALESCE(?, title), category = COALESCE(?, category), location = COALESCE(?, location),
             description = COALESCE(?, description), requirements = COALESCE(?, requirements),
             closing_date = ?, is_open = COALESCE(?, is_open)
       WHERE id = ?
    `).run(
      b.title ?? null, b.category ?? null, b.location ?? null, b.description ?? null,
      b.requirements ?? null, closingValue,
      b.isOpen === undefined ? null : (b.isOpen ? 1 : 0), job.id
    );
  } else {
    db.prepare(`
      UPDATE jobs
         SET title = COALESCE(?, title), category = COALESCE(?, category), location = COALESCE(?, location),
             description = COALESCE(?, description), requirements = COALESCE(?, requirements),
             is_open = COALESCE(?, is_open)
       WHERE id = ?
    `).run(
      b.title ?? null, b.category ?? null, b.location ?? null, b.description ?? null,
      b.requirements ?? null,
      b.isOpen === undefined ? null : (b.isOpen ? 1 : 0), job.id
    );
  }

  audit(req.admin.id, 'job.updated', `#${job.id}`, req);
  res.json({ ok: true });
});

app.post('/api/admin/jobs/:id/archive', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: 'Invalid job id.' });
  }

  const job = db.prepare('SELECT id, title, archived FROM jobs WHERE id = ?').get(id);
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found.' });

  db.prepare('UPDATE jobs SET archived = 1, archived_at = ? WHERE id = ?').run(nowSeconds(), id);

  audit(req.admin.id, 'job.archived', `#${id} ${job.title}`, req);
  res.json({ ok: true, id, archived: true });
});

app.post('/api/admin/jobs/:id/unarchive', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: 'Invalid job id.' });
  }

  const job = db.prepare('SELECT id, title, archived FROM jobs WHERE id = ?').get(id);
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found.' });

  db.prepare('UPDATE jobs SET archived = 0, archived_at = NULL WHERE id = ?').run(id);

  audit(req.admin.id, 'job.unarchived', `#${id} ${job.title}`, req);
  res.json({ ok: true, id, archived: false });
});

app.delete('/api/admin/jobs/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM jobs WHERE id = ?').run(Number(req.params.id));
  audit(req.admin.id, 'job.deleted', `#${req.params.id}`, req);
  res.json({ ok: true });
});

/* ==========================================================================
   ADMIN — ATS search
   ========================================================================== */
app.get('/api/admin/ats/search', requireAdmin, (req, res) => {
  try {
    const results = ats.search(db, { q: req.query.q, jobId: req.query.jobId, limit: req.query.limit });
    res.json({ ok: true, count: results.length, results });
  } catch (err) {
    if (err.code === 'BAD_QUERY') {
      return res.status(400).json({ ok: false, code: 'BAD_QUERY', error: err.message });
    }
    console.error('[ats/search]', err);
    res.status(500).json({ ok: false, error: 'Search failed.' });
  }
});

app.post('/api/admin/ats/reindex', requireAdmin, async (req, res) => {
  try {
    const r = await ats.reindexAll(db);
    audit(req.admin.id, 'ats.reindex', `${r.indexed}/${r.total}`, req);
    res.json({ ok: true, ...r });
  } catch (err) {
    console.error('[ats/reindex]', err);
    res.status(500).json({ ok: false, error: 'Reindex failed.' });
  }
});

/* ==========================================================================
   ADMIN — master list
   ========================================================================== */
app.get('/api/admin/jobs/:id/masterlist', requireAdmin, async (req, res) => {
  const jobId = Number(req.params.id);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    return res.status(400).json({ ok: false, code: 'BAD_ID', error: 'Invalid job id.' });
  }

  try {
    const result = await masterlist.buildMasterLists(db, jobId);

    if (!result.job.archived && db.isEffectivelyOpen(result.job)) {
      return res.status(409).json({
        ok: false, code: 'JOB_OPEN',
        error: 'This position is still open. The master list is only available after the closing moment.'
      });
    }

    try {
      const appCols = db.prepare('PRAGMA table_info(applications)').all().map((c) => c.name);
      const hasVerdict = appCols.includes('llm_verdict');
      const hasScreened = appCols.includes('llm_screened_at');
      if (hasVerdict || hasScreened) {
        const sets = [];
        if (hasVerdict) sets.push('llm_verdict = ?');
        if (hasScreened) sets.push('llm_screened_at = ?');
        sets.push('id = id');
        const updateApp = db.prepare(`UPDATE applications SET ${sets.join(', ')} WHERE id = ?`);
        const persist = db.transaction((rows) => {
          for (const r of rows) {
            const params = [];
            if (hasVerdict) params.push(r.verdict || null);
            if (hasScreened) params.push(nowSeconds());
            params.push(r.applicationId);
            updateApp.run(...params);
          }
        });
        persist([...result.qualified, ...result.unqualified]);
      }
    } catch { /* ignore */ }

    res.json({
      ok: true,
      job: {
        id: result.job.id,
        title: result.job.title,
        closing_date: result.job.closing_date,
        archived: Number(result.job.archived) === 1
      },
      counts: {
        total: result.total,
        qualified: result.qualified.length,
        unqualified: result.unqualified.length
      },
      screening: { mode: 'rules+ats', llmUsed: false },
      qualified: result.qualified,
      unqualified: result.unqualified
    });
  } catch (err) {
    if (err.code === 'JOB_NOT_FOUND') {
      return res.status(404).json({ ok: false, code: 'JOB_NOT_FOUND', error: 'Job not found.' });
    }
    console.error('[masterlist] build failed:', err);
    res.status(500).json({
      ok: false,
      code: 'BUILD_FAILED',
      error: err.message || 'Could not build the master list.'
    });
  }
});

app.get('/api/admin/jobs/:id/masterlist.csv', requireAdmin, async (req, res) => {
  const jobId = Number(req.params.id);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    return res.status(400).json({ ok: false, code: 'BAD_ID', error: 'Invalid job id.' });
  }

  try {
    const { job, qualified, unqualified } = await masterlist.buildMasterLists(db, jobId);

    if (!job.archived && db.isEffectivelyOpen(job)) {
      return res.status(409).json({
        ok: false,
        code: 'JOB_OPEN',
        error: 'This position is still open. The master list is only available after the closing moment.'
      });
    }

    const csv = masterlist.toCsv([
      ...qualified.map(r => ({ ...r, status: 'Qualified' })),
      ...unqualified.map(r => ({ ...r, status: 'Unqualified' }))
    ]);

    const safeTitle = job.title.replace(/[^a-z0-9]+/gi, '_').slice(0, 60);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="masterlist_job${job.id}_${safeTitle}.csv"`);
    res.send(csv);
  } catch (err) {
    if (err.code === 'JOB_NOT_FOUND') {
      return res.status(404).json({ ok: false, code: 'JOB_NOT_FOUND', error: 'Job not found.' });
    }
    console.error('[masterlist] csv failed:', err);
    res.status(500).json({ ok: false, code: 'BUILD_FAILED', error: err.message || 'Could not export master list.' });
  }
});

/* ==========================================================================
   STATIC FILES  (must come LAST so protected HTML routes win)
   ========================================================================== */
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res) => {
  res.status(404).type('text/plain').send('Not found.');
});

/* -------------------------------------------------------------------------- */
app.listen(PORT, () => {
  console.log(`Umzimvubu recruitment API on http://localhost:${PORT}`);
  if (ADMIN_IPS.length) console.log(`[admin] IP allowlist active: ${ADMIN_IPS.join(', ')}`);
});