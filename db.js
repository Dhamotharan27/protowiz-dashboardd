// Database layer. Same SQLite tables everywhere, two ways to store them:
//  - On your own computer or server: a SQLite file built into Node (node:sqlite). No install needed.
//  - On Vercel: Turso (hosted SQLite). Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN
//    (added automatically when you connect Turso from the Vercel Storage tab).
//    Without them, Vercel falls back to a temporary database and the dashboard shows a warning.
const crypto = require('crypto');
const path = require('path');

const ON_VERCEL = !!process.env.VERCEL;
const REMOTE_URL = process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL ||
  (/^libsql:/.test(process.env.DATABASE_URL || '') ? process.env.DATABASE_URL : '');
const REMOTE_TOKEN = process.env.TURSO_AUTH_TOKEN || process.env.LIBSQL_AUTH_TOKEN || '';
const FILE = process.env.DB_FILE || (ON_VERCEL ? '/tmp/protowiz.db' : path.join(__dirname, 'protowiz.db'));

// ---------- drivers: all(sql,args) -> rows, batch([[sql,args]]) -> atomic write, reads([[sql,args]]) -> [rows] ----------
function fileDriver(file) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  try { db.exec('PRAGMA journal_mode = WAL;'); } catch (e) { /* not supported on this disk, default journal is fine */ }
  db.exec('PRAGMA busy_timeout = 5000;');
  const plain = r => ({ ...r });
  const prep = (sql, args) => [db.prepare(sql), args || []];
  return {
    kind: 'sqlite-file',
    async all(sql, args) { const [s, a] = prep(sql, args); return s.all(...a).map(plain); },
    async batch(stmts) {
      db.exec('BEGIN IMMEDIATE');
      try { stmts.forEach(([sql, args]) => { const [s, a] = prep(sql, args); s.run(...a); }); db.exec('COMMIT'); }
      catch (e) { try { db.exec('ROLLBACK'); } catch (x) { /* already rolled back */ } throw e; }
    },
    async reads(stmts) { return stmts.map(([sql, args]) => { const [s, a] = prep(sql, args); return s.all(...a).map(plain); }); },
    close() { db.close(); }
  };
}

function libsqlDriver(url, authToken) {
  const { createClient } = require('@libsql/client');
  const c = createClient({ url, authToken: authToken || undefined });
  const rows = rs => rs.rows.map(r => Object.fromEntries(rs.columns.map((k, i) => [k, r[i]])));
  const st = ([sql, args]) => ({ sql, args: args || [] });
  return {
    kind: 'turso',
    async all(sql, args) { return rows(await c.execute(st([sql, args]))); },
    async batch(stmts) { await c.batch(stmts.map(st), 'write'); },
    async reads(stmts) { return (await c.batch(stmts.map(st), 'read')).map(rows); },
    close() { c.close(); }
  };
}

const store = REMOTE_URL ? libsqlDriver(REMOTE_URL, REMOTE_TOKEN) : fileDriver(FILE);
const info = { kind: store.kind, persistent: !(ON_VERCEL && !REMOTE_URL), secret: '' };

// ---------- passwords ----------
function hash(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
}
function check(pw, stored) {
  const [s, k] = String(stored || '').split(':');
  if (!s || !k) return false;
  const want = Buffer.from(k, 'hex'), x = crypto.scryptSync(String(pw), Buffer.from(s, 'hex'), 32);
  return want.length === x.length && crypto.timingSafeEqual(x, want);
}

// ---------- schema ----------
const TABLES = ['updates', 'activity', 'delivery', 'tests', 'failures', 'deps', 'tasks', 'projects', 'users'];
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, role TEXT NOT NULL, password_hash TEXT NOT NULL)',
  "CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, owner TEXT, status TEXT, progress INTEGER DEFAULT 0, due TEXT, details TEXT DEFAULT '')",
  "CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, title TEXT NOT NULL, project TEXT, owner TEXT, priority TEXT, status TEXT, progress INTEGER DEFAULT 0, due TEXT, details TEXT DEFAULT '', milestone TEXT DEFAULT '', completed_at TEXT DEFAULT '')",
  'CREATE TABLE IF NOT EXISTS deps(id TEXT PRIMARY KEY, task TEXT NOT NULL, depends_on TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS failures(id TEXT PRIMARY KEY, project TEXT, task TEXT, issue TEXT, severity TEXT, reporter TEXT, status TEXT)',
  'CREATE TABLE IF NOT EXISTS tests(id TEXT PRIMARY KEY, project TEXT, name TEXT, tester TEXT, date TEXT, result TEXT)',
  'CREATE TABLE IF NOT EXISTS delivery(id TEXT PRIMARY KEY, project TEXT, milestone TEXT, client TEXT, due TEXT, status TEXT)',
  'CREATE TABLE IF NOT EXISTS updates(id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT, author TEXT, note TEXT, at INTEGER)',
  'CREATE TABLE IF NOT EXISTS activity(id INTEGER PRIMARY KEY AUTOINCREMENT, t TEXT, at INTEGER)'
];
const META = 'CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)'; // app settings such as the login-signing key; survives Reset

const ymd = x => x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
function d(n) { const x = new Date(); x.setDate(x.getDate() + n); return ymd(x); }

function seedStatements() {
  const out = [], add = (sql, rows) => rows.forEach(r => out.push([sql, r]));
  const pw = hash(process.env.SEED_PASSWORD || 'demo1234');
  add('INSERT INTO users VALUES (?,?,?,?,?)', [
    ['U-001', 'Dhamotharan', 'dhamotharan', 'Manager', pw], ['U-002', 'Ravi Kumar', 'ravi', 'Employee', pw],
    ['U-003', 'Suresh Babu', 'suresh', 'Lead', pw], ['U-004', 'Priya', 'priya', 'Employee', pw],
    ['U-005', 'Vikram', 'vikram', 'Employee', pw], ['U-006', 'Arun', 'arun', 'Employee', pw]]);
  add('INSERT INTO projects VALUES (?,?,?,?,?,?,?)', [
    ['PRJ-001', 'IoT Weather Station', 'Ravi Kumar', 'In Progress', 55, d(5), 'IoT based station to monitor temperature, humidity and air quality with cloud integration.'],
    ['PRJ-002', 'AGV Robot', 'Suresh Babu', 'Testing', 80, d(10), 'Autonomous guided vehicle for warehouse movement.'],
    ['PRJ-003', 'Smart Home System', 'Priya', 'Planning', 0, d(15), 'Mobile controlled home automation.'],
    ['PRJ-004', 'Delivery Drone', 'Vikram', 'At Risk', 30, d(20), 'Small payload delivery drone.'],
    ['PRJ-005', 'AI Robot', 'Arun', 'Completed', 100, d(-3), 'Vision based assistant robot.']]);
  add('INSERT INTO tasks(id,title,project,owner,priority,status,progress,due,details,milestone,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [
    ['TSK-001', 'Hardware Design', 'PRJ-001', 'Ravi Kumar', 'High', 'Completed', 100, d(-8), 'Schematic and component selection.', 'Design', d(-9)],
    ['TSK-002', 'PCB Assembly', 'PRJ-001', 'Ravi Kumar', 'High', 'In Progress', 45, d(3), 'Assemble and solder the PCB.', 'Build', ''],
    ['TSK-003', 'Sensor Integration', 'PRJ-001', 'Ravi Kumar', 'High', 'Not Started', 0, d(1), 'Integrate the temperature and humidity sensor with the main controller and test the data reading.', 'Testing', ''],
    ['TSK-004', 'Motor Driver Tuning', 'PRJ-002', 'Suresh Babu', 'Medium', 'Testing', 85, d(6), 'Tune the drive motors.', 'Build', ''],
    ['TSK-005', 'Navigation Testing', 'PRJ-002', 'Suresh Babu', 'High', 'In Progress', 60, d(8), 'Test path following in the lab.', 'Testing', ''],
    ['TSK-006', 'Requirement Review', 'PRJ-003', 'Priya', 'Low', 'Not Started', 0, d(12), 'Review requirements with the client.', 'Planning', ''],
    ['TSK-007', 'Flight Controller', 'PRJ-004', 'Vikram', 'High', 'In Progress', 30, d(-2), 'Configure and test the flight controller.', 'Build', ''],
    ['TSK-008', 'GPS Module Setup', 'PRJ-004', 'Vikram', 'Medium', 'Not Started', 0, d(9), 'Install and calibrate GPS.', 'Integration', ''],
    ['TSK-009', 'Vision Model Training', 'PRJ-005', 'Arun', 'High', 'Completed', 100, d(-6), 'Train and validate the vision model.', 'Build', d(-5)]]);
  add('INSERT INTO deps VALUES (?,?,?)', [['DEP-001', 'TSK-003', 'TSK-001'], ['DEP-002', 'TSK-003', 'TSK-002'], ['DEP-003', 'TSK-008', 'TSK-007']]);
  add('INSERT INTO failures VALUES (?,?,?,?,?,?,?)', [
    ['F-001', 'PRJ-001', 'TSK-003', 'Sensor not responding', 'High', 'Ravi Kumar', 'Open'],
    ['F-002', 'PRJ-002', 'TSK-004', 'Overheating issue', 'Medium', 'Suresh Babu', 'In Progress'],
    ['F-003', 'PRJ-003', 'TSK-006', 'API timeout error', 'Medium', 'Priya', 'Resolved'],
    ['F-004', 'PRJ-004', 'TSK-007', 'GPS signal loss', 'Critical', 'Vikram', 'Open']]);
  add('INSERT INTO tests VALUES (?,?,?,?,?,?)', [
    ['TST-001', 'PRJ-002', 'Motor load test', 'Suresh Babu', d(-2), 'Passed'], ['TST-002', 'PRJ-002', 'Obstacle detection', 'Suresh Babu', d(2), 'Pending'],
    ['TST-003', 'PRJ-001', 'Sensor accuracy', 'Ravi Kumar', d(-1), 'Failed'], ['TST-004', 'PRJ-005', 'Final acceptance', 'Arun', d(-5), 'Passed']]);
  add('INSERT INTO delivery VALUES (?,?,?,?,?,?)', [
    ['DLV-001', 'PRJ-005', 'Final handover', 'Campus Robotics', d(-3), 'Delivered'], ['DLV-002', 'PRJ-002', 'Prototype demo', 'Warehouse Co', d(10), 'Pending'],
    ['DLV-003', 'PRJ-001', 'Field pilot', 'GreenFarm', d(5), 'In Transit']]);
  const now = Date.now();
  add('INSERT INTO activity(t,at) VALUES (?,?)', [
    ['New project AI Robot created', now - 9e7], ['Task PCB Assembly updated by Ravi Kumar', now - 5e7], ['Project AGV Robot moved to Testing', now - 36e6],
    ['Failure reported: GPS signal loss', now - 18e6], ['Task Hardware Design completed', now - 72e5]]);
  return out;
}

// ---------- start-up: create tables, upgrade old databases, add sample data to an empty one ----------
async function setup() {
  await store.batch([...SCHEMA.map(s => [s]), [META], ["INSERT OR IGNORE INTO meta(k, v) VALUES ('signing_key', ?)", [crypto.randomBytes(32).toString('hex')]]]);
  const [cols, users, key] = await store.reads([['PRAGMA table_info(tasks)'], ['SELECT COUNT(*) AS c FROM users'], ["SELECT v FROM meta WHERE k = 'signing_key'"]]);
  // upgrade databases made by older versions (adds milestone and completion date to tasks)
  const names = cols.map(c => c.name), up = [];
  if (!names.includes('milestone')) up.push(["ALTER TABLE tasks ADD COLUMN milestone TEXT DEFAULT ''"]);
  if (!names.includes('completed_at')) up.push(["ALTER TABLE tasks ADD COLUMN completed_at TEXT DEFAULT ''"], ["UPDATE tasks SET completed_at = due WHERE status = 'Completed'"]); // old completed tasks count as on time
  if (up.length) await store.batch(up);
  if (!Number(users[0].c)) {
    try { await store.batch(seedStatements()); }
    catch (e) { const again = await store.all('SELECT COUNT(*) AS c FROM users'); if (!Number(again[0].c)) throw e; } // another instance seeded first
  }
  info.secret = key[0].v;
}
let starting = null;
function ready() { return starting || (starting = setup().catch(e => { starting = null; throw e; })); }

async function reset() {
  await ready();
  await store.batch([...TABLES.map(t => ['DROP TABLE IF EXISTS ' + t]), ...SCHEMA.map(s => [s]), ...seedStatements()]);
}

module.exports = { store, ready, reset, hash, check, info };

if (require.main === module && process.argv.includes('--reset')) {
  reset().then(() => { console.log('Database reset with sample data (' + info.kind + ').'); store.close(); })
    .catch(e => { console.error('Reset failed:', e.message); process.exit(1); });
}
