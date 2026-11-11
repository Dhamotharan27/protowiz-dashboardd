// Checks a running deployment end to end (works on Vercel or any server). No install needed.
//   node smoke-test.js https://your-app.vercel.app            (logs in as dhamotharan / demo1234)
//   node smoke-test.js https://your-app.vercel.app USER PASS  (use a Manager or Lead account)
// It creates a temporary project with a task, dependency, failure, test, delivery and daily update,
// checks every rule, then deletes the project again (everything it made goes with it).
const [base0, user = process.env.SMOKE_USER || 'dhamotharan', pass = process.env.SMOKE_PASSWORD || 'demo1234'] = process.argv.slice(2);
if (!base0) { console.log('Usage: node smoke-test.js https://your-app.vercel.app [username] [password]'); process.exit(1); }
const base = base0.replace(/\/+$/, '');
const TAG = 'SMOKE-' + Date.now().toString(36).toUpperCase();
let pass_ = 0, fail = 0, tok = '';
const ok = (c, name, extra) => { if (c) { pass_++; console.log('  ok   ', name); } else { fail++; console.log('  FAIL ', name, extra === undefined ? '' : '-> ' + extra); } };
async function call(method, p, body) {
  const t0 = Date.now();
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Local-Date': new Date().toISOString().slice(0, 10), ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j = {}; try { j = JSON.parse(text); } catch (e) { j = { raw: text.slice(0, 200) }; }
  return { s: r.status, j, ms: Date.now() - t0, h: r.headers };
}
const day = n => { const x = new Date(); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };

(async () => {
  console.log('Checking', base);
  const page = await fetch(base + '/'); const html = await page.text();
  ok(page.status === 200 && /iBots Project Management/.test(html), 'dashboard page loads', page.status);
  for (const f of ['/protowiz.db', '/server.js', '/db.js', '/.env']) {
    const r = await fetch(base + f); ok(r.status === 404 || !/password_hash|JWT_SECRET|require\(/.test(await r.text()), `private file not public: ${f}`, r.status);
  }
  const h = await call('GET', '/api/health');
  ok(h.s === 200 && h.j.ok, 'API is up', JSON.stringify(h.j));
  ok(h.j.persistent === true, 'permanent database connected (' + h.j.storage + ')', h.j.persistent === false ? 'no database: connect Turso in Vercel > Storage, then redeploy' : JSON.stringify(h.j));
  ok((await call('GET', '/api/all')).s === 401, 'API refuses requests without login');
  ok((await call('POST', '/api/login', { username: user, password: pass + 'x' })).s === 401, 'wrong password refused');
  const lg = await call('POST', '/api/login', { username: user, password: pass });
  ok(lg.s === 200 && lg.j.token, `login as ${user} (${lg.ms} ms)`, JSON.stringify(lg.j));
  if (!lg.j.token) return done();
  tok = lg.j.token;
  let d = await call('GET', '/api/all');
  ok(d.s === 200 && Array.isArray(d.j.projects), `load all data (${d.ms} ms)`, d.s);
  const me = d.j.me || {}, owner = me.name;
  ok(me.role === 'Manager' || me.role === 'Lead', 'account can manage (role ' + me.role + ')', 'use a Manager or Lead login for the full check');

  const P = await call('POST', '/api/projects', { name: TAG + ' project', owner, status: 'Planning', due: day(30), desc: 'Temporary item from smoke-test.js' });
  ok(P.s === 200 && P.j.id, `create project (${P.ms} ms)`, JSON.stringify(P.j));
  if (!P.j.id) return done();
  const pid = P.j.id;
  try {
    ok((await call('PATCH', '/api/projects/' + pid, { status: 'In Progress' })).s === 200, 'edit project');
    const A = await call('POST', '/api/tasks', { title: TAG + ' task A', project: pid, milestone: 'Smoke', owner, priority: 'High', status: 'Not Started', progress: 0, due: day(5) });
    const B = await call('POST', '/api/tasks', { title: TAG + ' task B', project: pid, milestone: 'Smoke', owner, priority: 'Low', status: 'Not Started', progress: 0, due: day(3) });
    ok(A.s === 200 && B.s === 200, 'create two tasks', JSON.stringify([A.j, B.j]));
    const D = await call('POST', '/api/dependencies', { task: A.j.id, dependsOn: B.j.id });
    ok(D.s === 200, 'add dependency (A waits for B)', JSON.stringify(D.j));
    ok((await call('POST', '/api/dependencies', { task: B.j.id, dependsOn: A.j.id })).s === 400, 'circular dependency refused');
    ok((await call('PATCH', '/api/tasks/' + A.j.id, { status: 'In Progress' })).s === 409, 'blocked task cannot start');
    ok((await call('POST', `/api/tasks/${A.j.id}/updates`, { note: 'smoke test update' })).s === 200, 'daily update added');
    ok((await call('PATCH', '/api/tasks/' + B.j.id, { status: 'Completed' })).s === 200, 'complete task B');
    ok((await call('PATCH', '/api/tasks/' + A.j.id, { status: 'In Progress', progress: 50 })).s === 200, 'task A can start once B is done');
    const F = await call('POST', '/api/failures', { project: pid, task: A.j.id, issue: TAG + ' issue', severity: 'Low', reporter: owner, status: 'Open' });
    const T = await call('POST', '/api/testing', { project: pid, name: TAG + ' test', tester: owner, date: day(1), result: 'Pending' });
    const V = await call('POST', '/api/delivery', { project: pid, milestone: TAG + ' delivery', client: 'Smoke client', due: day(9), status: 'Pending' });
    ok(F.s === 200 && T.s === 200 && V.s === 200, 'add failure, test and delivery', JSON.stringify([F.j, T.j, V.j]));
    ok((await call('PATCH', '/api/failures/' + F.j.id, { status: 'Resolved' })).s === 200 && (await call('PATCH', '/api/testing/' + T.j.id, { result: 'Passed' })).s === 200 && (await call('PATCH', '/api/delivery/' + V.j.id, { status: 'Delivered' })).s === 200, 'update failure, test and delivery');
    d = await call('GET', '/api/all');
    const p = d.j.projects.find(x => x.id === pid), b = d.j.tasks.find(x => x.id === B.j.id);
    ok(p && p.progress === 75, 'project progress follows its tasks (75%)', p && p.progress);
    ok(!!b && /^\d{4}-\d{2}-\d{2}$/.test(b.completedAt), 'completion date saved', b && b.completedAt);
    ok(d.j.updates.some(u => u.task === A.j.id), 'daily update saved');
    // the same data must be visible on a fresh request (proves it is stored, not just in one server's memory)
    const again = await Promise.all([1, 2, 3].map(() => call('GET', '/api/all')));
    ok(again.every(r => r.j.tasks && r.j.tasks.some(t => t.id === A.j.id)), 'data visible on repeated requests');
  } finally {
    const del = await call('DELETE', '/api/projects/' + pid);
    ok(del.s === 200, 'delete temporary project');
    d = await call('GET', '/api/all');
    ok(d.j.projects && !d.j.projects.some(x => x.id === pid) && !d.j.tasks.some(t => t.project === pid) && !JSON.stringify(d.j.deps).includes(TAG), 'cleanup removed everything it created');
  }
  done();
})().catch(e => { console.log('  FAIL  could not reach', base, '-', e.message); fail++; done(); });

function done() { console.log(`\n${pass_} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }
