// SplitLah server: zero-dependency Node (>= 22.13) using node:http and node:sqlite.
// Run: node server.js   then open http://localhost:3000

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'splitlah.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_DAYS = 30;
const SECURE_COOKIE = process.env.NODE_ENV === 'production';

// ---------- database ----------

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY,
    username     TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    phone        TEXT,
    pass_hash    TEXT NOT NULL,
    salt         TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS groups (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    invite_code TEXT NOT NULL UNIQUE,
    created_by  INTEGER NOT NULL REFERENCES users(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS members (
    group_id  INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (group_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS expenses (
    id           INTEGER PRIMARY KEY,
    group_id     INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    description  TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    paid_by      INTEGER NOT NULL REFERENCES users(id),
    spent_on     TEXT NOT NULL,
    created_by   INTEGER NOT NULL REFERENCES users(id),
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS expense_shares (
    expense_id  INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    share_cents INTEGER NOT NULL CHECK (share_cents >= 0),
    PRIMARY KEY (expense_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS settlements (
    id           INTEGER PRIMARY KEY,
    group_id     INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    from_user    INTEGER NOT NULL REFERENCES users(id),
    to_user      INTEGER NOT NULL REFERENCES users(id),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    created_by   INTEGER NOT NULL REFERENCES users(id),
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    note         TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_expenses_group ON expenses(group_id);
  CREATE INDEX IF NOT EXISTS idx_settlements_group ON settlements(group_id);
`);

// Databases created by the first draft lack settlements.note.
if (!db.prepare('PRAGMA table_info(settlements)').all().some((c) => c.name === 'note')) {
  db.exec('ALTER TABLE settlements ADD COLUMN note TEXT');
}

const q = (sql) => db.prepare(sql);

function tx(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---------- helpers ----------

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// "12.5" -> 1250. Avoids float rounding by parsing the string.
function toCents(value) {
  const s = String(value ?? '').trim();
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) fail(400, 'Enter an amount like 12.50');
  return Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'));
}

function newInviteCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    const bytes = crypto.randomBytes(6);
    const code = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
    if (!q('SELECT 1 FROM groups WHERE invite_code = ?').get(code)) return code;
  }
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(token, maxAgeSec) {
  return `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSec}${SECURE_COOKIE ? '; Secure' : ''}`;
}

function cleanText(value, field, max) {
  const s = String(value ?? '').trim();
  if (!s) fail(400, `${field} is required`);
  if (s.length > max) fail(400, `${field} must be at most ${max} characters`);
  return s;
}

function publicUser(u) {
  return { id: u.id, username: u.username, displayName: u.display_name, phone: u.phone || '' };
}

// ---------- balances ----------

// Net balance per user: positive means the group owes them, negative means they owe.
function groupBalances(groupId) {
  const bal = new Map();
  const add = (uid, cents) => bal.set(uid, (bal.get(uid) || 0) + cents);
  for (const r of q('SELECT user_id FROM members WHERE group_id = ?').all(groupId)) add(r.user_id, 0);
  for (const e of q('SELECT paid_by, amount_cents FROM expenses WHERE group_id = ?').all(groupId)) add(e.paid_by, e.amount_cents);
  for (const s of q(`SELECT s.user_id, s.share_cents FROM expense_shares s
                     JOIN expenses e ON e.id = s.expense_id WHERE e.group_id = ?`).all(groupId)) add(s.user_id, -s.share_cents);
  for (const s of q('SELECT from_user, to_user, amount_cents FROM settlements WHERE group_id = ?').all(groupId)) {
    add(s.from_user, s.amount_cents);
    add(s.to_user, -s.amount_cents);
  }
  return bal;
}

// Greedy matching of biggest debtor to biggest creditor: at most n-1 transfers.
function suggestTransfers(bal) {
  const debtors = [], creditors = [];
  for (const [uid, c] of bal) {
    if (c < 0) debtors.push({ uid, c: -c });
    else if (c > 0) creditors.push({ uid, c });
  }
  debtors.sort((a, b) => b.c - a.c);
  creditors.sort((a, b) => b.c - a.c);
  const out = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amt = Math.min(debtors[i].c, creditors[j].c);
    out.push({ from: debtors[i].uid, to: creditors[j].uid, amountCents: amt });
    debtors[i].c -= amt;
    creditors[j].c -= amt;
    if (debtors[i].c === 0) i++;
    if (creditors[j].c === 0) j++;
  }
  return out;
}

// What each friend owes the user (positive) or is owed (negative), netted across every shared group.
// Built from each group's settle-up transfers so it matches what the group pages show.
function friendBalances(userId) {
  const groups = q(`SELECT g.id, g.name FROM groups g JOIN members m ON m.group_id = g.id
                    WHERE m.user_id = ? ORDER BY g.created_at`).all(userId);
  const friends = new Map();
  for (const g of groups) {
    for (const t of suggestTransfers(groupBalances(g.id))) {
      let other, cents;
      if (t.to === userId) { other = t.from; cents = t.amountCents; }
      else if (t.from === userId) { other = t.to; cents = -t.amountCents; }
      else continue;
      if (!friends.has(other)) friends.set(other, { cents: 0, groups: [] });
      const f = friends.get(other);
      f.cents += cents;
      f.groups.push({ id: g.id, name: g.name, cents });
    }
  }
  return friends;
}

// ---------- route handlers ----------

function requireMember(groupId, userId) {
  const g = q('SELECT * FROM groups WHERE id = ?').get(groupId);
  if (!g || !q('SELECT 1 FROM members WHERE group_id = ? AND user_id = ?').get(groupId, userId)) {
    fail(404, 'Group not found');
  }
  return g;
}

function memberIds(groupId) {
  return new Set(q('SELECT user_id FROM members WHERE group_id = ?').all(groupId).map((r) => r.user_id));
}

function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = Date.now() + SESSION_DAYS * 864e5;
  q('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, expires);
  res.setHeader('Set-Cookie', sessionCookie(token, SESSION_DAYS * 86400));
}

const routes = [];
const route = (method, pattern, handler, { auth = true } = {}) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '(\\d+)'; }) + '$');
  routes.push({ method, re, keys, handler, auth });
};

route('POST', '/api/register', ({ body, res }) => {
  const username = cleanText(body.username, 'Username', 30).toLowerCase();
  if (!/^[a-z0-9_.]{3,30}$/.test(username)) fail(400, 'Username: 3-30 letters, numbers, _ or .');
  const displayName = cleanText(body.displayName || username, 'Display name', 40);
  const password = String(body.password || '');
  if (password.length < 6) fail(400, 'Password must be at least 6 characters');
  if (q('SELECT 1 FROM users WHERE username = ?').get(username)) fail(409, 'That username is taken');
  const salt = crypto.randomBytes(16).toString('hex');
  const { lastInsertRowid } = q('INSERT INTO users (username, display_name, pass_hash, salt) VALUES (?, ?, ?, ?)')
    .run(username, displayName, hashPassword(password, salt), salt);
  startSession(res, Number(lastInsertRowid));
  return { user: publicUser(q('SELECT * FROM users WHERE id = ?').get(lastInsertRowid)) };
}, { auth: false });

route('POST', '/api/login', ({ body, res }) => {
  const u = q('SELECT * FROM users WHERE username = ?').get(String(body.username || '').trim());
  const ok = u && crypto.timingSafeEqual(
    Buffer.from(hashPassword(String(body.password || ''), u.salt), 'hex'),
    Buffer.from(u.pass_hash, 'hex'));
  if (!ok) fail(401, 'Wrong username or password');
  startSession(res, u.id);
  return { user: publicUser(u) };
}, { auth: false });

route('POST', '/api/logout', ({ req, res }) => {
  const token = parseCookies(req.headers.cookie).sid;
  if (token) q('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.setHeader('Set-Cookie', sessionCookie('', 0));
  return { ok: true };
}, { auth: false });

route('GET', '/api/me', ({ user }) => ({ user: publicUser(user) }));

route('PATCH', '/api/me', ({ user, body }) => {
  const displayName = cleanText(body.displayName, 'Display name', 40);
  const phone = String(body.phone || '').replace(/[^\d+]/g, '').slice(0, 16);
  q('UPDATE users SET display_name = ?, phone = ? WHERE id = ?').run(displayName, phone, user.id);
  return { user: publicUser(q('SELECT * FROM users WHERE id = ?').get(user.id)) };
});

route('GET', '/api/groups', ({ user }) => {
  const groups = q(`SELECT g.id, g.name, (SELECT COUNT(*) FROM members m2 WHERE m2.group_id = g.id) AS member_count
                    FROM groups g JOIN members m ON m.group_id = g.id
                    WHERE m.user_id = ? ORDER BY g.created_at DESC`).all(user.id);
  return {
    groups: groups.map((g) => ({
      id: g.id, name: g.name, memberCount: g.member_count,
      myBalanceCents: groupBalances(g.id).get(user.id) || 0,
    })),
  };
});

route('GET', '/api/friends', ({ user }) => {
  const friends = friendBalances(user.id);
  const users = q('SELECT * FROM users WHERE id = ?');
  return {
    friends: [...friends].map(([uid, f]) => ({ ...publicUser(users.get(uid)), netCents: f.cents, groups: f.groups }))
      .sort((a, b) => Math.abs(b.netCents) - Math.abs(a.netCents)),
  };
});

// Clears everything between the user and one friend: one repayment per shared group, so every group zeroes out.
// expectedCents guards against settling numbers the user never saw.
route('POST', '/api/friends/:uid/settle', ({ user, params, body }) => tx(() => {
  const f = friendBalances(user.id).get(params.uid);
  if (!f) fail(404, 'Nothing to settle with this person');
  if (Number(body.expectedCents) !== f.cents) fail(409, 'Balances changed since you looked. Refresh and try again.');
  const ins = q(`INSERT INTO settlements (group_id, from_user, to_user, amount_cents, created_by, note)
                 VALUES (?, ?, ?, ?, ?, 'Combined settle-up')`);
  for (const g of f.groups) {
    const [from, to] = g.cents > 0 ? [params.uid, user.id] : [user.id, params.uid];
    ins.run(g.id, from, to, Math.abs(g.cents), user.id);
  }
  return { cleared: f.groups.length };
}));

route('POST', '/api/groups', ({ user, body }) => {
  const name = cleanText(body.name, 'Group name', 60);
  return tx(() => {
    const { lastInsertRowid } = q('INSERT INTO groups (name, invite_code, created_by) VALUES (?, ?, ?)')
      .run(name, newInviteCode(), user.id);
    q('INSERT INTO members (group_id, user_id) VALUES (?, ?)').run(lastInsertRowid, user.id);
    return { id: Number(lastInsertRowid) };
  });
});

route('POST', '/api/groups/join', ({ user, body }) => {
  const code = String(body.code || '').trim().toUpperCase();
  const g = q('SELECT id FROM groups WHERE invite_code = ?').get(code);
  if (!g) fail(404, 'No group with that code');
  q('INSERT OR IGNORE INTO members (group_id, user_id) VALUES (?, ?)').run(g.id, user.id);
  return { id: g.id };
});

route('GET', '/api/groups/:id', ({ user, params }) => {
  const g = requireMember(params.id, user.id);
  const members = q(`SELECT u.* FROM users u JOIN members m ON m.user_id = u.id
                     WHERE m.group_id = ? ORDER BY m.joined_at`).all(g.id).map(publicUser);
  const shares = q(`SELECT s.expense_id, s.user_id, s.share_cents FROM expense_shares s
                    JOIN expenses e ON e.id = s.expense_id WHERE e.group_id = ?`).all(g.id);
  const sharesBy = new Map();
  for (const s of shares) {
    if (!sharesBy.has(s.expense_id)) sharesBy.set(s.expense_id, []);
    sharesBy.get(s.expense_id).push({ userId: s.user_id, shareCents: s.share_cents });
  }
  const expenses = q('SELECT * FROM expenses WHERE group_id = ? ORDER BY spent_on DESC, id DESC').all(g.id).map((e) => ({
    id: e.id, description: e.description, amountCents: e.amount_cents, paidBy: e.paid_by,
    spentOn: e.spent_on, createdBy: e.created_by, createdAt: e.created_at, shares: sharesBy.get(e.id) || [],
  }));
  const settlements = q('SELECT * FROM settlements WHERE group_id = ? ORDER BY id DESC').all(g.id).map((s) => ({
    id: s.id, from: s.from_user, to: s.to_user, amountCents: s.amount_cents, createdBy: s.created_by, createdAt: s.created_at,
    note: s.note || '',
  }));
  const bal = groupBalances(g.id);
  return {
    group: { id: g.id, name: g.name, inviteCode: g.invite_code, createdBy: g.created_by },
    members, expenses, settlements,
    balances: Object.fromEntries(bal),
    transfers: suggestTransfers(bal),
  };
});

route('PATCH', '/api/groups/:id', ({ user, params, body }) => {
  const g = requireMember(params.id, user.id);
  q('UPDATE groups SET name = ? WHERE id = ?').run(cleanText(body.name, 'Group name', 60), g.id);
  return { ok: true };
});

route('POST', '/api/groups/:id/members', ({ user, params, body }) => {
  const g = requireMember(params.id, user.id);
  const u = q('SELECT id FROM users WHERE username = ?').get(String(body.username || '').trim());
  if (!u) fail(404, 'No user with that username. Ask them to sign up, or share the invite code.');
  q('INSERT OR IGNORE INTO members (group_id, user_id) VALUES (?, ?)').run(g.id, u.id);
  return { ok: true };
});

route('DELETE', '/api/groups/:id/members/:uid', ({ user, params }) => {
  const g = requireMember(params.id, user.id);
  if (params.uid !== user.id && g.created_by !== user.id) fail(403, 'Only the group creator can remove other people');
  const used = q(`SELECT 1 FROM expenses WHERE group_id = ? AND paid_by = ?
                  UNION SELECT 1 FROM expense_shares s JOIN expenses e ON e.id = s.expense_id WHERE e.group_id = ? AND s.user_id = ?
                  UNION SELECT 1 FROM settlements WHERE group_id = ? AND (from_user = ? OR to_user = ?)`)
    .get(g.id, params.uid, g.id, params.uid, g.id, params.uid, params.uid);
  if (used) fail(409, 'This person is part of bills or payments in this group, so they can\'t be removed');
  q('DELETE FROM members WHERE group_id = ? AND user_id = ?').run(g.id, params.uid);
  return { ok: true };
});

route('POST', '/api/groups/:id/expenses', ({ user, params, body }) => {
  const g = requireMember(params.id, user.id);
  const ids = memberIds(g.id);
  const description = cleanText(body.description, 'Description', 80);
  const amount = toCents(body.amount);
  const paidBy = Number(body.paidBy);
  if (!ids.has(paidBy)) fail(400, 'The payer must be in the group');
  const spentOn = /^\d{4}-\d{2}-\d{2}$/.test(body.spentOn || '') ? body.spentOn : new Date().toISOString().slice(0, 10);

  let shares; // [[userId, cents]]
  if (body.splitMode === 'exact') {
    shares = Object.entries(body.shares || {})
      .map(([uid, v]) => [Number(uid), String(v).trim() === '' ? 0 : toCents(v)])
      .filter(([, c]) => c > 0);
    if (shares.some(([uid]) => !ids.has(uid))) fail(400, 'Everyone in the split must be in the group');
    const sum = shares.reduce((a, [, c]) => a + c, 0);
    if (sum !== amount) fail(400, `The amounts add up to ${(sum / 100).toFixed(2)}, not ${(amount / 100).toFixed(2)}`);
  } else {
    const people = [...new Set((body.splitAmong || []).map(Number))].filter((uid) => ids.has(uid));
    if (!people.length) fail(400, 'Pick at least one person to split with');
    const base = Math.floor(amount / people.length);
    let extra = amount - base * people.length; // leftover cents go to the first few people
    shares = people.map((uid) => [uid, base + (extra-- > 0 ? 1 : 0)]);
  }
  if (!shares.length) fail(400, 'Pick at least one person to split with');

  return tx(() => {
    const { lastInsertRowid } = q(`INSERT INTO expenses (group_id, description, amount_cents, paid_by, spent_on, created_by)
                                   VALUES (?, ?, ?, ?, ?, ?)`).run(g.id, description, amount, paidBy, spentOn, user.id);
    const ins = q('INSERT INTO expense_shares (expense_id, user_id, share_cents) VALUES (?, ?, ?)');
    for (const [uid, c] of shares) ins.run(lastInsertRowid, uid, c);
    return { id: Number(lastInsertRowid) };
  });
});

route('DELETE', '/api/groups/:id/expenses/:eid', ({ user, params }) => {
  const g = requireMember(params.id, user.id);
  const e = q('SELECT * FROM expenses WHERE id = ? AND group_id = ?').get(params.eid, g.id);
  if (!e) fail(404, 'Bill not found');
  if (![e.created_by, e.paid_by].includes(user.id)) fail(403, 'Only the person who added or paid this bill can delete it');
  q('DELETE FROM expenses WHERE id = ?').run(e.id);
  return { ok: true };
});

route('POST', '/api/groups/:id/settlements', ({ user, params, body }) => {
  const g = requireMember(params.id, user.id);
  const ids = memberIds(g.id);
  const from = Number(body.from), to = Number(body.to);
  if (!ids.has(from) || !ids.has(to) || from === to) fail(400, 'Pick two different people in the group');
  if (user.id !== from && user.id !== to) fail(403, 'You can only record payments you made or received');
  const amount = toCents(body.amount);
  const { lastInsertRowid } = q(`INSERT INTO settlements (group_id, from_user, to_user, amount_cents, created_by)
                                 VALUES (?, ?, ?, ?, ?)`).run(g.id, from, to, amount, user.id);
  return { id: Number(lastInsertRowid) };
});

route('DELETE', '/api/groups/:id/settlements/:sid', ({ user, params }) => {
  const g = requireMember(params.id, user.id);
  const s = q('SELECT * FROM settlements WHERE id = ? AND group_id = ?').get(params.sid, g.id);
  if (!s) fail(404, 'Payment not found');
  if (![s.from_user, s.to_user].includes(user.id)) fail(403, 'Only the two people in this payment can undo it');
  q('DELETE FROM settlements WHERE id = ?').run(s.id);
  return { ok: true };
});

// ---------- http plumbing ----------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 100_000) { reject(new HttpError(413, 'Request too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function currentUser(req) {
  const token = parseCookies(req.headers.cookie).sid;
  if (!token) return null;
  const s = q('SELECT * FROM sessions WHERE token_hash = ?').get(sha256(token));
  if (!s) return null;
  if (s.expires_at < Date.now()) { q('DELETE FROM sessions WHERE token_hash = ?').run(s.token_hash); return null; }
  return q('SELECT * FROM users WHERE id = ?').get(s.user_id) || null;
}

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, pathname);
  }
  try {
    // JSON-only writes, so a plain cross-site form post can't trigger them.
    if (req.method !== 'GET' && !String(req.headers['content-type'] || '').startsWith('application/json')) {
      fail(415, 'Send JSON');
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, Number(m[i + 1])]));
      const user = currentUser(req);
      if (r.auth && !user) fail(401, 'Please log in');
      const body = req.method === 'GET' ? {} : await readBody(req);
      return sendJSON(res, 200, await r.handler({ req, res, user, params, body }));
    }
    fail(404, 'Not found');
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    sendJSON(res, e.status || 500, { error: e.status ? e.message : 'Something went wrong' });
  }
});

server.listen(PORT, () => console.log(`SplitLah running at http://localhost:${PORT}`));
