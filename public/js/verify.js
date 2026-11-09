/* ==========================================================================
   /js/verify.js — 6-digit email verification
   ========================================================================== */
'use strict';

const $ = (id) => document.getElementById(id);

const params = new URLSearchParams(location.search);
const email = (params.get('email') || '').trim();

const store = {
  get(key) { try { return sessionStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { sessionStorage.setItem(key, value); } catch { /* ignore */ } },
  del(key) { try { sessionStorage.removeItem(key); } catch { /* ignore */ } }
};

function rememberEmail(value) {
  try { localStorage.setItem('candidateEmail', value); } catch { /* ignore */ }
}

const boxes = Array.from(document.querySelectorAll('#codeInputs input'));
const msg = $('msg');

function setMsg(text, kind) {
  if (!msg) return;
  msg.className = 'msg ' + (kind || '');
  msg.textContent = text;
}

const getCode = () => boxes.map((box) => box.value).join('');

/* auto-advance + backspace + paste */
boxes.forEach((box, index) => {
  box.addEventListener('input', () => {
    box.value = box.value.replace(/\D/g, '').slice(0, 1);
    if (box.value && index < boxes.length - 1) boxes[index + 1].focus();
    if (getCode().length === boxes.length) verifyCode();
  });

  box.addEventListener('keydown', (event) => {
    if (event.key === 'Backspace' && !box.value && index > 0) {
      boxes[index - 1].focus();
      boxes[index - 1].value = '';
      event.preventDefault();
    }
  });

  box.addEventListener('paste', (event) => {
    event.preventDefault();
    const digits = (event.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
    digits.split('').forEach((digit, i) => { if (boxes[i]) boxes[i].value = digit; });
    const next = Math.min(digits.length, boxes.length - 1);
    boxes[next].focus();
    if (digits.length === boxes.length) verifyCode();
  });
});

async function verifyCode() {
  const code = getCode();
  if (code.length !== boxes.length) { setMsg('Please enter all 6 digits.', 'error'); return; }
  if (!email) { setMsg('Missing email. Please start again.', 'error'); return; }

  setMsg('Verifying…');

  try {
    const response = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok || data.ok === false) {
      setMsg(data.error || 'Incorrect code. Please try again.', 'error');
      boxes.forEach((box) => { box.value = ''; });
      boxes[0]?.focus();
      return;
    }

    store.set('signupEmail', email);
    store.set('signupVerified', '1');
    store.set('signupStep', '2');
    rememberEmail(email);
    setMsg('Verified! Loading your details…', 'success');

    window.setTimeout(() => {
      window.location.assign('/signup.html?step=2&email=' + encodeURIComponent(email));
    }, 700);
  } catch {
    setMsg('Network error. Please try again.', 'error');
  }
}

async function resendCode() {
  if (!email) { setMsg('Missing email. Please start again.', 'error'); return; }
  setMsg('Sending a new code…');

  try {
    const response = await fetch('/api/resend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok || data.ok === false) {
      setMsg(data.error || 'Could not resend the code.', 'error');
      return;
    }

    setMsg('A new code has been sent.', 'success');
    boxes.forEach((box) => { box.value = ''; });
    boxes[0]?.focus();
  } catch {
    setMsg('Network error. Please try again.', 'error');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  if ($('emailShow')) $('emailShow').textContent = email || '(unknown)';
  boxes[0]?.focus();
});