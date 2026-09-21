#!/usr/bin/env bash
#
# One-time GitHub setup for NotifyHub.
#
# Creates: the repository, labels, milestones, the issue set, a Project board with
# the issues on it, branch protection on main, and a starter branch per issue.
#
# Requirements:
#   - gh CLI installed and signed in:  gh auth login
#   - the project scope:               gh auth refresh -s project,repo,workflow
#   - jq installed
#
# Usage, from the repository root:
#   ./scripts/setup-github.sh <github-owner> [repo-name] [public|private]
#
# Example:
#   ./scripts/setup-github.sh TK87tech notify-hub public
#
set -euo pipefail

OWNER="${1:-}"
REPO="${2:-notify-hub}"
VISIBILITY="${3:-public}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ISSUES_FILE="$SCRIPT_DIR/issues.json"

if [[ -z "$OWNER" ]]; then
  echo "Usage: $0 <github-owner> [repo-name] [public|private]" >&2
  exit 1
fi

for cmd in gh jq git; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing required command: $cmd" >&2; exit 1; }
done

if [[ ! -f "$ISSUES_FILE" ]]; then
  echo "Cannot find $ISSUES_FILE" >&2
  exit 1
fi

gh auth status >/dev/null 2>&1 || { echo "Run 'gh auth login' first." >&2; exit 1; }

SLUG="$OWNER/$REPO"
say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
note() { printf '    %s\n' "$1"; }

# ----------------------------------------------------------------------------
say "1/8  Repository"
# ----------------------------------------------------------------------------
if gh repo view "$SLUG" >/dev/null 2>&1; then
  note "$SLUG already exists — using it."
else
  gh repo create "$SLUG" "--$VISIBILITY" \
    --description "Notification queue system — team project" \
    --disable-wiki
  note "Created $SLUG"
fi

if [[ ! -d .git ]]; then
  git init -b main
fi
git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$SLUG.git"

# ----------------------------------------------------------------------------
say "2/8  First push to main"
# ----------------------------------------------------------------------------
git add -A
if git diff --cached --quiet && git rev-parse HEAD >/dev/null 2>&1; then
  note "Nothing new to commit."
else
  git commit -m "chore: project scaffolding, API contract and team docs" \
    -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>" || true
fi
git branch -M main
git push -u origin main
note "Pushed main."

# ----------------------------------------------------------------------------
say "3/8  Labels"
# ----------------------------------------------------------------------------
add_label() {  # name colour description
  gh label create "$1" --repo "$SLUG" --color "$2" --description "$3" --force >/dev/null
  note "label: $1"
}
add_label "owner:bell"    "5319E7" "Bell — backend lead: API, database, contract"
add_label "owner:relay"   "0E8A16" "Relay — backend: queue, workers, realtime"
add_label "owner:ember"   "006B75" "Ember — backend: email, push, preferences"
add_label "owner:pulse"   "1D76DB" "Pulse — frontend: bell, panel, toasts, API client"
add_label "owner:beacon"  "FBCA04" "Beacon — frontend: preferences, notifications page"
add_label "owner:prism"   "D93F0B" "Prism — frontend: template, shell, shared components"
add_label "owner:warden"  "5D4037" "Warden — DevOps and QA: CI, deploys, testing"
add_label "area:backend"  "C2E0C6" "Backend work"
add_label "area:frontend" "BFD4F2" "Frontend work"
add_label "area:infra"    "F9D0C4" "CI, deployment, monitoring"
add_label "area:all"      "EDEDED" "Everyone involved"
add_label "phase:plan"    "D4C5F9" "Stages 1-3"
add_label "phase:build"   "C5DEF5" "Stages 4-7"
add_label "phase:launch"  "C2E0C6" "Stages 8-11"
add_label "blocked"       "B60205" "Waiting on something else"

# ----------------------------------------------------------------------------
say "4/8  Milestones"
# ----------------------------------------------------------------------------
create_milestone() {  # title description
  if gh api "repos/$SLUG/milestones" --jq '.[].title' | grep -qxF "$1"; then
    note "milestone exists: $1"
  else
    gh api "repos/$SLUG/milestones" -f title="$1" -f description="$2" >/dev/null
    note "milestone: $1"
  fi
}
create_milestone "Phase 1 - Plan"   "Stages 1-3: requirements, UX design, architecture and API contract"
create_milestone "Phase 2 - Build"  "Stages 4-7: backend core, queue, channels, frontend"
create_milestone "Phase 3 - Launch" "Stages 8-11: integration, testing, deployment, iteration"

milestone_number() {
  gh api "repos/$SLUG/milestones" --jq ".[] | select(.title==\"$1\") | .number"
}
MS_PLAN=$(milestone_number "Phase 1 - Plan")
MS_BUILD=$(milestone_number "Phase 2 - Build")
MS_LAUNCH=$(milestone_number "Phase 3 - Launch")

# ----------------------------------------------------------------------------
say "5/8  Project board"
# ----------------------------------------------------------------------------
PROJECT_TITLE="NotifyHub Build"
PROJECT_NUMBER=""
if gh project list --owner "$OWNER" --format json >/dev/null 2>&1; then
  PROJECT_NUMBER=$(gh project list --owner "$OWNER" --format json \
    | jq -r --arg t "$PROJECT_TITLE" '.projects[]? | select(.title==$t) | .number' | head -1)
  if [[ -z "$PROJECT_NUMBER" ]]; then
    PROJECT_NUMBER=$(gh project create --owner "$OWNER" --title "$PROJECT_TITLE" --format json | jq -r '.number')
    note "Created project #$PROJECT_NUMBER"
  else
    note "Project #$PROJECT_NUMBER already exists."
  fi
else
  note "No project scope on this token."
  note "Run: gh auth refresh -s project,repo,workflow   then re-run this script."
  note "Continuing without the board — issues will still be created."
fi

# ----------------------------------------------------------------------------
say "6/8  Issues"
# ----------------------------------------------------------------------------
COUNT=$(jq 'length' "$ISSUES_FILE")
note "Creating $COUNT issues..."

for i in $(seq 0 $((COUNT - 1))); do
  TITLE=$(jq -r ".[$i].title"  "$ISSUES_FILE")
  BODY=$(jq -r  ".[$i].body"   "$ISSUES_FILE")
  OWNER_LABEL="owner:$(jq -r ".[$i].owner" "$ISSUES_FILE")"
  AREA_LABEL="area:$(jq -r ".[$i].area"   "$ISSUES_FILE")"
  PHASE=$(jq -r ".[$i].phase" "$ISSUES_FILE")

  case "$PHASE" in
    Plan)   PHASE_LABEL="phase:plan";   MS="$MS_PLAN" ;;
    Build)  PHASE_LABEL="phase:build";  MS="$MS_BUILD" ;;
    *)      PHASE_LABEL="phase:launch"; MS="$MS_LAUNCH" ;;
  esac

  if gh issue list --repo "$SLUG" --state all --limit 200 --json title --jq '.[].title' \
       | grep -qxF "$TITLE"; then
    note "exists: $TITLE"
    continue
  fi

  URL=$(gh issue create --repo "$SLUG" \
    --title "$TITLE" \
    --body "$BODY" \
    --label "$OWNER_LABEL" \
    --label "$AREA_LABEL" \
    --label "$PHASE_LABEL" \
    --milestone "$(gh api "repos/$SLUG/milestones/$MS" --jq .title)")

  note "created: $TITLE"

  if [[ -n "$PROJECT_NUMBER" ]]; then
    gh project item-add "$PROJECT_NUMBER" --owner "$OWNER" --url "$URL" >/dev/null 2>&1 \
      || note "  (could not add to board — add it by hand)"
  fi
done

# ----------------------------------------------------------------------------
say "7/8  Protect main"
# ----------------------------------------------------------------------------
if gh api -X PUT "repos/$SLUG/branches/main/protection" \
  -H "Accept: application/vnd.github+json" \
  --input - >/dev/null 2>&1 <<'JSON'
{
  "required_status_checks": null,
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_linear_history": true
}
JSON
then
  note "main now requires a pull request with 1 approval."
else
  note "Could not set branch protection automatically."
  note "On a FREE plan this works on PUBLIC repos only."
  note "Set it by hand: Settings -> Branches -> Add rule -> main"
  note "  [x] Require a pull request before merging  (1 approval)"
  note "  [x] Do not allow force pushes"
fi

# Nice defaults: squash-only merges, auto-delete merged branches
gh api -X PATCH "repos/$SLUG" \
  -F allow_squash_merge=true -F allow_merge_commit=false \
  -F allow_rebase_merge=false -F delete_branch_on_merge=true >/dev/null 2>&1 \
  && note "Squash merges only; branches auto-delete after merge."

# ----------------------------------------------------------------------------
say "8/8  Starter branches"
# ----------------------------------------------------------------------------
git fetch origin main --quiet
for i in $(seq 0 $((COUNT - 1))); do
  BRANCH=$(jq -r ".[$i].branch // empty" "$ISSUES_FILE")
  [[ -z "$BRANCH" ]] && continue
  if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
    note "exists: $BRANCH"
  else
    git branch "$BRANCH" origin/main 2>/dev/null || true
    git push origin "$BRANCH":"$BRANCH" --quiet
    note "branch: $BRANCH"
  fi
done
git checkout main --quiet

# ----------------------------------------------------------------------------
say "Done"
# ----------------------------------------------------------------------------
cat <<EOF

  Repository:  https://github.com/$SLUG
  Issues:      https://github.com/$SLUG/issues
  Board:       https://github.com/$OWNER?tab=projects

  Next, by hand (two minutes):

  1. Invite the other six: Settings -> Collaborators -> Add people
  2. Edit .github/CODEOWNERS and replace the placeholder usernames
  3. On the board, add a Status field with columns:
       To do | In progress | In review | Done
     then set every card to "To do"
  4. Each person: read docs/TEAM.md, find your code name, pick your first issue

EOF
