Option Explicit

Dim WshShell, Fso, appDir, WMI, procs, env, request, attempt, ready
Const dashboardUrl = "http://localhost:3117"

Set WshShell = CreateObject("WScript.Shell")
Set Fso = CreateObject("Scripting.FileSystemObject")
appDir = Fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = appDir

' Reuse the existing server; only cold launches need a new process.
Set WMI = GetObject("winmgmts:\\.\root\cimv2")
Set procs = WMI.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name = 'raceiq.exe'")
If procs.Count = 0 Then
    ' The launcher opens the browser, including on first run.
    Set env = WshShell.Environment("PROCESS")
    env("RACEIQ_LAUNCHER_OPENS_BROWSER") = "1"
    WshShell.Run """" & appDir & "\raceiq.exe""", 0, False
End If

' Wait until the local RaceIQ dashboard responds before opening the browser.
Set request = CreateObject("WinHttp.WinHttpRequest.5.1")
request.SetProxy 1
request.SetTimeouts 500, 500, 500, 500
ready = False
For attempt = 1 To 60
    On Error Resume Next
    request.Open "GET", "http://127.0.0.1:3117/", False
    request.Send
    If Err.Number = 0 Then
        ready = (request.Status = 200 And request.GetResponseHeader("X-RaceIQ") = "1")
    End If
    Err.Clear
    On Error GoTo 0
    If ready Then Exit For
    WScript.Sleep 500
Next

If ready Then
    WshShell.Run dashboardUrl, 1, False
Else
    MsgBox "RaceIQ did not become ready. Check the RaceIQ log and try again.", vbExclamation, "RaceIQ"
    WScript.Quit 1
End If
