# Branching and daily workflow

The whole point: five people commit every day and nobody breaks anyone else's work.

## The rules

1. **`main` is always working.** Nobody pushes to it directly — GitHub will refuse.
2. **One branch per issue.** The branch is deleted after it merges.
3. **A pull request is the only way into `main`,** and it needs one approval.
4. **Branches live for days, not weeks.** A branch older than a week will be
   painful to merge. Split the issue instead.
5. **Pull from `main` every morning** before you start typing.

## Branch naming

```
<type>/<code-name>/<short-description>
```

`<type>` is one of `feat`, `fix`, `chore`, `docs`, `test`.

Real examples for this project:

```
feat/bell/producer-api
feat/relay/queue-worker-retries
feat/ember/email-channel
feat/pulse/notification-bell
feat/beacon/preferences-page
feat/prism/ui-template
chore/warden/ci-pipeline
fix/pulse/toast-stacking-overlap
```

Seeing the code name in the branch means anyone can tell at a glance whose work
it is, and `git branch -a` reads like the team board.

## The loop, every single time

```bash
# 1. Start from a fresh main
git checkout main
git pull origin main

# 2. Branch for the issue you picked up
git checkout -b feat/pulse/notification-bell

# 3. Work. Commit small and often.
git add .
git commit -m "feat(notifications): add bell icon with unread badge"

# 4. Push your branch
git push -u origin feat/pulse/notification-bell

# 5. Open the pull request (gh CLI, or the button GitHub shows you)
gh pr create --fill --base main

# 6. After it is approved and merged, clean up
git checkout main
git pull origin main
git branch -d feat/pulse/notification-bell
```

## Keeping a long branch fresh

If your branch has been open a couple of days and `main` has moved:

```bash
git checkout main
git pull origin main
git checkout feat/pulse/notification-bell
git merge main          # resolve conflicts here, in your own branch
git push
```

Always resolve conflicts on your branch, never in `main`. If the merge goes
badly, your branch is the only thing at risk.

## Commit messages

We use Conventional Commits, because it is a small habit that makes the history
readable and lets us generate a changelog later.

```
feat(notifications): add bell icon with unread badge
fix(queue): retry failed email jobs with exponential backoff
chore(ci): cache node modules in the test workflow
docs(contract): document the notification:read event
design(panel): add empty and error states
```

Scope is the area: `notifications`, `preferences`, `queue`, `api`, `db`, `ci`.

## Avoiding merge conflicts in the first place

Conflicts happen when two people edit the same lines. The folder split in
`docs/TEAM.md` is designed so that rarely happens. Beyond that:

- **Never reformat a file you are not working on.** A stray formatter run touching
  200 files is the most common cause of a painful conflict.
- **Lockfiles** (`package-lock.json`): if it conflicts, don't hand-edit it. Take
  `main`'s version and re-run `npm install`:
  ```bash
  git checkout --theirs package-lock.json && npm install && git add package-lock.json
  ```
- **The API contract** (`contracts/openapi.yaml`) is edited by Bell only. Anyone
  else needing a change asks in the pull request, and Bell makes it.
- **Shared components** (`frontend/src/components`) are Prism's. Need a change?
  Ask Prism in the pull request rather than editing them yourself.
- **Never edit a `src/components/ui/` file** that the template generated, unless
  you are Prism. Wrap it in your own component instead.

## What a good pull request looks like

- Title reads like a commit message: `feat(notifications): add bell icon`.
- The description says `Closes #14`, so merging closes the issue automatically.
- Under 400 changed lines. Bigger than that, split it.
- Screenshots for anything visual, so Prism can review without pulling the branch.
- CI is green before you ask for a review.
