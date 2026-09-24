# Working on your tasks in VS Code

Everything here is the same loop as `docs/BRANCHING.md` — this just shows where
the buttons are. Follow it and you will not step on anyone else's work.

---

## One-time setup

**1. Install the tools** (PowerShell):

```powershell
winget install --id Git.Git -e
winget install --id GitHub.cli -e
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Microsoft.VisualStudioCode -e
```

**Close PowerShell and open a new window afterwards.** Windows only picks up
newly installed commands in a fresh window — this catches almost everyone.

**2. Tell Git who you are:**

```powershell
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
git config --global core.editor notepad
```

Use the same email as your GitHub account, or your commits will not be linked
to your profile. The `core.editor` line saves you from being trapped in Vim
when Git asks for a merge message.

**3. Sign in to GitHub:**

```powershell
gh auth login
```

Answer: GitHub.com → HTTPS → Yes → Login with a web browser.

**4. Clone the repository and open it:**

```powershell
cd $HOME\Documents
git clone https://github.com/TK87tech/notify-hub.git
cd notify-hub
code .
```

**5. Install the recommended extensions.** VS Code will show a notification
offering them — click **Install**. If you miss it, open the Extensions panel
(`Ctrl+Shift+X`), type `@recommended`, and install them all.

**6. Install the dependencies for your area:**

```powershell
cd backend        # or: cd frontend
npm install
Copy-Item .env.example .env
```

Backend people: `.env` must be in `backend/`, not the project root, and you
need Postgres running — `docker compose up -d` from the project root.

---

## The daily loop

### 1. Pick your issue

Open the [project board](https://github.com/TK87tech/notify-hub/projects).
Find an issue with your `owner:` label. Assign it to yourself and move it to
**In progress**.

Every issue has a "Done when" checklist. That is what finished means — no
guessing.

### 2. Start from a fresh `main`

In VS Code's terminal (`` Ctrl+` ``):

```powershell
git switch main
git pull origin main
```

**Do this every morning.** Starting from stale code is how conflicts happen.

### 3. Switch to your branch

Every issue already has a branch waiting — they were all created up front.
Click the **branch name in the bottom-left status bar**, and pick yours from
the list (for example `feat/pulse/notification-bell`).

Or in the terminal:

```powershell
git switch feat/pulse/notification-bell
git merge origin/main
```

That `merge` brings your branch up to date with whatever has landed since.

> **Use `git switch`, never `git checkout -b`.** The branch already exists, so
> `checkout -b` fails — and it fails *quietly* in a pasted block, leaving you
> committing to `main` by accident. That cost us an hour on day one.

### 4. Write the code

Normal VS Code. A few things worth knowing:

- `` Ctrl+` `` opens the terminal. Run `npm run dev` there and leave it running.
- Save often. Prettier formats on save, so don't fight the formatting.
- The Vitest extension puts a ▶ next to each test — click it to run just that one.
- `Ctrl+P` then a filename jumps straight to it.

### 5. Commit

Open the **Source Control** panel (`Ctrl+Shift+G`, or the branch icon in the
left sidebar). You will see your changed files.

1. **Review each change first.** Click a file to see what you actually changed.
   Thirty seconds here catches most accidents.
2. **Stage them** — hover a file and click **+**, or click **+** on "Changes"
   to stage everything.
3. **Write the message** in the box at the top, then press `Ctrl+Enter`.

Message format:

```
feat(notifications): add bell icon with unread badge
fix(queue): retry failed email jobs with backoff
chore(ci): cache node modules
docs(contract): document the read event
test(api): cover the expired-token case
```

Type is one of `feat`, `fix`, `chore`, `docs`, `test`. Scope is the area.
Commit small and often — several small commits are much easier to review than
one enormous one.

### 6. Push

Click **Sync Changes** in the Source Control panel, or the ↻ in the status bar.

First push of a branch, use the terminal instead, so the branch tracks itself
correctly:

```powershell
git push -u origin feat/pulse/notification-bell
```

After that, the Sync button works normally.

### 7. Open the pull request

With the GitHub Pull Requests extension: the **GitHub** icon in the left
sidebar → **Create Pull Request**. Base is `main`.

Or in the terminal:

```powershell
gh pr create --fill --base main
```

Then — and this matters — **edit the description to say `Closes #14`**, using
your issue's number. That closes the issue and moves its board card to Done
automatically when the PR merges. Without it, someone has to tidy up by hand.

Add screenshots for anything visual, so it can be reviewed without pulling
your branch.

### 8. Get it reviewed

Request your pair (see `docs/TEAM.md`). A message in the group chat gets a
faster response than the GitHub notification will.

Wait for CI to go green. If it is red, read the log before asking — the error
is usually the answer.

### 9. Merge and clean up

Once approved, **Squash and merge** on GitHub, then:

```powershell
git switch main
git pull origin main
```

Your branch is deleted automatically. Move to the next issue.

---

## Things that will bite you

**"fatal: not a git repository"**
You are in the wrong folder. `cd` into `notify-hub` first.

**You committed to `main` by mistake**
Not a disaster. Move the commit to where it belongs:

```powershell
git branch -f your-branch-name HEAD
git reset --hard origin/main
git switch your-branch-name
```

**"Everything up-to-date" but nothing appeared on GitHub**
Your commit did not happen. Check `git status`.

**A file you edited is not in Source Control**
It is gitignored — `.env`, `node_modules`, `dist`. That is intentional.
**Never force-add `.env`.** It holds secrets.

**Merge conflicts**
VS Code shows them inline with "Accept Current" / "Accept Incoming" buttons.
For `package-lock.json`, do not hand-merge — delete it and run `npm install`,
then stage the fresh one.

**CI passes suspiciously fast**
A job that finishes in under 10 seconds probably skipped rather than ran.
Check the step list before trusting a green tick.

---

## Terminal or buttons?

Either. The Source Control panel is fine for staging, committing and pushing,
and it is easier to review your own changes there.

Four things are worth doing in the terminal because the UI hides what is
happening: `git switch` to change branch, `git merge origin/main` to update,
`git push -u` on a branch's first push, and anything that has gone wrong.
