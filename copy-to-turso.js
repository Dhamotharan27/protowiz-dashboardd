// Copy your existing local data (protowiz.db) into the Turso database used on Vercel.
// 1. Put TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in .env (in Vercel: Storage > your database > .env.local tab,
//    or run `npx vercel env pull .env`)
// 2. npm install
// 3. node copy-to-turso.js                 (copies ./protowiz.db)
//    node copy-to-turso.js path/to/file.db
// Everything currently in Turso (projects, tasks, users...) is REPLACED by the local data.
const fs = require('fs'), path = require('path'), readline = require('readline');
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach(l => {
    const m = l.match(/^\s*([A-Za-z_]\w*)\s*=\s*"?(.*?)"?\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  });
} catch (e) { /* no .env */ }
const src = path.resolve(process.argv[2] || path.join(__dirname, 'protowiz.db'));
if (!process.env.TURSO_DATABASE_URL) { console.log('Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN first (see the top of this file).'); process.exit(1); }
if (!fs.existsSync(src)) { console.log('Local database not found:', src); process.exit(1); }

const { DatabaseSync } = require('node:sqlite');
const local = new DatabaseSync(src, { readOnly: true });
const { store, ready } = require('./db');
const TABLES = ['users', 'projects', 'tasks', 'deps', 'failures', 'tests', 'delivery', 'updates', 'activity'];

(async () => {
  const have = new Set(local.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name));
  const data = {};
  for (const t of TABLES) data[t] = have.has(t) ? local.prepare(`SELECT * FROM ${t}`).all().map(r => ({ ...r })) : [];
  data.tasks.forEach(t => { // older versions had no milestone / completion date
    if (t.milestone == null) t.milestone = '';
    if (t.completed_at == null) t.completed_at = t.status === 'Completed' ? t.due : '';
  });
  if (!data.users.some(u => u.role === 'Manager')) { console.log('The local database has no Manager account, nothing copied.'); process.exit(1); }
  console.log('Local data:', TABLES.map(t => `${t} ${data[t].length}`).join(', '));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = process.argv.includes('--yes') ? 'yes' : await new Promise(r => rl.question(`Replace ALL data in ${process.env.TURSO_DATABASE_URL} with this? Type yes: `, r));
  rl.close();
  if (ans.trim().toLowerCase() !== 'yes') { console.log('Cancelled.'); process.exit(0); }
  await ready(); // creates the tables in Turso if needed
  const stmts = [...[...TABLES].reverse().map(t => [`DELETE FROM ${t}`])];
  for (const t of TABLES) for (const row of data[t]) {
    const cols = Object.keys(row);
    stmts.push([`INSERT INTO ${t}(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, cols.map(c => typeof row[c] === 'bigint' ? Number(row[c]) : row[c])]);
  }
  await store.batch(stmts); // all or nothing
  console.log(`Done. Copied ${stmts.length - TABLES.length} rows to Turso. Users keep their current passwords.`);
  store.close();
})().catch(e => { console.error('Copy failed, Turso was not changed:', e.message); process.exit(1); });
