; installer/raceiq.iss
; Compile with: iscc /DMyAppVersion=1.0.0 installer\raceiq.iss

#ifndef MyAppVersion
  #define MyAppVersion "0.0.0"
#endif

#define MyAppName "RaceIQ"
#define MyAppPublisher "SpeedHQ"
#define MyAppURL "https://github.com/SpeedHQ/RaceIQ"
#define MyAppExeName "raceiq.exe"

[Setup]
AppId={{d023ef37-98d7-40de-94b3-58cea61b4d95}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={commonpf64}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=admin
OutputDir=..
OutputBaseFilename=RaceIQ-Setup-v{#MyAppVersion}
Compression=lzma
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
SetupIconFile=..\assets\raceiq.ico
UninstallDisplayIcon={app}\{#MyAppExeName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Code]
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  // Kill running RaceIQ process and its tray PowerShell script
  Exec('taskkill', '/F /IM raceiq.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  // Also kill any bun.exe running on port 3117 (dev mode)
  Exec('powershell.exe', '-NoProfile -Command "Get-NetTCPConnection -LocalPort 3117 -State Listen -EA 0 | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -EA 0 }"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := '';
end;

[Files]
Source: "..\dist\raceiq.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\public\*"; DestDir: "{app}\public"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\dist\data\*"; DestDir: "{app}\data"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\dist\node_modules\@libsql\win32-x64-msvc\*"; DestDir: "{app}\node_modules\@libsql\win32-x64-msvc"; Flags: ignoreversion
Source: "..\server\credstore.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "raceiq-launcher.vbs"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "wscript.exe"; Parameters: """{app}\raceiq-launcher.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\{#MyAppExeName}"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{commondesktop}\{#MyAppName}"; Filename: "wscript.exe"; Parameters: """{app}\raceiq-launcher.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "wscript.exe"; Parameters: """{app}\raceiq-launcher.vbs"""; WorkingDir: "{app}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "taskkill"; Parameters: "/F /IM raceiq.exe"; Flags: runhidden
Filename: "powershell.exe"; Parameters: "-NoProfile -Command ""Get-NetTCPConnection -LocalPort 3117 -State Listen -EA 0 | ForEach-Object {{ Stop-Process -Id $_.OwningProcess -Force -EA 0 }}"""; Flags: runhidden
Filename: "cmdkey"; Parameters: "/delete:RaceIQ:gemini-api-key"; Flags: runhidden
