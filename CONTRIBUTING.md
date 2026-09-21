# Contributing

## Before you write code

1. Pick an issue from the **To do** column of the project board.
2. Assign it to yourself and move it to **In progress**. If it is not assigned to
   you, it is not yours — ask in the group chat first.
3. Branch from a fresh `main`.

## While you work

- Keep the branch small. One issue, one branch, under 400 changed lines.
- Commit in Conventional Commits style: `feat(notifications): add bell icon`.
- Pull `main` into your branch each morning so conflicts stay small.

## When you are done

1. Push your branch and open a pull request against `main`.
2. Fill in the template. Write `Closes #14` so the issue closes on merge.
3. Attach screenshots for anything visual.
4. Wait for CI to pass, then request your pair's review (see `docs/TEAM.md`).
5. Merge with **Squash and merge**, then delete the branch.

## Reviewing

Aim to review within a working day. A blocked teammate is worse than a slightly
imperfect merge. When you review:

- Does it do what the issue asked?
- Does it match the API contract?
- Will it break anyone else's area?
- Are there obvious errors left unhandled?

Say what you like as well as what needs changing. Approve if it is good enough to
build on, and leave style nitpicks as non-blocking comments.

## Things that need a conversation, not a pull request

- Changing `contracts/openapi.yaml` — ask Bell.
- Adding a dependency — mention it in the group chat first.
- Changing a shared component in `frontend/src/components` — that is Prism's area.
- Changing the deploy or CI configuration — that is Warden's area.
- Any change to the database schema — Bell runs the migration.

## Definition of done

- The code works locally.
- CI is green.
- The pull request is approved and merged.
- The issue is closed and the card is in **Done**.
