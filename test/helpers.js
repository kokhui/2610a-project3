// Test helpers: start a real server on a throwaway database and talk to it over HTTP.
// Uses only Node built-ins, same as the app.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'server.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

// Starts server.js in a child process. The SIGTERM handler makes it exit normally,
// so V8 writes coverage for server.js when tests run with --experimental-test-coverage.
async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'splitlah-test-'));
  const port = await freePort();
  const child = spawn(process.execPath, [
    '--no-warnings', '-e', `process.on('SIGTERM', () => process.exit(0)); require(${JSON.stringify(SERVER)});`,
  ], {
    env: { ...process.env, PORT: String(port), DB_FILE: path.join(dir, 'test.db'), NODE_ENV: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (c) => { if (String(c).includes('running at')) resolve(); });
    child.on('exit', (code) => reject(new Error(`server exited (${code}): ${stderr}`)));
  });

  return {
    base: `http://localhost:${port}`,
    port,
    stderr: () => stderr,
    async stop() {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      await exited;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// An HTTP client that keeps its session cookie, like a browser tab.
function client(base) {
  let cookie = '';
  const c = {
    async request(method, url, body, { headers = {}, raw } = {}) {
      const res = await fetch(base + url, {
        method,
        headers: {
          ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
        body: raw !== undefined ? raw : method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data, headers: res.headers };
    },
    get: (url, opts) => c.request('GET', url, undefined, opts),
    post: (url, body, opts) => c.request('POST', url, body, opts),
    patch: (url, body, opts) => c.request('PATCH', url, body, opts),
    del: (url, opts) => c.request('DELETE', url, undefined, opts),
    get cookie() { return cookie; },
    set cookie(v) { cookie = v; },
  };
  return c;
}

let seq = 0;
// Registers a fresh user and returns a client logged in as them (with .user set).
async function newUser(base, name = 'user') {
  const c = client(base);
  const username = `${name}${++seq}`;
  const r = await c.post('/api/register', { username, password: 'secret123', displayName: name });
  if (r.status !== 200) throw new Error(`register failed: ${JSON.stringify(r.data)}`);
  c.user = r.data.user;
  return c;
}

// Creates a group owned by `owner`; every client in `others` joins it by invite code.
async function newGroup(owner, others = [], name = 'Trip') {
  const { data: { id } } = await owner.post('/api/groups', { name });
  const { data } = await owner.get(`/api/groups/${id}`);
  for (const o of others) await o.post('/api/groups/join', { code: data.group.inviteCode });
  return { id, inviteCode: data.group.inviteCode };
}

module.exports = { startServer, client, newUser, newGroup };
