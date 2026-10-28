#define AppName "Liquid Glass Remote"
#define AppVersion "1.1.0"
#define AppPublisher "Liquid Glass Remote"
#define AppExe "node.exe"

[Setup]
AppId={{A9D546E6-28F5-4B70-8816-08F4676D67F3}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\Programs\Liquid Glass Remote
DefaultGroupName={#AppName}
OutputDir=..\dist\installer
OutputBaseFilename=LiquidGlassRemoteSetup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
CloseApplications=yes
RestartApplications=no
Uninstallable=yes

[Tasks]
Name: "launch_at_login"; Description: "Start the receiver when I sign in to Windows"; Flags: checkedonce
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Files]
Source: "..\dist\windows\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Liquid Glass Remote Receiver"; Filename: "{app}\node.exe"; Parameters: """{app}\receiver\launch.js"""; WorkingDir: "{app}"
Name: "{userdesktop}\Liquid Glass Remote"; Filename: "{app}\node.exe"; Parameters: """{app}\receiver\launch.js"""; WorkingDir: "{app}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "LiquidGlassRemote"; ValueData: """{app}\node.exe"" ""{app}\receiver\launch.js"""; Tasks: launch_at_login; Flags: uninsdeletevalue

[Run]
Filename: "{app}\node.exe"; Parameters: """{app}\receiver\launch.js"""; WorkingDir: "{app}"; Description: "Start Liquid Glass Remote"; Flags: nowait postinstall skipifsilent

[Code]
function InitializeUninstall(): Boolean;
begin
  Result := True;
  if DirExists(ExpandConstant('{userappdata}\Liquid Glass Remote')) then
    if MsgBox('Also remove this laptop''s saved identity and pairing setup?', mbConfirmation, MB_YESNO) = IDYES then
      DelTree(ExpandConstant('{userappdata}\Liquid Glass Remote'), True, True, True);
end;
