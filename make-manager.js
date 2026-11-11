// Fix a user's role without logging in. Works on the local database file, or on Turso when
// TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are set (for example after `vercel env pull .env`).
//   node make-manager.js                 -> shows all users and their roles
//   node make-manager.js Dhamotharan     -> makes that user a Manager
//   node make-manager.js sathya Lead     -> sets another role (Manager, Lead or Employee)
const fs = require('fs'), path = require('path');
try { // load .env like the server does
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach(l => {
    const m = l.match(/^\s*([A-Za-z_]\w*)\s*=\s*"?(.*?)"?\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  });
} catch (e) { /* no .env */ }
const { store, ready, info } = require('./db');
const [name, role = 'Manager'] = process.argv.slice(2);
(async () => {
  await ready();
  if (!name) {
    console.log(`Users in this database (${info.kind}):`);
    (await store.all('SELECT id, name, email, role FROM users ORDER BY id')).forEach(u => console.log(`  ${u.id}  ${u.name}  (login: ${u.email})  role: ${u.role}`));
    console.log('\nTo change a role: node make-manager.js "Name" Manager');
  } else if (!['Manager', 'Lead', 'Employee'].includes(role)) {
    console.log('Role must be Manager, Lead or Employee');
  } else {
    const hit = await store.all('SELECT id FROM users WHERE lower(name) = lower(?) OR lower(email) = lower(?)', [name, name]);
    if (!hit.length) console.log(`No user found with the name or login "${name}". Run: node make-manager.js`);
    else { await store.batch([['UPDATE users SET role = ? WHERE id = ?', [role, hit[0].id]]]); console.log(`Done. ${name} is now ${role}. Logout and login again in the browser.`); }
  }
  store.close();
})().catch(e => { console.error(e.message); process.exit(1); });
