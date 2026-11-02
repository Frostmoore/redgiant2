; RedGiant-Setup.exe (G22): the Windows installer anyone can run. Next, next, finish: it switches
; WSL on if needed (the only step that asks for administrator rights; if Windows needs a restart,
; setup continues by itself afterwards), imports the "RedGiant" WSL distribution, and puts the
; RedGiant icon on the desktop and in the Start menu. No Docker Desktop: Docker runs inside the
; distribution.
;
; Built in CI: iscc /DAppVersion=1.23.0 RedGiant.iss, next to RedGiant.exe (launcher),
; redgiant.ico and redgiant-rootfs.tar.gz (the distribution).

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{6F0E3B52-8D4A-4C1E-9B7A-2E1D5C9F4A10}
AppName=RedGiant
AppVersion={#AppVersion}
AppPublisher=RedGiant
AppPublisherURL=https://github.com/Frostmoore/redgiant2
DefaultDirName={localappdata}\RedGiant
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=no
PrivilegesRequired=lowest
OutputDir=dist
OutputBaseFilename=RedGiant-Setup
SetupIconFile=redgiant.ico
UninstallDisplayIcon={app}\RedGiant.exe
UninstallDisplayName=RedGiant
WizardStyle=modern
Compression=lzma2/fast
SolidCompression=no
; The distribution is built for x64; WSL needs Windows 10 2004 or newer.
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
MinVersion=10.0.19041
CloseApplications=force
RestartApplications=no

[Languages]
Name: "it"; MessagesFile: "compiler:Languages\Italian.isl"
Name: "en"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
it.Autostart=Avvia RedGiant quando accendi il computer
en.Autostart=Start RedGiant when the computer starts
it.WslNeeded=RedGiant usa WSL, il Linux che Windows ha già al suo interno.%n%nOra lo attivo: Windows ti chiederà il permesso (rispondi Sì). Ci vuole qualche minuto.
en.WslNeeded=RedGiant uses WSL, the Linux built into Windows.%n%nIt will be switched on now: Windows will ask for permission (answer Yes). It takes a few minutes.
it.WslRestart=WSL è attivato, ma Windows deve riavviarsi per finire.%n%nRiavvia il computer: dopo il riavvio l'installazione di RedGiant riprende da sola.
en.WslRestart=WSL is switched on, but Windows must restart to finish.%n%nRestart the computer: after the restart, RedGiant's setup continues by itself.
it.WslFailed=Non sono riuscito ad attivare WSL. Controlla che la virtualizzazione sia attiva nel BIOS del computer, oppure chiedi aiuto.
en.WslFailed=WSL could not be switched on. Check that virtualization is enabled in the computer's BIOS, or ask for help.
it.Importing=Preparo RedGiant…
en.Importing=Preparing RedGiant…
it.ImportFailed=Non sono riuscito a preparare RedGiant dentro WSL (codice %1). Riprova; se succede ancora, chiedi aiuto.
en.ImportFailed=RedGiant could not be prepared inside WSL (code %1). Try again; if it happens again, ask for help.
it.KeepData=Vuoi tenere le conversazioni, i progetti e le impostazioni di RedGiant?%n%nSì: restano sul computer e li ritrovi se lo reinstalli.%nNo: vengono cancellati per sempre.
en.KeepData=Keep RedGiant's conversations, projects and settings?%n%nYes: they stay on the computer and come back if you install it again.%nNo: they are deleted for good.

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"
Name: "autostart"; Description: "{cm:Autostart}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "RedGiant.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "redgiant.ico"; DestDir: "{app}"; Flags: ignoreversion
; The script inside the distribution, for updates of an already installed one.
Source: "rootfs\redgiant-wsl"; DestDir: "{app}"; Flags: ignoreversion
Source: "rootfs\wsl.conf"; DestDir: "{app}"; Flags: ignoreversion
; Already compressed; removed once imported.
Source: "redgiant-rootfs.tar.gz"; DestDir: "{app}"; Flags: nocompression deleteafterinstall

[Icons]
Name: "{userprograms}\RedGiant"; Filename: "{app}\RedGiant.exe"; IconFilename: "{app}\redgiant.ico"
Name: "{userdesktop}\RedGiant"; Filename: "{app}\RedGiant.exe"; IconFilename: "{app}\redgiant.ico"; Tasks: desktopicon
Name: "{userstartup}\RedGiant"; Filename: "{app}\RedGiant.exe"; Parameters: "--background"; IconFilename: "{app}\redgiant.ico"; Tasks: autostart

[Run]
Filename: "{app}\RedGiant.exe"; Description: "{cm:LaunchProgram,RedGiant}"; Flags: nowait postinstall

[Code]
const
  Distro = 'RedGiant';
  RunOnceKey = 'Software\Microsoft\Windows\CurrentVersion\RunOnce';

function RunHidden(Params: String): Integer;
var
  Code: Integer;
begin
  if not Exec(ExpandConstant('{sys}\wsl.exe'), Params, '', SW_HIDE, ewWaitUntilTerminated, Code) then
    Code := -1;
  Result := Code;
end;

function WslWorks(): Boolean;
begin
  Result := RunHidden('--status') = 0;
end;

function DistroExists(): Boolean;
begin
  Result := RunHidden('-d ' + Distro + ' -u root -- true') = 0;
end;

{ Before anything is copied: WSL must work. Switching it on is the one step that asks for
  administrator rights; if Windows then needs a restart, setup runs again by itself afterwards. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
  Copy: String;
begin
  Result := '';
  if WslWorks() then Exit;
  MsgBox(CustomMessage('WslNeeded'), mbInformation, MB_OK);
  ShellExec('runas', ExpandConstant('{sys}\wsl.exe'), '--install --no-distribution', '',
    SW_SHOW, ewWaitUntilTerminated, Code);
  if WslWorks() then Exit;
  if (Code <> 0) and (Code <> 3010) and (Code <> 1641) then begin
    Result := CustomMessage('WslFailed');
    Exit;
  end;
  { Restart needed: a copy of this setup runs once at the next sign-in. }
  Copy := ExpandConstant('{localappdata}\RedGiant-Setup.exe');
  FileCopy(ExpandConstant('{srcexe}'), Copy, False);
  RegWriteStringValue(HKCU, RunOnceKey, 'RedGiantSetup', '"' + Copy + '"');
  NeedsRestart := True;
  Result := CustomMessage('WslRestart');
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
begin
  if CurStep <> ssPostInstall then Exit;
  WizardForm.StatusLabel.Caption := CustomMessage('Importing');
  if DistroExists() then begin
    { An update: the distribution and its data stay; its script and RedGiant's images are renewed. }
    RunHidden('-d ' + Distro + ' -u root --cd "' + ExpandConstant('{app}') +
      '" -- sh -c "cp redgiant-wsl /usr/local/bin/redgiant-wsl && chmod 755 /usr/local/bin/redgiant-wsl && cp wsl.conf /etc/wsl.conf"');
    RunHidden('-d ' + Distro + ' -u root -- sh -c "echo v{#AppVersion} > /etc/redgiant-ref"');
    RunHidden('-d ' + Distro + ' -u root -- /usr/local/bin/redgiant-wsl update');
    { The new wsl.conf applies at the distribution's next start. }
    RunHidden('--terminate ' + Distro);
  end else begin
    Code := RunHidden('--import ' + Distro + ' "' + ExpandConstant('{app}\wsl') + '" "' +
      ExpandConstant('{app}\redgiant-rootfs.tar.gz') + '" --version 2');
    if Code <> 0 then
      MsgBox(FmtMessage(CustomMessage('ImportFailed'), [IntToStr(Code)]), mbError, MB_OK);
  end;
  { The copy left for a restart is no longer needed. }
  DeleteFile(ExpandConstant('{localappdata}\RedGiant-Setup.exe'));
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Code: Integer;
begin
  if CurUninstallStep <> usUninstall then Exit;
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/IM RedGiant.exe /F', '', SW_HIDE, ewWaitUntilTerminated, Code);
  RunHidden('--terminate ' + Distro);
  if MsgBox(CustomMessage('KeepData'), mbConfirmation, MB_YESNO or MB_DEFBUTTON1) = IDNO then
    RunHidden('--unregister ' + Distro);
end;
