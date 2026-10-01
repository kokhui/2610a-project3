// SplitLah frontend: plain JS, hash routing (#/, #/g/<id>, #/profile).

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const app = $('#app');
const sheet = $('#sheet');
const sheetBody = $('#sheet-body');

let me = null;

// ---------- utils ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const { parseCents, MAX, MIN_PASSWORD } = SHARED;

// money() is unsigned: callers say who owes whom in words, or use signedMoney() / balanceSpan().
const money = (cents) => 'S$' + (Math.abs(cents) / 100).toFixed(2);
const signedMoney = (c) => (c > 0 ? '+' : c < 0 ? '−' : '') + money(c);
const toneClass = (c) => (c > 0 ? 'owed' : c < 0 ? 'owe' : 'muted');
// pos/neg receive the formatted unsigned amount; zero is the text for an even balance.
const balanceSpan = (c, { pos, neg, zero }) =>
  `<span class="${toneClass(c)}">${c > 0 ? pos(money(c)) : c < 0 ? neg(money(c)) : zero}</span>`;
const centsToInput = (cents) => (cents / 100).toFixed(2);
const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time

function fmtDate(iso) {
  const d = new Date(iso.length === 10 ? iso + 'T00:00:00' : iso.replace(' ', 'T') + 'Z');
  return d.toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined || method !== 'GET' ? { 'Content-Type': 'application/json' } : {},
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && me) { me = null; route(); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

// For buttons and inline forms: run the request, toast on success, then refresh. Failures go to a toast.
async function act(request, okMsg, then) {
  try {
    await request();
    if (okMsg) toast(okMsg);
    then?.();
  } catch (ex) { toast(ex.message); }
}

async function copy(text, label = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(label); }
  catch { prompt('Copy this:', text); }
}

function openSheet(html, onSubmit) {
  sheetBody.innerHTML = html;
  sheetBody.onsubmit = async (e) => {
    e.preventDefault();
    if (e.submitter?.value === 'cancel') return sheet.close();
    const err = $('.error', sheetBody);
    const btn = $('button.primary', sheetBody);
    if (err) err.textContent = '';
    if (btn) btn.disabled = true;
    try {
      await onSubmit(new FormData(sheetBody));
      sheet.close();
    } catch (ex) {
      if (err) err.textContent = ex.message; else toast(ex.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  };
  sheet.showModal();
  $('input:not([type=hidden]):not([type=checkbox]), select', sheetBody)?.focus();
}
sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.close(); });

function setNav() {
  $('#nav').hidden = !me;
  if (me) $('#nav-user').textContent = me.displayName;
}

// ---------- routing ----------

async function route() {
  setNav();
  if (sheet.open) sheet.close();
  if (!me) return renderAuth();
  const hash = location.hash || '#/';
  let m;
  try {
    if ((m = /^#\/g\/(\d+)(?:\/(\w+))?$/.exec(hash))) return await renderGroup(Number(m[1]), m[2] || 'balances');
    if (hash === '#/profile') return renderProfile();
    if ((m = /^#\/join\/(\w+)$/.exec(hash))) return await joinByCode(m[1]);
    return await renderHome();
  } catch (e) {
    app.innerHTML = `<div class="card empty"><p>${esc(e.message)}</p><a class="btn" href="#/">Back to home</a></div>`;
  }
}
window.addEventListener('hashchange', route);

$('#logout').addEventListener('click', async () => {
  await api('POST', '/api/logout').catch(() => {});
  me = null;
  location.hash = '#/';
  route();
});

// ---------- auth ----------

function renderAuth() {
  let mode = 'login';
  const draw = () => {
    app.innerHTML = `
      <div class="auth">
        <div class="hero">
          <img src="icon.svg" alt="">
          <h1>SplitLah</h1>
          <p class="muted">Log the bill when it lands on the table. Know who still owes whom.</p>
        </div>
        <div class="card">
          <div class="tabs" role="tablist">
            <button type="button" role="tab" data-mode="login" aria-selected="${mode === 'login'}">Log in</button>
            <button type="button" role="tab" data-mode="register" aria-selected="${mode === 'register'}">Sign up</button>
          </div>
          <form id="auth-form" novalidate>
            <div class="field">
              <label for="username">Username</label>
              <input id="username" name="username" autocomplete="username" autocapitalize="none" required>
            </div>
            ${mode === 'register' ? `
            <div class="field">
              <label for="displayName">Your name <span class="muted small">(what friends see)</span></label>
              <input id="displayName" name="displayName" autocomplete="nickname" required>
            </div>` : ''}
            <div class="field">
              <label for="password">Password</label>
              <input id="password" name="password" type="password" required
                autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}">
              ${mode === 'register' ? `<p class="muted small" style="margin:.3rem 0 0">At least ${MIN_PASSWORD} characters.</p>` : ''}
            </div>
            <div class="error" id="auth-error"></div>
            <button class="primary" style="width:100%;margin-top:.5rem">${mode === 'login' ? 'Log in' : 'Create account'}</button>
          </form>
        </div>
      </div>`;
    $$('[data-mode]').forEach((b) => b.addEventListener('click', () => { mode = b.dataset.mode; draw(); }));
    $('#auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      try {
        ({ user: me } = await api('POST', mode === 'login' ? '/api/login' : '/api/register', body));
        route();
      } catch (ex) {
        $('#auth-error').textContent = ex.message;
      }
    });
    $('#username').focus();
  };
  draw();
}

// ---------- home ----------

async function renderHome() {
  const [{ groups }, { friends }] = await Promise.all([api('GET', '/api/groups'), api('GET', '/api/friends')]);
  // Totals are netted per friend across groups, so owing Bob 100 in one group and being owed 150 in another counts as +50.
  const owe = friends.reduce((a, f) => a + Math.min(f.netCents, 0), 0);
  const owed = friends.reduce((a, f) => a + Math.max(f.netCents, 0), 0);

  app.innerHTML = `
    <h1>Hi, ${esc(me.displayName)}</h1>
    <div class="summary">
      <div class="card"><div class="muted small">You owe</div><div class="big num ${owe ? 'owe' : ''}">${money(owe)}</div></div>
      <div class="card"><div class="muted small">You're owed</div><div class="big num ${owed ? 'owed' : ''}">${money(owed)}</div></div>
    </div>
    ${friends.length ? `<div class="card">
      <h2>With each friend</h2>
      <p class="muted small">All your groups combined, so what you owe a friend in one group cancels out what they owe you in another.</p>
      <ul class="list">${friends.map((f, i) => `
        <li>
          <div class="row">
            <span class="avatar">${esc(initials(f.displayName))}</span>
            <span class="grow"><strong>${esc(f.displayName)}</strong><br>
              <span class="muted small">${f.groups.map((g) => `${esc(g.name)}: ${g.cents > 0 ? 'owes you' : 'you owe'} ${money(g.cents)}`).join(' · ')}</span></span>
            <span class="amount num">${balanceSpan(f.netCents, { pos: (m) => `owes you ${m}`, neg: (m) => `you owe ${m}`, zero: 'evens out' })}</span>
          </div>
          <div class="row wrap" style="margin-top:.5rem;padding-left:50px">
            <button class="small primary" data-settle-friend="${i}">${f.netCents > 0 ? `Got ${money(f.netCents)} back` : f.netCents < 0 ? `I paid ${money(f.netCents)}` : 'Clear it'}</button>
            ${f.netCents > 0 ? `<button class="small" data-remind-friend="${i}">Send reminder</button>` : ''}
          </div>
        </li>`).join('')}</ul>
    </div>` : ''}
    <div class="card">
      <div class="row between" style="margin-bottom:.5rem">
        <h2 style="margin:0">Your groups</h2>
        <div class="row">
          <button class="small" id="join-group">Join with code</button>
          <button class="small primary" id="new-group">New group</button>
        </div>
      </div>
      ${groups.length ? `<ul class="list">${groups.map((g) => `
        <li><a class="group-link" href="#/g/${g.id}">
          <span class="avatar">${esc(initials(g.name))}</span>
          <span class="grow"><span class="name">${esc(g.name)}</span><br>
            <span class="muted small">${g.memberCount} ${g.memberCount === 1 ? 'person' : 'people'}</span></span>
          <span class="amount num">${balanceLabel(g.myBalanceCents)}</span>
        </a></li>`).join('')}</ul>`
      : `<div class="empty"><p>No groups yet.</p><p class="small">Make one for your makan kakis, then share the invite code.</p></div>`}
    </div>`;

  $$('[data-settle-friend]').forEach((b) => b.addEventListener('click', () => settleFriendSheet(friends[b.dataset.settleFriend], renderHome)));
  $$('[data-remind-friend]').forEach((b) => b.addEventListener('click', () => {
    const f = friends[b.dataset.remindFriend];
    remindSheet(f, f.netCents, f.groups.length > 1 ? `across ${f.groups.map((g) => `"${g.name}"`).join(' and ')}` : `for "${f.groups[0].name}"`, []);
  }));

  $('#new-group').addEventListener('click', () => openSheet(`
    <h2>New group</h2>
    <div class="field"><label for="g-name">Group name</label>
      <input id="g-name" name="name" placeholder="e.g. Friday supper crew" maxlength="${MAX.groupName}" required></div>
    <div class="error"></div>
    <div class="sheet-actions"><button value="cancel" formnovalidate>Cancel</button><button class="primary">Create</button></div>`,
    async (fd) => { const { id } = await api('POST', '/api/groups', { name: fd.get('name') }); location.hash = `#/g/${id}`; }));

  $('#join-group').addEventListener('click', () => openSheet(`
    <h2>Join a group</h2>
    <p class="muted small">Ask a friend for the 6-letter invite code from their group page.</p>
    <div class="field"><label for="g-code">Invite code</label>
      <input id="g-code" name="code" maxlength="6" autocapitalize="characters" autocomplete="off" required style="text-transform:uppercase;letter-spacing:.15em"></div>
    <div class="error"></div>
    <div class="sheet-actions"><button value="cancel" formnovalidate>Cancel</button><button class="primary">Join</button></div>`,
    async (fd) => { const { id } = await api('POST', '/api/groups/join', { code: fd.get('code') }); location.hash = `#/g/${id}`; }));
}

const balanceLabel = (c) => balanceSpan(c, { pos: (m) => `owed ${m}`, neg: (m) => `you owe ${m}`, zero: 'settled' });

async function joinByCode(code) {
  const { id } = await api('POST', '/api/groups/join', { code });
  toast('You joined the group');
  location.replace(`#/g/${id}`);
}

// ---------- group ----------

async function renderGroup(id, tab) {
  const data = await api('GET', `/api/groups/${id}`);
  const { group, members, expenses, balances } = data;
  const byId = new Map(members.map((m) => [m.id, m]));
  const name = (uid) => (uid === me.id ? 'You' : byId.get(uid)?.displayName ?? 'Someone');
  const myBal = balances[me.id] || 0;

  const tabs = [['balances', 'Who owes who'], ['bills', `Bills (${expenses.length})`], ['people', `People (${members.length})`]];

  app.innerHTML = `
    <p class="small"><a href="#/">← All groups</a></p>
    <div class="row between wrap" style="margin-bottom:.75rem">
      <div class="grow"><h1 style="margin:0">${esc(group.name)}</h1>
        <div class="small">${myBal ? balanceLabel(myBal) + ' overall' : '<span class="muted">You are all settled up here</span>'}</div></div>
    </div>
    <div class="section-tabs" role="tablist">
      ${tabs.map(([k, label]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${k === tab}">${label}</button>`).join('')}
    </div>
    <div id="tab-body"></div>
    <button class="primary fab" id="add-bill">+ Add bill</button>`;

  $$('[data-tab]').forEach((b) => b.addEventListener('click', () => { location.hash = `#/g/${id}/${b.dataset.tab}`; }));
  $('#add-bill').addEventListener('click', () => billSheet(data, () => renderGroup(id, 'bills')));

  const ctx = { ...data, id, byId, name, myBal, reload: () => renderGroup(id, tab) };
  groupTabs[tab]?.($('#tab-body'), ctx);
}

const groupTabs = { balances: renderBalancesTab, bills: renderBillsTab, people: renderPeopleTab };

function renderBalancesTab(body, { group, members, expenses, balances, transfers, byId, name, reload }) {
  body.innerHTML = `
    <div class="card">
      <h2>Settle up</h2>
      ${transfers.length ? transfers.map((t, i) => {
        const mine = t.from === me.id || t.to === me.id;
        return `<div class="transfer ${t.to === me.id ? 'mine-owed' : ''}">
          <div class="row between">
            <div><strong>${esc(name(t.from))}</strong> ${t.from === me.id ? 'owe' : 'owes'} <strong>${esc(name(t.to))}</strong></div>
            <div class="amount num">${money(t.amountCents)}</div>
          </div>
          ${mine ? `<div class="actions">
            <button class="small primary" data-settle="${i}">${t.from === me.id ? 'I paid this' : 'Mark as received'}</button>
            ${t.to === me.id ? `<button class="small" data-remind="${i}">Send reminder</button>` : ''}
          </div>` : ''}
        </div>`;
      }).join('') : `<div class="empty"><p>Everyone is square. 🎉</p><p class="small">Add a bill when someone pays for the group.</p></div>`}
      <p class="muted small" style="margin:.8rem 0 0">This is the fewest number of payments that clears every bill in the group.</p>
    </div>
    <div class="card">
      <h2>Balances</h2>
      <ul class="list">${members.map((m) => `
        <li class="row"><span class="avatar">${esc(initials(m.displayName))}</span>
          <span class="grow">${esc(m.id === me.id ? `${m.displayName} (you)` : m.displayName)}</span>
          <span class="amount num">${balanceSpan(balances[m.id] || 0, { pos: (a) => `gets back ${a}`, neg: (a) => `owes ${a}`, zero: 'settled' })}</span></li>`).join('')}
      </ul>
    </div>`;
  $$('[data-settle]', body).forEach((b) => b.addEventListener('click', () => settleSheet(group, transfers[b.dataset.settle], name, reload)));
  $$('[data-remind]', body).forEach((b) => b.addEventListener('click', () => {
    const t = transfers[b.dataset.remind];
    const recent = expenses
      .filter((e) => e.paidBy === me.id && e.shares.some((s) => s.userId === t.from))
      .slice(0, 3)
      .map((e) => `• ${e.description} (${fmtDate(e.spentOn)}): ${money(e.shares.find((s) => s.userId === t.from).shareCents)}`);
    remindSheet(byId.get(t.from), t.amountCents, `for "${group.name}"`, recent);
  }));
}

// Bills and repayments newest first, each with myNet (how it moved userId's balance) and running (the balance after it).
function buildTimeline(expenses, settlements, userId) {
  const items = [
    ...expenses.map((e) => ({ kind: 'bill', sortKey: e.spentOn + e.createdAt, e })),
    ...settlements.map((s) => ({ kind: 'pay', sortKey: s.createdAt.slice(0, 10) + s.createdAt, s })),
  ].sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  // Walk oldest to newest to accumulate the running balance, then reverse for display.
  let running = 0;
  for (const it of items) {
    it.myNet = it.kind === 'bill'
      ? (it.e.paidBy === userId ? it.e.amountCents : 0) - (it.e.shares.find((s) => s.userId === userId)?.shareCents || 0)
      : (it.s.from === userId ? it.s.amountCents : 0) - (it.s.to === userId ? it.s.amountCents : 0);
    running += it.myNet;
    it.running = running;
  }
  return items.reverse();
}

function renderBillsTab(body, { id, expenses, settlements, name, myBal, reload }) {
  const items = buildTimeline(expenses, settlements, me.id);
  const runningLine = (it) => it.myNet
    ? `<br><span class="small">Your balance: <span class="muted">${signedMoney(it.running - it.myNet)}</span> → <strong class="num ${toneClass(it.running)}">${signedMoney(it.running)}</strong></span>`
    : '';
  const bills = items.filter((it) => it.kind === 'bill').length;
  const pays = items.length - bills;
  body.innerHTML = `
    ${items.length ? `<div class="card">
      <div class="row between"><h2 style="margin:0">Your balance here</h2>
        <strong class="num ${toneClass(myBal)}" style="font-size:1.3rem">${signedMoney(myBal)}</strong></div>
      <p class="muted small" style="margin:.4rem 0 0">All ${bills} ${bills === 1 ? 'bill' : 'bills'}${pays ? ` and ${pays} ${pays === 1 ? 'repayment' : 'repayments'}` : ''} added together:
        what you paid for others minus what others paid for you. ${myBal > 0 ? 'Positive means the group owes you.' : myBal < 0 ? 'Negative means you owe the group.' : ''}
        Each row shows how it moved your balance.</p>
    </div>` : ''}
    <div class="card">${items.length ? `<ul class="list">${items.map((it) => {
    if (it.kind === 'pay') {
      const s = it.s;
      return `<li class="row"><span class="avatar" aria-hidden="true">💸</span>
        <span class="grow"><strong>${esc(name(s.from))}</strong> paid <strong>${esc(name(s.to))}</strong><br>
          <span class="muted small">${fmtDate(s.createdAt)} · ${s.combined ? 'cleared in a combined settle-up' : 'repayment'}</span>${runningLine(it)}</span>
        <span class="amount num">${money(s.amountCents)}<br>
          ${[s.from, s.to].includes(me.id) ? `<button class="link small" data-undo="${s.id}">Undo</button>` : ''}</span></li>`;
    }
    const e = it.e;
    const split = e.shares.map((s) => `${esc(name(s.userId))} ${money(s.shareCents)}`).join(', ');
    return `<li class="row"><span class="avatar" aria-hidden="true">🧾</span>
      <span class="grow"><strong>${esc(e.description)}</strong><br>
        <span class="muted small">${fmtDate(e.spentOn)} · ${esc(name(e.paidBy))} paid ${money(e.amountCents)}</span><br>
        <span class="muted small">Split: ${split}</span>${runningLine(it)}</span>
      <span class="amount num small">${balanceSpan(it.myNet, { pos: (a) => `you lent ${a}`, neg: (a) => `you borrowed ${a}`, zero: 'not involved' })}<br>
        ${[e.paidBy, e.createdBy].includes(me.id) ? `<button class="link small" data-del="${e.id}">Delete</button>` : ''}</span></li>`;
  }).join('')}</ul>` : `<div class="empty"><p>No bills yet.</p><p class="small">Tap <strong>+ Add bill</strong> right after someone pays, so nobody forgets the amount.</p></div>`}</div>`;

  $$('[data-del]', body).forEach((b) => b.addEventListener('click', () => {
    if (!confirm('Delete this bill? Everyone\'s balances will change.')) return;
    act(() => api('DELETE', `/api/groups/${id}/expenses/${b.dataset.del}`), 'Bill deleted', reload);
  }));
  $$('[data-undo]', body).forEach((b) => b.addEventListener('click', () => {
    if (!confirm('Undo this repayment?')) return;
    act(() => api('DELETE', `/api/groups/${id}/settlements/${b.dataset.undo}`), 'Repayment removed', reload);
  }));
}

function renderPeopleTab(body, { id, group, members, reload }) {
  const joinLink = `${location.origin}${location.pathname}#/join/${group.inviteCode}`;
  body.innerHTML = `
    <div class="card">
      <h2>Invite friends</h2>
      <p class="muted small">Friends sign up, then enter this code (or open the link).</p>
      <div class="invite">
        <span class="code">${esc(group.inviteCode)}</span>
        <button class="small" id="copy-code">Copy code</button>
        <button class="small" id="copy-link">Copy invite link</button>
      </div>
      <form id="add-member" class="row" style="margin-top:1rem">
        <input name="username" placeholder="Or add by username" autocapitalize="none" aria-label="Username to add" required>
        <button class="primary">Add</button>
      </form>
    </div>
    <div class="card">
      <h2>People</h2>
      <ul class="list">${members.map((m) => `
        <li class="row"><span class="avatar">${esc(initials(m.displayName))}</span>
          <span class="grow">${esc(m.displayName)}${m.id === me.id ? ' <span class="pill">you</span>' : ''}${m.id === group.createdBy ? ' <span class="pill">creator</span>' : ''}<br>
            <span class="muted small">@${esc(m.username)}</span></span>
          ${m.id === me.id || group.createdBy === me.id ? `<button class="small danger" data-remove="${m.id}">${m.id === me.id ? 'Leave' : 'Remove'}</button>` : ''}
        </li>`).join('')}</ul>
    </div>
    <div class="card">
      <h2>Rename group</h2>
      <form id="rename" class="row"><input name="name" value="${esc(group.name)}" maxlength="${MAX.groupName}" aria-label="Group name" required><button>Save</button></form>
    </div>`;
  $('#copy-code').addEventListener('click', () => copy(group.inviteCode, 'Invite code copied'));
  $('#copy-link').addEventListener('click', () => copy(`Join "${group.name}" on SplitLah: ${joinLink}`, 'Invite link copied'));
  $('#add-member').addEventListener('submit', (e) => {
    e.preventDefault();
    act(() => api('POST', `/api/groups/${id}/members`, { username: new FormData(e.target).get('username') }), 'Added', reload);
  });
  $('#rename').addEventListener('submit', (e) => {
    e.preventDefault();
    act(() => api('PATCH', `/api/groups/${id}`, { name: new FormData(e.target).get('name') }), 'Renamed', reload);
  });
  $$('[data-remove]', body).forEach((b) => b.addEventListener('click', () => {
    const leaving = Number(b.dataset.remove) === me.id;
    if (!confirm(leaving ? 'Leave this group?' : 'Remove this person from the group?')) return;
    act(() => api('DELETE', `/api/groups/${id}/members/${b.dataset.remove}`), null, () => { if (leaving) location.hash = '#/'; else reload(); });
  }));
}

// ---------- bill sheet ----------

function billSheet({ group, members }, done) {
  let mode = 'equal';
  openSheet(`
    <h2>Add a bill</h2>
    <div class="field"><label for="b-desc">What was it?</label>
      <input id="b-desc" name="description" placeholder="e.g. Hotpot at Haidilao" maxlength="${MAX.description}" required></div>
    <div class="fields-2" style="margin-top:.85rem">
      <div><label for="b-amt">Total (S$)</label><input id="b-amt" name="amount" inputmode="decimal" placeholder="0.00" required></div>
      <div><label for="b-date">Date</label><input id="b-date" name="spentOn" type="date" value="${today()}" max="${today()}"></div>
    </div>
    <div class="field"><label for="b-payer">Who paid?</label>
      <select id="b-payer" name="paidBy">${members.map((m) => `<option value="${m.id}" ${m.id === me.id ? 'selected' : ''}>${esc(m.id === me.id ? 'Me' : m.displayName)}</option>`).join('')}</select></div>
    <div class="field">
      <div class="row between"><label style="margin:0">Split between</label>
        <div class="seg"><button type="button" data-mode="equal" aria-pressed="true">Equally</button><button type="button" data-mode="exact" aria-pressed="false">Exact amounts</button></div>
      </div>
      <div class="split-list">${members.map((m) => `
        <div class="row">
          <label><input type="checkbox" name="among" value="${m.id}" checked> ${esc(m.id === me.id ? 'Me' : m.displayName)}</label>
          <span class="num muted small" data-each="${m.id}"></span>
          <input type="text" inputmode="decimal" name="share-${m.id}" placeholder="0.00" aria-label="Amount for ${esc(m.displayName)}" hidden>
        </div>`).join('')}
      </div>
      <p class="muted small" id="split-hint" style="margin:.4rem 0 0"></p>
    </div>
    <div class="error"></div>
    <div class="sheet-actions"><button value="cancel" formnovalidate>Cancel</button><button class="primary">Save bill</button></div>`,
  async (fd) => {
    const body = { description: fd.get('description'), amount: fd.get('amount'), paidBy: Number(fd.get('paidBy')), spentOn: fd.get('spentOn'), splitMode: mode };
    if (mode === 'equal') body.splitAmong = fd.getAll('among').map(Number);
    else body.shares = Object.fromEntries(members.map((m) => [m.id, fd.get(`share-${m.id}`) || '']));
    await api('POST', `/api/groups/${group.id}/expenses`, body);
    toast('Bill saved');
    done();
  });

  const update = () => {
    const total = parseCents($('#b-amt').value);
    const hint = $('#split-hint');
    if (mode === 'equal') {
      const ids = $$('input[name=among]:checked', sheetBody).map((c) => c.value);
      $$('[data-each]', sheetBody).forEach((el) => {
        el.textContent = ids.includes(el.dataset.each) && total > 0 && ids.length ? money(Math.floor(total / ids.length)) + (total % ids.length ? '+' : '') : '';
      });
      hint.textContent = !ids.length ? 'Pick at least one person.' : total > 0 ? `${money(total)} ÷ ${ids.length} people` : '';
    } else {
      const sum = members.reduce((a, m) => a + (parseCents(sheetBody.elements[`share-${m.id}`].value) || 0), 0);
      const left = (total || 0) - sum;
      hint.innerHTML = total > 0 ? (left === 0 ? '<span class="owed">Adds up ✓</span>' : `${money(left)} ${left > 0 ? 'left to assign' : 'too much'}`) : '';
    }
  };

  $$('.seg button', sheetBody).forEach((b) => b.addEventListener('click', () => {
    mode = b.dataset.mode;
    $$('.seg button', sheetBody).forEach((x) => x.setAttribute('aria-pressed', x === b));
    $$('input[name=among]', sheetBody).forEach((c) => { c.hidden = mode === 'exact'; });
    $$('[data-each]', sheetBody).forEach((el) => { el.hidden = mode === 'exact'; });
    $$('input[name^=share-]', sheetBody).forEach((i) => { i.hidden = mode === 'equal'; });
    update();
  }));
  sheetBody.addEventListener('input', update);
  update();
}

// ---------- settle & remind ----------

function settleSheet(group, t, name, done) {
  openSheet(`
    <h2>Record a repayment</h2>
    <p><strong>${esc(name(t.from))}</strong> → <strong>${esc(name(t.to))}</strong></p>
    <div class="field"><label for="s-amt">Amount (S$)</label>
      <input id="s-amt" name="amount" inputmode="decimal" value="${centsToInput(t.amountCents)}" required>
      <p class="muted small" style="margin:.3rem 0 0">Paid only part of it? Change the amount.</p></div>
    <div class="error"></div>
    <div class="sheet-actions"><button value="cancel" formnovalidate>Cancel</button><button class="primary">Record</button></div>`,
  async (fd) => {
    await api('POST', `/api/groups/${group.id}/settlements`, { from: t.from, to: t.to, amount: fd.get('amount') });
    toast('Repayment recorded');
    done();
  });
}

// Combined settle-up with one friend: the server records one repayment in each shared group.
function settleFriendSheet(f, done) {
  const n = f.groups.length;
  const what = f.netCents > 0 ? `${esc(f.displayName)} pays you <strong>${money(f.netCents)}</strong>`
    : f.netCents < 0 ? `You pay ${esc(f.displayName)} <strong>${money(f.netCents)}</strong>`
    : `You and ${esc(f.displayName)} owe each other the same amount, so no money changes hands`;
  openSheet(`
    <h2>Settle up with ${esc(f.displayName)}</h2>
    <p>${what}.</p>
    <ul class="list small" style="margin-bottom:.75rem">${f.groups.map((g) => `
      <li class="row between"><span>${esc(g.name)}</span>
        <span class="num ${toneClass(g.cents)}">${signedMoney(g.cents)}</span></li>`).join('')}
      <li class="row between"><strong>Combined</strong><strong class="num">${signedMoney(f.netCents)}</strong></li>
    </ul>
    <p class="muted small">${n > 1 ? `This records a repayment in each of the ${n} groups, so all of them clear.` : 'This records the repayment in the group.'}
      Only do this once the money has actually changed hands.</p>
    <div class="error"></div>
    <div class="sheet-actions"><button value="cancel" formnovalidate>Cancel</button><button class="primary">Settle all</button></div>`,
  async () => {
    await api('POST', `/api/friends/${f.id}/settle`, { expectedCents: f.netCents });
    toast(`All square with ${f.displayName}`);
    done();
  });
}

function remindSheet(debtor, amountCents, context, recent) {
  const msg = `Hi ${debtor.displayName}! Friendly reminder from SplitLah: you owe me ${money(amountCents)} ${context}.`
    + (recent.length ? `\n\n${recent.join('\n')}` : '')
    + (me.phone ? `\n\nPayNow to ${me.phone}. Thanks!` : '\n\nThanks!');
  let phone = (debtor.phone || '').replace(/\D/g, '');
  if (phone.length === 8) phone = '65' + phone; // local SG number
  const wa = `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;

  openSheet(`
    <h2>Remind ${esc(debtor.displayName)}</h2>
    <textarea readonly rows="7" style="width:100%;font:inherit;padding:.6rem;border-radius:10px;border:1px solid var(--border);background:var(--surface-2);color:var(--text)">${esc(msg)}</textarea>
    ${debtor.phone ? '' : `<p class="muted small">${esc(debtor.displayName)} hasn't added a phone number, so WhatsApp will ask you to pick the chat.</p>`}
    <div class="sheet-actions">
      <button value="cancel" formnovalidate>Close</button>
      <button type="button" id="copy-msg">Copy</button>
      <a class="btn primary" href="${esc(wa)}" target="_blank" rel="noopener">Open WhatsApp</a>
    </div>`, async () => {});
  $('#copy-msg').addEventListener('click', () => copy(msg, 'Message copied'));
}

// ---------- profile ----------

function renderProfile() {
  app.innerHTML = `
    <p class="small"><a href="#/">← Home</a></p>
    <h1>Your profile</h1>
    <form class="card" id="profile">
      <div class="field"><label>Username</label><input value="@${esc(me.username)}" disabled></div>
      <div class="field"><label for="p-name">Your name</label><input id="p-name" name="displayName" value="${esc(me.displayName)}" maxlength="${MAX.displayName}" required></div>
      <div class="field"><label for="p-phone">Mobile number <span class="muted small">(optional)</span></label>
        <input id="p-phone" name="phone" value="${esc(me.phone)}" inputmode="tel" placeholder="e.g. 91234567">
        <p class="muted small" style="margin:.3rem 0 0">Lets friends WhatsApp you reminders and shows your PayNow number on the reminders you send.</p></div>
      <div class="error"></div>
      <button class="primary" style="margin-top:.5rem">Save</button>
    </form>`;
  $('#profile').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      ({ user: me } = await api('PATCH', '/api/me', Object.fromEntries(new FormData(e.target))));
      setNav();
      toast('Saved');
    } catch (ex) { $('.error', e.target).textContent = ex.message; }
  });
}

// ---------- boot ----------

// An invite link (#/join/CODE) stays in the URL while logged out, so route() joins right after login.
(async () => {
  try { ({ user: me } = await api('GET', '/api/me')); } catch { me = null; }
  route();
})();
