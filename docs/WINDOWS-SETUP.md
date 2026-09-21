# Windows setup

You only do this once. About five minutes, most of it downloading.

## 1. Install the three tools

Open **PowerShell** (press Start, type "PowerShell", press Enter) and run:

```powershell
winget install --id Git.Git -e
winget install --id GitHub.cli -e
winget install --id OpenJS.NodeJS.LTS -e
```

If `winget` is not recognised either, your Windows is older than version 1809 or
the App Installer is missing. Download the installers directly instead:

- Git: <https://git-scm.com/download/win>
- GitHub CLI: <https://cli.github.com>
- Node.js LTS: <https://nodejs.org>

**Close PowerShell and open a new one after installing.** Windows only picks up
newly installed commands in a fresh window — this is the single most common
reason people think an install failed.

Check they worked:

```powershell
git --version
gh --version
node --version
```

## 2. Sign in to GitHub

```powershell
gh auth login
```

Answer the prompts:

- **What account?** → GitHub.com
- **Protocol?** → HTTPS
- **Authenticate Git with your GitHub credentials?** → Yes
- **How would you like to authenticate?** → Login with a web browser

It shows an eight-character code. Press Enter, your browser opens, paste the
code, approve.

Then grant the extra permission the project board needs:

```powershell
gh auth refresh -s project,repo,workflow
```

## 3. Tell Git who you are

```powershell
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

Use the same email as your GitHub account, otherwise your commits will not be
linked to your profile.

## 4. Run the setup

Unzip the starter kit, then in PowerShell move into the folder. If you unzipped
it to Downloads:

```powershell
cd $HOME\Downloads\notify-hub
```

Allow scripts to run in this window only (this does not change your system
settings permanently):

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

Then run it:

```powershell
.\scripts\setup-github.ps1 -Owner TK87tech
```

Use `public` unless you have a paid plan — branch protection is free only on
public repositories:

```powershell
.\scripts\setup-github.ps1 -Owner TK87tech -Repo notify-hub -Visibility public
```

## Common problems

**"'gh' is not recognized"**
You did not open a new PowerShell window after installing. Close it and open a
fresh one.

**"cannot be loaded because running scripts is disabled"**
Run the `Set-ExecutionPolicy` line above first. It applies to that window only.

**"The term '.\scripts\setup-github.ps1' is not recognized"**
You are in the wrong folder. Run `dir` — you should see `scripts`, `docs`,
`contracts` listed. If not, `cd` into the `notify-hub` folder first.

**You are in Command Prompt, not PowerShell**
The prompt `C:\Users\HP>` is Command Prompt. PowerShell's prompt starts with
`PS`. Press Start and open "PowerShell" instead — the script needs it.

**"The '<' operator is reserved for future use"**
The `.ps1` file was saved without a byte-order mark and contains non-ASCII
characters. Windows PowerShell 5.1 then reads it as ANSI and mangles them into
smart quotes, which it treats as string delimiters. Use the latest kit - its
script is plain ASCII. If you ever edit the script yourself, keep it ASCII, or
save it as "UTF-8 with BOM".

**"HTTP 403" or "Resource not accessible"**
Run `gh auth refresh -s project,repo,workflow` and try again.

## The rest of the team

Everyone else only needs steps 1 to 3. They do not run the setup script — that
is a one-time job for whoever creates the repository. Once it exists, they clone:

```powershell
git clone https://github.com/TK87tech/notify-hub.git
cd notify-hub
```
