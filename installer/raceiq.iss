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
DefaultDirName={localappdata}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..
OutputBaseFilename=RaceIQ-Setup-v{#MyAppVersion}
Compression=lzma
SolidCompression=yes
WizardStyle=modern
CloseApplications=force
SetupIconFile=..\assets\raceiq.ico
UninstallFilesDir={app}\uninstall
UninstallDisplayIcon={app}\{#MyAppExeName}
UninstallDisplayName={#MyAppName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Code]
const
  OldAppId = '{d023ef37-98d7-40de-94b3-58cea61b4d95}_is1';

function GetOldUninstallString(): String;
var
  UninstallKey: String;
begin
  Result := '';
  // Check both 64-bit and 32-bit registry for the old admin install
  UninstallKey := 'Software\Microsoft\Windows\CurrentVersion\Uninstall\' + OldAppId;
  if not RegQueryStringValue(HKLM, UninstallKey, 'UninstallString', Result) then
    RegQueryStringValue(HKLM32, UninstallKey, 'UninstallString', Result);
end;

procedure RemoveOldAdminInstall();
var
  UninstallString: String;
  ResultCode: Integer;
begin
  UninstallString := GetOldUninstallString();
  if UninstallString <> '' then
  begin
    Log('Found old admin install, running uninstaller: ' + UninstallString);
    // Run the old uninstaller silently
    Exec('powershell.exe',
      '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command "Start-Process -FilePath ''' +
      RemoveQuotes(UninstallString) + ''' -ArgumentList ''/VERYSILENT'',''/NORESTART'' -Verb RunAs -Wait"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Log('Old uninstaller finished with code: ' + IntToStr(ResultCode));
  end;
end;

procedure UpdatePrepareStatus(const Msg: String);
begin
  if not WizardSilent then
    WizardForm.PreparingLabel.Caption := Msg;
  Log(Msg);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  UpdatePrepareStatus('Closing RaceIQ...');
  Exec('taskkill', '/F /IM raceiq.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('powershell.exe', '-NoProfile -Command "Get-NetTCPConnection -LocalPort 3117 -State Listen -EA 0 | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -EA 0 }"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

  if GetOldUninstallString() <> '' then
  begin
    UpdatePrepareStatus('Removing old install...');
    RemoveOldAdminInstall();
  end;

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
Name: "{userprograms}\{#MyAppName}"; Filename: "wscript.exe"; Parameters: """{app}\raceiq-launcher.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\{#MyAppExeName}"
Name: "{userprograms}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{userdesktop}\{#MyAppName}"; Filename: "wscript.exe"; Parameters: """{app}\raceiq-launcher.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "wscript.exe"; Parameters: """{app}\raceiq-launcher.vbs"""; WorkingDir: "{app}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: nowait postinstall runasoriginaluser
Filename: "wscript.exe"; Parameters: """{app}\raceiq-launcher.vbs"""; WorkingDir: "{app}"; Flags: nowait skipifnotsilent runasoriginaluser

[UninstallRun]
Filename: "taskkill"; Parameters: "/F /IM raceiq.exe"; Flags: runhidden; RunOnceId: "KillRaceIQ"
Filename: "powershell.exe"; Parameters: "-NoProfile -Command ""Get-NetTCPConnection -LocalPort 3117 -State Listen -EA 0 | ForEach-Object {{ Stop-Process -Id $_.OwningProcess -Force -EA 0 }}"""; Flags: runhidden; RunOnceId: "KillPort3117"
Filename: "cmdkey"; Parameters: "/delete:RaceIQ:gemini-api-key"; Flags: runhidden; RunOnceId: "DeleteApiKey"
