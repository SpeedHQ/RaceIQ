Option Explicit

Dim WshShell, Fso, appDir, WMI, procs, env, request, attempt, ready
Dim logDir, logPath, logWritten, result, status, marker, processCount
Const dashboardUrl = "http://localhost:3117"

Set WshShell = CreateObject("WScript.Shell")
Set Fso = CreateObject("Scripting.FileSystemObject")
appDir = Fso.GetParentFolderName(WScript.ScriptFullName)
Set env = WshShell.Environment("PROCESS")
logDir = env("DATA_DIR")
If logDir = "" Then logDir = Fso.BuildPath(env("APPDATA"), "RaceIQ")
On Error Resume Next
If Not Fso.FolderExists(logDir) Then Fso.CreateFolder logDir
On Error GoTo 0
logPath = Fso.GetAbsolutePathName(Fso.BuildPath(logDir, "launcher.log"))
WriteLog "Launcher started"
On Error Resume Next
WshShell.CurrentDirectory = appDir
If Err.Number <> 0 Then Fail "Setting working directory: " & Err.Description

' Reuse the existing server; only cold launches need a new process.
Set WMI = GetObject("winmgmts:\\.\root\cimv2")
If Err.Number <> 0 Then Fail "Opening process list: " & Err.Description
Set procs = WMI.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name = 'raceiq.exe'")
If Err.Number <> 0 Then Fail "Querying raceiq.exe: " & Err.Description
processCount = procs.Count
If Err.Number <> 0 Then Fail "Counting raceiq.exe processes: " & Err.Description
If processCount = 0 Then
    ' The launcher opens the browser, including on first run.
    WriteLog "Starting new raceiq.exe"
    env("RACEIQ_LAUNCHER_OPENS_BROWSER") = "1"
    WshShell.Run """" & appDir & "\raceiq.exe""", 0, False
    If Err.Number <> 0 Then Fail "Starting raceiq.exe: " & Err.Description
Else
    WriteLog "Reusing existing raceiq.exe"
End If

' Wait until the local RaceIQ dashboard responds before opening the browser.
Set request = CreateObject("WinHttp.WinHttpRequest.5.1")
If Err.Number <> 0 Then Fail "Creating readiness probe: " & Err.Description
request.SetProxy 1
request.SetTimeouts 500, 500, 500, 500
If Err.Number <> 0 Then Fail "Configuring readiness probe: " & Err.Description
On Error GoTo 0
ready = False
For attempt = 1 To 60
    On Error Resume Next
    request.Open "GET", "http://127.0.0.1:3117/", False
    If Err.Number = 0 Then request.Send
    If Err.Number = 0 Then status = request.Status
    If Err.Number <> 0 Then
        result = "Request failed (" & Err.Number & "): " & Err.Description
    Else
        result = "HTTP " & status
        If status = 200 Then
            marker = request.GetResponseHeader("X-RaceIQ")
            If Err.Number <> 0 Then
                result = result & "; X-RaceIQ unavailable: " & Err.Description
            ElseIf marker = "1" Then
                ready = True
                result = result & "; X-RaceIQ=1"
            Else
                result = result & "; X-RaceIQ did not match"
            End If
        End If
    End If
    Err.Clear
    On Error GoTo 0
    If ready Then Exit For
    WScript.Sleep 500
Next

If ready Then
    WriteLog "Ready after probe " & attempt & ": " & result
    WshShell.Run dashboardUrl, 1, False
Else
    Fail "Final probe (60/60): " & result
End If

Sub WriteLog(message)
    Dim stream
    On Error Resume Next
    Set stream = Fso.OpenTextFile(logPath, 8, True)
    stream.WriteLine Now & "  " & message
    stream.Close
    logWritten = (Err.Number = 0)
    On Error GoTo 0
End Sub

Sub Fail(reason)
    Dim detail
    WriteLog reason
    If logWritten Then
        detail = "Launcher log: " & logPath
    Else
        detail = "Could not write launcher log: " & logPath
    End If
    MsgBox "RaceIQ did not become ready." & vbCrLf & reason & vbCrLf & detail, vbExclamation, "RaceIQ"
    WScript.Quit 1
End Sub
