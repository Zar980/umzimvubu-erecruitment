'use strict';

const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = ((value << 8) | byte) & 0xffff; // keep only what's needed; avoids int32 overflow
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    value = ((value << 5) | ALPHABET.indexOf(char)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

const generateSecret = (bytes = 20) => base32Encode(crypto.randomBytes(bytes));

function hotp(secret, counter, digits = 6) {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

const totp = (secret, atMs = Date.now(), step = 30, digits = 6) =>
  hotp(secret, Math.floor(atMs / 1000 / step), digits);

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function verifyTotp(secret, token, window = 1, atMs = Date.now()) {
  const clean = String(token || '').replace(/\D/g, '');
  if (clean.length !== 6 || !secret) return false;
  let ok = false;
  // Check every slot (no early return) so timing doesn't reveal which one matched.
  for (let i = -window; i <= window; i++) {
    if (safeEqual(totp(secret, atMs + i * 30000), clean)) ok = true;
  }
  return ok;
}

const otpauthUrl = ({ secret, label, issuer }) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}` +
  `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

module.exports = { generateSecret, totp, verifyTotp, otpauthUrl };