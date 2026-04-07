Set WshShell = CreateObject("WScript.Shell")
Set Fso = CreateObject("Scripting.FileSystemObject")
appDir = Fso.GetParentFolderName(WScript.ScriptFullName)

' Check if raceiq.exe is already running
Set WMI = GetObject("winmgmts:\\.\root\cimv2")
Set procs = WMI.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name = 'raceiq.exe'")

If procs.Count > 0 Then
    ' Already running — just open the browser
    WshShell.Run "http://localhost:3117", 1, False
Else
    ' Not running — launch the app
    WshShell.Run """" & appDir & "\raceiq.exe""", 0, False
End If
