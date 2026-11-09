'use strict';

require('dotenv').config();
const nodemailer = require('nodemailer');

// --- 1. Brevo Setup (Primary for Production) ---
const hasBrevo = !!process.env.BREVO_API_KEY;
const brevoSender = process.env.BREVO_SENDER || 'robustnumber1@gmail.com'; // Must be verified in Brevo

// --- 2. SMTP Fallback (Local Dev) ---
const hasSmtpConfig = !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
let transporter = null;
if (!hasBrevo && hasSmtpConfig) {
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    tls: { rejectUnauthorized: false }
  });
}

const transportName = hasBrevo ? 'brevo' : (hasSmtpConfig ? 'smtp' : 'console');

async function sendMail({ to, subject, text, html }) {
  // --- BREVO (HTTP API) ---
  if (hasBrevo) {
    try {
      const response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'api-key': process.env.BREVO_API_KEY,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          sender: { name: 'Umzimvubu Local Municipality', email: brevoSender },
          to: [{ email: to }],
          subject: subject,
          htmlContent: html,
          textContent: text
        })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || 'Brevo API error');
      }

      console.log(`[mailer] Brevo email sent successfully to ${to}. ID: ${data.messageId}`);
      return { delivered: true, transport: 'brevo', messageId: data.messageId };
    } catch (error) {
      console.error(`[mailer] Brevo failed for ${to}:`, error.message);
      return { delivered: false, transport: 'brevo_error', error: error.message };
    }
  }

  // --- SMTP FALLBACK (Local Dev) ---
  if (hasSmtpConfig) {
    try {
      const info = await transporter.sendMail({
        from: `"Umzimvubu Local Municipality" <${process.env.GMAIL_USER}>`,
        to, subject, text, html
      });
      console.log(`[mailer] SMTP email sent successfully to ${to}. ID: ${info.messageId}`);
      return { delivered: true, transport: 'smtp', messageId: info.messageId };
    } catch (error) {
      console.error(`[mailer] SMTP failed for ${to}:`, error.message);
      return { delivered: false, transport: 'smtp_error', error: error.message };
    }
  }

  // --- CONSOLE FALLBACK (No credentials) ---
  console.log('\n--- DEV MODE EMAIL ---');
  console.log(`To: ${to}\nSubject: ${subject}\nText: ${text}\n----------------------\n`);
  return { delivered: false, transport: 'console' };
}

function devPrint(label, to, subject, text) {
  if (!hasBrevo && !hasSmtpConfig) {
    console.log(`\n--- DEV PRINT: ${label} ---\nTo: ${to}\nSubject: ${subject}\nText: ${text}\n----------------------\n`);
  }
}

async function sendSms({ to, text }) {
  console.log(`[SMS Mock] to ${to}: ${text}`);
  return { delivered: false, transport: 'console' };
}

function maskEmail(email) {
  if (!email) return '';
  const [name, domain] = email.split('@');
  return `${name[0]}***@${domain}`;
}

function maskPhone(phone) {
  if (!phone) return '';
  return phone.slice(0, -4).replace(/\d/g, '*') + phone.slice(-4);
}

module.exports = {
  sendMail, sendSms, devPrint, maskEmail, maskPhone, transportName
};