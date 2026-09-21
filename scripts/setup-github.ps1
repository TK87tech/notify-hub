<#
    One-time GitHub setup for NotifyHub - Windows PowerShell version.

    This file is deliberately plain ASCII. Windows PowerShell 5.1 reads .ps1
    files as ANSI unless they have a byte-order mark, so accented characters,
    dashes and arrows get mangled and break the parser. Keep it ASCII.

    Creates: the repository, labels, milestones, every issue, a Project board
    with the issues on it, branch protection on main, and a starter branch
    per issue.

    Requirements (install once - see docs/WINDOWS-SETUP.md):
      winget install --id Git.Git -e
      winget install --id GitHub.cli -e
      gh auth login
      gh auth refresh -s project,repo,workflow

    Usage, from the repository root, in PowerShell:
      .\scripts\setup-github.ps1 -Owner TK87tech
      .\scripts\setup-github.ps1 -Owner TK87tech -Repo notify-hub -Visibility public

    If PowerShell refuses to run the script, allow local scripts for this
    session only:
      Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Owner,

    [string]$Repo = "notify-hub",

    [ValidateSet("public", "private")]
    [string]$Visibility = "public"
)

# Deliberately NOT "Stop". Tools like gh write ordinary progress and "not
# found" messages to stderr, and with Stop PowerShell turns those into fatal
# errors. Every step below checks its own exit code instead.
$ErrorActionPreference = "Continue"
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
}

function Invoke-Quiet {
    # Run a native command, swallow all its output, return its exit code.
    # No param() block on purpose: a declared parameter would swallow flags
    # like -F or -X that we need to pass through to git and gh untouched.
    if ($args.Count -eq 0) { return 1 }
    $exe  = $args[0]
    $rest = @()
    if ($args.Count -gt 1) { $rest = $args[1..($args.Count - 1)] }
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $exe @rest 2>&1 | Out-Null
        return $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
    }
}

function Invoke-Capture {
    # Run a native command and return its stdout as a single string.
    # Stderr is discarded. $global:LastCode holds the exit code.
    # No param() block, for the same reason as Invoke-Quiet above.
    if ($args.Count -eq 0) { $global:LastCode = 1; return "" }
    $exe  = $args[0]
    $rest = @()
    if ($args.Count -gt 1) { $rest = $args[1..($args.Count - 1)] }
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $out = & $exe @rest 2>$null
        $global:LastCode = $LASTEXITCODE
        if ($null -eq $out) { return "" }
        return ($out | Out-String).Trim()
    } finally {
        $ErrorActionPreference = $prev
    }
}

function Say  { param([string]$m) Write-Host ""; Write-Host "==> $m" -ForegroundColor Cyan }
function Note { param([string]$m) Write-Host "    $m" -ForegroundColor Gray }
function Warn { param([string]$m) Write-Host "    $m" -ForegroundColor Yellow }

function Write-Utf8NoBom {
    param([string]$Path, [string]$Text)
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text, $enc)
}

# ---------------------------------------------------------------- checks ----
if (-not (Get-Command "git" -ErrorAction SilentlyContinue)) {
    Write-Host "Missing required command: git" -ForegroundColor Red
    Write-Host "Install it with:  winget install --id Git.Git -e" -ForegroundColor Red
    Write-Host "Then close this window, open a NEW PowerShell, and run this again." -ForegroundColor Red
    exit 1
}
if (-not (Get-Command "gh" -ErrorAction SilentlyContinue)) {
    Write-Host "Missing required command: gh" -ForegroundColor Red
    Write-Host "Install it with:  winget install --id GitHub.cli -e" -ForegroundColor Red
    Write-Host "Then close this window, open a NEW PowerShell, and run this again." -ForegroundColor Red
    exit 1
}

if ((Invoke-Quiet gh auth status) -ne 0) {
    Write-Host "You are not signed in. Run:  gh auth login" -ForegroundColor Red
    exit 1
}

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$IssuesFile = Join-Path $ScriptDir "issues.json"
if (-not (Test-Path $IssuesFile)) {
    Write-Host "Cannot find $IssuesFile" -ForegroundColor Red
    exit 1
}

$Issues = Get-Content $IssuesFile -Raw -Encoding UTF8 | ConvertFrom-Json
$Slug   = "$Owner/$Repo"

# ------------------------------------------------------------ 1  repo ------
Say "1/8  Repository"
if ((Invoke-Quiet gh repo view $Slug) -eq 0) {
    Note "$Slug already exists - using it."
} else {
    Note "Not found, so creating it..."
    $code = Invoke-Quiet gh repo create $Slug "--$Visibility" --description "Notification queue system - team project" --disable-wiki
    if ($code -ne 0) {
        Write-Host "Could not create $Slug." -ForegroundColor Red
        Write-Host "Check the name is free and that you have permission on that account." -ForegroundColor Red
        exit 1
    }
    Note "Created $Slug"
}

if (-not (Test-Path ".git")) { Invoke-Quiet git init -b main | Out-Null }
if ((Invoke-Quiet git remote get-url origin) -ne 0) {
    Invoke-Quiet git remote add origin "https://github.com/$Slug.git" | Out-Null
}

# ------------------------------------------------------------ 2  push ------
Say "2/8  First push to main"
Invoke-Quiet git add -A | Out-Null
if ((Invoke-Quiet git diff --cached --quiet) -ne 0) {
    # The commit message goes through a file. It contains angle brackets, and
    # PowerShell reserves those characters on the command line.
    $msgFile = [System.IO.Path]::GetTempFileName()
    $lines = @(
        "chore: project scaffolding, API contract and team docs",
        "",
        "Co-Authored-By: Claude Opus 5 " + [char]60 + "noreply@anthropic.com" + [char]62
    )
    Write-Utf8NoBom -Path $msgFile -Text ($lines -join "`n")
    $code = Invoke-Quiet git commit -F $msgFile
    Remove-Item $msgFile -Force -ErrorAction SilentlyContinue
    if ($code -ne 0) {
        Write-Host "git commit failed. Have you set your identity?" -ForegroundColor Red
        Write-Host '  git config --global user.name "Your Name"' -ForegroundColor Red
        Write-Host '  git config --global user.email "you@example.com"' -ForegroundColor Red
        exit 1
    }
    Note "Committed."
} else {
    Note "Nothing new to commit."
}
Invoke-Quiet git branch -M main | Out-Null
if ((Invoke-Quiet git push -u origin main) -ne 0) {
    Write-Host "Could not push to $Slug." -ForegroundColor Red
    Write-Host "If the repo already had commits, run:  git pull --rebase origin main" -ForegroundColor Red
    exit 1
}
Note "Pushed main."

# ---------------------------------------------------------- 3  labels ------
Say "3/8  Labels"
$labels = @(
    @{ n = "owner:bell";    c = "5319E7"; d = "Bell - backend lead: API, database, contract" },
    @{ n = "owner:relay";   c = "0E8A16"; d = "Relay - backend: queue, workers, realtime" },
    @{ n = "owner:ember";   c = "006B75"; d = "Ember - backend: email, push, preferences" },
    @{ n = "owner:pulse";   c = "1D76DB"; d = "Pulse - frontend: bell, panel, toasts, API client" },
    @{ n = "owner:beacon";  c = "FBCA04"; d = "Beacon - frontend: preferences, notifications, auth" },
    @{ n = "owner:prism";   c = "D93F0B"; d = "Prism - frontend: template, shell, shared components" },
    @{ n = "owner:warden";  c = "5D4037"; d = "Warden - DevOps and QA: CI, deploys, testing" },
    @{ n = "area:backend";  c = "C2E0C6"; d = "Backend work" },
    @{ n = "area:frontend"; c = "BFD4F2"; d = "Frontend work" },
    @{ n = "area:infra";    c = "F9D0C4"; d = "CI, deployment, monitoring" },
    @{ n = "area:all";      c = "EDEDED"; d = "Everyone involved" },
    @{ n = "phase:plan";    c = "D4C5F9"; d = "Stages 1-3" },
    @{ n = "phase:build";   c = "C5DEF5"; d = "Stages 4-7" },
    @{ n = "phase:launch";  c = "C2E0C6"; d = "Stages 8-11" },
    @{ n = "blocked";       c = "B60205"; d = "Waiting on something else" }
)
foreach ($l in $labels) {
    Invoke-Quiet gh label create $l.n --repo $Slug --color $l.c --description $l.d --force | Out-Null
    Note ("label: " + $l.n)
}

# ------------------------------------------------------ 4  milestones ------
Say "4/8  Milestones"
$milestones = @(
    @{ t = "Phase 1 - Plan";   d = "Stages 1-3: requirements, UI template, architecture and API contract" },
    @{ t = "Phase 2 - Build";  d = "Stages 4-7: backend core, queue, channels, frontend" },
    @{ t = "Phase 3 - Launch"; d = "Stages 8-11: integration, testing, deployment, iteration" }
)
$existingMilestones = @()
$msRaw = Invoke-Capture gh api "repos/$Slug/milestones" --jq ".[].title"
if ($global:LastCode -eq 0 -and $msRaw) {
    $existingMilestones = @($msRaw -split "`r?`n" | Where-Object { $_ -ne "" })
}

foreach ($m in $milestones) {
    if ($existingMilestones -contains $m.t) {
        Note ("milestone exists: " + $m.t)
    } else {
        Invoke-Quiet gh api "repos/$Slug/milestones" -f "title=$($m.t)" -f "description=$($m.d)" | Out-Null
        Note ("milestone: " + $m.t)
    }
}

# --------------------------------------------------------- 5  project ------
Say "5/8  Project board"
$ProjectTitle  = "NotifyHub Build"
$ProjectNumber = $null
$projectsJson = Invoke-Capture gh project list --owner $Owner --format json
if ($global:LastCode -eq 0 -and $projectsJson) {
    $found = ($projectsJson | ConvertFrom-Json).projects | Where-Object { $_.title -eq $ProjectTitle } | Select-Object -First 1
    if ($found) {
        $ProjectNumber = $found.number
        Note "Project #$ProjectNumber already exists."
    } else {
        $createdJson = Invoke-Capture gh project create --owner $Owner --title $ProjectTitle --format json
        if ($global:LastCode -eq 0 -and $createdJson) {
            $ProjectNumber = ($createdJson | ConvertFrom-Json).number
            Note "Created project #$ProjectNumber"
        } else {
            Warn "Could not create the board - continuing without it."
        }
    }
} else {
    Warn "No project scope on this token."
    Warn "Run:  gh auth refresh -s project,repo,workflow   then run this script again."
    Warn "Continuing without the board - issues will still be created."
}

# ---------------------------------------------------------- 6  issues ------
Say "6/8  Issues"
Note ("Creating " + $Issues.Count + " issues...")
$created = 0
$failed  = 0
$skipped = 0

$existingTitles = @()
$titlesRaw = Invoke-Capture gh issue list --repo $Slug --state all --limit 300 --json title --jq ".[].title"
if ($global:LastCode -eq 0 -and $titlesRaw) {
    $existingTitles = @($titlesRaw -split "`r?`n" | Where-Object { $_ -ne "" })
}

foreach ($issue in $Issues) {
    if ($existingTitles -contains $issue.title) {
        Note ("exists: " + $issue.title)
        $skipped++
        continue
    }

    if ($issue.phase -eq "Plan") {
        $phaseLabel = "phase:plan"
        $milestone  = "Phase 1 - Plan"
    } elseif ($issue.phase -eq "Build") {
        $phaseLabel = "phase:build"
        $milestone  = "Phase 2 - Build"
    } else {
        $phaseLabel = "phase:launch"
        $milestone  = "Phase 3 - Launch"
    }

    # Issue bodies contain newlines and markdown, so they go through a file.
    $bodyFile = [System.IO.Path]::GetTempFileName()
    Write-Utf8NoBom -Path $bodyFile -Text $issue.body

    $ownerLabel = "owner:" + $issue.owner
    $areaLabel  = "area:"  + $issue.area

    $url = Invoke-Capture gh issue create --repo $Slug --title $issue.title --body-file $bodyFile --label $ownerLabel --label $areaLabel --label $phaseLabel --milestone $milestone
    $createCode = $global:LastCode

    Remove-Item $bodyFile -Force -ErrorAction SilentlyContinue

    if ($createCode -ne 0 -or -not $url) {
        Warn ("FAILED: " + $issue.title)
        $failed++
        continue
    }
    Note ("created: " + $issue.title)
    $created++

    if ($ProjectNumber) {
        if ((Invoke-Quiet gh project item-add $ProjectNumber --owner $Owner --url $url) -ne 0) {
            Warn "  (could not add to board - add it by hand)"
        }
    }
}

# ------------------------------------------------------ 7  protection ------
Say "7/8  Protect main"
$protection = @{
    required_status_checks = $null
    enforce_admins         = $false
    required_pull_request_reviews = @{
        required_approving_review_count = 1
        dismiss_stale_reviews           = $true
        require_code_owner_reviews      = $false
    }
    restrictions            = $null
    allow_force_pushes      = $false
    allow_deletions         = $false
    required_linear_history = $true
} | ConvertTo-Json -Depth 5

$protFile = [System.IO.Path]::GetTempFileName()
Write-Utf8NoBom -Path $protFile -Text $protection
$protOk = ((Invoke-Quiet gh api -X PUT "repos/$Slug/branches/main/protection" -H "Accept: application/vnd.github+json" --input $protFile) -eq 0)
Remove-Item $protFile -Force -ErrorAction SilentlyContinue

if ($protOk) {
    Note "main now requires a pull request with 1 approval."
} else {
    Warn "Could not set branch protection automatically."
    Warn "On a FREE plan this works on PUBLIC repos only."
    Warn "Set it by hand: Settings -> Branches -> Add rule -> main"
    Warn "  [x] Require a pull request before merging  (1 approval)"
    Warn "  [x] Do not allow force pushes"
}

if ((Invoke-Quiet gh api -X PATCH "repos/$Slug" -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false -F delete_branch_on_merge=true) -eq 0) {
    Note "Squash merges only; branches auto-delete after merge."
}

# -------------------------------------------------------- 8  branches ------
Say "8/8  Starter branches"
Invoke-Quiet git fetch origin main --quiet | Out-Null
foreach ($issue in $Issues) {
    if (-not $issue.branch) { continue }
    if ((Invoke-Quiet git ls-remote --exit-code --heads origin $issue.branch) -eq 0) {
        Note ("exists: " + $issue.branch)
    } else {
        Invoke-Quiet git branch $issue.branch origin/main | Out-Null
        $refspec = $issue.branch + ":" + $issue.branch
        if ((Invoke-Quiet git push origin $refspec --quiet) -eq 0) {
            Note ("branch: " + $issue.branch)
        } else {
            Warn ("could not push branch: " + $issue.branch)
        }
    }
}
Invoke-Quiet git checkout main --quiet | Out-Null

# ------------------------------------------------------------- done --------
Say "Done"
Write-Host ""
Write-Host ("  Issues: " + $created + " new, " + $skipped + " already there, " + $failed + " failed") -ForegroundColor Green
Write-Host "  Repository:  https://github.com/$Slug" -ForegroundColor Green
Write-Host "  Issues:      https://github.com/$Slug/issues" -ForegroundColor Green
Write-Host "  Board:       https://github.com/${Owner}?tab=projects" -ForegroundColor Green
Write-Host ""
Write-Host "  Next, by hand (two minutes):" -ForegroundColor Green
Write-Host ""
Write-Host "  1. Invite the other six: Settings -> Collaborators -> Add people" -ForegroundColor Green
Write-Host "  2. Edit .github/CODEOWNERS and replace the placeholder usernames" -ForegroundColor Green
Write-Host "  3. On the board, add a Status field with columns:" -ForegroundColor Green
Write-Host "       To do | In progress | In review | Done" -ForegroundColor Green
Write-Host "     then set every card to 'To do'" -ForegroundColor Green
Write-Host "  4. Each person: read docs/TEAM.md, find your code name, pick an issue" -ForegroundColor Green
Write-Host ""
