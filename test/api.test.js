const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, newUser, newGroup } = require('./helpers');

let server, base;
before(async () => { server = await startServer(); base = server.base; });
after(async () => { await server.stop(); });

const group = async (c, id) => (await c.get(`/api/groups/${id}`)).data;

describe('accounts', () => {
  test('register logs you in and normalises the username', async () => {
    const c = client(base);
    const r = await c.post('/api/register', { username: '  NewPerson ', password: 'secret123' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.user, { id: r.data.user.id, username: 'newperson', displayName: 'newperson', phone: '' });
    const cookie = r.headers.get('set-cookie');
    assert.match(cookie, /^sid=[\w-]+; HttpOnly; Path=\/; SameSite=Lax; Max-Age=2592000$/);
    assert.equal((await c.get('/api/me')).data.user.username, 'newperson');
  });

  test('register validates input', async () => {
    const c = client(base);
    assert.equal((await c.post('/api/register', { password: 'secret123' })).data.error, 'Username is required');
    assert.equal((await c.post('/api/register', { username: 'a'.repeat(31), password: 'secret123' })).status, 400);
    assert.equal((await c.post('/api/register', { username: 'no spaces', password: 'secret123' })).data.error,
      'Username: 3-30 letters, numbers, _ or .');
    assert.equal((await c.post('/api/register', { username: 'shortpw', password: '12345' })).data.error,
      'Password must be at least 6 characters');
    assert.equal((await c.post('/api/register', { username: 'longname', displayName: 'x'.repeat(41), password: 'secret123' })).status, 400);
  });

  test('usernames are unique regardless of case', async () => {
    await client(base).post('/api/register', { username: 'taken', password: 'secret123' });
    const r = await client(base).post('/api/register', { username: 'TAKEN', password: 'secret123' });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, 'That username is taken');
  });

  test('login checks the password', async () => {
    await client(base).post('/api/register', { username: 'loginme', password: 'secret123', displayName: 'Lo' });
    const bad = await client(base).post('/api/login', { username: 'loginme', password: 'wrong-pass' });
    assert.equal(bad.status, 401);
    assert.equal(bad.data.error, 'Wrong username or password');
    assert.equal((await client(base).post('/api/login', { username: 'nobody', password: 'secret123' })).status, 401);
    assert.equal((await client(base).post('/api/login', {})).status, 401);

    const c = client(base);
    const ok = await c.post('/api/login', { username: ' LoginMe ', password: 'secret123' });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.user.displayName, 'Lo');
    assert.equal((await c.get('/api/me')).status, 200);
  });

  test('logout ends the session', async () => {
    const c = await newUser(base);
    const cookie = c.cookie;
    const r = await c.post('/api/logout');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
    c.cookie = cookie; // reusing the old token must not work
    assert.equal((await c.get('/api/me')).status, 401);
    assert.equal((await client(base).post('/api/logout')).status, 200); // logged out already is fine
  });

  test('protected routes need a session', async () => {
    const anon = client(base);
    for (const [m, u] of [['GET', '/api/me'], ['GET', '/api/groups'], ['POST', '/api/groups'], ['GET', '/api/groups/1']]) {
      const r = await anon.request(m, u, {});
      assert.equal(r.status, 401, `${m} ${u}`);
      assert.equal(r.data.error, 'Please log in');
    }
    anon.cookie = 'sid=not-a-real-token';
    assert.equal((await anon.get('/api/me')).status, 401);
  });

  test('PATCH /api/me updates the profile and strips junk from the phone number', async () => {
    const c = await newUser(base);
    const r = await c.patch('/api/me', { displayName: ' Alice T ', phone: '+65 9123-4567 ext' });
    assert.equal(r.status, 200);
    assert.equal(r.data.user.displayName, 'Alice T');
    assert.equal(r.data.user.phone, '+6591234567');
    assert.equal((await c.patch('/api/me', { displayName: '', phone: '' })).data.error, 'Display name is required');
    assert.equal((await c.patch('/api/me', { displayName: 'A', phone: '1'.repeat(30) })).data.user.phone, '1'.repeat(16));
  });
});

describe('groups', () => {
  test('create, list, view and rename', async () => {
    const a = await newUser(base, 'alice');
    assert.equal((await a.post('/api/groups', { name: ' ' })).data.error, 'Group name is required');
    assert.equal((await a.post('/api/groups', { name: 'x'.repeat(61) })).status, 400);

    const { id, inviteCode } = await newGroup(a, [], 'Bali');
    assert.match(inviteCode, /^[A-HJ-NP-Z2-9]{6}$/);
    const list = (await a.get('/api/groups')).data.groups;
    assert.deepEqual(list, [{ id, name: 'Bali', memberCount: 1, myBalanceCents: 0 }]);

    const g = await group(a, id);
    assert.deepEqual(g.group, { id, name: 'Bali', inviteCode, createdBy: a.user.id });
    assert.deepEqual(g.members.map((m) => m.id), [a.user.id]);
    assert.deepEqual(g.balances, { [a.user.id]: 0 });

    assert.equal((await a.patch(`/api/groups/${id}`, { name: 'Bali 2026' })).status, 200);
    assert.equal((await group(a, id)).group.name, 'Bali 2026');
    assert.equal((await a.patch(`/api/groups/${id}`, { name: '' })).status, 400);
  });

  test('non-members cannot see or change a group', async () => {
    const a = await newUser(base);
    const outsider = await newUser(base);
    const { id } = await newGroup(a);
    for (const [m, u] of [['GET', `/api/groups/${id}`], ['PATCH', `/api/groups/${id}`],
      ['POST', `/api/groups/${id}/expenses`], ['POST', `/api/groups/${id}/settlements`], ['GET', '/api/groups/99999']]) {
      const r = await outsider.request(m, u, { name: 'hacked' });
      assert.equal(r.status, 404, `${m} ${u}`);
      assert.equal(r.data.error, 'Group not found');
    }
  });

  test('join by invite code, case-insensitively', async () => {
    const a = await newUser(base);
    const b = await newUser(base);
    const { id, inviteCode } = await newGroup(a);
    assert.equal((await b.post('/api/groups/join', { code: 'NOPE00' })).status, 404);
    assert.equal((await b.post('/api/groups/join', {})).status, 404);
    const r = await b.post('/api/groups/join', { code: ` ${inviteCode.toLowerCase()} ` });
    assert.deepEqual(r.data, { id });
    assert.equal((await b.post('/api/groups/join', { code: inviteCode })).status, 200); // joining twice is harmless
    assert.equal((await group(b, id)).members.length, 2);
    assert.equal((await b.get('/api/groups')).data.groups[0].memberCount, 2);
  });
});

describe('invites', () => {
  test('inviting by username needs the invitee to accept', async () => {
    const a = await newUser(base, 'host');
    const b = await newUser(base, 'guest');
    const { id } = await newGroup(a, [], 'Dinner');

    assert.equal((await a.post(`/api/groups/${id}/members`, { username: 'ghost' })).status, 404);
    assert.equal((await a.post(`/api/groups/${id}/members`, { username: a.user.username })).status, 409);
    assert.equal((await a.post(`/api/groups/${id}/members`, { username: b.user.username.toUpperCase() })).status, 200);
    assert.equal((await a.post(`/api/groups/${id}/members`, { username: b.user.username })).status, 200); // re-inviting is a no-op

    // Invited but not yet a member.
    assert.equal((await b.get(`/api/groups/${id}`)).status, 404);
    assert.deepEqual((await group(a, id)).invited, [{ username: b.user.username, displayName: 'guest' }]);
    assert.deepEqual((await b.get('/api/invites')).data.invites, [
      { groupId: id, groupName: 'Dinner', invitedBy: { displayName: 'host', username: a.user.username } },
    ]);

    assert.deepEqual((await b.post(`/api/invites/${id}/accept`)).data, { id });
    assert.equal((await group(b, id)).members.length, 2);
    assert.deepEqual((await b.get('/api/invites')).data.invites, []);
    assert.deepEqual((await group(a, id)).invited, []);
    assert.equal((await a.post(`/api/groups/${id}/members`, { username: b.user.username })).data.error,
      'They are already in this group');
  });

  test('declining removes the invite; accepting a missing invite fails', async () => {
    const a = await newUser(base);
    const b = await newUser(base);
    const { id } = await newGroup(a);
    await a.post(`/api/groups/${id}/members`, { username: b.user.username });
    assert.equal((await b.post(`/api/invites/${id}/decline`)).status, 200);
    assert.deepEqual((await b.get('/api/invites')).data.invites, []);
    const r = await b.post(`/api/invites/${id}/accept`);
    assert.equal(r.status, 404);
    assert.equal(r.data.error, 'Invite not found');
  });

  test('joining by code clears a pending invite', async () => {
    const a = await newUser(base);
    const b = await newUser(base);
    const { id, inviteCode } = await newGroup(a);
    await a.post(`/api/groups/${id}/members`, { username: b.user.username });
    await b.post('/api/groups/join', { code: inviteCode });
    assert.deepEqual((await b.get('/api/invites')).data.invites, []);
  });
});

describe('members', () => {
  test('removing people', async () => {
    const a = await newUser(base);
    const b = await newUser(base);
    const c = await newUser(base);
    const { id } = await newGroup(a, [b, c]);

    const r = await b.del(`/api/groups/${id}/members/${c.user.id}`);
    assert.equal(r.status, 403);
    assert.equal(r.data.error, 'Only the group creator can remove other people');

    assert.equal((await a.del(`/api/groups/${id}/members/${c.user.id}`)).status, 200); // creator removes someone
    assert.equal((await c.get(`/api/groups/${id}`)).status, 404);
    assert.equal((await b.del(`/api/groups/${id}/members/${b.user.id}`)).status, 200); // anyone can leave
    assert.deepEqual((await group(a, id)).members.map((m) => m.id), [a.user.id]);
  });

  test('people on bills or payments cannot be removed', async () => {
    const a = await newUser(base);
    const b = await newUser(base);
    const c = await newUser(base);
    const d = await newUser(base);
    const { id } = await newGroup(a, [b, c, d]);
    await a.post(`/api/groups/${id}/expenses`, { description: 'Taxi', amount: '10', paidBy: a.user.id, splitAmong: [a.user.id, b.user.id] });
    await c.post(`/api/groups/${id}/settlements`, { from: c.user.id, to: d.user.id, amount: '1' });
    for (const u of [a, b, c, d]) {
      const r = await a.del(`/api/groups/${id}/members/${u.user.id}`);
      assert.equal(r.status, 409, u.user.username);
      assert.match(r.data.error, /can't be removed/);
    }
  });
});

describe('expenses', () => {
  test('equal split puts leftover cents on the first people', async () => {
    const a = await newUser(base);
    const b = await newUser(base);
    const c = await newUser(base);
    const { id } = await newGroup(a, [b, c]);
    const r = await a.post(`/api/groups/${id}/expenses`, {
      description: ' Dinner ', amount: '10', paidBy: a.user.id,
      splitAmong: [a.user.id, b.user.id, c.user.id, b.user.id, 999999], spentOn: '2026-09-30',
    });
    assert.equal(r.status, 200);
    const g = await group(a, id);
    const e = g.expenses[0];
    assert.equal(e.id, r.data.id);
    assert.equal(e.description, 'Dinner');
    assert.equal(e.amountCents, 1000);
    assert.equal(e.spentOn, '2026-09-30');
    assert.deepEqual(e.shares.map((s) => s.shareCents).sort(), [333, 333, 334]);
    assert.equal(e.shares.reduce((s, x) => s + x.shareCents, 0), 1000);
    assert.equal(g.balances[a.user.id], 1000 - e.shares.find((s) => s.userId === a.user.id).shareCents);
    assert.equal(Object.values(g.balances).reduce((s, x) => s + x, 0), 0);
  });

  test('missing date defaults to today', async () => {
    const a = await newUser(base);
    const { id } = await newGroup(a);
    await a.post(`/api/groups/${id}/expenses`, { description: 'Coffee', amount: 4.5, paidBy: a.user.id, splitAmong: [a.user.id], spentOn: 'yesterday' });
    const e = (await group(a, id)).expenses[0];
    assert.equal(e.spentOn, new Date().toISOString().slice(0, 10));
    assert.equal(e.amountCents, 450);
  });

  test('exact split must add up to the total', async () => {
    const a = await newUser(base);
    const b = await newUser(base);
    const { id } = await newGroup(a, [b]);
    const url = `/api/groups/${id}/expenses`;
    const bill = { description: 'Groceries', amount: '12.50', paidBy: b.user.id, splitMode: 'exact' };

    let r = await a.post(url, { ...bill, shares: { [a.user.id]: '5', [b.user.id]: '7' } });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'The amounts add up to 12.00, not 12.50');

    r = await a.post(url, { ...bill, shares: { [a.user.id]: '11.5', 999999: '1' } });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'Everyone in the split must be in the group');

    r = await a.post(url, { ...bill, shares: { [a.user.id]: '', [b.user.id]: '' } });
    assert.equal(r.data.error, 'The amounts add up to 0.00, not 12.50');

    r = await a.post(url, { ...bill, shares: { [a.user.id]: '12.5', [b.user.id]: '' } });
    assert.equal(r.status, 200);
    const g = await group(a, id);
    assert.deepEqual(g.expenses[0].shares, [{ userId: a.user.id, shareCents: 1250 }]);
    assert.deepEqual(g.balances, { [a.user.id]: -1250, [b.user.id]: 1250 });
    assert.deepEqual(g.transfers, [{ from: a.user.id, to: b.user.id, amountCents: 1250 }]);
  });

  test('expense validation', async () => {
    const a = await newUser(base);
    const b = await newUser(base);
    const { id } = await newGroup(a);
    const url = `/api/groups/${id}/expenses`;
    const ok = { description: 'Lunch', amount: '9', paidBy: a.user.id, splitAmong: [a.user.id] };
    const cases = [
      [{ ...ok, description: '' }, 'Description is required'],
      [{ ...ok, description: 'x'.repeat(81) }, 'Description must be at most 80 characters'],
      [{ ...ok, amount: '1.234' }, 'Enter an amount like 12.50'],
      [{ ...ok, amount: '-5' }, 'Enter an amount like 12.50'],
      [{ ...ok, amount: '12345678' }, 'Enter an amount like 12.50'],
      [{ ...ok, amount: undefined }, 'Enter an amount like 12.50'],
      [{ ...ok, amount: '0' }, 'The amount must be more than 0'],
      [{ ...ok, amount: '0.00' }, 'The amount must be more than 0'],
      [{ ...ok, amount: '0', splitMode: 'exact', shares: { [a.user.id]: '0' } }, 'The amount must be more than 0'],
      [{ ...ok, paidBy: b.user.id }, 'The payer must be in the group'],
      [{ ...ok, splitAmong: [] }, 'Pick at least one person to split with'],
      [{ ...ok, splitAmong: [b.user.id] }, 'Pick at least one person to split with'],
      [{ ...ok, splitMode: 'exact', shares: { [a.user.id]: 'abc' } }, 'Enter an amount like 12.50'],
    ];
    for (const [body, error] of cases) {
      const r = await a.post(url, body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.data.error, error);
    }
    assert.equal((await group(a, id)).expenses.length, 0);
  });

  test('only the creator or payer can delete a bill', async () => {
    const a = await newUser(base);
    const b = await newUser(base);
    const c = await newUser(base);
    const { id } = await newGroup(a, [b, c]);
    const other = await newGroup(a);
    const { data: { id: eid } } = await a.post(`/api/groups/${id}/expenses`,
      { description: 'Tickets', amount: '30', paidBy: b.user.id, splitAmong: [a.user.id, b.user.id, c.user.id] });

    const r = await c.del(`/api/groups/${id}/expenses/${eid}`);
    assert.equal(r.status, 403);
    assert.equal(r.data.error, 'Only the person who added or paid this bill can delete it');
    assert.equal((await a.del(`/api/groups/${other.id}/expenses/${eid}`)).status, 404); // wrong group
    assert.equal((await a.del(`/api/groups/${id}/expenses/999999`)).status, 404);

    assert.equal((await b.del(`/api/groups/${id}/expenses/${eid}`)).status, 200); // payer
    const g = await group(a, id);
    assert.deepEqual(g.expenses, []);
    assert.deepEqual(g.transfers, []);
  });

  test('leaving a bill takes your share off the total', async () => {
    const a = await newUser(base);
    const b = await newUser(base);
    const c = await newUser(base);
    const { id } = await newGroup(a, [b, c]);
    const { data: { id: eid } } = await a.post(`/api/groups/${id}/expenses`,
      { description: 'Pizza', amount: '30', paidBy: a.user.id, splitAmong: [a.user.id, b.user.id] });

    let r = await c.post(`/api/groups/${id}/expenses/${eid}/leave`);
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'You are not part of this bill');
    assert.equal((await b.post(`/api/groups/${id}/expenses/999999/leave`)).status, 404);

    r = await b.post(`/api/groups/${id}/expenses/${eid}/leave`);
    assert.deepEqual(r.data, { deleted: false });
    let g = await group(a, id);
    assert.equal(g.expenses[0].amountCents, 1500);
    assert.deepEqual(g.expenses[0].shares, [{ userId: a.user.id, shareCents: 1500 }]);
    assert.equal(g.balances[b.user.id], 0);

    // The last person leaving deletes the bill.
    r = await a.post(`/api/groups/${id}/expenses/${eid}/leave`);
    assert.deepEqual(r.data, { deleted: true });
    g = await group(a, id);
    assert.deepEqual(g.expenses, []);
  });
});

describe('settlements', () => {
  test('recording and undoing a repayment', async () => {
    const a = await newUser(base);
    const b = await newUser(base);
    const c = await newUser(base);
    const { id } = await newGroup(a, [b, c]);
    await a.post(`/api/groups/${id}/expenses`, { description: 'Hotel', amount: '100', paidBy: a.user.id, splitAmong: [a.user.id, b.user.id] });
    const url = `/api/groups/${id}/settlements`;

    let r = await c.post(url, { from: b.user.id, to: a.user.id, amount: '10' });
    assert.equal(r.status, 403);
    assert.equal(r.data.error, 'You can only record payments you made or received');
    for (const body of [{ from: b.user.id, to: b.user.id, amount: '1' }, { from: b.user.id, to: 999999, amount: '1' }, {}]) {
      r = await b.post(url, body);
      assert.equal(r.status, 400);
      assert.equal(r.data.error, 'Pick two different people in the group');
    }
    assert.equal((await b.post(url, { from: b.user.id, to: a.user.id, amount: 'lots' })).status, 400);
    r = await b.post(url, { from: b.user.id, to: a.user.id, amount: '0' });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'The amount must be more than 0');

    // Partial payment.
    r = await b.post(url, { from: b.user.id, to: a.user.id, amount: '20' });
    assert.equal(r.status, 200);
    let g = await group(a, id);
    assert.deepEqual(g.settlements, [{ id: r.data.id, from: b.user.id, to: a.user.id, amountCents: 2000, createdBy: b.user.id, createdAt: g.settlements[0].createdAt, note: '' }]);
    assert.deepEqual(g.transfers, [{ from: b.user.id, to: a.user.id, amountCents: 3000 }]);
    assert.equal((await a.get('/api/groups')).data.groups[0].myBalanceCents, 3000);

    const sid = r.data.id;
    assert.equal((await c.del(`${url}/${sid}`)).status, 403);
    assert.equal((await a.del(`${url}/999999`)).status, 404);
    assert.equal((await a.del(`${url}/${sid}`)).status, 200); // the receiver can undo it too
    g = await group(a, id);
    assert.deepEqual(g.settlements, []);
    assert.deepEqual(g.transfers, [{ from: b.user.id, to: a.user.id, amountCents: 5000 }]);
  });

  test('settle-up suggests at most n-1 transfers', async () => {
    const us = await Promise.all([1, 2, 3, 4].map(() => newUser(base)));
    const [a, b, c, d] = us;
    const { id } = await newGroup(a, [b, c, d]);
    const all = us.map((u) => u.user.id);
    await a.post(`/api/groups/${id}/expenses`, { description: 'A', amount: '40', paidBy: a.user.id, splitAmong: all });
    await b.post(`/api/groups/${id}/expenses`, { description: 'B', amount: '20', paidBy: b.user.id, splitAmong: all });
    const g = await group(a, id);
    assert.deepEqual(g.balances, { [a.user.id]: 2500, [b.user.id]: 500, [c.user.id]: -1500, [d.user.id]: -1500 });
    assert.ok(g.transfers.length <= 3);
    const net = Object.fromEntries(all.map((u) => [u, 0]));
    for (const t of g.transfers) { net[t.from] += t.amountCents; net[t.to] -= t.amountCents; }
    for (const u of all) assert.equal(net[u] + g.balances[u], 0);
  });
});

describe('friends', () => {
  test('balances net across groups and settle-all clears every group', async () => {
    const a = await newUser(base, 'ann');
    const b = await newUser(base, 'bob');
    const g1 = await newGroup(a, [b], 'One');
    const g2 = await newGroup(a, [b], 'Two');
    // In One, Ann owes Bob 100. In Two, Bob owes Ann 150. Net: Bob owes Ann 50.
    await b.post(`/api/groups/${g1.id}/expenses`, { description: 'x', amount: '100', paidBy: b.user.id, splitMode: 'exact', shares: { [a.user.id]: '100' } });
    await a.post(`/api/groups/${g2.id}/expenses`, { description: 'y', amount: '150', paidBy: a.user.id, splitMode: 'exact', shares: { [b.user.id]: '150' } });

    const { friends } = (await a.get('/api/friends')).data;
    assert.equal(friends.length, 1);
    assert.equal(friends[0].id, b.user.id);
    assert.equal(friends[0].displayName, 'bob');
    assert.equal(friends[0].netCents, 5000);
    assert.deepEqual(friends[0].groups, [{ id: g1.id, name: 'One', cents: -10000 }, { id: g2.id, name: 'Two', cents: 15000 }]);
    assert.equal((await b.get('/api/friends')).data.friends[0].netCents, -5000);

    let r = await a.post(`/api/friends/${b.user.id}/settle`, { expectedCents: 1234 });
    assert.equal(r.status, 409);
    assert.match(r.data.error, /Balances changed/);
    r = await a.post(`/api/friends/${b.user.id}/settle`, { expectedCents: 5000 });
    assert.deepEqual(r.data, { cleared: 2 });

    for (const gid of [g1.id, g2.id]) {
      const g = await group(a, gid);
      assert.deepEqual(g.transfers, []);
      assert.equal(g.settlements[0].note, 'Combined settle-up');
    }
    assert.deepEqual((await a.get('/api/friends')).data.friends, []);
    r = await a.post(`/api/friends/${b.user.id}/settle`, { expectedCents: 0 });
    assert.equal(r.status, 404);
    assert.equal(r.data.error, 'Nothing to settle with this person');
  });

  test('friends are sorted by the size of the balance', async () => {
    const a = await newUser(base);
    const b = await newUser(base);
    const c = await newUser(base);
    const { id } = await newGroup(a, [b, c]);
    await a.post(`/api/groups/${id}/expenses`, { description: 'x', amount: '30', paidBy: a.user.id, splitMode: 'exact', shares: { [b.user.id]: '10', [c.user.id]: '20' } });
    const { friends } = (await a.get('/api/friends')).data;
    assert.deepEqual(friends.map((f) => [f.id, f.netCents]), [[c.user.id, 2000], [b.user.id, 1000]]);
  });
});

describe('http plumbing', () => {
  test('writes must be JSON', async () => {
    const r = await client(base).post('/api/login', undefined, { headers: { 'Content-Type': 'text/plain' }, raw: 'x' });
    assert.equal(r.status, 415);
    assert.equal(r.data.error, 'Send JSON');
  });

  test('invalid JSON is a 400', async () => {
    const r = await client(base).post('/api/login', undefined, { raw: '{nope' });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'Invalid JSON');
  });

  test('an empty body counts as {}', async () => {
    const r = await client(base).post('/api/login', undefined, { raw: '' });
    assert.equal(r.status, 401);
  });

  test('unknown API routes are 404 JSON', async () => {
    const c = await newUser(base);
    for (const [m, u] of [['GET', '/api/nope'], ['DELETE', '/api/me'], ['GET', '/api/groups/abc']]) {
      const r = await c.request(m, u);
      assert.equal(r.status, 404, `${m} ${u}`);
      assert.deepEqual(r.data, { error: 'Not found' });
      assert.equal(r.headers.get('cache-control'), 'no-store');
    }
  });

  test('static files', async () => {
    let r = await fetch(`${base}/`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await r.text(), /<html/i);
    assert.equal((await fetch(`${base}/app.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal((await fetch(`${base}/style.css`)).headers.get('content-type'), 'text/css; charset=utf-8');
    assert.equal((await fetch(`${base}/icon.svg`)).headers.get('content-type'), 'image/svg+xml');
    assert.equal((await fetch(`${base}/missing.js`)).status, 404);
    assert.equal((await fetch(`${base}/%`)).status, 400);
    assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405);
  });

  test('static paths cannot escape public/', async () => {
    // fetch normalises "../", so send the raw request line.
    const res = await new Promise((resolve, reject) => {
      const req = require('node:http').request({ host: 'localhost', port: server.port, path: '/..%2fserver.js' }, resolve);
      req.on('error', reject);
      req.end();
    });
    res.resume();
    assert.equal(res.statusCode, 403);
  });
});
