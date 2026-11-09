'use strict';

const state = {
  step: 1,
  email: '',
  title: '',
  education: [],
  experience: [],
  categories: [],
  locations: []
};

/* ---------- Helpers ---------- */
const $ = id => document.getElementById(id);
const val = id => { const el = $(id); return el ? String(el.value).trim() : ''; };

const store = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch {} },
  del(k) { try { sessionStorage.removeItem(k); } catch {} }
};

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

/* ---------- Fill month + year dropdowns ---------- */
function fillMonths() {
  const months = [
    'January','February','March','April','May','June',
    'July','August','September','October','November','December'
  ];
  document.querySelectorAll('select[id$="Month"]').forEach(sel => {
    if (sel.options.length === 0) {
      months.forEach(m => sel.add(new Option(m, m)));
    }
  });
}

function fillYears() {
  const now = new Date().getFullYear();
  for (let y = now + 1; y >= 1970; y--) {
    document.querySelectorAll('select[id$="Year"]').forEach(sel => {
      if (sel.options.length === 0) {
        sel.add(new Option(String(y), String(y)));
      }
    });
  }
}

/* ---------- Bootstrap: check ?step= and storage ---------- */
function bootstrap() {
  const params = new URLSearchParams(location.search);
  const requestedStep = Number(params.get('step') || 0);
  const urlEmail = (params.get('email') || '').trim();

  if (urlEmail) {
    state.email = urlEmail;
    store.set('signupEmail', urlEmail);
  }

  const savedEmail = urlEmail || store.get('signupEmail') || '';
  const verified = store.get('signupVerified') === '1';
  const savedStep = Number(store.get('signupStep') || 1);

  if (savedEmail) {
    state.email = savedEmail;
    const emailInput = $('email');
    const emailDisplay = $('emailDisplay');
    if (emailInput) emailInput.value = savedEmail;
    if (emailDisplay) emailDisplay.value = savedEmail;
  }

  const target = requestedStep || savedStep || 1;

  if (target >= 2 && verified && savedEmail) {
    showStep(target);
  } else if (target >= 2 && !verified) {
    alert('Please verify your email first.');
    showStep(1);
  } else {
    showStep(1);
  }
}

/* ---------- Navigation ---------- */
function showStep(n) {
  const cards = [...document.querySelectorAll('.form-card')];
  cards.forEach(el => el.classList.remove('active'));

  const card = document.querySelector(`.form-card[data-step="${n}"]`) || cards[0];
  if (card) card.classList.add('active');

  document.querySelectorAll('.progress .step').forEach(el =>
    el.classList.toggle('active', Number(el.dataset.step) === n));

  state.step = n;
  store.set('signupStep', String(n));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function goStep(n) {
  if (!validateStep(state.step)) return;
  showStep(n);
}

/* ---------- Validation ---------- */
function validateStep(s) {
  if (s === 1) {
    const email = val('email');
    if (!email) { alert('Please enter your email'); return false; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      alert('Please enter a valid email');
      return false;
    }
    const terms = $('terms');
    if (!terms || !terms.checked) { alert('Please accept the terms'); return false; }
  }
  if (s === 2) {
    if (!val('firstName')) { alert('Please enter your first name'); return false; }
    if (!val('lastName')) { alert('Please enter your last name'); return false; }
    if (!val('phoneNumber')) { alert('Please enter your phone number'); return false; }
  }
  return true;
}

/* ---------- Step 1: Subscribe ---------- */
async function startSignup() {
  if (!validateStep(1)) return;
  const email = val('email');

  const btn = $('subscribeBtn');
  const originalLabel = btn ? btn.textContent : '';
  const msg = $('msg');

  function fail(text) {
    if (msg) { msg.className = 'msg error'; msg.textContent = text; }
    if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  if (msg) { msg.className = 'msg'; msg.textContent = ''; }

  try {
    const res = await fetch('/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, acceptedTerms: true })
    });

    let data = {};
    try { data = await res.json(); } catch { data = {}; }

    if (!res.ok || data.ok === false) {
      fail(data.error || 'Something went wrong. Please try again.');
      return;
    }

    const status = data.status || '';
    const profileExists = status === 'profile_exists' || data.hasProfile === true;
    const alreadyRegistered = status === 'registered' || data.registered === true;

    // 1. Profile already exists — redirect to profile management
    if (profileExists) {
      store.set('signupEmail', email);
      if (msg) {
        msg.className = 'msg success';
        msg.innerHTML = '✅ Your profile already exists — no need to sign up again. ' +
                        '<a href="/profile.html">Update your profile</a> or <a href="/">apply for jobs</a>.';
      }
      if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
      return;
    }

    // 2. Email known, no profile — skip verification
    if (alreadyRegistered) {
      state.email = email;
      store.set('signupEmail', email);
      store.set('signupVerified', '1');
      if (msg) { msg.className = 'msg success'; msg.textContent = '✅ Welcome back! Loading your profile…'; }
      window.location.assign('/signup.html?step=2&email=' + encodeURIComponent(email));
      return;
    }

    // 3. Brand new email — normal verification flow
    state.email = email;
    store.set('signupEmail', email);
    store.del('signupVerified');
    window.location.assign('/verify.html?email=' + encodeURIComponent(email));
  } catch {
    fail('Network error. Please try again.');
  }
}

/* ---------- Chips ---------- */
function addChip(selectOrId, containerId) {
  const select = typeof selectOrId === 'string' ? $(selectOrId) : selectOrId;
  const container = $(containerId);
  if (!select || !container) return;

  const value = select.value.trim();
  if (!value) return;

  if ([...container.querySelectorAll('.chip')].some(c => c.dataset.value === value)) {
    select.value = '';
    return;
  }

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
  select.value = '';
}

/* ---------- Title buttons ---------- */
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

/* ---------- Education ---------- */
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

/* ---------- Experience ---------- */
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

/* ---------- Submit Profile ---------- */
async function submitProfile() {
  const cvInput = $('cvFile');
  const cv = cvInput && cvInput.files && cvInput.files[0];
  if (!cv) { alert('Please upload your CV'); return; }

  const catChips = $('catChips');
  const locChips = $('locChips');
  state.categories = catChips
    ? [...catChips.querySelectorAll('.chip')].map(c => c.dataset.value) : [];
  state.locations = locChips
    ? [...locChips.querySelectorAll('.chip')].map(c => c.dataset.value) : [];

  const fd = new FormData();
  fd.append('email', state.email);
  fd.append('firstName', val('firstName'));
  fd.append('lastName', val('lastName'));
  fd.append('middleName', val('middleName'));
  fd.append('title', state.title);
  fd.append('phoneCountryCode', val('phoneCountryCode'));
  fd.append('phoneNumber', val('phoneNumber'));
  fd.append('preferredJobCategory', state.categories.join(', '));
  fd.append('preferredJobLocation', state.locations.join(', '));
  fd.append('country', val('country'));
  fd.append('streetNumber', val('streetNumber'));
  fd.append('complexName', val('complexName'));
  fd.append('unitNumber', val('unitNumber'));
  fd.append('streetName', val('streetName'));
  fd.append('suburb', val('suburb'));
  fd.append('city', val('city'));
  fd.append('postalCode', val('postalCode'));
  fd.append('receiveJobAlerts', $('jobAlerts')?.checked ? '1' : '');
  fd.append('receiveMarketing', $('marketing')?.checked ? '1' : '');
  fd.append('education', JSON.stringify(state.education));
  fd.append('experience', JSON.stringify(state.experience));
  fd.append('cv', cv);
  const cover = $('coverFile')?.files?.[0];
  if (cover) fd.append('coverLetter', cover);

  const msg = $('submitMsg');
  const btn = $('submitBtn');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch('/api/profile', { method: 'POST', body: fd });

    let data = {};
    try { data = await res.json(); } catch { data = {}; }

    if (res.ok && data.ok !== false) {
      if (msg) {
        msg.className = 'msg success';
        msg.textContent = data.created === false
          ? '✅ Profile updated! You can now apply for jobs.'
          : '✅ Profile submitted! You can now apply for jobs.';
      }
      store.del('signupEmail');
      store.del('signupVerified');
      store.del('signupStep');
      setTimeout(() => { window.location.assign('/'); }, 2000);
    } else {
      if (msg) {
        msg.className = 'msg error';
        msg.textContent = '❌ ' + (data.error || 'Error');
      }
      if (btn) btn.disabled = false;
    }
  } catch {
    if (msg) { msg.className = 'msg error'; msg.textContent = '❌ Network error'; }
    if (btn) btn.disabled = false;
  }
}

/* ---------- Init ---------- */
ready(() => {
  fillMonths();
  fillYears();
  initTitleButtons();
  bootstrap();
});