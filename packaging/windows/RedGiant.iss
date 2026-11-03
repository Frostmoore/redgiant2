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
; Asked on a first installation only ("auto": an update keeps the folder it has).
DisableDirPage=auto
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
; A first installation asks the language (Windows' one proposed); an update uses the one chosen
; then and asks nothing at all (2026-11-03).
ShowLanguageDialog=yes
UsePreviousLanguage=yes
LanguageDetectionMethod=uilanguage
; RedGiant is closed by the setup itself (PrepareToInstall): Windows' own "close the
; applications" page listed nothing it could name, and left the old RedGiant running.
CloseApplications=no
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
it.ImportFailed=Non sono riuscito a preparare RedGiant dentro WSL (codice %1).%n%nCosa ha risposto WSL:%n%2%n%nRiprova; se succede ancora, manda a chi ti aiuta il file:%n%3
en.ImportFailed=RedGiant could not be prepared inside WSL (code %1).%n%nWhat WSL said:%n%2%n%nTry again; if it happens again, send this file to whoever helps you:%n%3
it.NoVirtualization=Il computer ha la virtualizzazione spenta, e senza di lei WSL non può partire.%n%nSi accende nel BIOS: riavvia il computer, entra nel BIOS (di solito con Canc, F2 o F10 all'accensione) e attiva «Intel VT-x», «Intel Virtualization Technology» o «AMD-V / SVM Mode». Poi esegui di nuovo questa installazione.
en.NoVirtualization=Virtualization is off on this computer, and WSL cannot start without it.%n%nIt is switched on in the BIOS: restart the computer, enter the BIOS (usually Del, F2 or F10 at power-on) and enable "Intel VT-x", "Intel Virtualization Technology" or "AMD-V / SVM Mode". Then run this setup again.
it.VmPlatform=Su questo computer manca un pezzo di Windows che WSL usa: la «Piattaforma macchina virtuale».%n%nOra la attivo: Windows ti chiederà il permesso (rispondi Sì). Poi va riavviato il computer, e dopo il riavvio l'installazione di RedGiant riprende da sola.
en.VmPlatform=A part of Windows that WSL uses is missing on this computer: the "Virtual Machine Platform".%n%nIt will be switched on now: Windows will ask for permission (answer Yes). Then the computer must restart, and after the restart RedGiant's setup continues by itself.
it.UpdateWsl=Aggiorno WSL e riprovo…
en.UpdateWsl=Updating WSL and trying again…
it.AlreadyInstalled=RedGiant %1 è già installato su questo computer.%n%nVuoi aggiornarlo alla versione %2? Conversazioni, progetti e impostazioni restano come sono.
en.AlreadyInstalled=RedGiant %1 is already installed on this computer.%n%nUpdate it to version %2? Conversations, projects and settings stay as they are.
it.DataTitle=Dove mettere i dati
en.DataTitle=Where the data go
it.DataSub=Progetti, conversazioni e impostazioni di RedGiant.
en.DataSub=RedGiant's projects, conversations and settings.
it.DataText=RedGiant tiene qui tutto quello che fai: scegli un disco con spazio (servono almeno 20 GB, di più se userai modelli sul computer).
en.DataText=RedGiant keeps everything you do here: choose a disk with room (at least 20 GB, more if you will run models on this computer).
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
Source: "..\..\install.sh"; DestDir: "{app}"; Flags: ignoreversion
; Already compressed; removed once imported.
Source: "redgiant-rootfs.tar.gz"; DestDir: "{app}"; Flags: nocompression deleteafterinstall

[Icons]
Name: "{userprograms}\RedGiant"; Filename: "{app}\RedGiant.exe"; IconFilename: "{app}\redgiant.ico"
Name: "{userdesktop}\RedGiant"; Filename: "{app}\RedGiant.exe"; IconFilename: "{app}\redgiant.ico"; Tasks: desktopicon
Name: "{userstartup}\RedGiant"; Filename: "{app}\RedGiant.exe"; Parameters: "--background"; IconFilename: "{app}\redgiant.ico"; Tasks: autostart

[Registry]
; What RedGiant.exe reads: its version (to look for newer ones) and where the data are.
; DataDir outlives an uninstallation that keeps the data, so installing again finds them.
Root: HKCU; Subkey: "Software\RedGiant"; ValueType: string; ValueName: "Version"; ValueData: "{#AppVersion}"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\RedGiant"; ValueType: string; ValueName: "DataDir"; ValueData: "{code:DataDir}"

[Run]
; A first installation asks; an update opens RedGiant by itself (CurStepChanged).
Filename: "{app}\RedGiant.exe"; Description: "{cm:LaunchProgram,RedGiant}"; Flags: nowait postinstall; Check: not IsUpdate

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

{ Runs wsl and keeps what it said (in UTF-8, WSL_UTF8), to show it when something fails. }
function RunCaptured(Params: String; var Output: String): Integer;
var
  Code: Integer;
  Log: String;
  Text: AnsiString;
begin
  Log := ExpandConstant('{tmp}\wsl-output.txt');
  DeleteFile(Log);
  if not Exec(ExpandConstant('{cmd}'), '/c set WSL_UTF8=1&& "' + ExpandConstant('{sys}\wsl.exe') + '" ' +
      Params + ' > "' + Log + '" 2>&1', '', SW_HIDE, ewWaitUntilTerminated, Code) then
    Code := -1;
  Output := '';
  if LoadStringFromFile(Log, Text) then
    Output := Trim(String(Text));
  Result := Code;
end;

const
  UninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{6F0E3B52-8D4A-4C1E-9B7A-2E1D5C9F4A10}_is1';

{ The version already installed, from Windows' own list of programs; '' when there is none. }
function InstalledVersion(): String;
begin
  Result := '';
  if not RegQueryStringValue(HKCU, UninstallKey, 'DisplayVersion', Result) then
    if RegKeyExists(HKCU, UninstallKey) then Result := '?';
end;

var
  Updating: Boolean;
  { The Virtual Machine Platform was switched on during this run: Windows must restart. }
  VmRestart: Boolean;
  DataPage: TInputDirWizardPage;

{ RedGiant already there: this is an update, asked once and then done without pages. }
function IsUpdate(): Boolean;
begin
  Result := Updating;
end;

{ Windows' list of programs says whether RedGiant is there (no WSL call before the window: it
  can be slow or fail). An update asks one question, unless it runs silently from RedGiant. }
function InitializeSetup(): Boolean;
var
  Old: String;
begin
  Result := True;
  Old := InstalledVersion();
  Updating := Old <> '';
  { Setup going on after a restart it asked for: no question. }
  if Updating and not WizardSilent() and (ExpandConstant('{param:CONTINUE|0}') <> '1') then
    Result := MsgBox(FmtMessage(CustomMessage('AlreadyInstalled'), [Old, '{#AppVersion}']),
      mbConfirmation, MB_YESNO) = IDYES;
end;

procedure InitializeWizard();
var
  Previous: String;
begin
  DataPage := CreateInputDirPage(wpSelectDir, CustomMessage('DataTitle'), CustomMessage('DataSub'),
    CustomMessage('DataText'), False, '');
  DataPage.Add('');
  if not RegQueryStringValue(HKCU, 'Software\RedGiant', 'DataDir', Previous) then
    Previous := ExpandConstant('{localappdata}\RedGiant\data');
  DataPage.Values[0] := Previous;
end;

{ Where the distribution (projects, conversations, settings) lives. }
function DataDir(Param: String): String;
var
  Kept: String;
begin
  if Updating and RegQueryStringValue(HKCU, 'Software\RedGiant', 'DataDir', Kept) then
    Result := Kept
  else if Updating then
    Result := ExpandConstant('{app}\wsl')
  else
    Result := DataPage.Values[0];
end;

{ An update shows nothing but its progress; it ends by opening RedGiant. }
function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := Updating and (PageID <> wpInstalling);
end;

{ Before anything is copied: WSL must work. Switching it on is the one step that asks for
  administrator rights; if Windows then needs a restart, setup runs again by itself afterwards. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
  Copy: String;
begin
  Result := '';
  { An open RedGiant (often only in the tray) would keep its files and stop the new one from
    starting at the end: closed first. }
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/IM RedGiant.exe /F', '', SW_HIDE, ewWaitUntilTerminated, Code);
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
  CopyFile(ExpandConstant('{srcexe}'), Copy, False);
  RegWriteStringValue(HKCU, RunOnceKey, 'RedGiantSetup', '"' + Copy + '" /CONTINUE=1');
  NeedsRestart := True;
  Result := CustomMessage('WslRestart');
end;

function Contains(Text, Part: String): Boolean;
begin
  Result := Pos(Lowercase(Part), Lowercase(Text)) > 0;
end;

function NoHypervisor(Output: String): Boolean;
begin
  Result := Contains(Output, 'HCS_E_HYPERV_NOT_INSTALLED') or Contains(Output, '0x80370102') or
    Contains(Output, 'virtualiz');
end;

{ WSL cannot start a virtual machine. First the Virtual Machine Platform is switched on (once):
  Windows restarts and setup goes on by itself. If it is still missing after that, the cause is
  virtualization off in the BIOS, which only the person can switch on: explained. }
procedure HypervisorMissing();
var
  Code: Integer;
  Tried, Copy: String;
begin
  if RegQueryStringValue(HKCU, 'Software\RedGiant', 'VmPlatformTried', Tried) then begin
    MsgBox(CustomMessage('NoVirtualization'), mbError, MB_OK);
    Exit;
  end;
  MsgBox(CustomMessage('VmPlatform'), mbInformation, MB_OK);
  ShellExec('runas', ExpandConstant('{sys}\wsl.exe'), '--install --no-distribution', '',
    SW_SHOW, ewWaitUntilTerminated, Code);
  RegWriteStringValue(HKCU, 'Software\RedGiant', 'VmPlatformTried', '1');
  Copy := ExpandConstant('{localappdata}\RedGiant-Setup.exe');
  CopyFile(ExpandConstant('{srcexe}'), Copy, False);
  RegWriteStringValue(HKCU, RunOnceKey, 'RedGiantSetup', '"' + Copy + '" /CONTINUE=1');
  VmRestart := True;
end;

{ Inno asks to restart at the end when this is true. }
function NeedRestart(): Boolean;
begin
  Result := VmRestart;
end;

{ The distribution into the data folder. The data of an earlier installation, kept when it was
  removed, are taken back as they are; a WSL too old is updated and the import tried again;
  virtualization switched off is explained; any other failure shows what WSL said and leaves it
  in a file. }
procedure ImportDistro();
var
  Code: Integer;
  Output, Disk, Report: String;
begin
  ForceDirectories(DataDir(''));
  Disk := AddBackslash(DataDir('')) + 'ext4.vhdx';
  if FileExists(Disk) then
    Code := RunCaptured('--import-in-place ' + Distro + ' "' + Disk + '"', Output)
  else
    Code := RunCaptured('--import ' + Distro + ' "' + DataDir('') + '" "' +
      ExpandConstant('{app}\redgiant-rootfs.tar.gz') + '" --version 2', Output);
  if Code = 0 then Exit;
  if NoHypervisor(Output) then begin
    HypervisorMissing();
    Exit;
  end;
  { Often an old WSL: updated (Windows asks permission), then once more. }
  WizardForm.StatusLabel.Caption := CustomMessage('UpdateWsl');
  ShellExec('runas', ExpandConstant('{sys}\wsl.exe'), '--update', '', SW_SHOW, ewWaitUntilTerminated, Code);
  if FileExists(Disk) then
    Code := RunCaptured('--import-in-place ' + Distro + ' "' + Disk + '"', Output)
  else
    Code := RunCaptured('--import ' + Distro + ' "' + DataDir('') + '" "' +
      ExpandConstant('{app}\redgiant-rootfs.tar.gz') + '" --version 2', Output);
  WizardForm.StatusLabel.Caption := CustomMessage('Importing');
  if Code = 0 then Exit;
  if NoHypervisor(Output) then begin
    HypervisorMissing();
    Exit;
  end;
  Report := ExpandConstant('{localappdata}\RedGiant-install-error.txt');
  SaveStringToFile(Report, 'RedGiant {#AppVersion}' + #13#10 + 'Data: ' + DataDir('') + #13#10 +
    'Code: ' + IntToStr(Code) + #13#10 + Output + #13#10, False);
  if Output = '' then Output := '-';
  MsgBox(FmtMessage(CustomMessage('ImportFailed'), [IntToStr(Code), Output, Report]), mbError, MB_OK);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
begin
  if (CurStep = ssDone) and Updating then begin
    Exec(ExpandConstant('{app}\RedGiant.exe'), '', '', SW_SHOWNORMAL, ewNoWait, Code);
    Exit;
  end;
  if CurStep <> ssPostInstall then Exit;
  WizardForm.StatusLabel.Caption := CustomMessage('Importing');
  if DistroExists() then begin
    { An update: the distribution and its data stay; its scripts are renewed. The images come
      down at RedGiant's next start, with the progress bar in its window. }
    RunHidden('-d ' + Distro + ' -u root --cd "' + ExpandConstant('{app}') +
      '" -- sh -c "cp redgiant-wsl /usr/local/bin/redgiant-wsl && chmod 755 /usr/local/bin/redgiant-wsl && cp wsl.conf /etc/wsl.conf && cp install.sh /usr/local/share/redgiant/install.sh"');
    RunHidden('-d ' + Distro + ' -u root -- sh -c "echo v{#AppVersion} > /etc/redgiant-ref"');
    RunHidden('-d ' + Distro + ' -u root -- /usr/local/bin/redgiant-wsl update');
    { The new wsl.conf applies at the distribution's next start. }
    RunHidden('--terminate ' + Distro);
  end else begin
    ImportDistro();
  end;
  if VmRestart then Exit;
  { The copy left for a restart is no longer needed. }
  DeleteFile(ExpandConstant('{localappdata}\RedGiant-Setup.exe'));
  RegDeleteValue(HKCU, 'Software\RedGiant', 'VmPlatformTried');
end;

{ An update ends by itself: RedGiant was opened again at ssDone (CurStepChanged). }
procedure CurPageChanged(CurPageID: Integer);
begin
  if Updating and (CurPageID = wpFinished) then
    WizardForm.NextButton.OnClick(WizardForm.NextButton);
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
