'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const db = new Database(path.join(__dirname, 'database.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/* ==========================================================================
   Policy
   ========================================================================== */
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_VALID_DAYS = 30;
const PASSWORD_VALID_SECONDS = PASSWORD_VALID_DAYS * 24 * 60 * 60;
const PASSWORD_HISTORY_DEPTH = 3;
const BCRYPT_ROUNDS = 12;

const PASSWORD_REQUIREMENTS = {
  minLength: PASSWORD_MIN_LENGTH,
  upper: /[A-Z]/,
  lower: /[a-z]/,
  digit: /[0-9]/,
  special: /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`]/
};

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '12345678', '123456789',
  '1234567890', '12345678901', 'qwerty', 'qwerty123', 'admin',
  'admin123', 'administrator', 'welcome', 'welcome1', 'letmein',
  'changeme', 'iloveyou', 'monkey', 'dragon', 'football', 'baseball',
  'abc123', 'abcd1234', 'p@ssw0rd', 'passw0rd', 'umzimvubu', 'ulmadmin'
]);

const OTP_SECRET = process.env.OTP_SECRET || process.env.SESSION_SECRET || 'ulm-otp-secret-change-me';
const OTP_MAX_ATTEMPTS = 5;

const MAX_LOGIN_FAILURES = 5;
const LOCKOUT_SECONDS = 15 * 60;

const nowSeconds = () => Math.floor(Date.now() / 1000);

function checkPasswordStrength(password) {
  const pwd = String(password ?? '');

  if (pwd.length < PASSWORD_MIN_LENGTH) {
    return { code: 'WEAK_LENGTH', error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.` };
  }
  if (!PASSWORD_REQUIREMENTS.upper.test(pwd)) {
    return { code: 'WEAK_UPPER', error: 'Password must contain at least one uppercase letter (A–Z).' };
  }
  if (!PASSWORD_REQUIREMENTS.lower.test(pwd)) {
    return { code: 'WEAK_LOWER', error: 'Password must contain at least one lowercase letter (a–z).' };
  }
  if (!PASSWORD_REQUIREMENTS.digit.test(pwd)) {
    return { code: 'WEAK_DIGIT', error: 'Password must contain at least one number (0–9).' };
  }
  if (!PASSWORD_REQUIREMENTS.special.test(pwd)) {
    return { code: 'WEAK_SPECIAL', error: 'Password must contain at least one symbol (!@#$%^&* etc.).' };
  }
  const lower = pwd.toLowerCase();
  for (const bad of COMMON_PASSWORDS) {
    if (lower === bad || lower.includes(bad)) {
      return { code: 'WEAK_COMMON', error: 'Password contains a common word or pattern. Choose something less predictable.' };
    }
  }
  if (/(.)\1\1\1/.test(pwd)) {
    return { code: 'WEAK_REPEAT', error: 'Password must not repeat the same character more than 3 times in a row.' };
  }
  return null;
}

/* ==========================================================================
   Schema
   ========================================================================== */
function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      first_name TEXT,
      last_name TEXT,
      title TEXT,
      middle_name TEXT,
      phone_country_code TEXT DEFAULT '+27',
      phone_number TEXT,
      preferred_job_category TEXT,
      preferred_job_location TEXT,
      country TEXT DEFAULT 'South Africa',
      street_number TEXT,
      complex_name TEXT,
      unit_number TEXT,
      street_name TEXT,
      suburb TEXT,
      city TEXT,
      postal_code TEXT,
      receive_job_alerts INTEGER DEFAULT 1,
      receive_marketing INTEGER DEFAULT 0,
      cv_path TEXT,
      cover_letter_path TEXT,
      verified INTEGER DEFAULT 0,
      verification_code TEXT,
      verification_expires INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS education (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      degree TEXT, major TEXT, school TEXT,
      start_month TEXT, start_year TEXT, end_month TEXT, end_year TEXT,
      education_level TEXT, country TEXT, city TEXT,
      average_grade TEXT, year_acquired TEXT,
      FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS experience (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      employer_name TEXT, job_title TEXT,
      start_month TEXT, start_year TEXT, end_month TEXT, end_year TEXT,
      is_current INTEGER DEFAULT 0,
      employer_country TEXT, employer_city TEXT, responsibilities TEXT,
      FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS candidate_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      doc_type TEXT NOT NULL,
      filename TEXT NOT NULL,
      text TEXT,
      parsed TEXT,
      indexed_at INTEGER,
      uploaded_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_candidate_documents_candidate ON candidate_documents (candidate_id);
    CREATE INDEX IF NOT EXISTS idx_candidate_documents_type      ON candidate_documents (doc_type);

    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      category TEXT,
      location TEXT DEFAULT 'Umzimvubu, Eastern Cape, South Africa',
      description TEXT,
      requirements TEXT,
      closing_date TEXT,
      is_open INTEGER DEFAULT 1,
      archived INTEGER DEFAULT 0,
      archived_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      job_id INTEGER NOT NULL,
      status TEXT DEFAULT 'submitted',
      applied_at INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(candidate_id, job_id),
      FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT,
      password_hash TEXT DEFAULT '',
      password_set_at INTEGER,
      password_expires_at INTEGER,
      totp_secret TEXT,
      totp_enabled INTEGER DEFAULT 0,
      totp_confirmed_at INTEGER,
      failed_attempts INTEGER DEFAULT 0,
      locked_until INTEGER,
      last_login_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS admin_password_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER NOT NULL,
      password_hash TEXT NOT NULL,
      changed_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY (admin_id) REFERENCES admin_users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS admin_otp (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'reset',
      code_hash TEXT NOT NULL,
      attempts INTEGER DEFAULT 0,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY (admin_id) REFERENCES admin_users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS admin_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER,
      event TEXT NOT NULL,
      detail TEXT,
      ip TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      data TEXT,
      expires INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_admin_otp ON admin_otp (admin_id, purpose, consumed_at);
  `);

  /* ---- Candidate column migrations ---- */
  const candCols = db.prepare('PRAGMA table_info(candidates)').all().map((c) => c.name);
  const addCandCol = (name, ddl) => {
    if (!candCols.includes(name)) db.exec(`ALTER TABLE candidates ADD COLUMN ${ddl}`);
  };
  addCandCol('gender', 'gender TEXT');
  addCandCol('has_disability', 'has_disability INTEGER DEFAULT 0');
  addCandCol('disability_status', 'disability_status TEXT');
  addCandCol('receipt_number', 'receipt_number TEXT');
  addCandCol('drivers_licence', 'drivers_licence INTEGER DEFAULT 0');
  addCandCol('drivers_licence_code', 'drivers_licence_code TEXT');

  /* ---- Application column migrations ---- */
  const appCols = db.prepare('PRAGMA table_info(applications)').all().map((c) => c.name);
  const addAppCol = (name, ddl) => {
    if (!appCols.includes(name)) db.exec(`ALTER TABLE applications ADD COLUMN ${ddl}`);
  };
  addAppCol('llm_json', 'llm_json TEXT');
  addAppCol('llm_verdict', 'llm_verdict TEXT');
  addAppCol('llm_screened_at', 'llm_screened_at INTEGER');

  /* ---- Job column migrations ---- */
  const jobCols = db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name);
  const addJobCol = (name, ddl) => {
    if (!jobCols.includes(name)) db.exec(`ALTER TABLE jobs ADD COLUMN ${ddl}`);
  };
  addJobCol('archived', 'archived INTEGER DEFAULT 0');
  addJobCol('archived_at', 'archived_at INTEGER');

  /* ---- Admin column migrations ---- */
  const adminCols = db.prepare('PRAGMA table_info(admin_users)').all();
  const adminColNames = adminCols.map((c) => c.name);
  const addCol = (name, ddl) => {
    if (!adminColNames.includes(name)) db.exec(`ALTER TABLE admin_users ADD COLUMN ${ddl}`);
  };
  addCol('email', 'email TEXT');
  addCol('password_set_at', 'password_set_at INTEGER');
  addCol('password_expires_at', 'password_expires_at INTEGER');
  addCol('totp_secret', 'totp_secret TEXT');
  addCol('totp_enabled', 'totp_enabled INTEGER DEFAULT 0');
  addCol('totp_confirmed_at', 'totp_confirmed_at INTEGER');
  addCol('failed_attempts', 'failed_attempts INTEGER DEFAULT 0');
  addCol('locked_until', 'locked_until INTEGER');
  addCol('last_login_at', 'last_login_at INTEGER');

  db.prepare(`
    UPDATE admin_users
       SET password_set_at = COALESCE(password_set_at, created_at, strftime('%s','now')),
           password_expires_at = COALESCE(password_expires_at, strftime('%s','now') + ?)
     WHERE password_hash IS NOT NULL AND password_hash <> ''
  `).run(PASSWORD_VALID_SECONDS);

  db.prepare("UPDATE admin_users SET password_hash = '' WHERE password_hash IS NULL").run();
  db.prepare('UPDATE admin_users SET totp_enabled = 0 WHERE totp_enabled IS NULL').run();
  db.prepare('UPDATE admin_users SET failed_attempts = 0 WHERE failed_attempts IS NULL').run();

  const jobCount = db.prepare('SELECT COUNT(*) AS c FROM jobs').get().c;
  if (jobCount === 0) {
    const insertJob = db.prepare(`
      INSERT INTO jobs (title, category, description, requirements, closing_date)
      VALUES (?, ?, ?, ?, ?)
    `);
    const jobs = [
      ['Municipal Manager', 'MANAGEMENT', 'Lead the municipality in delivering quality services.', "Bachelor's degree in Public Administration; 10 years experience", '2026-12-31T16:00'],
      ['Senior Accountant', 'FINANCE', 'Manage municipal finances and reporting.', 'BCom Accounting; 5 years experience; CA(SA) advantageous', '2026-11-30T16:00'],
      ['Civil Engineer', 'TECHNICAL SERVICES', 'Design and oversee municipal infrastructure projects.', 'BSc Civil Engineering; ECSA registration', '2026-12-15T16:00'],
      ['HR Officer', 'HUMAN RESOURCES', 'Support HR operations and recruitment.', 'Diploma/Degree in HR; 3 years experience', '2026-11-20T16:00'],
      ['General Worker', 'GENERAL WORKERS', 'Perform general maintenance duties.', 'Grade 10; physical fitness', '2026-11-10T16:00'],
      ['IT Support Technician', 'INFORMATION TECHNOLOGY', 'Provide technical support to municipal staff.', 'Diploma in IT; A+ / N+ certification', '2026-12-05T16:00']
    ];
    const tx = db.transaction((rows) => rows.forEach((r) => insertJob.run(...r)));
    tx(jobs);
  }

  const adminCount = db.prepare('SELECT COUNT(*) AS c FROM admin_users').get().c;
  if (adminCount === 0) {
    db.prepare('INSERT INTO admin_users (username, password_hash, email) VALUES (?, ?, ?)')
      .run(ADMIN_USERNAME, '', process.env.ADMIN_EMAIL || null);
  }
}

init();

require('./ats').migrate(db);

/* ==========================================================================
   Admin records
   ========================================================================== */
const qAdminByUsername = db.prepare('SELECT * FROM admin_users WHERE username = ?');
const qAdminById = db.prepare('SELECT * FROM admin_users WHERE id = ?');
const qFirstAdmin = db.prepare('SELECT * FROM admin_users ORDER BY id LIMIT 1');

const getAdminByUsername = (username) => qAdminByUsername.get(String(username || '').trim()) || null;
const getAdminById = (id) => qAdminById.get(Number(id)) || null;
const ensureAdminRow = () => qFirstAdmin.get() || null;

function createAdmin(username, email) {
  const info = db.prepare('INSERT INTO admin_users (username, password_hash, email) VALUES (?, ?, ?)')
    .run(String(username || '').trim() || ADMIN_USERNAME, '', email || null);
  return getAdminById(info.lastInsertRowid);
}

function renameAdmin(adminId, username) {
  db.prepare('UPDATE admin_users SET username = ? WHERE id = ?').run(String(username).trim(), adminId);
  return getAdminById(adminId);
}

function setAdminEmail(adminId, email) {
  db.prepare('UPDATE admin_users SET email = ? WHERE id = ?').run(String(email || '').trim() || null, adminId);
  return getAdminById(adminId);
}

/* ==========================================================================
   Password
   ========================================================================== */
const passwordIsSet = (admin) => Boolean(admin && admin.password_hash);

function adminStatus(admin) {
  const hasPassword = passwordIsSet(admin);
  const expiresAt = hasPassword ? admin.password_expires_at || null : null;
  const secondsLeft = expiresAt ? Math.max(0, expiresAt - nowSeconds()) : null;
  return {
    hasPassword,
    expired: Boolean(hasPassword && expiresAt && expiresAt <= nowSeconds()),
    expiresAt,
    secondsLeft,
    daysLeft: secondsLeft === null ? null : Math.ceil(secondsLeft / 86400)
  };
}

function verifyAdminPassword(admin, password) {
  if (!passwordIsSet(admin)) return false;
  try { return bcrypt.compareSync(String(password), admin.password_hash); } catch { return false; }
}

function passwordReused(admin, password) {
  if (!admin) return false;
  if (verifyAdminPassword(admin, password)) return true;
  const history = db.prepare(`
    SELECT password_hash FROM admin_password_history
     WHERE admin_id = ? ORDER BY changed_at DESC, id DESC LIMIT ?
  `).all(admin.id, PASSWORD_HISTORY_DEPTH);
  return history.some((row) => {
    try { return bcrypt.compareSync(String(password), row.password_hash); } catch { return false; }
  });
}

function setAdminPassword(adminId, password) {
  const hash = bcrypt.hashSync(String(password), BCRYPT_ROUNDS);
  const now = nowSeconds();

  db.transaction(() => {
    db.prepare('INSERT INTO admin_password_history (admin_id, password_hash) VALUES (?, ?)')
      .run(adminId, hash);
    db.prepare(`
      UPDATE admin_users SET password_hash = ?, password_set_at = ?, password_expires_at = ?
       WHERE id = ?
    `).run(hash, now, now + PASSWORD_VALID_SECONDS, adminId);
    db.prepare(`
      DELETE FROM admin_password_history
       WHERE admin_id = ?
         AND id NOT IN (
           SELECT id FROM admin_password_history WHERE admin_id = ?
            ORDER BY changed_at DESC, id DESC LIMIT ?
         )
    `).run(adminId, adminId, PASSWORD_HISTORY_DEPTH);
  })();

  return { expiresAt: now + PASSWORD_VALID_SECONDS, daysLeft: PASSWORD_VALID_DAYS };
}

function clearAdminPassword(adminId) {
  db.prepare(`
    UPDATE admin_users SET password_hash = '', password_set_at = NULL, password_expires_at = NULL
     WHERE id = ?
  `).run(adminId);
}

const touchAdminLogin = (adminId) =>
  db.prepare('UPDATE admin_users SET last_login_at = ? WHERE id = ?').run(nowSeconds(), adminId);

function isAdminLocked(admin) {
  return Boolean(admin && admin.locked_until && admin.locked_until > nowSeconds());
}

function recordFailedLogin(adminId) {
  const admin = getAdminById(adminId);
  if (!admin) return;
  const attempts = (admin.failed_attempts || 0) + 1;
  const lockedUntil = attempts >= MAX_LOGIN_FAILURES ? nowSeconds() + LOCKOUT_SECONDS : null;
  db.prepare('UPDATE admin_users SET failed_attempts = ?, locked_until = ? WHERE id = ?')
    .run(lockedUntil ? 0 : attempts, lockedUntil, adminId);
  return { attempts, lockedUntil };
}

function clearFailedLogins(adminId) {
  db.prepare('UPDATE admin_users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(adminId);
}

/* ==========================================================================
   OTP
   ========================================================================== */
const hashOtp = (code) =>
  crypto.createHmac('sha256', OTP_SECRET).update(String(code)).digest('hex');

function createAdminOtp(adminId, code, purpose = 'reset', ttlSeconds = 600) {
  db.prepare('UPDATE admin_otp SET consumed_at = ? WHERE admin_id = ? AND purpose = ? AND consumed_at IS NULL')
    .run(nowSeconds(), adminId, purpose);

  const info = db.prepare(`
    INSERT INTO admin_otp (admin_id, purpose, code_hash, expires_at) VALUES (?, ?, ?, ?)
  `).run(adminId, purpose, hashOtp(code), nowSeconds() + ttlSeconds);

  return { id: info.lastInsertRowid, expiresAt: nowSeconds() + ttlSeconds };
}

function latestAdminOtp(adminId, purpose = 'reset') {
  return db.prepare(`
    SELECT * FROM admin_otp
     WHERE admin_id = ? AND purpose = ?
     ORDER BY id DESC LIMIT 1
  `).get(adminId, purpose) || null;
}

function verifyAdminOtp(adminId, code, purpose = 'reset') {
  const row = latestAdminOtp(adminId, purpose);
  if (!row || row.consumed_at) return { ok: false, code: 'NO_OTP', error: 'Request a new PIN.' };
  if (row.expires_at <= nowSeconds()) {
    db.prepare('UPDATE admin_otp SET consumed_at = ? WHERE id = ?').run(nowSeconds(), row.id);
    return { ok: false, code: 'EXPIRED', error: 'That PIN has expired. Request a new one.' };
  }
  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    db.prepare('UPDATE admin_otp SET consumed_at = ? WHERE id = ?').run(nowSeconds(), row.id);
    return { ok: false, code: 'TOO_MANY', error: 'Too many attempts. Request a new PIN.' };
  }

  const expected = Buffer.from(row.code_hash, 'hex');
  const supplied = Buffer.from(hashOtp(code), 'hex');

  if (expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied)) {
    db.prepare('UPDATE admin_otp SET consumed_at = ? WHERE id = ?').run(nowSeconds(), row.id);
    return { ok: true };
  }

  const attempts = row.attempts + 1;
  db.prepare('UPDATE admin_otp SET attempts = ? WHERE id = ?').run(attempts, row.id);
  return {
    ok: false,
    code: 'INVALID',
    error: `Incorrect PIN. ${Math.max(0, OTP_MAX_ATTEMPTS - attempts)} attempt(s) left.`
  };
}

/* ==========================================================================
   TOTP
   ========================================================================== */
function setAdminTotp(adminId, secret, enabled) {
  db.prepare('UPDATE admin_users SET totp_secret = ?, totp_enabled = ?, totp_confirmed_at = ? WHERE id = ?')
    .run(secret, enabled ? 1 : 0, enabled ? nowSeconds() : null, adminId);
  return getAdminById(adminId);
}

function clearAdminTotp(adminId) {
  db.prepare('UPDATE admin_users SET totp_secret = NULL, totp_enabled = 0, totp_confirmed_at = NULL WHERE id = ?')
    .run(adminId);
}

/* ==========================================================================
   Audit
   ========================================================================== */
function logAudit(adminId, event, detail, ip) {
  db.prepare('INSERT INTO admin_audit (admin_id, event, detail, ip) VALUES (?, ?, ?, ?)')
    .run(adminId || null, event, detail || null, ip || null);
}

/* ==========================================================================
   Effective open/closed state
   ========================================================================== */
function parseClosingDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;

  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  return null;
}

function isEffectivelyOpen(job) {
  if (!job) return false;
  if (Number(job.archived) === 1) return false;
  if (Number(job.is_open) !== 1) return false;
  if (!job.closing_date) return true;
  const closeAt = parseClosingDate(job.closing_date);
  if (!closeAt) return true;
  return closeAt.getTime() > Date.now();
}

function annotateOpenState(job) {
  if (!job) return job;
  const open = isEffectivelyOpen(job);
  job.effectiveOpen = open;
  job.effectiveClosed = !open;
  const closeAt = parseClosingDate(job.closing_date);
  job.closingAt = closeAt ? closeAt.toISOString() : null;
  job.msUntilClosing = closeAt ? (closeAt.getTime() - Date.now()) : null;
  job.isArchived = Number(job.archived) === 1;
  return job;
}

/* ==========================================================================
   Exports
   ========================================================================== */
Object.assign(db, {
  ADMIN_USERNAME,
  PASSWORD_MIN_LENGTH,
  PASSWORD_VALID_DAYS,
  PASSWORD_VALID_SECONDS,
  OTP_MAX_ATTEMPTS,
  MAX_LOGIN_FAILURES,
  LOCKOUT_SECONDS,

  checkPasswordStrength,

  getAdminByUsername, getAdminById, ensureAdminRow, createAdmin, renameAdmin, setAdminEmail,
  adminStatus, verifyAdminPassword, passwordReused, setAdminPassword, clearAdminPassword, touchAdminLogin,
  isAdminLocked, recordFailedLogin, clearFailedLogins,
  createAdminOtp, latestAdminOtp, verifyAdminOtp,
  setAdminTotp, clearAdminTotp,
  logAudit,

  parseClosingDate,
  isEffectivelyOpen,
  annotateOpenState
});

module.exports = db;