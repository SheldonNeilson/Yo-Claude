<#
  Yo Claude installer and updater. Run it from the folder you cloned (or double-click "Install Yo Claude.cmd"):

      powershell -ExecutionPolicy Bypass -File install.ps1          # install / repair
      powershell -ExecutionPolicy Bypass -File install.ps1 -Update  # what "Check for updates" runs

  Sets up Python packages for the app and for PC control, downloads the speech models, makes sure Claude Code is
  installed and signed in, then starts Yo Claude (which adds its Desktop / Start menu shortcuts and starts with
  Windows; both can be changed from its tray menu). Safe to run again at any time.
#>
param([switch]$Update)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # Invoke-WebRequest is far faster without the progress bar
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$data = Join-Path $env:USERPROFILE ".yoclaude"

function Step($text) { Write-Host ""; Write-Host "== $text" -ForegroundColor DarkYellow }
function Ask($question) {
    if ($Update) { return $true }
    $answer = Read-Host "$question [Y/n]"
    return ($answer -eq "" -or $answer -match "^[yY]")
}
function Check($what) { if ($LASTEXITCODE) { throw "$what failed (exit code $LASTEXITCODE). Scroll up for the error." } }

Write-Host "Yo Claude setup" -ForegroundColor DarkYellow

if ($Update) {
    Step "Getting the latest version"
    Start-Sleep -Seconds 3   # let the running app exit
    git -C $here pull --ff-only
    Check "git pull"
}

# --- Python ---------------------------------------------------------------------------------------------------
function Find-Python {
    foreach ($v in "3.13", "3.12", "3.11", "3.10") {
        try {
            $p = & py "-$v" -c "import sys; print(sys.executable)" 2>$null
            if ($LASTEXITCODE -eq 0 -and $p) { return $p.Trim() }
        } catch {}
    }
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source -notmatch "WindowsApps") {   # not the Microsoft Store placeholder
        $out = & $cmd.Source -c "import sys; print('%d.%d' % sys.version_info[:2]); print(sys.executable)" 2>$null
        if ($out) {
            $ver = [version]$out[0]
            if ($ver -ge [version]"3.10" -and $ver -le [version]"3.13") { return $out[1].Trim() }
        }
    }
    return $null
}
Step "Python"
$python = Find-Python
if (-not $python) {
    if (Ask "Python 3.13 isn't installed. Install it now (winget, just for you)?") {
        winget install -e --id Python.Python.3.13 --scope user --accept-package-agreements --accept-source-agreements
        $env:Path = [Environment]::GetEnvironmentVariable("Path", "User") + ";" + [Environment]::GetEnvironmentVariable("Path", "Machine")
        $python = Find-Python
    }
    if (-not $python) { throw "Yo Claude needs Python 3.10 to 3.13. Install it from python.org, then run this again." }
}
Write-Host "Using $python"

function New-Env($folder, $requirements, $label) {
    if (-not (Test-Path "$folder\Scripts\python.exe")) {
        Write-Host "Creating the $label environment"
        & $python -m venv $folder
        Check "Creating the $label environment"
    }
    & "$folder\Scripts\python.exe" -m pip install --upgrade pip --quiet --disable-pip-version-check
    & "$folder\Scripts\python.exe" -m pip install -r $requirements --disable-pip-version-check
    Check "Installing the $label packages"
}
Step "Yo Claude packages"
New-Env (Join-Path $here ".venv") (Join-Path $here "requirements.txt") "Yo Claude"
Step "PC control packages"
New-Env (Join-Path $here "pc_control\.venv") (Join-Path $here "pc_control\requirements.txt") "PC control"

# --- speech models --------------------------------------------------------------------------------------------
Step "Wake word model (40 MB)"
$models = Join-Path $data "models"
$vosk = Join-Path $models "vosk-model-small-en-us-0.15"
if (Test-Path (Join-Path $vosk "am\final.mdl")) {
    Write-Host "Already there."
} else {
    New-Item -ItemType Directory -Force $models | Out-Null
    $zip = Join-Path $models "vosk.zip"
    Invoke-WebRequest "https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip" -OutFile $zip -UseBasicParsing
    Expand-Archive $zip -DestinationPath $models -Force
    Remove-Item $zip
}
Step "Speech recognition model (about 500 MB, first time only)"
& (Join-Path $here ".venv\Scripts\python.exe") -c "from faster_whisper import WhisperModel; WhisperModel('small.en', device='cpu', compute_type='int8'); print('Ready.')"
Check "Downloading the speech recognition model"

# --- Claude Code ----------------------------------------------------------------------------------------------
Step "Claude Code"
$localBin = Join-Path $env:USERPROFILE ".local\bin"
if (-not (Get-Command claude -ErrorAction SilentlyContinue) -and (Test-Path "$localBin\claude.exe")) { $env:Path += ";$localBin" }
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Host "Yo Claude talks to Claude through Claude Code, using your own Claude account (Pro or Max)."
    if (Ask "Claude Code isn't installed. Install it now with Anthropic's official installer?") {
        Invoke-RestMethod "https://claude.ai/install.ps1" | Invoke-Expression
        $env:Path += ";$localBin"
    }
}
if (Get-Command claude -ErrorAction SilentlyContinue) {
    $status = (& claude auth status 2>$null) -join "`n"
    if ($status -notmatch '"loggedIn":\s*true') {
        Write-Host "Sign in to your Claude account (a browser window opens)."
        & claude auth login
    } else {
        Write-Host "Installed and signed in."
    }
} else {
    Write-Host "Install Claude Code later from https://claude.com/claude-code and sign in; Yo Claude needs it to answer." -ForegroundColor Yellow
}

# --- start ----------------------------------------------------------------------------------------------------
Step "Starting Yo Claude"
Start-Process (Join-Path $here ".venv\Scripts\pythonw.exe") -ArgumentList "`"$(Join-Path $here 'app.py')`"" -WorkingDirectory $here
Write-Host "Done. Yo Claude is in your tray (bottom right), on your Desktop and in the Start menu." -ForegroundColor Green
Write-Host "Say ""yo claude"" to start. The welcome tour opens the first time."
if (-not $Update) { Read-Host "Press Enter to close" | Out-Null } else { Start-Sleep -Seconds 4 }
