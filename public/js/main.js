/* ==========================================================================
   /js/main.js — public jobs board
   Renders the open positions, the "Apply" pop-up, and shows "Closed on:"
   instead of "Closing:" for jobs whose closing date has already passed.
   ========================================================================== */
'use strict';

const ENDPOINT = Object.freeze({
  JOBS: '/api/jobs',
  CATEGORIES: '/api/categories',
  APPLY: '/api/apply'
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function ready(fn) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn, { once: true });
  } else {
    fn();
  }
}

/* --------------------------------------------------------------------------
   Categories
   -------------------------------------------------------------------------- */
async function loadCategories() {
  const select = $('categoryFilter');
  if (!select) return;

  try {
    const response = await fetch(ENDPOINT.CATEGORIES);
    const data = await response.json();
    (data.categories || []).forEach((category) => {
      const option = document.createElement('option');
      option.value = category;
      option.textContent = category;
      select.appendChild(option);
    });
  } catch {
    /* filter stays with just "All Categories" */
  }
}

/* --------------------------------------------------------------------------
   Jobs
   -------------------------------------------------------------------------- */
const jobsById = new Map();

async function loadJobs() {
  const list = $('jobsList');
  const counter = $('jobCount');
  if (!list) return;

  const params = new URLSearchParams();
  const search = $('searchInput')?.value.trim();
  const category = $('categoryFilter')?.value;

  if (search) params.set('search', search);
  if (category) params.set('category', category);

  list.innerHTML = '<p class="loading">Loading positions…</p>';

  try {
    const response = await fetch(`${ENDPOINT.JOBS}?${params.toString()}`);
    const data = await response.json();
    const jobs = data.jobs || [];

    jobsById.clear();
    jobs.forEach((job) => jobsById.set(Number(job.id), job));

    renderJobs(jobs);
    if (counter) counter.textContent = String(jobs.length);
  } catch {
    list.innerHTML = '<p class="msg error">Could not load positions.</p>';
  }
}

function renderJobs(jobs) {
  const list = $('jobsList');
  if (!list) return;

  if (!jobs.length) {
    list.innerHTML = '<p class="empty">No open positions match your search.</p>';
    return;
  }

  list.innerHTML = jobs.map((job) => {
    /* The server annotates each job with effectiveOpen / effectiveClosed. */
    const open = job.effectiveOpen !== false;
    const closing = job.closing_date || 'Open until filled';

    const dateLine = open
      ? `<small class="job-closing">Closing: ${escapeHtml(closing)}</small>`
      : `<small class="job-closing job-closed-label">Closed on: ${escapeHtml(closing)}</small>`;

    const applyButton = open
      ? `<button type="button" class="btn-primary" onclick="applyForJob(${Number(job.id)})">Apply</button>`
      : `<button type="button" class="btn-primary" disabled aria-disabled="true">Closed</button>`;

    return `
      <article class="job-card${open ? '' : ' job-card-closed'}">
        <h4>${escapeHtml(job.title)}</h4>
        <p class="job-meta">${escapeHtml(job.category || 'General')} · ${escapeHtml(job.location || '')}</p>
        <p class="job-desc">${escapeHtml(job.description || '')}</p>
        <p class="job-req">${escapeHtml(job.requirements || '')}</p>
        <div class="job-foot">
          ${dateLine}
          ${applyButton}
        </div>
      </article>`;
  }).join('');
}

/** Inline handler from the Search button. */
function filterJobs() {
  loadJobs();
}

/* --------------------------------------------------------------------------
   Apply pop-up
   -------------------------------------------------------------------------- */
let pendingJobId = null;
let sending = false;

function setApplyMsg(text, isError = true) {
  const el = $('applyMsg');
  if (!el) return;
  el.textContent = text || '';
  el.className = isError ? 'apply-msg error' : 'apply-msg';
}

/** Inline handler from each job card's Apply button. */
function applyForJob(jobId) {
  const job = jobsById.get(Number(jobId));
  pendingJobId = Number(jobId);

  /* Short-circuit if the job is already closed — no point opening the form. */
  if (job && job.effectiveClosed === true) {
    alert(`"${job.title}" closed on ${job.closing_date || 'its closing date'}. Applications are no longer accepted.`);
    return;
  }

  $('applyJobTitle').textContent = job ? job.title : '';
  $('applyEmail').value = '';
  setApplyMsg('');
  $('applyForm').style.display = 'block';
  $('applyResult').style.display = 'none';
  $('applySubmit').disabled = false;
  $('applySubmit').textContent = 'Submit application';

  $('applyModal').classList.add('open');
  $('applyEmail').focus();
}

function closeApplyModal() {
  $('applyModal').classList.remove('open');
  pendingJobId = null;
  sending = false;
}

function showApplySuccess(data, email) {
  $('applyForm').style.display = 'none';
  $('applyResult').style.display = 'block';

  $('applyResultText').textContent = data.message ||
    (data.alreadyApplied
      ? `You have already applied with ${email}.`
      : `Applied and email sent to ${email}.`);
  $('applyDevNote').textContent = data.devNote || '';
}

function showSignupPrompt(message) {
  const el = $('applyMsg');
  el.className = 'apply-msg error';
  el.textContent = '';
  el.append(`${message} `);

  const link = document.createElement('a');
  link.href = '/signup.html';
  link.textContent = 'Join the Talent Community';
  el.appendChild(link);
}

async function submitApplication() {
  if (sending || pendingJobId === null) return;

  const email = $('applyEmail').value.trim().toLowerCase();

  if (!email) { setApplyMsg('Please enter your email.'); return; }
  if (!EMAIL_RE.test(email)) { setApplyMsg('Please enter a valid email address.'); return; }

  sending = true;
  const button = $('applySubmit');
  button.disabled = true;
  button.textContent = 'Submitting…';
  setApplyMsg('');

  try {
    const response = await fetch(ENDPOINT.APPLY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, jobId: pendingJobId })
    });
    const data = await response.json().catch(() => ({}));

    if (response.ok && data.ok !== false) {
      showApplySuccess(data, email);
      sending = false;
      return;
    }

    if (data.code === 'NOT_REGISTERED' || data.code === 'PROFILE_INCOMPLETE') {
      showSignupPrompt(data.error || 'We could not find a completed profile for that email.');
    } else {
      setApplyMsg(data.error || 'Could not submit your application.');
    }
  } catch {
    setApplyMsg('Network error. Please try again.');
  }

  sending = false;
  button.disabled = false;
  button.textContent = 'Submit application';
}

function initApplyModal() {
  $('applySubmit')?.addEventListener('click', submitApplication);
  $('applyCancel')?.addEventListener('click', closeApplyModal);
  $('applyClose')?.addEventListener('click', closeApplyModal);

  $('applyEmail')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); submitApplication(); }
  });

  $('applyModal')?.addEventListener('click', (event) => {
    if (event.target === $('applyModal')) closeApplyModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && $('applyModal')?.classList.contains('open')) closeApplyModal();
  });
}

/* --------------------------------------------------------------------------
   Init
   -------------------------------------------------------------------------- */
ready(() => {
  initApplyModal();
  loadCategories();
  loadJobs();

  $('searchInput')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') loadJobs();
  });
  $('categoryFilter')?.addEventListener('change', loadJobs);
});