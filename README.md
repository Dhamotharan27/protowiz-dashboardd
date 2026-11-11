# iBots Project Management (Protowiz)

Project-wise task assignment, dependency, failure, testing and delivery tracking.
Blue and white dashboard with login. Needs only Node.js. No npm install, nothing to compile.
Runs on your own computer, or online on Vercel (see "Deploy on Vercel" below).

## Easiest: double-click
- Windows: double-click `start.bat` (starts the server and opens the dashboard in your browser)
- Mac / Linux: run `./start.sh`
- To start automatically every time you log in to Windows: double-click `autostart-on.bat` (turn off with `autostart-off.bat`)

## Run manually (Windows, Mac, Linux)
1. Install Node.js 22.13 or newer (Node 24 is fine): https://nodejs.org
2. Open a terminal in this folder
3. (Optional) copy `.env.example` to `.env` and change JWT_SECRET and PORT
4. Run:

    node server.js

   or `npm start`
5. Open http://localhost:3000

Login: `dhamotharan` / `demo1234` (Manager)
Other users, same password: ravi (Employee), suresh (Lead), priya, vikram, arun

## Check everything works
    npm test
Runs 88 automated checks on a temporary database. Your data is not touched.
`npm run test:turso` runs the same checks through the Turso driver used on Vercel (run `npm install` first).

## Deploy on Vercel
Vercel cannot keep a database file between requests, so online the data lives in **Turso** (hosted SQLite,
free tier, one click from Vercel). Same tables and rules as the local version.

1. Put this folder in a GitHub repository (or deploy from a terminal with `npx vercel`).
2. In Vercel: **Add New > Project**, import the repository. Framework Preset: **Other**. Leave the build
   settings empty; `vercel.json` already sets everything.
3. Open the project's **Storage** tab > **Create Database** > **Turso** > connect it to this project
   (all environments). This adds `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` for you.
4. **Settings > Environment Variables**, add:
   - `SEED_PASSWORD`: the password the sample accounts get when the empty database is first filled.
     Without it they use `demo1234`, which anyone reading this file knows.
   - `JWT_SECRET` (optional): a long random string. If you skip it, a random key is created and kept in the database.
5. **Deployments > ... > Redeploy** so the new settings are used.
6. Check the live site from any computer with Node.js:

       node smoke-test.js https://your-app.vercel.app dhamotharan YOUR_SEED_PASSWORD

   It logs in, creates a temporary project with tasks, a dependency, failure, test and delivery, checks the
   rules, then deletes it again. Every line should say `ok`.
7. Log in, change the sample users' passwords (Users > Edit) or delete the sample data you do not need.

If the site shows a yellow "Demo storage" bar, Turso is not connected yet: do steps 3 and 5.

Moving data you already have on a computer: put the Turso values in `.env` (Vercel > Storage > your
database shows them, or run `npx vercel env pull .env`), run `npm install`, then `node copy-to-turso.js`.
`node make-manager.js` also works against Turso this way, if you ever lock yourself out.

## Reset to sample data
    npm run seed
(or Settings > Reset Sample Data inside the app)

## Files
- start.bat / start.sh : one-click start
- autostart-on.bat / autostart-off.bat : start with Windows
- server.js  : web server and API, login, rules
- db.js      : database: local SQLite file (built into Node) or Turso on Vercel; tables and sample data
- public/index.html : the dashboard
- api/index.mjs, vercel.json, .vercelignore : Vercel setup (the API runs as one Vercel Function)
- test.js    : automated tests
- smoke-test.js : checks a live deployment
- copy-to-turso.js : copies a local protowiz.db into Turso
- make-manager.js : change a user's role without logging in
- protowiz.db : created automatically on first run (your data lives here, back it up)

## Dashboard counts
Period buttons (This Week, This Month, Last 30 Days, All Time, or your own From and To dates) and a search box.
Cards: Total Projects, Total Tasks, Milestones, Deadlines, Completed On Time, Delayed Tasks, Dependencies,
Overdue Now, Blocked Tasks, Due in 7 Days, Milestones Done. The table shows Project, Task, Milestone, Deadline and Delay.
- Counts use each item's deadline date inside the period
- Delayed = overdue, or finished after its deadline
- A milestone is a group of tasks with the same milestone name in a project; it is Done when all its tasks are Completed
- The completion date is saved automatically when a task is marked Completed (old completed tasks count as on time)

## Screens
Dashboard, Projects (with project page and tabs), Tasks (with task page), Dependencies,
Failures, Testing, Delivery, Reports, Users, Settings.

## Rules built in
- A task cannot start, be tested or be completed until the tasks it depends on are Completed
- Circular and duplicate dependencies are refused
- Completing a task sets progress to 100 and updates the project progress
- Manager and Lead: add, edit, delete everything, manage users, close failures
- Employee: can see the Users list (read only), add projects, add and assign tasks, report failures, and update their own tasks (status, progress, daily updates). Cannot edit or delete projects, manage users, or close failures
- At least one Manager always remains; you cannot delete your own account
- Renaming a person updates their projects, tasks and failures
- Deleting a project or task removes its dependencies, failures and updates

## Notes
- Passwords are stored hashed (scrypt). Login sessions last 12 hours.
- Completion dates use the date on the user's own computer (Vercel servers run on UTC time).
- To use on a company network, run it on a server, set a long JWT_SECRET, and put it behind HTTPS.
  Vercel gives you HTTPS automatically.
