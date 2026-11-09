'use strict';

require('dotenv').config();
const nodemailer = require('nodemailer');

// Check if credentials exist
const hasSmtpConfig = !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);

let transporter = null;

if (hasSmtpConfig) {
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    },
    tls: {
      rejectUnauthorized: false // Helps with local Windows certificate errors
    }
  });
}

const transportName = hasSmtpConfig ? 'smtp' : 'console';

async function sendMail({ to, subject, text, html }) {
  if (!hasSmtpConfig) {
    console.log('\n--- DEV MODE EMAIL ---');
    console.log(`To: ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(`Text: ${text}`);
    console.log('----------------------\n');
    return { delivered: false, transport: 'console' };
  }

  try {
    const info = await transporter.sendMail({
      from: `"Umzimvubu Local Municipality" <${process.env.GMAIL_USER}>`,
      to,
      subject,
      text,
      html
    });
    console.log(`[mailer] Email sent successfully to ${to}. Message ID: ${info.messageId}`);
    return { delivered: true, transport: 'smtp', messageId: info.messageId };
  } catch (error) {
    console.error(`[mailer] Failed to send email to ${to}:`, error.message);
    return { delivered: false, transport: 'smtp_error', error: error.message };
  }
}

function devPrint(label, to, subject, text) {
  if (!hasSmtpConfig) {
    console.log(`\n--- DEV PRINT: ${label} ---`);
    console.log(`To: ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(`Text: ${text}`);
    console.log('----------------------\n');
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
  sendMail,
  sendSms,
  devPrint,
  maskEmail,
  maskPhone,
  transportName
};