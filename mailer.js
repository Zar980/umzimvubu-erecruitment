'use strict';

require('dotenv').config();
const { Resend } = require('resend');
const nodemailer = require('nodemailer');

// Check if we have a Resend API Key (Preferred for Render)
const hasResend = !!process.env.RESEND_API_KEY;
const resend = hasResend ? new Resend(process.env.RESEND_API_KEY) : null;

// Fallback to SMTP (Local development)
const hasSmtpConfig = !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
let transporter = null;
if (!hasResend && hasSmtpConfig) {
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    tls: { rejectUnauthorized: false }
  });
}

const transportName = hasResend ? 'resend' : (hasSmtpConfig ? 'smtp' : 'console');

async function sendMail({ to, subject, text, html }) {
  if (hasResend) {
    try {
      const data = await resend.emails.send({
        from: 'Umzimvubu Recruitment <onboarding@resend.dev>', // Resend's test domain
        to: [to],
        subject: subject,
        text: text,
        html: html
      });
      console.log(`[mailer] Resend email sent successfully to ${to}. ID: ${data.id}`);
      return { delivered: true, transport: 'resend', messageId: data.id };
    } catch (error) {
      console.error(`[mailer] Resend failed for ${to}:`, error);
      return { delivered: false, transport: 'resend_error', error: error.message };
    }
  }

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

  console.log('\n--- DEV MODE EMAIL ---');
  console.log(`To: ${to}\nSubject: ${subject}\nText: ${text}\n----------------------\n`);
  return { delivered: false, transport: 'console' };
}

function devPrint(label, to, subject, text) {
  if (!hasResend && !hasSmtpConfig) {
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