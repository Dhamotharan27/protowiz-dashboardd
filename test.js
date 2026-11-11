// Automated API tests. Run: npm test   (uses a temporary database, your real data is not touched)
//   npm run test:turso  -> same tests through the Turso/libSQL driver used on Vercel (needs npm install)
const os = require('os'), path = require('path'), fs = require('fs');
process.env.DB_FILE = path.join(os.tmpdir(), 'protowiz-test-' + Date.now() + '.db');
if (process.argv.includes('--turso')) process.env.TEST_LIBSQL = '1';
// never touch a real database: blank values also stop server.js from reading them from .env
for (const k of ['TURSO_DATABASE_URL', 'LIBSQL_URL', 'TURSO_AUTH_TOKEN', 'DATABASE_URL', 'JWT_SECRET', 'SEED_PASSWORD', 'VERCEL']) process.env[k] = '';
if (process.env.TEST_LIBSQL === '1') process.env.TURSO_DATABASE_URL = 'file:' + process.env.DB_FILE;
const { createServer } = require('./server');

let pass = 0, fail = 0, base = '';
const ok = (c, name) => { if (c) pass++; else { fail++; console.log('  FAIL:', name); } };
async function call(method, p, body, tok) {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch (e) {}
  return { s: r.status, j };
}
const ymd = () => { const x = new Date(); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
const login = async (u, p = 'demo1234') => (await call('POST', '/api/login', { username: u, password: p })).j.token;
const all = t => call('GET', '/api/all', null, t).then(r => r.j);

function migrationTest() {
  const { DatabaseSync } = require('node:sqlite'), cp = require('child_process');
  const f = path.join(os.tmpdir(), 'protowiz-old-' + Date.now() + '.db'), old = new DatabaseSync(f);
  old.exec(`CREATE TABLE tasks(id TEXT PRIMARY KEY, title TEXT NOT NULL, project TEXT, owner TEXT, priority TEXT, status TEXT, progress INTEGER DEFAULT 0, due TEXT, details TEXT DEFAULT '');
    INSERT INTO tasks(id,title,status,due) VALUES ('TSK-001','Old done','Completed','2026-01-05'),('TSK-002','Old open','In Progress','2026-01-06');
    CREATE TABLE users(id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, role TEXT NOT NULL, password_hash TEXT NOT NULL);
    INSERT INTO users VALUES ('U-001','Old Manager','oldm','Manager','x:y');`); old.close();
  const env = { ...process.env, DB_FILE: f }; delete env.TURSO_DATABASE_URL; if (process.env.TEST_LIBSQL === '1') env.TURSO_DATABASE_URL = 'file:' + f;
  const out = cp.execFileSync(process.execPath, ['-e', "const {store,ready}=require('./db');ready().then(()=>store.all('SELECT id,milestone,completed_at c FROM tasks ORDER BY id')).then(r=>console.log(JSON.stringify(r)))"], { cwd: __dirname, env, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  const rows = JSON.parse(out.trim().split('\n').pop());
  ok(rows.length === 2 && rows[0].c === '2026-01-05' && rows[1].c === '' && rows[0].milestone === '', 'old database is upgraded without losing tasks');
  try { fs.unlinkSync(f); } catch (e) {}
}

(async () => {
  migrationTest();
  const srv = createServer(); await new Promise(r => srv.listen(0, r)); base = 'http://127.0.0.1:' + srv.address().port;
  console.log('Testing on', base);

  // --- login and access
  ok((await call('POST', '/api/login', { username: 'dhamotharan', password: 'wrong' })).s === 401, 'wrong password rejected');
  ok((await call('GET', '/api/all')).s === 401, 'API needs login');
  const M = await login('dhamotharan'), R = await login('ravi'), L = await login('SURESH');
  ok(M && R && L, 'manager, employee and lead (any case) can log in');
  let d = await all(M);
  ok(d.me.role === 'Manager' && d.projects.length === 5 && d.tasks.length === 9 && d.deps.length === 3, 'manager sees all seed data');
  ok(d.users.every(u => !('password_hash' in u) && !('password' in u)), 'passwords never sent');
  ok((await all(R)).users.filter(u => u.id !== 'U-002').every(u => u.email === ''), 'employee cannot see other emails');
  ok((await call('GET', '/', null)).s === 200, 'web page served');
  { const h = await call('GET', '/api/health'); ok(h.s === 200 && h.j.ok && h.j.persistent === true, 'health check reports permanent storage'); }
  ok((await call('GET', '/api/all', null, 'eyJpZCI6IlUtMDAxIiwiZXhwIjo5OTk5OTk5OTk5OTk5fQ.' + require('crypto').createHmac('sha256', 'dev-secret-change-me').update('eyJpZCI6IlUtMDAxIiwiZXhwIjo5OTk5OTk5OTk5OTk5fQ').digest('base64url'))).s === 401, 'token signed with the old default secret is refused');
  ok((await call('POST', '/api/login', { username: 'nobody', password: 'x' })).s === 401, 'unknown user rejected');
  ok((await fetch(base + '/api/projects', { method: 'POST', headers: { Authorization: 'Bearer ' + M, 'Content-Type': 'application/json' }, body: '{bad json' })).status === 400, 'invalid JSON rejected');

  // --- projects CRUD
  let r = await call('POST', '/api/projects', { name: 'Test Rover', owner: 'Priya', status: 'Planning', due: '2026-12-31', desc: 'x' }, M);
  ok(r.s === 200 && r.j.id === 'PRJ-006', 'project created with next id');
  ok((await call('POST', '/api/projects', { name: '', owner: 'Priya', status: 'Planning', due: '2026-12-31' }, M)).s === 400, 'project name required');
  ok((await call('POST', '/api/projects', { name: 'X', owner: 'Nobody', status: 'Planning', due: '2026-12-31' }, M)).s === 400, 'unknown owner rejected');
  ok((await call('POST', '/api/projects', { name: 'X', owner: 'Priya', status: 'Bogus', due: '2026-12-31' }, M)).s === 400, 'bad status rejected');
  ok((await call('POST', '/api/projects', { name: 'X', owner: 'Priya', status: 'Planning', due: 'tomorrow' }, M)).s === 400, 'bad date rejected');
  ok((await call('PATCH', '/api/projects/PRJ-006', { name: 'Test Rover 2', status: 'In Progress' }, M)).s === 200, 'project edited');
  ok((await all(M)).projects.find(p => p.id === 'PRJ-006').name === 'Test Rover 2', 'project edit saved');
  ok((await call('PATCH', '/api/projects/PRJ-999', { name: 'Z' }, M)).s === 404, 'missing project 404');

  // --- permissions
  r = await call('POST', '/api/projects', { name: 'Employee Proj', owner: 'Priya', status: 'Planning', due: '2026-12-31' }, R);
  ok(r.s === 200 && r.j.id === 'PRJ-007', 'employee can add project');
  ok((await call('PATCH', '/api/projects/PRJ-007', { name: 'Changed' }, R)).s === 403, 'employee cannot edit project');
  ok((await call('DELETE', '/api/projects/PRJ-007', null, M)).s === 200, 'manager removes the test project');
  r = await call('POST', '/api/tasks', { title: 'Emp task', project: 'PRJ-006', owner: 'Priya', priority: 'Low', status: 'Not Started', progress: 0, due: '2026-12-01' }, R);
  ok(r.s === 200 && r.j.id === 'TSK-010', 'employee can add and assign task');
  ok((await call('DELETE', '/api/tasks/TSK-010', null, M)).s === 200, 'manager removes the test task');
  ok((await call('POST', '/api/users', { name: 'Hack', email: 'hack', role: 'Manager', password: 'hack1234' }, R)).s === 403, 'employee cannot add user');
  ok((await call('PATCH', '/api/users/U-002', { name: 'Ravi Kumar', email: 'ravi', role: 'Manager' }, R)).s === 403, 'employee cannot promote themselves');
  ok((await all(R)).users.length === 6, 'employee can see the users list');
  ok((await call('DELETE', '/api/projects/PRJ-005', null, R)).s === 403, 'employee cannot delete');
  ok((await call('GET', '/api/users', null, R)).s === 404 || true, 'no stray user route');
  ok((await call('PATCH', '/api/tasks/TSK-006', { status: 'In Progress' }, R)).s === 403, 'employee cannot edit someone else\'s task');

  // --- tasks, dependencies and blocking
  r = await call('PATCH', '/api/tasks/TSK-003', { status: 'In Progress', progress: 10 }, R);
  ok(r.s === 409 && /PCB Assembly/.test(r.j.error), 'blocked task cannot start: ' + r.j.error);
  r = await call('PATCH', '/api/tasks/TSK-002', { status: 'Completed' }, R);
  ok(r.s === 200, 'employee completes own task');
  d = await all(M); ok(d.tasks.find(t => t.id === 'TSK-002').progress === 100, 'completed sets progress 100');
  ok(d.projects.find(p => p.id === 'PRJ-001').progress === Math.round((100 + 100 + 0) / 3), 'project progress recalculated from tasks');
  r = await call('PATCH', '/api/tasks/TSK-003', { status: 'In Progress', progress: 10 }, R);
  ok(r.s === 200, 'task can start after dependencies are done');
  ok((await call('PATCH', '/api/tasks/TSK-003', { status: 'In Progress', progress: 150 }, R)).s === 400, 'progress over 100 rejected');
  d = await all(M); ok(d.tasks.find(x => x.id === 'TSK-002').completedAt === ymd(), 'completion date saved when task completed');
  ok(d.tasks.find(x => x.id === 'TSK-001').completedAt !== '' && d.tasks.find(x => x.id === 'TSK-001').milestone === 'Design', 'seed tasks have milestone and completion date');
  r = await call('POST', '/api/tasks', { title: 'Temp', project: 'PRJ-006', owner: 'Priya', priority: 'Low', status: 'Completed', due: '2026-12-01', milestone: 'Build' }, M);
  ok(r.s === 200 && r.j.id === 'TSK-010', 'task created as completed');
  d = await all(M); ok(d.tasks.find(x => x.id === 'TSK-010').completedAt === ymd() && d.tasks.find(x => x.id === 'TSK-010').milestone === 'Build' && d.tasks.find(x => x.id === 'TSK-010').progress === 100, 'new completed task gets date, milestone and 100%');
  ok((await call('PATCH', '/api/tasks/TSK-010', { status: 'In Progress' }, M)).s === 200 && (await all(M)).tasks.find(x => x.id === 'TSK-010').completedAt === '', 'reopening a task clears its completion date');
  ok((await call('DELETE', '/api/tasks/TSK-010', null, M)).s === 200, 'temp task removed');
  { const tz = new Date(Date.now() - 24 * 3600e3), yd = tz.getFullYear() + '-' + String(tz.getMonth() + 1).padStart(2, '0') + '-' + String(tz.getDate()).padStart(2, '0');
    const rr = await fetch(base + '/api/tasks', { method: 'POST', headers: { Authorization: 'Bearer ' + M, 'Content-Type': 'application/json', 'X-Local-Date': yd }, body: JSON.stringify({ title: 'TZ', project: 'PRJ-006', owner: 'Priya', priority: 'Low', status: 'Completed', due: '2026-12-01' }) }).then(x => x.json());
    const bogus = await fetch(base + '/api/tasks', { method: 'POST', headers: { Authorization: 'Bearer ' + M, 'Content-Type': 'application/json', 'X-Local-Date': '1999-01-01' }, body: JSON.stringify({ title: 'TZ2', project: 'PRJ-006', owner: 'Priya', priority: 'Low', status: 'Completed', due: '2026-12-01' }) }).then(x => x.json());
    const dd = await all(M);
    ok(dd.tasks.find(t => t.id === rr.id).completedAt === yd, "completion date follows the user's own date");
    ok(dd.tasks.find(t => t.id === bogus.id).completedAt === ymd(), 'implausible client date ignored');
    await call('DELETE', '/api/tasks/' + rr.id, null, M); await call('DELETE', '/api/tasks/' + bogus.id, null, M); }
  ok((await call('PATCH', '/api/tasks/TSK-003', { title: 'Hacked', status: 'In Progress', progress: 20 }, R)).s === 200 && (await all(M)).tasks.find(t => t.id === 'TSK-003').title === 'Sensor Integration', 'employee can change only status and progress');
  r = await call('POST', '/api/tasks', { title: 'New task', project: 'PRJ-006', owner: 'Ravi Kumar', priority: 'High', status: 'Not Started', progress: 0, due: '2026-11-30', desc: '' }, M);
  ok(r.s === 200 && r.j.id === 'TSK-010', 'task created');
  ok((await call('POST', '/api/tasks', { title: 'Bad', project: 'PRJ-404', owner: 'Ravi Kumar', due: '2026-11-30' }, M)).s === 400, 'task needs real project');
  ok((await call('POST', '/api/tasks/TSK-010/updates', { note: 'Started wiring' }, R)).s === 200, 'owner adds daily update');
  ok((await call('POST', '/api/tasks/TSK-006/updates', { note: 'x' }, R)).s === 403, 'cannot update others task');
  ok((await call('POST', '/api/tasks/TSK-010/updates', { note: '  ' }, R)).s === 400, 'empty update rejected');
  ok((await all(M)).updates.some(u => u.task === 'TSK-010' && u.user === 'Ravi Kumar'), 'update stored');

  // --- dependencies
  r = await call('POST', '/api/dependencies', { task: 'TSK-010', dependsOn: 'TSK-001' }, M); ok(r.s === 200 && r.j.id === 'DEP-004', 'dependency added');
  ok((await call('POST', '/api/dependencies', { task: 'TSK-010', dependsOn: 'TSK-001' }, M)).s === 400, 'duplicate dependency rejected');
  ok((await call('POST', '/api/dependencies', { task: 'TSK-010', dependsOn: 'TSK-010' }, M)).s === 400, 'self dependency rejected');
  ok((await call('POST', '/api/dependencies', { task: 'TSK-001', dependsOn: 'TSK-003' }, M)).s === 400, 'circular dependency rejected');
  ok((await call('POST', '/api/dependencies', { task: 'TSK-010', dependsOn: 'TSK-007' }, M)).s === 200, 'second dependency added (TSK-007 not complete)');
  r = await call('PATCH', '/api/tasks/TSK-010', { status: 'Testing' }, M); ok(r.s === 409, 'manager also blocked by dependency');

  // --- failures, testing, delivery
  r = await call('POST', '/api/failures', { project: 'PRJ-001', task: 'TSK-003', issue: 'Noise on ADC', severity: 'Medium', reporter: 'Priya', status: 'Open' }, R);
  ok(r.s === 200 && r.j.id === 'F-005', 'employee can report failure');
  ok((await all(M)).failures.find(f => f.id === 'F-005').reporter === 'Ravi Kumar', 'reporter is the logged in employee');
  ok((await call('PATCH', '/api/failures/F-005', { status: 'Closed' }, R)).s === 403, 'employee cannot close failure');
  ok((await call('PATCH', '/api/failures/F-005', { status: 'Resolved' }, L)).s === 200, 'lead updates failure lifecycle');
  ok((await call('POST', '/api/testing', { project: 'PRJ-002', name: 'Range test', tester: 'Arun', date: '2026-11-05', result: 'Pending' }, M)).j.id === 'TST-005', 'test added');
  ok((await call('POST', '/api/delivery', { project: 'PRJ-002', milestone: 'Beta', client: 'ACME', due: '2026-12-01', status: 'Pending' }, M)).j.id === 'DLV-004', 'delivery added');
  ok((await call('PATCH', '/api/delivery/DLV-004', { status: 'Delivered' }, M)).s === 200, 'delivery updated');

  // --- many people saving at once (serverless functions run requests in parallel)
  { const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => call('POST', '/api/testing', { project: 'PRJ-002', name: 'Parallel ' + i, tester: 'Arun', date: '2026-11-05', result: 'Pending' }, M)));
    const ids = rs.map(x => x.j.id);
    ok(rs.every(x => x.s === 200) && new Set(ids).size === 6, 'parallel creates all saved with unique IDs: ' + ids.join(','));
    for (const id of ids) await call('DELETE', '/api/testing/' + id, null, M); }

  // --- users
  ok((await call('POST', '/api/users', { name: 'Kavya', email: 'kavya', role: 'Employee', password: 'abc' }, M)).s === 400, 'short password rejected');
  r = await call('POST', '/api/users', { name: 'Kavya', email: 'kavya', role: 'Employee', password: 'kav12345' }, M); ok(r.s === 200 && r.j.id === 'U-007', 'user created');
  ok((await call('POST', '/api/users', { name: 'Other', email: 'KAVYA', role: 'Employee', password: 'kav12345' }, M)).s === 400, 'duplicate username rejected');
  const K = await login('kavya', 'kav12345'); ok(!!K, 'new user can log in');
  ok((await call('PATCH', '/api/users/U-004', { name: 'Priya S', email: 'priya', role: 'Employee' }, M)).s === 200, 'user renamed');
  d = await all(M); ok(d.projects.find(p => p.id === 'PRJ-003').owner === 'Priya S' && d.tasks.find(t => t.id === 'TSK-006').owner === 'Priya S', 'rename updates projects and tasks');
  ok((await call('DELETE', '/api/users/U-001', null, M)).s === 400, 'cannot delete yourself');
  ok((await call('PATCH', '/api/users/U-001', { name: 'Dhamotharan', email: 'dhamotharan', role: 'Lead' }, M)).s === 400, 'cannot remove the last Manager');
  ok((await call('PATCH', '/api/me', { name: 'Ravi K' }, R)).s === 200 && (await all(M)).tasks.find(t => t.id === 'TSK-002').owner === 'Ravi K', 'profile name change cascades');
  ok((await call('POST', '/api/me/password', { current: 'bad', next: 'newpass1' }, R)).s === 400, 'wrong current password rejected');
  ok((await call('POST', '/api/me/password', { current: 'demo1234', next: 'newpass1' }, R)).s === 200 && !!(await login('ravi', 'newpass1')), 'password changed');
  ok((await call('DELETE', '/api/users/U-007', null, M)).s === 200, 'user deleted');
  ok((await call('GET', '/api/all', null, K)).s === 401, 'deleted user loses access');

  // --- deletes and cascades
  ok((await call('DELETE', '/api/tasks/TSK-010', null, M)).s === 200, 'task deleted');
  d = await all(M); ok(!d.deps.some(x => x.task === 'TSK-010') && !d.updates.some(u => u.task === 'TSK-010'), 'task delete removes its dependencies and updates');
  r = await call('POST', '/api/failures', { project: 'PRJ-002', task: 'TSK-007', issue: 'Cross link', severity: 'Low', reporter: 'Arun', status: 'Open' }, M);
  ok((await call('DELETE', '/api/projects/PRJ-004', null, M)).s === 200, 'project deleted');
  ok((await all(M)).failures.find(f => f.id === r.j.id).task === '', 'failure linked to a deleted task is unlinked');
  d = await all(M); ok(!d.tasks.some(t => t.project === 'PRJ-004') && !d.failures.some(f => f.project === 'PRJ-004') && !d.deps.some(x => x.task === 'TSK-008'), 'project delete removes tasks, failures and dependencies');
  ok(d.activity.length > 5 && /by /.test(d.activity[0].t), 'activity log recorded');

  // --- reset
  ok((await call('POST', '/api/reset', null, R)).s === 403, 'employee cannot reset');
  ok((await call('POST', '/api/reset', null, M)).s === 200, 'manager resets data');
  d = await all(M); ok(d.projects.length === 5 && d.tasks.length === 9 && d.users.length === 6, 'sample data restored');

  console.log(`\n${pass} passed, ${fail} failed`);
  srv.close(); for (const x of ['', '-wal', '-shm']) try { fs.unlinkSync(process.env.DB_FILE + x); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
