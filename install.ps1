# Installs or updates Otterdeck on Windows, for this user only (no admin rights needed).
#
#   irm https://raw.githubusercontent.com/trpwrmusic/otterdeck/master/install.ps1 | iex
#
# Optional, as environment variables before the call:
#   OTTER_VERSION      a specific version, e.g. 0.2.0 (default: the newest)
#   OTTER_BUNDLE       a local package instead of the download (for tests)
#   OTTER_INSTALL_DIR  installation folder (default: %LOCALAPPDATA%\Programs\Otterdeck)
#   OTTER_NO_START     1 = do not start Otterdeck afterwards
#   OTTER_FILES_ONLY   1 = only the files: no Start menu entry, no PATH change (tests)
#
# Layout: <dir>\node (own Node.js), <dir>\versions\<version>, <dir>\current (the version that starts).
# Settings and projects live separately in %APPDATA%\Otterdeck and survive updates and reinstalls.
# (Plain ASCII on purpose: Windows PowerShell reads scripts without a BOM in the ANSI code page.)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Repo = 'trpwrmusic/otterdeck'
$NodeVersion = 'v22.14.0'

function Say($text) { Write-Host "  $text" }

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
if ($arch -ne 'x64') { throw 'Otterdeck gibt es fuer Windows bisher nur auf x64.' }

$base = if ($env:OTTER_INSTALL_DIR) { $env:OTTER_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\Otterdeck' }
$versions = Join-Path $base 'versions'
New-Item -ItemType Directory -Force $versions | Out-Null
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('otterdeck-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force $tmp | Out-Null
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'

Write-Host ''
Write-Host 'Otterdeck wird installiert' -ForegroundColor White
Say "Ordner: $base"

try {
  # ---- Node.js: an own copy, so Otterdeck does not depend on what else is installed ----
  $node = Join-Path $base 'node\node.exe'
  $haveNode = (Test-Path $node) -and ((& $node --version) -eq $NodeVersion)
  if (-not $haveNode) {
    Say "Node.js $NodeVersion laden"
    $zip = Join-Path $tmp 'node.zip'
    Invoke-WebRequest "https://nodejs.org/dist/$NodeVersion/node-$NodeVersion-win-$arch.zip" -OutFile $zip -UseBasicParsing
    Expand-Archive $zip -DestinationPath $tmp -Force
    $old = Join-Path $base 'node'
    if (Test-Path $old) { Remove-Item -Recurse -Force $old }
    Move-Item (Join-Path $tmp "node-$NodeVersion-win-$arch") $old
  }

  # ---- Otterdeck itself ----
  $pkg = Join-Path $tmp 'otterdeck.tar.gz'
  if ($env:OTTER_BUNDLE) {
    Copy-Item $env:OTTER_BUNDLE $pkg
  } else {
    $asset = "otterdeck-win-$arch.tar.gz"
    $url = if ($env:OTTER_VERSION) { "https://github.com/$Repo/releases/download/v$($env:OTTER_VERSION.TrimStart('v'))/$asset" } else { "https://github.com/$Repo/releases/latest/download/$asset" }
    Say 'Otterdeck laden'
    Invoke-WebRequest $url -OutFile $pkg -UseBasicParsing
  }
  $unpacked = Join-Path $tmp 'app'
  New-Item -ItemType Directory -Force $unpacked | Out-Null
  & $tar -xzf $pkg -C $unpacked
  if ($LASTEXITCODE -ne 0) { throw 'Das Paket liess sich nicht entpacken.' }
  $version = (Get-Content (Join-Path $unpacked 'package.json') -Raw | ConvertFrom-Json).version
  $target = Join-Path $versions $version
  if (Test-Path (Join-Path $target 'server\index.ts')) {
    Say "Version $version ist schon da"
  } else {
    if (Test-Path $target) { Remove-Item -Recurse -Force $target }
    Move-Item $unpacked $target
    Say "Version $version installiert"
  }
  [IO.File]::WriteAllText((Join-Path $base 'current'), $version)

  # ---- Launchers: they read "current", so updates need nothing else ----
  Copy-Item (Join-Path $target 'assets\otterdeck.ico') (Join-Path $base 'otterdeck.ico') -Force
  $vbs = @'
' Starts Otterdeck without a console window (Start menu, autostart with "background").
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
cur = Trim(fso.OpenTextFile(base & "\current").ReadAll())
args = ""
For Each a In WScript.Arguments
  args = args & " " & a
Next
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = base & "\versions\" & cur
sh.Run """" & base & "\node\node.exe"" """ & base & "\versions\" & cur & "\bin\otter.mjs""" & args, 0, False
'@
  [IO.File]::WriteAllText((Join-Path $base 'otterdeck.vbs'), $vbs)
  $cmd = @'
@echo off
rem otter: open Otterdeck, or otter stop / status / restart
set /p CUR=<"%~dp0current"
"%~dp0node\node.exe" "%~dp0versions\%CUR%\bin\otter.mjs" %*
'@
  [IO.File]::WriteAllText((Join-Path $base 'otter.cmd'), $cmd)

  if ($env:OTTER_FILES_ONLY -ne '1') {
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Programs')) 'Otterdeck.lnk'))
    $lnk.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
    $lnk.Arguments = '"' + (Join-Path $base 'otterdeck.vbs') + '"'
    $lnk.WorkingDirectory = $base
    $lnk.IconLocation = (Join-Path $base 'otterdeck.ico') + ',0'
    $lnk.Description = 'Ein Zuhause fuer deine Claude-Code-Sitzungen'
    $lnk.Save()
    Say 'Eintrag im Startmenue angelegt'

    # "otter" in new terminals (user PATH only).
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not (($userPath -split ';') -contains $base)) {
      [Environment]::SetEnvironmentVariable('Path', (($userPath.TrimEnd(';') + ';' + $base).TrimStart(';')), 'User')
      Say 'Befehl "otter" eingerichtet (in neuen Terminals)'
    }
  }

  # Older versions: keep the one that starts and the one before.
  Get-ChildItem $versions -Directory | Where-Object { $_.Name -ne $version } | Sort-Object LastWriteTime -Descending | Select-Object -Skip 1 |
    ForEach-Object { try { Remove-Item -Recurse -Force $_.FullName } catch {} }
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

if (-not (Get-Command claude -ErrorAction SilentlyContinue) -and -not (Test-Path (Join-Path $env:USERPROFILE '.local\bin\claude.exe'))) {
  Write-Host ''
  Say 'Claude Code fehlt noch. Installieren mit:'
  Say '  irm https://claude.ai/install.ps1 | iex'
}

Write-Host ''
if ($env:OTTER_NO_START -ne '1') {
  Say 'Otterdeck startet, die Einrichtung fuehrt dich durch den Rest.'
  Start-Process (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('"' + (Join-Path $base 'otterdeck.vbs') + '"')
} else {
  Say 'Fertig. Starten ueber das Startmenue oder mit "otter".'
}
Write-Host ''
