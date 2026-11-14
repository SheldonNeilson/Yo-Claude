<#
  sync-invaders.ps1 - publish Bug Invaders to the web copy, and list the era files in Yo Claude's own page.

  Source of truth (edit only these, never the site copies):
    ui\invaders.js, ui\invaders.css        the core + framework
    ui\invaders-eNN-*.js                   one file per era (they push onto window.INVADERS_ERAS)
    scripts\site-bug-invaders.index.html   master of the standalone page (markers <!--invaders:css--> and <!--invaders:js-->)

  What it does:
    1. Copies ui\invaders*.js and ui\invaders*.css to <Site> (default ..\..\Neilson\site\bug-invaders\, the Neilson repo beside this one), and deletes
       invaders*.js|css there that no longer exist in ui\. scores.php is never touched.
    2. Writes <Site>\index.html from the master: the era scripts first (ordinal name order), invaders.js last, each with
       ?v=<VERSION>.<hash of all the files>, so a changed file always busts the browser cache.
    3. Rewrites the block between "<!-- invaders:eras" and "<!-- /invaders:eras -->" in ui\index.html with a <script> tag for every
       ui\invaders-e*.js that exists right now. Only existing files are listed, so there is never a 404. A new era file only needs this
       script to be run again (or one tag added by hand inside that block, before invaders.js).

  Usage:  powershell -File scripts\sync-invaders.ps1 [-Site <dir>] [-Version <v>]
#>
[CmdletBinding()]
param(
  [string]$Site = "",
  [string]$Version
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$ui = Join-Path $root "ui"
$utf8 = New-Object System.Text.UTF8Encoding($false)   # no BOM; Get-Content / Set-Content would mangle the arrows and dots on Windows PowerShell 5.1
if (-not $Version) { $Version = ([IO.File]::ReadAllText((Join-Path $root "VERSION"))).Trim() }
if (-not $Site) { $Site = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "..\..\Neilson\site\bug-invaders")) }   # (the Neilson repo beside this one)
if (-not (Test-Path $Site)) { throw "site folder not found: $Site" }

function Sort-Ordinal([string[]]$names) { $a = [string[]]@($names | Where-Object { $_ }); [Array]::Sort($a, [StringComparer]::Ordinal); return $a }
$eraJs = @(Sort-Ordinal (Get-ChildItem $ui -Filter "invaders-e*.js" | ForEach-Object { $_.Name }))
$allJs = @($eraJs) + @("invaders.js")
$allCss = @(Sort-Ordinal (Get-ChildItem $ui -Filter "invaders*.css" | ForEach-Object { $_.Name }))
if (-not (Test-Path (Join-Path $ui "invaders.js"))) { throw "ui\invaders.js is missing" }

# a short hash of every file, so the ?v= changes whenever any of them does
$ms = New-Object IO.MemoryStream
foreach ($n in (@($allJs) + @($allCss))) { $b = [IO.File]::ReadAllBytes((Join-Path $ui $n)); $ms.Write($b, 0, $b.Length) }
$sha = [Security.Cryptography.SHA1]::Create()
$stamp = "$Version." + (([BitConverter]::ToString($sha.ComputeHash($ms.ToArray())) -replace "-", "").Substring(0, 8).ToLower())

# 1. copy, and drop orphans
$copied = @()
foreach ($n in (@($allJs) + @($allCss))) {
  $src = Join-Path $ui $n; $dst = Join-Path $Site $n
  $same = (Test-Path $dst) -and ((Get-FileHash $src -Algorithm SHA1).Hash -eq (Get-FileHash $dst -Algorithm SHA1).Hash)
  if (-not $same) { Copy-Item $src $dst -Force; $copied += $n }
}
$keep = @($allJs) + @($allCss)
$removed = @(Get-ChildItem $Site -File | Where-Object { $_.Name -like "invaders*.js" -or $_.Name -like "invaders*.css" } | Where-Object { $keep -notcontains $_.Name })
foreach ($f in $removed) { Remove-Item $f.FullName -Force }

# 2. the standalone page, from the master
$masterPath = Join-Path $PSScriptRoot "site-bug-invaders.index.html"
$html = [IO.File]::ReadAllText($masterPath)
if ($html -notmatch "<!--invaders:css-->" -or $html -notmatch "<!--invaders:js-->") { throw "markers missing in $masterPath" }
$cssTags = ($allCss | ForEach-Object { "<link rel=`"stylesheet`" href=`"$_`?v=$stamp`" />" }) -join "`n  "
$jsTags = ($allJs | ForEach-Object { "<script src=`"$_`?v=$stamp`"></script>" }) -join "`n"
$html = $html.Replace("<!--invaders:css-->", $cssTags).Replace("<!--invaders:js-->", $jsTags)
$indexPath = Join-Path $Site "index.html"
$old = if (Test-Path $indexPath) { [IO.File]::ReadAllText($indexPath) } else { "" }
$pageState = "unchanged"
if ($old -ne $html) { [IO.File]::WriteAllText($indexPath, $html, $utf8); $pageState = "written" }

# 3. Yo Claude's own page: the era tags (only files that exist)
$uiIndex = Join-Path $ui "index.html"
$text = [IO.File]::ReadAllText($uiIndex)
$nl = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
$tags = ($eraJs | ForEach-Object { "<script src=`"$_`"></script>$nl" }) -join ""
$rx = New-Object Text.RegularExpressions.Regex("(?s)(<!-- invaders:eras[^\r\n]*-->\r?\n).*?(<!-- /invaders:eras -->)")
if (-not $rx.IsMatch($text)) { throw "the invaders:eras block is missing in ui\index.html" }
$new = $rx.Replace($text, { param($m) $m.Groups[1].Value + $tags + $m.Groups[2].Value }, 1)
$uiState = "unchanged"
if ($new -ne $text) { [IO.File]::WriteAllText($uiIndex, $new, $utf8); $uiState = "written" }

Write-Host "Bug Invaders sync  (stamp ?v=$stamp)"
Write-Host ("  site copies : " + $(if ($copied.Count) { $copied -join ", " } else { "all up to date" }))
if ($removed.Count) { Write-Host ("  removed     : " + (($removed | ForEach-Object { $_.Name }) -join ", ")) }
Write-Host "  era files   : $(if ($eraJs.Count) { $eraJs -join ', ' } else { '(none yet)' })"
Write-Host "  site index.html : $pageState   ($indexPath)"
Write-Host "  ui\index.html   : $uiState   (era tags: $($eraJs.Count))"
Write-Host "  scores.php left alone."
