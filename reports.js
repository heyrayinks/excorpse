const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Abuse reports — a persistent, operator-reviewable queue. Deliberately a
// SEPARATE store from users.json: reports are append-heavy, unrelated to the
// user write-path, and must survive even when the thing they're about (a
// comment, a live game) is gone. Same zero-dependency, serialized-write
// pattern as data.js, kept independent so a report write can never contend
// with or corrupt the user file.
const DATA_DIR = path.join(__dirname, 'data');
const REPORTS_FILE = path.join(DATA_DIR, 'reports.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(REPORTS_FILE)) {
  fs.writeFileSync(REPORTS_FILE, JSON.stringify({ reports: [] }, null, 2));
}

let writeQueue = Promise.resolve();
function queue(fn) {
  const result = writeQueue.then(fn);
  writeQueue = result.catch(() => {});
  return result;
}

function read() {
  try {
    return JSON.parse(fs.readFileSync(REPORTS_FILE, 'utf-8'));
  } catch (err) {
    console.error('[reports] read error:', err.message);
    return { reports: [] };
  }
}

function write(data) {
  return new Promise((resolve, reject) => {
    const tmp = REPORTS_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(data, null, 2), err => {
      if (err) return reject(err);
      fs.rename(tmp, REPORTS_FILE, err2 => (err2 ? reject(err2) : resolve()));
    });
  });
}

const TYPES = ['comment', 'creation', 'player', 'game', 'other'];

// Trim + hard-cap every string a reporter controls, so a report can't be used
// to smuggle a huge payload into the store or the notification email. Whatever
// the client sends, this is what lands on disk.
function clampStr(v, max) {
  return (v == null ? '' : String(v)).trim().slice(0, max);
}

// Capture a report. `reporter` is { id, name } or null for an anonymous game
// player (class kids draw without accounts — they still need to be able to
// report). `context` is type-specific and snapshotted here on purpose: the
// reported comment or game may be deleted before the operator reviews it, so
// the report has to carry its own evidence.
exports.createReport = ({ type, reason, reporter, context }) => {
  const t = TYPES.includes(type) ? type : 'other';
  const report = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    type: t,
    reason: clampStr(reason, 1000),
    reporterId: reporter && reporter.id ? reporter.id : null,
    reporterName: clampStr(reporter && reporter.name, 60) || 'anonymous',
    context: {
      // Only known, size-bounded fields are copied — never the raw context
      // object, so a client can't stuff arbitrary data (or a base64 image) in.
      commentText: clampStr(context && context.commentText, 1000),
      targetName: clampStr(context && context.targetName, 60),
      gameCode: clampStr(context && context.gameCode, 12),
      ownerId: clampStr(context && context.ownerId, 64),
      favoriteId: clampStr(context && context.favoriteId, 64),
      commentId: clampStr(context && context.commentId, 64),
      where: clampStr(context && context.where, 40),
    },
    resolved: false,
    resolvedAt: null,
    resolvedNote: null,
  };
  return queue(() => {
    const store = read();
    store.reports.unshift(report); // newest first
    // Soft cap so the file can't grow unbounded from report spam. Resolved
    // reports are dropped first; if somehow all 500 are open, the oldest goes.
    if (store.reports.length > 500) {
      const keep = store.reports.filter(r => !r.resolved);
      store.reports = (keep.length <= 500 ? keep : keep.slice(0, 500));
    }
    return write(store).then(() => report);
  });
};

exports.listReports = ({ status = 'open', limit = 100 } = {}) => {
  const store = read();
  let rows = store.reports;
  if (status === 'open') rows = rows.filter(r => !r.resolved);
  else if (status === 'resolved') rows = rows.filter(r => r.resolved);
  return {
    openCount: store.reports.filter(r => !r.resolved).length,
    total: store.reports.length,
    reports: rows.slice(0, Math.min(limit, 500)),
  };
};

exports.resolveReport = (id, note) => {
  return queue(() => {
    const store = read();
    const r = store.reports.find(x => x.id === id);
    if (!r) return { notFound: true };
    r.resolved = true;
    r.resolvedAt = Date.now();
    r.resolvedNote = clampStr(note, 500) || null;
    return write(store).then(() => ({ resolved: r }));
  });
};
