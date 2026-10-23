<#
  Removes Yo Claude's launch-at-login entry and shortcuts, and stops it. Your sessions stay in Claude Code
  (~/.claude). Asks before deleting Yo Claude's own data (~/.yoclaude: settings, models, logs, trash).
      powershell -ExecutionPolicy Bypass -File uninstall.ps1
#>
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$data = Join-Path $env:USERPROFILE ".yoclaude"

Get-CimInstance Win32_Process -Filter "Name like 'python%'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$here*app.py*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Remove-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name YoClaude -ErrorAction SilentlyContinue
foreach ($folder in [Environment]::GetFolderPath("Desktop"), [Environment]::GetFolderPath("Programs")) {
    Remove-Item (Join-Path $folder "Yo Claude.lnk") -ErrorAction SilentlyContinue
}
Write-Host "Yo Claude is stopped, and no longer starts with Windows. Shortcuts removed."

$answer = Read-Host "Also delete Yo Claude's data in $data (settings, speech models, logs, its session trash)? [y/N]"
if ($answer -match "^[yY]") {
    Remove-Item $data -Recurse -Force
    Write-Host "Deleted."
}
Write-Host "To finish, delete this folder: $here"
Read-Host "Press Enter to close" | Out-Null
