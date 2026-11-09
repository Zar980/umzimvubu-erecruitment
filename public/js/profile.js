'use strict';

const state = {
  email: '',
  title: '',
  education: [],
  experience: []
};

const $ = id => document.getElementById(id);
const val = id => { const el = $(id); return el ? String(el.value).trim() : ''; };

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function ready(fn) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn, { once: true });
  } else {
    fn();
  }
}

// Redirect unauthenticated visitors. `?next=` lets us return them after login.
function goToLogin() {
  const next = encodeURIComponent(location.pathname + location.search);
  location.replace('/signup.html?next=' + next);
}

// --- Views ---
function showLogin() {
  const lv = $('loginView'); if (lv) lv.style.display = 'block';
  const vv = $('verifyView'); if (vv) vv.style.display = 'none';
  const pv = $('profileView'); if (pv) pv.style.display = 'none';
}

function showVerify(email) {
  const lv = $('loginView'); if (lv) lv.style.display = 'none';
  const vv = $('verifyView'); if (vv) vv.style.display = 'block';
  const pv = $('profileView'); if (pv) pv.style.display = 'none';
  const ve = $('verifyEmail'); if (ve) ve.textContent = email;
  const vc = $('verifyCode'); if (vc) { vc.value = ''; vc.focus(); }
}

function showProfile() {
  const lv = $('loginView'); if (lv) lv.style.display = 'none';
  const vv = $('verifyView'); if (vv) vv.style.display = 'none';
  const pv = $('profileView'); if (pv) pv.style.display = 'block';
}

// --- Login flow ---
async function requestCode() {
  const email = val('loginEmail');
  if (!email) { setMsg('loginMsg', 'Enter your email.'); return; }

  const btn = $('loginBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  setMsg('loginMsg', '');

  try {
    const res = await fetch('/api/candidate/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await res.json().catch(() => ({}));

    if (!data.ok) {
      setMsg('loginMsg', data.error || 'Error');
      if (btn) { btn.disabled = false; btn.textContent = 'Send Code'; }
      return;
    }

    state.email = email;
    showVerify(email);

  } catch {
    setMsg('loginMsg', 'Network error.');
    if (btn) { btn.disabled = false; btn.textContent = 'Send Code'; }
  }
}

async function verifyCode() {
  const input = $('verifyCode');
  const code = input ? input.value.replace(/\D/g, '') : '';
  if (code.length !== 6) { setMsg('verifyMsg', 'Enter the 6-digit code.'); return; }

  const btn = $('verifyBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Verifying…'; }
  setMsg('verifyMsg', '');

  try {
    const res = await fetch('/api/candidate/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: state.email, code })
    });
    const data = await res.json().catch(() => ({}));

    if (!data.ok) {
      setMsg('verifyMsg', data.error || 'Invalid code.');
      if (btn) { btn.disabled = false; btn.textContent = 'Verify'; }
      return;
    }

    const loaded = await loadProfile();
    if (loaded) showProfile();

  } catch {
    setMsg('verifyMsg', 'Network error.');
    if (btn) { btn.disabled = false; btn.textContent = 'Verify'; }
  }
}

async function logout() {
  try { await fetch('/api/candidate/logout', { method: 'POST' }); } catch { /* ignore */ }
  location.replace('/');
}

// --- Load Profile ---
// Returns true on success, false on 401 (caller may redirect).
async function loadProfile() {
  // reset transient state so we don't paint stale data over a failed load
  state.education = [];
  state.experience = [];

  let res;
  try {
    res = await fetch('/api/candidate/profile', { credentials: 'include' });
  } catch {
    goToLogin();
    return false;
  }

  if (res.status === 401) {
    goToLogin();
    return false;
  }

  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    goToLogin();
    return false;
  }

  const c = data.candidate || {};

  // If they somehow bypassed the server guard, kick them back to signup
  if (!c.first_name) {
    goToLogin();
    return false;
  }

  safeSet('firstName', c.first_name);
  safeSet('middleName', c.middle_name);
  safeSet('lastName', c.last_name);
  safeSet('emailDisplay', c.email);
  safeSet('phoneCountryCode', c.phone_country_code || '+27');
  safeSet('phoneNumber', c.phone_number);

  safeSet('country', c.country || 'South Africa');
  safeSet('streetNumber', c.street_number);
  safeSet('complexName', c.complex_name);
  safeSet('unitNumber', c.unit_number);
  safeSet('streetName', c.street_name);
  safeSet('suburb', c.suburb);
  safeSet('city', c.city);
  safeSet('postalCode', c.postal_code);

  safeCheck('jobAlerts', c.receive_job_alerts === 1);
  safeCheck('marketing', c.receive_marketing === 1);

  // Title
  state.title = c.title || '';
  const titleGroup = $('titleGroup');
  if (titleGroup) {
    titleGroup.querySelectorAll('button').forEach(b => {
      b.classList.toggle('selected', b.dataset.title === state.title);
    });
  }

  // Chips
  const catChips = $('catChips');
  if (catChips) {
    catChips.innerHTML = '';
    if (c.preferred_job_category) {
      c.preferred_job_category.split(',').forEach(cat => {
        if (cat.trim()) addChipFromValue('catChips', cat.trim());
      });
    }
  }
  const locChips = $('locChips');
  if (locChips) {
    locChips.innerHTML = '';
    if (c.preferred_job_location) {
      c.preferred_job_location.split(',').forEach(loc => {
        if (loc.trim()) addChipFromValue('locChips', loc.trim());
      });
    }
  }

  // Education & Experience
  state.education = Array.isArray(data.education) ? data.education : [];
  state.experience = Array.isArray(data.experience) ? data.experience : [];
  renderEducation();
  renderExperience();

  return true;
}

function safeSet(id, value) { const el = $(id); if (el) el.value = value || ''; }
function safeCheck(id, checked) { const el = $(id); if (el) el.checked = !!checked; }

function addChipFromValue(containerId, value) {
  const container = $(containerId);
  if (!container) return;

  const chip = document.createElement('div');
  chip.className = 'chip';
  chip.dataset.value = value;

  const span = document.createElement('span');
  span.textContent = value;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = '×';
  btn.addEventListener('click', () => chip.remove());

  chip.append(span, btn);
  container.appendChild(chip);
}

// --- Save Profile ---
async function saveProfile() {
  const cvInput = $('cvFile');
  const coverInput = $('coverFile');
  const cvFile = cvInput && cvInput.files ? cvInput.files[0] : null;

  const formData = new FormData();
  formData.append('firstName', val('firstName'));
  formData.append('middleName', val('middleName'));
  formData.append('lastName', val('lastName'));
  formData.append('title', state.title);
  formData.append('phoneCountryCode', val('phoneCountryCode'));
  formData.append('phoneNumber', val('phoneNumber'));

  const catChipsEl = $('catChips');
  const cats = catChipsEl
    ? [...catChipsEl.querySelectorAll('.chip')].map(c => c.dataset.value)
    : [];
  formData.append('preferredJobCategory', cats.join(', '));

  const locChipsEl = $('locChips');
  const locs = locChipsEl
    ? [...locChipsEl.querySelectorAll('.chip')].map(c => c.dataset.value)
    : [];
  formData.append('preferredJobLocation', locs.join(', '));

  formData.append('country', val('country'));
  formData.append('streetNumber', val('streetNumber'));
  formData.append('complexName', val('complexName'));
  formData.append('unitNumber', val('unitNumber'));
  formData.append('streetName', val('streetName'));
  formData.append('suburb', val('suburb'));
  formData.append('city', val('city'));
  formData.append('postalCode', val('postalCode'));

  formData.append('receiveJobAlerts', $('jobAlerts')?.checked ? '1' : '');
  formData.append('receiveMarketing', $('marketing')?.checked ? '1' : '');

  formData.append('education', JSON.stringify(state.education));
  formData.append('experience', JSON.stringify(state.experience));

  if (cvFile) formData.append('cv', cvFile);
  if (coverInput && coverInput.files && coverInput.files[0]) {
    formData.append('coverLetter', coverInput.files[0]);
  }

  const btn = $('saveBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  setMsg('saveMsg', '');

  try {
    const res = await fetch('/api/profile', {
      method: 'POST',
      body: formData
    });

    if (res.status === 401) {
      goToLogin();
      return;
    }

    const data = await res.json().catch(() => ({}));

    if (data.ok) {
      setMsg('saveMsg', '✅ Profile saved successfully!', true);
      if (btn) { btn.disabled = false; btn.textContent = 'Saved!'; }
      if (cvInput) cvInput.value = '';
      if (coverInput) coverInput.value = '';
    } else {
      setMsg('saveMsg', '❌ ' + (data.error || 'Error'));
      if (btn) { btn.disabled = false; btn.textContent = 'Save Changes'; }
    }
  } catch {
    setMsg('saveMsg', '❌ Network error.');
    if (btn) { btn.disabled = false; btn.textContent = 'Save Changes'; }
  }
}

function setMsg(id, text, good) {
  const el = $(id);
  if (!el) return;
  el.textContent = text || '';
  el.className = good ? 'msg success' : 'msg error';
}

// --- Title group ---
function initTitleButtons() {
  const group = $('titleGroup');
  if (!group) return;
  group.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      group.querySelectorAll('button').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      state.title = btn.dataset.title || '';
    });
  });
}

// --- Chips ---
function addChip(selectId, containerId) {
  const select = $(selectId);
  const container = $(containerId);
  if (!select || !container) return;

  const value = select.value.trim();
  if (!value) return;

  if ([...container.querySelectorAll('.chip')].some(c => c.dataset.value === value)) {
    select.value = '';
    return;
  }

  addChipFromValue(containerId, value);
  select.value = '';
}

// --- Education / Experience ---
function openEducationForm() { $('eduModal')?.classList.add('open'); }
function openExperienceForm() { $('expModal')?.classList.add('open'); }
function closeModal(id) { $(id)?.classList.remove('open'); }

function saveEducation() {
  const e = {
    degree: val('eduDegree'),
    major: val('eduMajor'),
    school: val('eduSchool'),
    startMonth: val('eduStartMonth'),
    startYear: val('eduStartYear'),
    endMonth: val('eduEndMonth'),
    endYear: val('eduEndYear'),
    educationLevel: val('eduLevel'),
    country: val('eduCountry'),
    city: val('eduCity'),
    averageGrade: val('eduGrade'),
    yearAcquired: val('eduYearAcquired')
  };
  if (!e.degree) { alert('Please enter your qualification'); return; }
  state.education.push(e);
  renderEducation();
  closeModal('eduModal');
}

function renderEducation() {
  const list = $('educationList');
  if (!list) return;
  list.innerHTML = state.education.map((e, i) => `
    <div class="list-item">
      <div>
        <strong>${esc(e.degree)}</strong>
        <small>${esc(e.school)} ${esc(e.startMonth)}/${esc(e.startYear)} – ${esc(e.endMonth)}/${esc(e.endYear)}</small>
      </div>
      <button type="button" onclick="removeItem('education', ${i})">×</button>
    </div>`).join('');
}

function saveExperience() {
  const e = {
    employerName: val('expEmployer'),
    jobTitle: val('expTitle'),
    startMonth: val('expStartMonth'),
    startYear: val('expStartYear'),
    endMonth: val('expEndMonth'),
    endYear: val('expEndYear'),
    isCurrent: !!$('expCurrent')?.checked,
    employerCountry: val('expCountry'),
    employerCity: val('expCity'),
    responsibilities: val('expResp')
  };
  if (!e.employerName) { alert('Please enter the employer name'); return; }
  state.experience.push(e);
  renderExperience();
  closeModal('expModal');
}

function renderExperience() {
  const list = $('experienceList');
  if (!list) return;
  list.innerHTML = state.experience.map((e, i) => `
    <div class="list-item">
      <div>
        <strong>${esc(e.employerName)}</strong> — ${esc(e.jobTitle)}
        <small>${esc(e.startMonth)}/${esc(e.startYear)} – ${e.isCurrent ? 'Current' : esc(e.endMonth) + '/' + esc(e.endYear)}</small>
      </div>
      <button type="button" onclick="removeItem('experience', ${i})">×</button>
    </div>`).join('');
}

function removeItem(kind, index) {
  if (!Array.isArray(state[kind])) return;
  state[kind].splice(index, 1);
  if (kind === 'education') renderEducation();
  if (kind === 'experience') renderExperience();
}

// --- Dropdowns (Month/Year) ---
function fillMonths() {
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  document.querySelectorAll('select[id$="Month"]').forEach(sel => {
    if (sel.options.length === 0) {
      months.forEach(m => sel.add(new Option(m, m)));
    }
  });
}

function fillYears() {
  const now = new Date().getFullYear();
  const startYear = 1970;
  const endYear = now + 1;
  document.querySelectorAll('select[id$="Year"]').forEach(sel => {
    if (sel.options.length === 0) {
      for (let y = endYear; y >= startYear; y--) {
        sel.add(new Option(String(y), String(y)));
      }
    }
  });
}

// --- Init ---
ready(async () => {
  fillMonths();
  fillYears();
  initTitleButtons();

  try {
    const res = await fetch('/api/candidate/profile', { credentials: 'include' });
    if (res.ok) {
      const data = await res.json();
      
      // If they logged in but didn't finish signup, send them back to complete it
      if (!data.candidate || !data.candidate.first_name) {
        const next = encodeURIComponent(location.pathname + location.search);
        window.location.replace('/signup.html?next=' + next);
        return;
      }
      
      await loadProfile();
      showProfile();
    } else {
      const next = encodeURIComponent(location.pathname + location.search);
      window.location.replace('/signup.html?next=' + next);
    }
  } catch {
    const next = encodeURIComponent(location.pathname + location.search);
    window.location.replace('/signup.html?next=' + next);
  }
});