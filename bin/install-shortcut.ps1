# Adds "Otterdeck" to the Start menu. Run again any time; it just overwrites the shortcut.
#   powershell -ExecutionPolicy Bypass -File bin\install-shortcut.ps1
$root = Split-Path -Parent $PSScriptRoot
$programs = [Environment]::GetFolderPath('Programs')
$lnk = Join-Path $programs 'Otterdeck.lnk'

$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($lnk)
$s.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$s.Arguments = '"' + (Join-Path $root 'bin\otter.vbs') + '"'
$s.WorkingDirectory = $root
$s.IconLocation = (Join-Path $root 'assets\otterdeck.ico') + ',0'
$s.Description = 'Ein Zuhause für deine Claude-Code-Sitzungen'
$s.Save()
Write-Output "Startmenü-Eintrag angelegt: $lnk"
