Option Explicit
Dim fs, shell, root, python, entry, command
Set fs = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
root = fs.GetParentFolderName(WScript.ScriptFullName)
python = fs.BuildPath(root, "plugins\context_hygiene\.venv\Scripts\pythonw.exe")
entry = fs.BuildPath(root, "shared\desktop_host\launcher.pyw")
If Not fs.FileExists(python) Then
    MsgBox "Existing Python environment not found: " & python, 16, "Context Harness"
    WScript.Quit 1
End If
If Not fs.FileExists(entry) Then
    MsgBox "Launcher not found: " & entry, 16, "Context Harness"
    WScript.Quit 1
End If
command = Chr(34) & python & Chr(34) & " " & Chr(34) & entry & Chr(34)
On Error Resume Next
shell.Run command, 0, False
If Err.Number <> 0 Then
    MsgBox "Cannot open launcher: " & Err.Description, 16, "Context Harness"
    WScript.Quit 1
End If
