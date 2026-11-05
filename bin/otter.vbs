' Starts Otterdeck without a console window (used by the Start menu shortcut).
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = root
sh.Run "node """ & root & "\bin\otter.mjs""", 0, False
