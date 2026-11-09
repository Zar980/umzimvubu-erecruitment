'use strict';

let policy = { minLength: 8, validDays: 30, otpTtl: 10 };
let currentUsername = 'admin';
let csrfToken = '';
let currentMasterJobId = null;
let currentHistoryCandidateId = null;
let showArchivedJobs = false;

const $ = (id) => document.getElementById(id);

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function setMsg(id, text, good) {
  const el = $(id);
  if (!el) return;
  el.textContent = text || '';
  el.style.color = good ? '#1a7f37' : '';
}

/* --------------------------------------------------------------------------
   Fetch with CSRF + session-state handling
   -------------------------------------------------------------------------- */
async function api(url, options = {}) {
  const opts = { credentials: 'include', ...options };
  const method = (opts.method || 'GET').toUpperCase();

  if (method !== 'GET' && method !== 'HEAD') {
    opts.headers = { ...(opts.headers || {}), 'X-CSRF-Token': csrfToken };
  }

  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({ ok: false, error: 'Bad response' }));

  if (data.csrfToken) csrfToken = data.csrfToken;

  if (res.status === 401 && !['BAD_CREDENTIALS', 'TOTP_REQUIRED', 'TOTP_INVALID', 'RESET_NOT_VERIFIED'].includes(data.code)) {
    showLogin();
    throw new Error('Unauthorized');
  }

  if (res.status === 403 && data.code === 'PASSWORD_EXPIRED') {
    $('changeCurrent').value = $('loginPass').value || '';
    showChange();
    setMsg('changeMsg', data.error);
    throw new Error('Password expired');
  }

  if (res.status === 403 && data.code === 'CSRF') {
    await loadStatus();
    return api(url, options);
  }

  return data;
}

const post = (url, body) => api(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {})
});

/* --------------------------------------------------------------------------
   Views
   -------------------------------------------------------------------------- */
const VIEWS = ['viewLogin', 'viewSetup', 'viewTotp', 'viewOtp', 'viewReset', 'viewChange'];

function showOnly(view) {
  VIEWS.forEach((id) => { const el = $(id); if (el) el.style.display = id === view ? 'block' : 'none'; });
  $('authPanel').style.display = 'block';
  $('dashboardPanel').style.display = 'none';
}

function clearMessages() {
  ['loginMsg', 'setupMsg', 'totpMsg', 'otpMsg', 'resetMsg', 'changeMsg'].forEach((id) => setMsg(id, ''));
}

function showLogin() { showOnly('viewLogin'); clearMessages(); }
function showSetup() {
  showOnly('viewSetup'); clearMessages();
  $('setupUser').value = $('loginUser').value || currentUsername || 'admin';
  $('setupPass').value = ''; $('setupPass2').value = '';
}
function showTotp() { showOnly('viewTotp'); clearMessages(); $('totpCode').value = ''; $('totpCode').focus(); }
function showOtp(email, ttl) {
  showOnly('viewOtp'); clearMessages();
  $('otpCode').value = '';
  if (email) $('otpEmail').textContent = email;
  if (ttl) $('otpTtl').textContent = ttl;
  $('otpCode').focus();
}
function showReset() { showOnly('viewReset'); clearMessages(); $('resetPass').value = ''; $('resetPass2').value = ''; }
function showChange() { showOnly('viewChange'); clearMessages(); }

async function showDashboard() {
  $('authPanel').style.display = 'none';
  $('dashboardPanel').style.display = 'block';
  await Promise.all([loadCandidates(), loadJobs(), load2fa()]);
  await renderSessionInfo();
}

/* --------------------------------------------------------------------------
   Status / boot
   -------------------------------------------------------------------------- */
async function loadStatus() {
  const res = await fetch('/api/admin/status', { credentials: 'include' });
  const data = await res.json().catch(() => ({ ok: false }));
  if (data.csrfToken) csrfToken = data.csrfToken;
  return data;
}

async function boot() {
  const status = await loadStatus().catch(() => ({ ok: false }));
  if (!status.ok) { showLogin(); return; }

  policy.minLength = status.minLength || 8;
  policy.validDays = status.validDays || 30;
  policy.otpTtl = status.otpTtlMinutes || 10;
  currentUsername = status.username || 'admin';

  $('setupMinLen').textContent = policy.minLength;
  $('setupValidDays').textContent = policy.validDays;
  $('changeValidDays').textContent = policy.validDays;
  $('otpTtl').textContent = policy.otpTtl;
  $('loginUser').value = currentUsername;
  if (status.email) $('dashEmail').value = status.email;

  if (status.signedIn) { await showDashboard(); return; }

  showLogin();

  if (!status.hasPassword) {
    $('noPasswordNote').style.display = 'block';
    $('expiryNote').style.display = 'none';
    return;
  }

  $('noPasswordNote').style.display = 'none';

  if (status.expired) {
    $('expiryNote').style.display = 'none';
    showChange();
    return;
  }

  if (status.daysLeft !== null && status.daysLeft !== undefined) {
    $('expiryNote').style.display = 'block';
    $('expiryNote').textContent = `Password expires in ${status.daysLeft} day(s).`;
  } else {
    $('expiryNote').style.display = 'none';
  }
}

/* --------------------------------------------------------------------------
   Login
   -------------------------------------------------------------------------- */
async function login() {
  const username = $('loginUser').value.trim();
  const password = $('loginPass').value;
  setMsg('loginMsg', '');

  if (!username || !password) { setMsg('loginMsg', 'Enter your username and password.'); return; }

  const data = await post('/api/admin/login', { username, password });

  if (data.ok) { $('loginPass').value = ''; await showDashboard(); return; }

  if (data.code === 'NO_PASSWORD') {
    $('noPasswordNote').style.display = 'block';
    setMsg('loginMsg', data.error);
    return;
  }
  if (data.code === 'TOTP_REQUIRED') { showTotp(); return; }
  if (data.code === 'PASSWORD_EXPIRED') {
    $('changeCurrent').value = password;
    $('loginPass').value = '';
    showChange();
    setMsg('changeMsg', data.error);
    return;
  }
  setMsg('loginMsg', data.error || 'Login failed.');
}

async function submitTotp() {
  const code = $('totpCode').value.replace(/\D/g, '');
  if (code.length !== 6) { setMsg('totpMsg', 'Enter the 6-digit code.'); return; }

  const data = await post('/api/admin/login/totp', { code });

  if (data.ok) { await showDashboard(); return; }
  if (data.code === 'PASSWORD_EXPIRED') { showChange(); setMsg('changeMsg', data.error); return; }
  setMsg('totpMsg', data.error || 'Invalid code.');
}

async function logout() {
  await fetch('/api/admin/logout', { method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': csrfToken } });
  await loadStatus();
  showLogin();
}

/* --------------------------------------------------------------------------
   Forgot password (OTP)
   -------------------------------------------------------------------------- */
async function forgotPassword() {
  const username = $('loginUser').value.trim() || currentUsername;
  setMsg('loginMsg', '');

  const data = await post('/api/admin/forgot', { username });

  if (!data.ok) { setMsg('loginMsg', data.error || 'Could not send PIN.'); return; }

  showOtp(data.email || 'the admin terminal', Math.round((data.expiresInSeconds || policy.otpTtl * 60) / 60));

  if (data.sent === false) {
    setMsg('otpMsg', `A PIN was already sent. Wait ${data.cooldownSeconds}s to resend, or enter the PIN you have.`);
    return;
  }

  const channels = data.channels || [];
  const where = [];
  if (channels.includes('email')) where.push(`email (${data.email})`);
  if (channels.includes('sms')) where.push(`SMS (${data.phone})`);
  if (channels.includes('terminal')) where.push('the server terminal');

  setMsg(
    'otpMsg',
    data.devMode && channels.includes('terminal')
      ? `DEV MODE: PIN sent to ${where.join(' and ')}. Check the window running "node server.js".`
      : `PIN sent to ${where.join(' and ')}.`,
    true
  );
}

async function submitOtp() {
  const code = $('otpCode').value.replace(/\D/g, '');
  if (code.length !== 6) { setMsg('otpMsg', 'Enter the 6-digit PIN.'); return; }

  const data = await post('/api/admin/forgot/verify', { username: $('loginUser').value.trim(), code });

  if (!data.ok) { setMsg('otpMsg', data.error || 'Invalid PIN.'); return; }
  showReset();
}

async function submitReset() {
  const newPassword = $('resetPass').value;
  const confirmPassword = $('resetPass2').value;

  const problem = checkPassword(newPassword, confirmPassword);
  if (problem) { setMsg('resetMsg', problem); return; }

  const data = await post('/api/admin/reset', { newPassword, confirmPassword });

  if (!data.ok) {
    if (data.code === 'RESET_NOT_VERIFIED') {
      showOtp();
      setMsg('otpMsg', data.error || 'Verify your PIN first.');
      return;
    }
    setMsg('resetMsg', data.error || 'Could not reset password.');
    return;
  }

  $('resetPass').value = ''; $('resetPass2').value = '';
  $('loginPass').value = '';
  await loadStatus().catch(() => null);
  showLogin();
  $('loginUser').value = data.username || currentUsername;
  setMsg(
    'loginMsg',
    `Password reset (2FA was cleared). Log in with your new password. It expires in ${data.daysLeft} days.`,
    true
  );
  $('loginPass').focus();
}

/* --------------------------------------------------------------------------
   Password forms
   -------------------------------------------------------------------------- */
function checkPassword(newPass, confirmPass) {
  if (!newPass || newPass.length < policy.minLength) {
    return `Password must be at least ${policy.minLength} characters.`;
  }
  if (!/[A-Z]/.test(newPass)) {
    return 'Password must contain at least one uppercase letter (A–Z).';
  }
  if (!/[a-z]/.test(newPass)) {
    return 'Password must contain at least one lowercase letter (a–z).';
  }
  if (!/[0-9]/.test(newPass)) {
    return 'Password must contain at least one number (0–9).';
  }
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`]/.test(newPass)) {
    return 'Password must contain at least one symbol (!@#$%^&* etc.).';
  }
  if (/(.)\1\1\1/.test(newPass)) {
    return 'Password must not repeat the same character more than 3 times in a row.';
  }
  if (newPass !== confirmPass) {
    return 'The two passwords do not match.';
  }
  return null;
}

async function submitSetup() {
  const username = $('setupUser').value.trim();
  const email = $('setupEmail').value.trim();
  const newPassword = $('setupPass').value;
  const confirmPassword = $('setupPass2').value;

  if (!email) { setMsg('setupMsg', 'Email is required for reset PINs.'); return; }
  const problem = checkPassword(newPassword, confirmPassword);
  if (problem) { setMsg('setupMsg', problem); return; }

  const data = await post('/api/admin/setup', { username, email, newPassword, confirmPassword });

  if (!data.ok) {
    setMsg('setupMsg', data.error || 'Could not save password.');
    if (data.code === 'PASSWORD_EXISTS') showLogin();
    return;
  }

  setMsg('setupMsg', `Password saved. Expires in ${data.daysLeft} day(s).`, true);
  $('setupPass').value = ''; $('setupPass2').value = '';
  await showDashboard();
}

async function submitChange() {
  const currentPassword = $('changeCurrent').value;
  const newPassword = $('changePass').value;
  const confirmPassword = $('changePass2').value;

  if (!currentPassword) { setMsg('changeMsg', 'Enter your current password.'); return; }
  const problem = checkPassword(newPassword, confirmPassword);
  if (problem) { setMsg('changeMsg', problem); return; }

  const data = await post('/api/admin/password', { currentPassword, newPassword, confirmPassword });

  if (!data.ok) { setMsg('changeMsg', data.error || 'Could not update password.'); return; }

  $('changeCurrent').value = ''; $('changePass').value = ''; $('changePass2').value = '';
  await showDashboard();
}

async function submitDashboardChange() {
  const currentPassword = $('dashCurrent').value;
  const newPassword = $('dashPass').value;
  const confirmPassword = $('dashPass2').value;

  if (!currentPassword) { setMsg('dashMsg', 'Enter your current password.'); return; }
  const problem = checkPassword(newPassword, confirmPassword);
  if (problem) { setMsg('dashMsg', problem); return; }

  const data = await post('/api/admin/password', { currentPassword, newPassword, confirmPassword });

  if (!data.ok) { setMsg('dashMsg', data.error || 'Could not update password.'); return; }

  $('dashCurrent').value = ''; $('dashPass').value = ''; $('dashPass2').value = '';
  setMsg('dashMsg', `Password updated. Expires in ${data.daysLeft} day(s).`, true);
  await renderSessionInfo();
}

async function submitEmail() {
  const email = $('dashEmail').value.trim();
  const password = $('dashEmailPass').value;

  const data = await post('/api/admin/email', { email, password });
  if (!data.ok) { setMsg('emailMsg', data.error || 'Could not update email.'); return; }

  $('dashEmailPass').value = '';
  setMsg('emailMsg', `Reset PINs now go to ${data.email}.`, true);
}

/* --------------------------------------------------------------------------
   2FA
   -------------------------------------------------------------------------- */
async function load2fa() {
  const data = await api('/api/admin/2fa');
  const enabled = Boolean(data.enabled);

  $('totpStatus').textContent = enabled
    ? 'Enabled — a 6-digit code is required at every login.'
    : 'Disabled — add an authenticator app for a second factor.';
  $('totpStartBtn').style.display = enabled ? 'none' : 'inline-block';
  $('totpDisable').style.display = enabled ? 'block' : 'none';
  $('totpSetup').style.display = 'none';
}

async function start2fa() {
  const data = await api('/api/admin/2fa/setup', { method: 'POST' });
  if (!data.ok) { setMsg('totpMsg', data.error || 'Setup failed.'); return; }
  $('totpSecret').textContent = data.secret;
  $('totpSetup').style.display = 'block';
  setMsg('totpMsg', 'Add the secret to your app, then confirm the code.');
}

async function confirm2fa() {
  const code = $('totpConfirm').value.replace(/\D/g, '');
  const data = await api('/api/admin/2fa/enable', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code })
  });
  if (!data.ok) { setMsg('totpMsg', data.error || 'Invalid code.'); return; }
  $('totpConfirm').value = '';
  setMsg('totpMsg', '2FA enabled.', true);
  await load2fa();
}

async function disable2fa() {
  const data = await api('/api/admin/2fa/disable', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: $('totpDisablePass').value, code: $('totpDisableCode').value })
  });
  if (!data.ok) { setMsg('totpMsg', data.error || 'Could not disable.'); return; }
  $('totpDisablePass').value = ''; $('totpDisableCode').value = '';
  setMsg('totpMsg', '2FA disabled.', true);
  await load2fa();
}

/* --------------------------------------------------------------------------
   Dashboard data
   -------------------------------------------------------------------------- */
async function renderSessionInfo() {
  const status = await loadStatus().catch(() => null);
  const el = $('sessionInfo');
  if (!el) return;
  if (!status || !status.ok || !status.hasPassword) { el.textContent = ''; return; }
  el.textContent = `Signed in as ${status.username}. Password expires in ${status.daysLeft} day(s).`;
  if (status.email) $('dashEmail').value = status.email;
}

function formatDateTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-ZA', {
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    });
  } catch { return iso; }
}

function humanDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function formatClosing(stored, isoTimestamp) {
  if (!stored && !isoTimestamp) return '—';
  try {
    const d = isoTimestamp ? new Date(isoTimestamp) : new Date(stored);
    if (Number.isNaN(d.getTime())) return String(stored || '—');
    return d.toLocaleString('en-ZA', {
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    });
  } catch { return String(stored || '—'); }
}

async function loadCandidates() {
  const data = await api('/api/admin/candidates');
  const rows = data.candidates || [];
  const target = $('candidatesTable');

  if (!rows.length) {
    target.innerHTML = '<p>No candidates yet.</p>';
    return;
  }

  target.innerHTML = `
    <table class="candidates-table">
      <thead>
        <tr>
          <th class="cand-check"><input type="checkbox" id="candSelectAll" title="Select all" /></th>
          <th>Name</th>
          <th>Email</th>
          <th>Phone</th>
          <th>City</th>
          <th>Verified</th>
          <th>Applications</th>
          <th>CV</th>
          <th>CV updated</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((r) => `
          <tr data-candidate-id="${r.id}">
            <td class="cand-check"><input type="checkbox" class="cand-row-check" value="${r.id}" /></td>
            <td>${esc([r.title, r.first_name, r.last_name].filter(Boolean).join(' '))}</td>
            <td>${esc(r.email)}</td>
            <td>${esc([r.phone_country_code, r.phone_number].filter(Boolean).join(' '))}</td>
            <td>${esc(r.city)}</td>
            <td>${r.verified ? '&#10003;' : '&mdash;'}</td>
            <td>${esc(r.application_count ?? 0)}</td>
            <td>${r.cv_path
              ? `<a href="/uploads/${encodeURIComponent(String(r.cv_path).split(/[\\\\/]/).pop())}"
                    target="_blank" rel="noopener">Download</a>`
              : '&mdash;'}</td>
            <td>${r.cv_updated_at ? esc(formatDateTime(r.cv_updated_at)) : '&mdash;'}</td>
            <td><button type="button" class="btn-secondary" onclick="openHistoryPanel(${r.id})">History</button></td>
          </tr>`).join('')}
      </tbody>
    </table>`;

  initCandidatesTable();
  loadLlmBadge();
}

function initCandidatesTable() {
  const selectAll = $('candSelectAll');
  const rowChecks = document.querySelectorAll('.cand-row-check');

  if (selectAll) {
    selectAll.addEventListener('change', () => {
      rowChecks.forEach((cb) => { cb.checked = selectAll.checked; });
    });

    rowChecks.forEach((cb) => {
      cb.addEventListener('change', () => {
        const all = [...rowChecks].every((x) => x.checked);
        selectAll.checked = all;
      });
    });
  }

  const exportBtn = $('btnExportCsv');
  if (exportBtn) {
    const clone = exportBtn.cloneNode(true);
    exportBtn.parentNode.replaceChild(clone, exportBtn);
    clone.addEventListener('click', exportCandidatesCsv);
  }

  const deleteBtn = $('btnDeleteSelected');
  if (deleteBtn) {
    const clone = deleteBtn.cloneNode(true);
    deleteBtn.parentNode.replaceChild(clone, deleteBtn);
    clone.addEventListener('click', deleteSelectedCandidates);
  }
}

function getSelectedCandidateIds() {
  return [...document.querySelectorAll('.cand-row-check:checked')]
    .map((cb) => Number(cb.value))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function exportCandidatesCsv() {
  const ids = getSelectedCandidateIds();
  const qs = ids.length ? `?ids=${ids.join(',')}` : '';
  window.location.assign(`/api/admin/candidates/export.csv${qs}`);
}

async function deleteSelectedCandidates() {
  const ids = getSelectedCandidateIds();
  if (!ids.length) { alert('Tick at least one candidate first.'); return; }
  if (!confirm(`Delete ${ids.length} candidate(s)? This cannot be undone.`)) return;

  const res = await api('/api/admin/candidates', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids })
  });

  if (!res.ok) { alert(res.error || 'Delete failed.'); return; }
  await loadCandidates();
}

async function loadLlmBadge() {
  const badge = $('llmBadge');
  if (!badge) return;
  badge.style.display = 'inline-block';
  badge.textContent = 'Screening: rules + Gemini AI';
  badge.className = 'badge badge-open';
}

/* ==========================================================================
   Jobs table — with archive toggle and FORCE AI LIST
   ========================================================================== */
async function loadJobs() {
  const qs = showArchivedJobs ? '?includeArchived=1' : '';
  const data = await api('/api/admin/jobs' + qs);
  const jobs = data.jobs || [];
  const target = $('jobsTable');
  const archivedCount = data.archivedCount || 0;

  const toggle = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:10px">
      <label class="checkbox" style="margin:0">
        <input type="checkbox" id="showArchivedToggle" ${showArchivedJobs ? 'checked' : ''} />
        Show archived (${archivedCount})
      </label>
    </div>`;

  if (!jobs.length) {
    target.innerHTML = toggle + '<p>No jobs yet.</p>';
    wireJobsToggle();
    return;
  }

  target.innerHTML = toggle + `
    <table>
      <tr><th>Title</th><th>Category</th><th>Closing</th><th>Status</th><th></th></tr>
      ${jobs.map((j) => {
        const isArchived = Number(j.archived) === 1;
        const isOpen = !isArchived && j.effectiveOpen !== false;
        const closing = formatClosing(j.closing_date, j.closingAt);

        const countdown = (!isArchived && j.msUntilClosing !== null && j.msUntilClosing !== undefined)
          ? (j.msUntilClosing > 0
              ? `<small class="countdown-open">closes in ${humanDuration(j.msUntilClosing)}</small>`
              : `<small class="countdown-closed">closed ${humanDuration(-j.msUntilClosing)} ago</small>`)
          : '';

        let status;
        if (isArchived) status = '<span class="badge" style="background:#eee;color:#555">Archived</span>';
        else if (isOpen) status = '<span class="badge badge-open">Open</span>';
        else status = '<span class="badge badge-closed">Closed</span>';

        const archiveBtn = isArchived
          ? `<button type="button" class="btn-secondary" onclick="unarchiveJob(${j.id})">Restore</button>`
          : `<button type="button" class="btn-secondary" onclick="archiveJob(${j.id})">Archive</button>`;

        return `
          <tr>
            <td>${esc(j.title)}</td>
            <td>${esc(j.category)}</td>
            <td>${esc(closing)} ${countdown}</td>
            <td>${status}</td>
            <td class="job-actions">
              <button type="button" style="background:#1a4d8f;color:white;border:none;padding:6px 12px;border-radius:4px;cursor:pointer;font-weight:bold;" 
                      onclick="openMasterList(${j.id}, true)">Force AI Master List</button>
              ${archiveBtn}
              <button type="button" onclick="deleteJob(${j.id})">Delete</button>
            </td>
          </tr>`;
      }).join('')}
    </table>`;

  wireJobsToggle();
}

function wireJobsToggle() {
  const toggle = $('showArchivedToggle');
  if (!toggle) return;
  toggle.addEventListener('change', () => {
    showArchivedJobs = toggle.checked;
    loadJobs().catch(() => {});
  });
}

async function archiveJob(id) {
  if (!confirm('Archive this job? It will disappear from the public site and from this list, but all applications and the master list remain.')) return;

  try {
    const res = await api(`/api/admin/jobs/${id}/archive`, { method: 'POST' });
    if (!res.ok) {
      alert(res.error || 'Archive failed.');
      return;
    }
    await loadJobs();
  } catch (err) {
    console.error('Error archiving:', err);
    alert('Network error while archiving.');
  }
}

async function unarchiveJob(id) {
  if (!confirm('Restore this job to the active list?')) return;

  try {
    // Send the POST request
    const res = await api(`/api/admin/jobs/${id}/unarchive`, { method: 'POST' });
    
    // If the server returns an error, alert it
    if (!res.ok) {
      alert(res.error || 'Restore failed.');
      return;
    }
    
    // Show a success message
    alert('✅ Job restored successfully! It is now back in the active list.');
    
    // Refresh the table
    await loadJobs();
    
  } catch (err) {
    console.error('Error restoring job:', err);
    alert('Network error while trying to restore the job. Check the browser console.');
  }
}

async function deleteJob(id) {
  if (!confirm('Permanently delete this job and all its applications? This cannot be undone.')) return;
  await api('/api/admin/jobs/' + id, { method: 'DELETE' });
  await loadJobs();
}

/* ==========================================================================
   MASTER LIST
   ========================================================================== */
async function openMasterList(jobId, force = false) {
  currentMasterJobId = Number(jobId);

  const panel = $('masterListPanel');
  if (!panel) { alert('Master list panel is missing from admin.html.'); return; }

  panel.classList.add('open');
  $('masterListTitle').textContent = 'Building master list…';
  $('masterListSummary').textContent = 'Screening CVs — this may take a few seconds per candidate…';
  $('masterListQualified').innerHTML = '';
  $('masterListUnqualified').innerHTML = '';
  $('masterListDownload').disabled = true;
  $('masterListRebuild').disabled = true;

  let data;
  try {
    // Sending the ?force=1 flag if the button was clicked
    const res = await fetch(`/api/admin/jobs/${currentMasterJobId}/masterlist${force ? '?force=1' : ''}`, {
      credentials: 'include',
      headers: { 'X-CSRF-Token': csrfToken }
    });
    data = await res.json().catch(() => ({ ok: false, code: 'BAD_RESPONSE' }));
    if (data.csrfToken) csrfToken = data.csrfToken;
  } catch {
    data = { ok: false, code: 'NETWORK', error: 'Network error. Please try again.' };
  }

  if (!data.ok) {
    $('masterListTitle').textContent = 'Master List';

    let friendly;
    switch (data.code) {
      case 'JOB_OPEN':      friendly = 'Position still open — the master list is only available after the closing moment.'; break;
      case 'JOB_NOT_FOUND': friendly = 'This job no longer exists.'; break;
      case 'BUILD_FAILED':  friendly = data.error || 'Could not build the master list.'; break;
      case 'BAD_RESPONSE':  friendly = 'The server did not return a valid response. Try again.'; break;
      case 'NETWORK':       friendly = 'Network error. Please check your connection and try again.'; break;
      default:              friendly = data.error || 'Could not build the master list.';
    }

    $('masterListSummary').textContent = friendly;
    return;
  }

  $('masterListTitle').textContent = data.job.title;

  $('masterListSummary').textContent =
    `${data.counts.total} applications · ` +
    `${data.counts.qualified} qualified · ` +
    `${data.counts.unqualified} unqualified · ATS requirements match`;

  renderMasterRows($('masterListQualified'),   data.qualified);
  renderMasterRows($('masterListUnqualified'), data.unqualified);

  $('masterListDownload').disabled = false;
  $('masterListRebuild').disabled = false;
}

function renderMasterRows(container, rows) {
  if (!container) return;

  if (!rows || !rows.length) {
    container.innerHTML = '<p class="empty">None.</p>';
    return;
  }

  container.innerHTML = rows.map((r) => {
    const ats = Number(r.atsScore || 0);
    const atsColour = ats >= 50
      ? { bg: '#e6f4e9', fg: '#1d6b3b' }
      : ats >= 30
        ? { bg: '#fff3cd', fg: '#8a6d3b' }
        : { bg: '#fdecea', fg: '#b42318' };

    const atsBadge = `<span class="badge"
        style="background:${atsColour.bg};color:${atsColour.fg};font-weight:700">ATS ${ats}%</span>`;

    const pre = (s) => esc(String(s || '—')).replace(/\n/g, '<br>');

    // --- Render the AI reasoning if it exists ---
    let aiBlock = '';
    if (r.source === 'hybrid-rules+gemini' && r.aiReasons && r.aiReasons.length > 0) {
      aiBlock = `
        <div style="background: #eaf0fb; border-left: 4px solid #1a4d8f; padding: 10px; margin: 10px 0; font-size: 13px; border-radius: 0 4px 4px 0;">
          <strong style="color: #1a4d8f; display: flex; align-items: center; gap: 6px; margin-bottom: 4px;">
            <span style="font-size: 16px;">🤖</span> Gemini AI Analysis
          </strong>
          <ul style="margin: 0; padding-left: 20px; color: #333;">
            ${r.aiReasons.map(reason => `<li>${esc(reason)}</li>`).join('')}
          </ul>
        </div>
      `;
    }

    const umlBlock = `
      <div class="master-row-meta">
        <span>👤 ${pre(r.nameGenderCell)}</span>
      </div>
      <div class="master-row-meta">
        <span>🚗 Driving Licence: ${esc(r.drivingLicence || '—')}</span>
      </div>
      <div class="master-row-meta"><span>🎓 Formal Qualifications:</span></div>
      <p class="master-cell">${pre(r.formalQualifications)}</p>

      <div class="master-row-meta"><span>📜 Other Certificates and Qualifications:</span></div>
      <p class="master-cell">${pre(r.otherCertificates)}</p>

      <div class="master-row-meta"><span>💼 Previous Experience:</span></div>
      <p class="master-cell">${pre(r.previousExperience)}</p>

      <div class="master-row-meta"><span>💼 Current Experience:</span></div>
      <p class="master-cell">${pre(r.currentExperience)}</p>
    `;

    const proofBlock = `
      <details class="proof-block">
        <summary>Original Job Listing</summary>
        <p class="proof-text">${esc(r.originalListing || '—')}</p>
      </details>
      <details class="proof-block">
        <summary>Applicant Response (CV extract)</summary>
        <p class="proof-text" style="white-space:pre-line">${esc(r.applicantResponse || '—')}</p>
      </details>
    `;

    return `
      <div class="master-row">
        <div class="master-row-head">
          <strong>${esc(r.applicationNo)}</strong>
          <span>${esc(r.name || '')}</span>
          ${atsBadge}
        </div>
        ${aiBlock}
        ${umlBlock}
        ${proofBlock}
        <small class="master-row-notes">${esc(r.reasons || '')}</small>
      </div>
    `;
  }).join('');
}

function closeMasterList() {
  $('masterListPanel')?.classList.remove('open');
  currentMasterJobId = null;
}

function downloadMasterListCsv() {
  if (!currentMasterJobId) return;
  window.location.assign(`/api/admin/jobs/${currentMasterJobId}/masterlist.csv`);
}

async function rebuildMasterList() {
  if (!currentMasterJobId) return;
  if (!confirm('Rebuild the master list? Each CV will be re-screened.')) return;

  $('masterListRebuild').disabled = true;
  $('masterListSummary').textContent = 'Re-screening CVs…';
  $('masterListQualified').innerHTML = '';
  $('masterListUnqualified').innerHTML = '';

  let data;
  try {
    // Adding force=1 here as well so rebuild always works
    const res = await fetch(`/api/admin/jobs/${currentMasterJobId}/masterlist?rebuild=1&force=1`, {
      credentials: 'include',
      headers: { 'X-CSRF-Token': csrfToken }
    });
    data = await res.json().catch(() => ({ ok: false, code: 'BAD_RESPONSE' }));
    if (data.csrfToken) csrfToken = data.csrfToken;
  } catch {
    data = { ok: false, error: 'Network error.' };
  }

  if (!data.ok) {
    $('masterListSummary').textContent = data.error || 'Rebuild failed.';
    $('masterListRebuild').disabled = false;
    return;
  }

  $('masterListSummary').textContent =
    `${data.counts.total} applications · ` +
    `${data.counts.qualified} qualified · ` +
    `${data.counts.unqualified} unqualified · ATS requirements match`;

  renderMasterRows($('masterListQualified'),   data.qualified);
  renderMasterRows($('masterListUnqualified'), data.unqualified);

  $('masterListDownload').disabled = false;
  $('masterListRebuild').disabled = false;
}

function initMasterListPanel() {
  const panel = $('masterListPanel');
  if (!panel) return;

  panel.addEventListener('click', (event) => {
    if (event.target === panel) closeMasterList();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && panel.classList.contains('open')) {
      closeMasterList();
    }
  });
}

/* ==========================================================================
   Application History
   ========================================================================== */
async function openHistoryPanel(candidateId) {
  currentHistoryCandidateId = Number(candidateId);

  const panel = $('historyPanel');
  if (!panel) { alert('History panel missing from admin.html.'); return; }

  panel.classList.add('open');
  $('historyTitle').textContent = 'Application History';
  $('historySummary').textContent = 'Loading…';
  $('historyList').innerHTML = '';

  let data;
  try {
    const res = await fetch(`/api/admin/candidates/${currentHistoryCandidateId}/applications`, {
      credentials: 'include',
      headers: { 'X-CSRF-Token': csrfToken }
    });
    data = await res.json().catch(() => ({ ok: false, error: 'Bad response.' }));
    if (data.csrfToken) csrfToken = data.csrfToken;
  } catch {
    data = { ok: false, error: 'Network error.' };
  }

  if (!data.ok) {
    $('historySummary').textContent = data.error || 'Could not load history.';
    return;
  }

  $('historyTitle').textContent = `Application History — ${data.candidate.name}`;
  $('historySummary').textContent = `${data.total} application(s) · ${data.candidate.email}`;

  if (!data.applications.length) {
    $('historyList').innerHTML = '<p class="empty">This candidate has not applied for any position.</p>';
    return;
  }

  $('historyList').innerHTML = data.applications.map((a) => {
    const appliedDate = a.appliedAt
      ? new Date(a.appliedAt * 1000).toLocaleString('en-ZA')
      : '—';

    const verdictBadge = a.verdict === 'Qualified'
      ? '<span class="badge badge-open">Qualified</span>'
      : a.verdict === 'Unqualified'
        ? '<span class="badge badge-closed">Unqualified</span>'
        : '<span class="badge" style="background:#fff3cd;color:#8a6d3b">Not yet screened</span>';

    return `
      <div class="master-row">
        <div class="master-row-head">
          <strong>${esc(a.applicationNo || `APP-${a.applicationId}`)}</strong>
          <span>${esc(a.job.title)}</span>
        </div>
        <div class="master-row-meta">
          <span>🏷 ${esc(a.job.category || '—')}</span>
          <span>📅 Applied ${esc(appliedDate)}</span>
          <span>🗓 Closing ${esc(a.job.closing_date || 'Open')}</span>
          <span>📌 Status ${esc(a.status)}</span>
        </div>
        <div class="master-row-meta">${verdictBadge}</div>
      </div>`;
  }).join('');
}

function closeHistoryPanel() {
  $('historyPanel')?.classList.remove('open');
  currentHistoryCandidateId = null;
}

/* ==========================================================================
   ATS — boolean CV search
   ========================================================================== */
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
  setMsg(
    'atsMsg',
    d.ok ? `Indexed ${d.indexed} of ${d.total} CVs.` : (d.error || 'Failed.'),
    d.ok
  );
}

/* --------------------------------------------------------------------------
   Start + 60-second refresh of the jobs table
   -------------------------------------------------------------------------- */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initMasterListPanel();
    boot();
    setInterval(() => {
      const panel = $('dashboardPanel');
      if (panel && panel.style.display !== 'none') {
        loadJobs().catch(() => {});
      }
    }, 60_000);
  });
} else {
  initMasterListPanel();
  boot();
  setInterval(() => {
    const panel = $('dashboardPanel');
    if (panel && panel.style.display !== 'none') {
      loadJobs().catch(() => {});
    }
  }, 60_000);
}