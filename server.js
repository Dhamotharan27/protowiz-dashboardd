// Protowiz / iBots Project Management server.
// Runs two ways with the same code:
//   node server.js        -> local web server (Node 22.13+, no npm install needed)
//   Vercel                -> api/index.mjs calls handleApi() for /api/*, public/ is served by Vercel
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// tiny .env loader
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach(l => {
    const m = l.match(/^\s*([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  });
} catch (e) { /* no .env file, defaults are used */ }

const { store, ready, reset, hash, check, info } = require('./db');
// Login tokens are signed with JWT_SECRET if you set one, otherwise with a random key kept in the database.
const secret = () => process.env.JWT_SECRET || info.secret;

class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const bad = m => new HttpError(400, m);
const forbid = m => new HttpError(403, m || 'You do not have permission for this action');

// ---------- auth tokens (HMAC signed, 12 hours) ----------
const mac = b => crypto.createHmac('sha256', secret()).update(b).digest('base64url');
function sign(p) { const b = Buffer.from(JSON.stringify(p)).toString('base64url'); return b + '.' + mac(b); }
function unsign(t) {
  const [b, s] = String(t || '').split('.');
  if (!b || !s) return null;
  const ok = mac(b);
  if (s.length !== ok.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(ok))) return null;
  try { const p = JSON.parse(Buffer.from(b, 'base64url').toString()); return p.exp > Date.now() ? p : null; } catch (e) { return null; }
}
const isMgr = u => u.role !== 'Employee';

// ---------- entity definitions ----------
const ST = ['Planning', 'Not Started', 'In Progress', 'Testing', 'At Risk', 'Completed'];
const TS = ['Not Started', 'In Progress', 'Testing', 'Completed'];
// field types: t required text, o optional text, d date, n number 0-100, u existing person, p existing project, k existing task, K task or empty, [..] allowed values
const E = {
  projects: { t: 'projects', pre: 'PRJ-', label: 'Project', f: { name: 't', owner: 'u', status: ST, due: 'd', desc: 'o' } },
  tasks: { t: 'tasks', pre: 'TSK-', label: 'Task', f: { title: 't', project: 'p', milestone: 'o', owner: 'u', priority: ['Low', 'Medium', 'High'], status: TS, progress: 'n', due: 'd', desc: 'o' } },
  dependencies: { t: 'deps', pre: 'DEP-', label: 'Dependency', f: { task: 'k', dependsOn: 'k' } },
  failures: { t: 'failures', pre: 'F-', label: 'Failure', f: { project: 'p', task: 'K', issue: 't', severity: ['Low', 'Medium', 'High', 'Critical'], reporter: 'u', status: ['Open', 'In Progress', 'Resolved', 'Closed'] } },
  testing: { t: 'tests', pre: 'TST-', label: 'Test', f: { project: 'p', name: 't', tester: 'u', date: 'd', result: ['Pending', 'Passed', 'Failed'] } },
  delivery: { t: 'delivery', pre: 'DLV-', label: 'Delivery', f: { project: 'p', milestone: 't', client: 't', due: 'd', status: ['Pending', 'In Transit', 'Delivered'] } },
  users: { t: 'users', pre: 'U-', label: 'User', f: { name: 't', email: 't', role: ['Manager', 'Lead', 'Employee'] } }
};
const LBL = { name: 'Name', owner: 'Owner', status: 'Status', due: 'Due date', desc: 'Description', title: 'Task title', project: 'Project', priority: 'Priority', progress: 'Progress', task: 'Task', dependsOn: 'Depends on', issue: 'Issue', severity: 'Severity', reporter: 'Reported by', tester: 'Tester', date: 'Test date', result: 'Result', milestone: 'Milestone', client: 'Client', email: 'Username', role: 'Role' };
const col = f => ({ desc: 'details', dependsOn: 'depends_on' }[f] || f);
const sel = k => 'id, ' + Object.keys(E[k].f).map(f => `${col(f)} AS "${f}"`).join(', ') + (k === 'projects' ? ', progress' : k === 'tasks' ? ', completed_at AS "completedAt"' : '');
const ymd = x => x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
// "Today" for completion dates: the user's own date sent by the browser (servers such as Vercel run on UTC),
// accepted only if it is within a day of the server's date.
function today(ctx) {
  const v = ctx && ctx.localDate, now = Date.now();
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Math.abs(Date.parse(v + 'T12:00:00Z') - now) < 40 * 3600e3) return v;
  return ymd(new Date(now));
}
const all = (sql, ...a) => store.all(sql, a);
const one = async (sql, ...a) => (await store.all(sql, a))[0];
const get = (k, id) => one(`SELECT ${sel(k)} FROM ${E[k].t} WHERE id = ?`, id);
const logStmt = t => ['INSERT INTO activity(t, at) VALUES (?, ?)', [t, Date.now()]];
// project progress = average of its tasks; 100% marks it Completed, dropping below reopens it
const recalcStmt = pid => [`UPDATE projects SET
  progress = (SELECT CAST(ROUND(AVG(progress)) AS INTEGER) FROM tasks WHERE project = projects.id),
  status = CASE WHEN (SELECT ROUND(AVG(progress)) FROM tasks WHERE project = projects.id) = 100 THEN 'Completed'
                WHEN status = 'Completed' THEN 'In Progress' ELSE status END
  WHERE id = ? AND EXISTS (SELECT 1 FROM tasks WHERE project = projects.id)`, [pid]];
const renameStmts = (o, n) => o === n ? [] : [['projects', 'owner'], ['tasks', 'owner'], ['failures', 'reporter'], ['tests', 'tester'], ['updates', 'author']].map(([t, c]) => [`UPDATE ${t} SET ${c} = ? WHERE ${c} = ?`, [n, o]]);
const isClash = e => /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(String(e && (e.message || e.code)));

async function nextId(k) {
  const sp = E[k]; let m = 0;
  (await all(`SELECT id FROM ${sp.t}`)).forEach(r => { const n = parseInt(String(r.id).slice(sp.pre.length), 10); if (n > m) m = n; });
  return sp.pre + String(m + 1).padStart(3, '0');
}

async function clean(k, body, cur, only) {
  const out = {};
  for (const [f, t] of Object.entries(E[k].f)) {
    const L = LBL[f];
    if (only && !only.includes(f)) { out[f] = cur[f]; continue; }
    let v = body[f];
    if (v === undefined) { if (cur) { out[f] = cur[f]; continue; } v = Array.isArray(t) ? t[0] : t === 'n' ? 0 : ''; }
    if (Array.isArray(t)) { if (!t.includes(v)) throw bad(`${L} must be one of: ${t.join(', ')}`); }
    else if (t === 'n') { if (v === null || v === '' || !Number.isFinite(Number(v)) || Number(v) < 0 || Number(v) > 100) throw bad('Progress must be between 0 and 100'); v = Math.round(Number(v)); }
    else if (t === 'o') { if (typeof v !== 'string') throw bad(L + ' must be text'); v = v.trim().slice(0, 2000); }
    else if (t === 'd') { if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(new Date(v + 'T00:00:00'))) throw bad(L + ' must be a valid date'); }
    else if (typeof v !== 'string') throw bad(L + ' is required');
    else {
      v = v.trim();
      if (t === 'K' && v === '') { /* optional */ }
      else if (!v) throw bad(L + ' is required');
      else if (v.length > 200) throw bad(L + ' is too long');
      else if (t === 'u' && !(await one('SELECT 1 AS x FROM users WHERE name = ?', v))) throw bad(L + ': unknown person');
      else if (t === 'p' && !(await one('SELECT 1 AS x FROM projects WHERE id = ?', v))) throw bad(L + ': project not found');
      else if ((t === 'k' || t === 'K') && !(await one('SELECT 1 AS x FROM tasks WHERE id = ?', v))) throw bad(L + ': task not found');
    }
    out[f] = v;
  }
  return out;
}

const unmet = async id => (await all(`SELECT k.title FROM deps d JOIN tasks k ON k.id = d.depends_on WHERE d.task = ? AND k.status != 'Completed'`, id)).map(r => r.title);
// would a new "task waits for dependsOn" edge close a loop? (walks the dependency graph from dependsOn)
async function reaches(from, to, skipId) {
  const g = {};
  (await all('SELECT id, task, depends_on FROM deps')).forEach(e => { if (e.id !== skipId) (g[e.task] = g[e.task] || []).push(e.depends_on); });
  const seen = {}, stack = [from];
  while (stack.length) { const a = stack.pop(); if (a === to) return true; if (seen[a]) continue; seen[a] = 1; (g[a] || []).forEach(x => stack.push(x)); }
  return false;
}
const managers = async () => Number((await one(`SELECT COUNT(*) AS n FROM users WHERE role = 'Manager'`)).n);

async function rules(k, v, cur) {
  if (k === 'tasks' && cur && v.status !== cur.status && ['In Progress', 'Testing', 'Completed'].includes(v.status)) {
    const u = await unmet(cur.id); if (u.length) throw new HttpError(409, 'Blocked by: ' + u.join(', ') + '. Complete those tasks first.');
  }
  if (k === 'dependencies') {
    if (v.task === v.dependsOn) throw bad('A task cannot depend on itself');
    const dup = await one('SELECT id FROM deps WHERE task = ? AND depends_on = ?', v.task, v.dependsOn);
    if (dup && (!cur || dup.id !== cur.id)) throw bad('This dependency already exists');
    if (await reaches(v.dependsOn, v.task, cur && cur.id)) throw bad('This would create a circular dependency');
  }
  if (k === 'users') {
    const e = await one('SELECT id FROM users WHERE email = ?', v.email); if (e && (!cur || e.id !== cur.id)) throw bad('This username is already used');
    const n = await one('SELECT id FROM users WHERE name = ?', v.name); if (n && (!cur || n.id !== cur.id)) throw bad('This name is already used');
    if (cur && cur.role === 'Manager' && v.role !== 'Manager' && await managers() <= 1) throw bad('At least one Manager is required');
  }
}

async function create(k, ctx) {
  if (!(isMgr(ctx.user) || ['failures', 'projects', 'tasks'].includes(k))) throw forbid();
  const v = await clean(k, ctx.body, null);
  if (k === 'failures' && !isMgr(ctx.user)) v.reporter = ctx.user.name;
  await rules(k, v, null);
  if (k === 'tasks' && v.status === 'Completed') v.progress = 100;
  let pwHash = '';
  if (k === 'users') {
    const pw = ctx.body.password; if (typeof pw !== 'string' || pw.length < 4) throw bad('Password needs at least 4 characters');
    pwHash = hash(pw);
  }
  for (let attempt = 1; ; attempt++) { // two people saving at the same moment can pick the same new ID: try the next one
    const id = await nextId(k), cols = ['id', ...Object.keys(v).map(col)], vals = [id, ...Object.values(v)];
    if (k === 'tasks') { cols.push('completed_at'); vals.push(v.status === 'Completed' ? today(ctx) : ''); }
    if (k === 'users') { cols.push('password_hash'); vals.push(pwHash); }
    const stmts = [[`INSERT INTO ${E[k].t}(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, vals]];
    if (k === 'tasks') stmts.push(recalcStmt(v.project));
    stmts.push(logStmt(`${E[k].label} added: ${v.name || v.title || v.issue || v.milestone || id} by ${ctx.user.name}`));
    try { await store.batch(stmts); return { id }; }
    catch (e) { if (!isClash(e) || attempt >= 5) throw e; if (k === 'users') await rules(k, v, null); }
  }
}

async function update(k, id, ctx) {
  const cur = await get(k, id); if (!cur) throw new HttpError(404, 'Not found');
  let only = null;
  if (!isMgr(ctx.user)) { if (k === 'tasks' && cur.owner === ctx.user.name) only = ['status', 'progress']; else throw forbid(); }
  const v = await clean(k, ctx.body, cur, only);
  await rules(k, v, cur);
  if (k === 'tasks' && v.status === 'Completed') v.progress = 100;
  const sets = Object.keys(v).map(f => col(f) + ' = ?'), vals = Object.values(v);
  if (k === 'users' && ctx.body.password) {
    if (typeof ctx.body.password !== 'string' || ctx.body.password.length < 4) throw bad('Password needs at least 4 characters');
    sets.push('password_hash = ?'); vals.push(hash(ctx.body.password));
  }
  if (k === 'tasks') {
    if (v.status === 'Completed' && cur.status !== 'Completed') { sets.push('completed_at = ?'); vals.push(today(ctx)); }
    else if (v.status !== 'Completed') sets.push("completed_at = ''");
  }
  const stmts = [[`UPDATE ${E[k].t} SET ${sets.join(', ')} WHERE id = ?`, [...vals, id]]];
  if (k === 'users') stmts.push(...renameStmts(cur.name, v.name));
  if (k === 'tasks') { stmts.push(recalcStmt(v.project)); if (cur.project !== v.project) stmts.push(recalcStmt(cur.project)); }
  stmts.push(logStmt(`${E[k].label} ${k === 'tasks' && v.status === 'Completed' && cur.status !== 'Completed' ? 'completed' : 'updated'}: ${v.name || v.title || v.issue || v.milestone || id} by ${ctx.user.name}`));
  try { await store.batch(stmts); } catch (e) { if (isClash(e)) throw bad('This username is already used'); throw e; }
  return { ok: true };
}

async function remove(k, id, ctx) {
  if (!isMgr(ctx.user)) throw forbid();
  const cur = await get(k, id); if (!cur) throw new HttpError(404, 'Not found');
  if (k === 'users') {
    if (id === ctx.user.id) throw bad('You cannot delete your own account');
    if (cur.role === 'Manager' && await managers() <= 1) throw bad('At least one Manager is required');
  }
  const stmts = [];
  if (k === 'projects') {
    const ts = '(SELECT id FROM tasks WHERE project = ?)';
    stmts.push([`DELETE FROM deps WHERE task IN ${ts} OR depends_on IN ${ts}`, [id, id]], [`DELETE FROM updates WHERE task IN ${ts}`, [id]],
      [`UPDATE failures SET task = '' WHERE task IN ${ts}`, [id]]);
    ['tasks', 'failures', 'tests', 'delivery'].forEach(t => stmts.push([`DELETE FROM ${t} WHERE project = ?`, [id]]));
  }
  if (k === 'tasks') stmts.push(['DELETE FROM deps WHERE task = ? OR depends_on = ?', [id, id]], ['DELETE FROM updates WHERE task = ?', [id]], [`UPDATE failures SET task = '' WHERE task = ?`, [id]]);
  stmts.push([`DELETE FROM ${E[k].t} WHERE id = ?`, [id]]);
  if (k === 'tasks') stmts.push(recalcStmt(cur.project));
  stmts.push(logStmt(`${E[k].label} deleted by ${ctx.user.name}`));
  await store.batch(stmts);
  return { ok: true };
}

// ---------- routes ----------
const routes = [];
const route = (m, re, fn, open) => routes.push({ m, re: new RegExp('^' + re + '$'), fn, open });

route('GET', '/api/health', () => ({ ok: true, storage: info.kind, persistent: info.persistent }), true);

route('POST', '/api/login', async ctx => {
  const u = String(ctx.body.username || '').trim(), p = String(ctx.body.password || '');
  const r = await one('SELECT * FROM users WHERE email = ? OR lower(name) = lower(?)', u, u);
  // spaces copied by accident around a password are forgiven
  if (!r || !(check(p, r.password_hash) || (p.trim() !== p && check(p.trim(), r.password_hash)))) {
    console.warn(`Failed login for "${u.slice(0, 60)}" (${r ? 'wrong password' : 'no such user'})`); // shows in Vercel > Logs
    throw new HttpError(401, 'Wrong username or password');
  }
  return { token: sign({ id: r.id, exp: Date.now() + 12 * 3600e3 }) };
}, true);

route('GET', '/api/all', async ctx => {
  const me = ctx.user, mgr = isMgr(me);
  const [users, projects, tasks, deps, failures, tests, delivery, updates, activity] = await store.reads([
    ['SELECT id, name, email, role FROM users ORDER BY id'],
    [`SELECT ${sel('projects')} FROM projects ORDER BY id`],
    [`SELECT ${sel('tasks')} FROM tasks ORDER BY id`],
    [`SELECT ${sel('dependencies')} FROM deps ORDER BY id`],
    [`SELECT ${sel('failures')} FROM failures ORDER BY id`],
    [`SELECT ${sel('testing')} FROM tests ORDER BY id`],
    [`SELECT ${sel('delivery')} FROM delivery ORDER BY id`],
    ['SELECT task, author AS "user", note, at FROM updates ORDER BY id DESC LIMIT 300'],
    ['SELECT t, at FROM activity ORDER BY id DESC LIMIT 30']]);
  return {
    me: { id: me.id, name: me.name, email: me.email, role: me.role },
    storage: { kind: info.kind, persistent: info.persistent },
    users: users.map(u => mgr || u.id === me.id ? u : { ...u, email: '' }),
    projects, tasks, deps, failures, tests, delivery, updates, activity
  };
});

route('POST', '/api/tasks/([^/]+)/updates', async ctx => {
  const t = await get('tasks', ctx.m[1]); if (!t) throw new HttpError(404, 'Task not found');
  if (!isMgr(ctx.user) && t.owner !== ctx.user.name) throw forbid('You can only add updates to your own tasks');
  const note = String(ctx.body.note || '').trim(); if (!note) throw bad('Write an update first');
  await store.batch([['INSERT INTO updates(task, author, note, at) VALUES (?,?,?,?)', [t.id, ctx.user.name, note.slice(0, 1000), Date.now()]],
    logStmt(`Daily update added on ${t.title} by ${ctx.user.name}`)]);
  return { ok: true };
});

route('PATCH', '/api/me', async ctx => {
  const name = String(ctx.body.name || '').trim(); if (!name) throw bad('Name cannot be empty');
  if (name.length > 200) throw bad('Name is too long');
  const x = await one('SELECT id FROM users WHERE name = ?', name); if (x && x.id !== ctx.user.id) throw bad('This name is already used');
  await store.batch([['UPDATE users SET name = ? WHERE id = ?', [name, ctx.user.id]], ...renameStmts(ctx.user.name, name)]);
  return { ok: true };
});
route('POST', '/api/me/password', async ctx => {
  if (!check(String(ctx.body.current || ''), ctx.user.password_hash)) throw bad('Current password is wrong');
  const n = ctx.body.next; if (typeof n !== 'string' || n.length < 4) throw bad('New password needs at least 4 characters');
  await store.batch([['UPDATE users SET password_hash = ? WHERE id = ?', [hash(n), ctx.user.id]]]);
  return { ok: true };
});
route('POST', '/api/reset', async ctx => { if (!isMgr(ctx.user)) throw forbid(); await reset(); return { ok: true }; });

const K = '(projects|tasks|dependencies|failures|testing|delivery|users)';
route('POST', `/api/${K}`, ctx => create(ctx.m[1], ctx));
route('PATCH', `/api/${K}/([^/]+)`, ctx => update(ctx.m[1], ctx.m[2], ctx));
route('DELETE', `/api/${K}/([^/]+)`, ctx => remove(ctx.m[1], ctx.m[2], ctx));

// ---------- API core, shared by the local server and Vercel ----------
// req: { method, path, auth, localDate, body } (body = raw text) -> { status, data }
async function handleApi(req) {
  try {
    let hit = null, m;
    for (const r of routes) if (r.m === req.method && (m = req.path.match(r.re))) { hit = { r, m }; break; }
    if (!hit) throw new HttpError(404, 'Not found');
    const ctx = { m: hit.m, body: {}, localDate: req.localDate };
    if (['POST', 'PATCH'].includes(req.method) && req.body) {
      if (req.body.length > 1e6) throw bad('Request too large');
      try { const j = JSON.parse(req.body); ctx.body = j && typeof j === 'object' ? j : {}; } catch (e) { throw bad('Invalid JSON'); }
    }
    await ready();
    if (!hit.r.open) {
      const tok = unsign(String(req.auth || '').replace(/^Bearer\s+/i, ''));
      const u = tok && await one('SELECT * FROM users WHERE id = ?', tok.id);
      if (!u) throw new HttpError(401, 'Please log in');
      ctx.user = u;
    }
    return { status: 200, data: await hit.r.fn(ctx) };
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, data: { error: e.message } };
    console.error(e);
    if (isClash(e)) return { status: 409, data: { error: 'Someone else saved a change at the same moment. Please try again.' } };
    return { status: 500, data: { error: 'Server error. Please try again.' } };
  }
}

// ---------- local http server ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function readBody(req) {
  return new Promise((ok, no) => {
    let s = ''; req.on('data', c => { s += c; if (s.length > 1e6) { no(bad('Request too large')); req.destroy(); } });
    req.on('end', () => ok(s)); req.on('error', no);
  });
}
function send(res, status, data) { const b = JSON.stringify(data); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(b); }

function staticFile(req, res, p) {
  const root = path.join(__dirname, 'public');
  const f = path.normalize(path.join(root, p === '/' ? 'index.html' : p));
  if (!f.startsWith(root + path.sep) && f !== root) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(f, (e, buf) => {
    if (e) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(buf);
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    const p = new URL(req.url, 'http://localhost').pathname;
    if (!p.startsWith('/api/')) return req.method === 'GET' ? staticFile(req, res, p) : (res.writeHead(405), res.end());
    let body = '';
    try { if (['POST', 'PATCH'].includes(req.method)) body = await readBody(req); }
    catch (e) { return send(res, e.status || 400, { error: e.message }); }
    const r = await handleApi({ method: req.method, path: p, auth: req.headers.authorization, localDate: req.headers['x-local-date'], body });
    send(res, r.status, r.data);
  });
}

module.exports = { createServer, handleApi };
if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3000;
  const srv = createServer();
  srv.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Change PORT in the .env file.` : e.message); process.exit(1); });
  ready().catch(e => console.error('Database problem:', e.message));
  srv.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`iBots Project Management running at ${url}  (login: dhamotharan / demo1234)  storage: ${info.kind}`);
    if (process.env.OPEN_BROWSER === '1') { // opened by start.bat / start.sh
      const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
      require('child_process').exec(cmd, () => {});
    }
  });
}
