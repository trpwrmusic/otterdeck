' Starts Otterdeck without a console window (Start menu shortcut, autostart with "background").
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = root
args = ""
For Each a In WScript.Arguments
  args = args & " " & a
Next
sh.Run "node """ & root & "\bin\otter.mjs""" & args, 0, False
