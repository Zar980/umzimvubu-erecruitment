'use strict';

const session = require('express-session');
const db = require('./db');

const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

class SqliteSessionStore extends session.Store {
  constructor({ ttlMs = DEFAULT_TTL_MS } = {}) {
    super();
    this.ttlMs = ttlMs;

    this.qGet = db.prepare('SELECT data, expires FROM sessions WHERE sid = ?');
    this.qSet = db.prepare(`
      INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires
    `);
    this.qTouch = db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?');
    this.qDelete = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.qPurge = db.prepare('DELETE FROM sessions WHERE expires < ?');
    this.qCount = db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE expires >= ?');

    this.purgeExpired();
    this.timer = setInterval(() => this.purgeExpired(), CLEANUP_INTERVAL_MS);
    this.timer.unref(); // don't keep the process alive just for cleanup
  }

  expiryFor(sess) {
    const cookieExpires = sess && sess.cookie && sess.cookie.expires;
    const t = cookieExpires ? new Date(cookieExpires).getTime() : NaN;
    return Number.isFinite(t) ? t : Date.now() + this.ttlMs;
  }

  purgeExpired() {
    try { this.qPurge.run(Date.now()); } catch (err) { console.error('[session] purge failed:', err.message); }
  }

  get(sid, cb) {
    try {
      const row = this.qGet.get(sid);
      if (!row) return cb(null, null);
      if (row.expires < Date.now()) {
        this.qDelete.run(sid);
        return cb(null, null);
      }
      let data = null;
      try { data = JSON.parse(row.data); } catch { this.qDelete.run(sid); }
      cb(null, data);
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sess, cb = () => {}) {
    try {
      this.qSet.run(sid, JSON.stringify(sess), this.expiryFor(sess));
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  touch(sid, sess, cb = () => {}) {
    try {
      this.qTouch.run(this.expiryFor(sess), sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  destroy(sid, cb = () => {}) {
    try {
      this.qDelete.run(sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  length(cb) {
    try { cb(null, this.qCount.get(Date.now()).c); } catch (err) { cb(err); }
  }
}

module.exports = SqliteSessionStore;