; RedGiant-Setup.exe (G22; RedGiant 3.0, G30.2): the Windows installer anyone can run. Next, next,
; finish. Everything runs on Windows itself: RedGiant.exe, the Node that runs the server, the
; server (which starts its own Postgres) and the web page. No WSL, no Docker, no virtualization,
; no administrator rights.
;
; Built in CI: iscc /DAppVersion=3.0.0 RedGiant.iss, next to RedGiant.exe (launcher),
; redgiant.ico, redgiant.cmd, node\node.exe, server\ (pnpm deploy of @redgiant/server, with the
; command line in server\cli, packaging/cli/stage.mjs) and web\ (the page).

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
; Thousands of small files (the server's modules): one solid block compresses them far better.
Compression=lzma2/max
SolidCompression=yes
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
MinVersion=10.0.17763
; A first installation asks the language (Windows' one proposed); an update uses the one chosen
; then and asks nothing at all (2026-11-03).
ShowLanguageDialog=yes
UsePreviousLanguage=yes
LanguageDetectionMethod=uilanguage
; RedGiant is closed by the setup itself (PrepareToInstall, RedGiant.exe --quit).
CloseApplications=no
RestartApplications=no
; The `redgiant` command in the user's PATH is a choice (the "clipath" task, off by default):
; Windows is told when the user's environment changes, so new terminals see it.
ChangesEnvironment=yes

[Languages]
Name: "it"; MessagesFile: "compiler:Languages\Italian.isl"
Name: "en"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
it.Autostart=Avvia RedGiant quando accendi il computer
en.Autostart=Start RedGiant when the computer starts
it.AlreadyInstalled=RedGiant %1 è già installato su questo computer.%n%nVuoi aggiornarlo alla versione %2? Conversazioni, progetti e impostazioni restano come sono.
en.AlreadyInstalled=RedGiant %1 is already installed on this computer.%n%nUpdate it to version %2? Conversations, projects and settings stay as they are.
it.OldWsl=Sul computer c'è RedGiant %1, che girava dentro WSL. RedGiant 3 gira direttamente su Windows e non può aggiornarlo.%n%nDisinstalla prima la versione vecchia (Impostazioni di Windows, App, RedGiant), poi esegui di nuovo questa installazione. Se vuoi tenere conversazioni e progetti, prima fai un backup da RedGiant (Impostazioni, Backup) e importalo dopo.
en.OldWsl=RedGiant %1, which ran inside WSL, is on this computer. RedGiant 3 runs directly on Windows and cannot update it.%n%nUninstall the old version first (Windows Settings, Apps, RedGiant), then run this setup again. To keep conversations and projects, make a backup in RedGiant first (Settings, Backup) and import it afterwards.
it.DataTitle=Dove mettere i dati
en.DataTitle=Where the data go
it.DataSub=Progetti, conversazioni e impostazioni di RedGiant.
en.DataSub=RedGiant's projects, conversations and settings.
it.DataText=RedGiant tiene qui tutto quello che fai: scegli un disco con spazio (servono almeno 5 GB, di più se userai modelli sul computer).
en.DataText=RedGiant keeps everything you do here: choose a disk with room (at least 5 GB, more if you will run models on this computer).
it.DeleteModels=Vuoi eliminare anche i modelli scaricati e i motori per farli girare (%1)?%n%nSì: liberi lo spazio; se reinstalli RedGiant li riscarichi.%nNo: restano, pronti per la prossima volta.
en.DeleteModels=Delete the downloaded models and the engines that run them as well (%1)?%n%nYes: the space is freed; if you install RedGiant again they are downloaded again.%nNo: they stay, ready for next time.
it.KeepData=Vuoi tenere le conversazioni, i progetti e le impostazioni di RedGiant?%n%nSì: restano sul computer e li ritrovi se lo reinstalli.%nNo: vengono cancellati per sempre.
it.CliPath=Aggiungi il comando «redgiant» al terminale (solo per il tuo utente)
en.CliPath=Add the «redgiant» command to the terminal (for your user only)
it.CliGroup=Riga di comando:
en.CliGroup=Command line:
en.KeepData=Keep RedGiant's conversations, projects and settings?%n%nYes: they stay on the computer and come back if you install it again.%nNo: they are deleted for good.

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"
Name: "autostart"; Description: "{cm:Autostart}"; GroupDescription: "{cm:AdditionalIcons}"
; Off unless chosen: the only change outside RedGiant's folder is the user's own PATH (G36.15).
Name: "clipath"; Description: "{cm:CliPath}"; GroupDescription: "{cm:CliGroup}"; Flags: unchecked

[Files]
Source: "RedGiant.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "redgiant.ico"; DestDir: "{app}"; Flags: ignoreversion
; The command line (G36.15): always there, usable as {app}\bin\redgiant.cmd; in the PATH by choice.
Source: "redgiant.cmd"; DestDir: "{app}\bin"; Flags: ignoreversion
Source: "node\node.exe"; DestDir: "{app}\node"; Flags: ignoreversion
Source: "server\*"; DestDir: "{app}\server"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "web\*"; DestDir: "{app}\web"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
; An update replaces the server whole: modules removed in the new version must not linger.
Type: filesandordirs; Name: "{app}\server"
Type: filesandordirs; Name: "{app}\web"
; A differential update half done (G36.18): the installer replaces everything anyway.
Type: filesandordirs; Name: "{app}\update"

[UninstallDelete]
; Files a differential update brought (G36.18) are not in setup's list: the folders go whole.
Type: filesandordirs; Name: "{app}\server"
Type: filesandordirs; Name: "{app}\web"
Type: filesandordirs; Name: "{app}\node"
Type: filesandordirs; Name: "{app}\update"
Type: filesandordirs; Name: "{app}\bin"

[Icons]
Name: "{userprograms}\RedGiant"; Filename: "{app}\RedGiant.exe"; IconFilename: "{app}\redgiant.ico"
Name: "{userdesktop}\RedGiant"; Filename: "{app}\RedGiant.exe"; IconFilename: "{app}\redgiant.ico"; Tasks: desktopicon
Name: "{userstartup}\RedGiant"; Filename: "{app}\RedGiant.exe"; Parameters: "--background"; IconFilename: "{app}\redgiant.ico"; Tasks: autostart

[Registry]
; What RedGiant.exe reads: its version (to look for newer ones) and where the data are.
; DataDir outlives an uninstallation that keeps the data, so installing again finds them.
Root: HKCU; Subkey: "Software\RedGiant"; ValueType: string; ValueName: "Version"; ValueData: "{#AppVersion}"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\RedGiant"; ValueType: string; ValueName: "DataDir"; ValueData: "{code:DataDir}"
; The command line in the user's PATH, only when chosen; taken out again on uninstall (CliPathOut).
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; ValueData: "{code:CliPathWith}"; Tasks: clipath; Check: CliPathMissing

[Run]
; A first installation asks; an update opens RedGiant by itself (CurStepChanged).
Filename: "{app}\RedGiant.exe"; Description: "{cm:LaunchProgram,RedGiant}"; Flags: nowait postinstall skipifsilent; Check: not IsUpdate

[Code]
const
  UninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{6F0E3B52-8D4A-4C1E-9B7A-2E1D5C9F4A10}_is1';

var
  Updating: Boolean;
  DataPage: TInputDirWizardPage;

{ The version already installed, from Windows' own list of programs; '' when there is none. }
function InstalledVersion(): String;
begin
  Result := '';
  if not RegQueryStringValue(HKCU, UninstallKey, 'DisplayVersion', Result) then
    if RegKeyExists(HKCU, UninstallKey) then Result := '?';
end;

function IsUpdate(): Boolean;
begin
  Result := Updating;
end;

{ A RedGiant from before 3.0 kept its data in a WSL disk (ext4.vhdx): it is not updated in place
  (the person's decision, 2026-11-05: uninstall, install again, import a backup if wanted). }
function OldWslInstall(): Boolean;
var
  Data: String;
begin
  Result := RegQueryStringValue(HKCU, 'Software\RedGiant', 'DataDir', Data) and
    FileExists(AddBackslash(Data) + 'ext4.vhdx');
end;

function InitializeSetup(): Boolean;
var
  Old: String;
begin
  Result := True;
  Old := InstalledVersion();
  if (Old <> '') and OldWslInstall() then begin
    SuppressibleMsgBox(FmtMessage(CustomMessage('OldWsl'), [Old]), mbInformation, MB_OK, IDOK);
    Result := False;
    Exit;
  end;
  Updating := Old <> '';
  if Updating and not WizardSilent() then
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

{ Where the projects, conversations, settings and the database live. }
function DataDir(Param: String): String;
var
  Kept: String;
begin
  if Updating and RegQueryStringValue(HKCU, 'Software\RedGiant', 'DataDir', Kept) then
    Result := Kept
  else if Updating then
    Result := ExpandConstant('{localappdata}\RedGiant\data')
  else
    Result := DataPage.Values[0];
end;

{ The user's own PATH (HKCU\Environment), '' when it has none. }
function UserPath(): String;
begin
  if not RegQueryStringValue(HKCU, 'Environment', 'Path', Result) then Result := '';
end;

function CliDir(): String;
begin
  Result := ExpandConstant('{app}\bin');
end;

{ True when the user's PATH does not hold RedGiant's bin folder yet (compared without case). }
function CliPathMissing(): Boolean;
begin
  Result := Pos(';' + Lowercase(CliDir()) + ';', ';' + Lowercase(UserPath()) + ';') = 0;
end;

{ The user's PATH with RedGiant's bin folder at the end; everything else as it was. }
function CliPathWith(Param: String): String;
begin
  Result := UserPath();
  if (Result <> '') and (Copy(Result, Length(Result), 1) <> ';') then Result := Result + ';';
  Result := Result + CliDir();
end;

{ Uninstalling takes RedGiant's bin folder out of the user's PATH again, and nothing else. }
procedure CliPathOut();
var
  Path, Low, Dir: String;
  P: Integer;
begin
  if not RegQueryStringValue(HKCU, 'Environment', 'Path', Path) then Exit;
  Path := ';' + Path + ';';
  Low := Lowercase(Path);
  Dir := ';' + Lowercase(CliDir()) + ';';
  P := Pos(Dir, Low);
  if P = 0 then Exit;
  Delete(Path, P, Length(Dir) - 1);
  Path := Copy(Path, 2, Length(Path) - 2);
  if Path = '' then
    RegDeleteValue(HKCU, 'Environment', 'Path')
  else
    RegWriteExpandStringValue(HKCU, 'Environment', 'Path', Path);
end;

{ An update shows nothing but its progress; it ends by opening RedGiant. }
function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := Updating and (PageID <> wpInstalling);
end;

{ What RedGiant left running (2026-11-05: 3.0.0 could leave Postgres on after closing, and setup
  could not replace its files, "Accesso negato"): Postgres stopped the proper way with its own
  pg_ctl, then whatever still runs from the program's or the engine's folder is stopped. }
procedure StopLeftovers();
var
  Code: Integer;
  Data, PgCtl, Cmd: String;
begin
  PgCtl := ExpandConstant('{app}\server\node_modules\@embedded-postgres\windows-x64\native\bin\pg_ctl.exe');
  if RegQueryStringValue(HKCU, 'Software\RedGiant', 'DataDir', Data) and FileExists(PgCtl)
    and DirExists(Data + '\postgres') then
    Exec(PgCtl, 'stop -D "' + Data + '\postgres" -m fast -w -t 30', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Cmd := '-NoProfile -NonInteractive -Command "Get-Process | Where-Object { $_.Path -like ''' +
    ExpandConstant('{app}') + '\*'' -or $_.Path -like ''' + ExpandConstant('{localappdata}') +
    '\RedGiant\engine\*'' } | Stop-Process -Force"';
  Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Cmd, '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

{ RedGiant asked to stop the proper way (server and Postgres with it); what is left after a
  minute is stopped by force, so its files can be replaced. }
procedure StopRedGiant();
var
  Code: Integer;
begin
  if FileExists(ExpandConstant('{app}\RedGiant.exe')) then
    Exec(ExpandConstant('{app}\RedGiant.exe'), '--quit', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/IM RedGiant.exe /F', '', SW_HIDE, ewWaitUntilTerminated, Code);
  StopLeftovers();
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  StopRedGiant();
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
begin
  { An update opens RedGiant again by itself. --after-update (3.5.3): a RedGiant page still open
    reloads by itself on the new version, and only when none comes back is a page opened. }
  if (CurStep = ssDone) and Updating then
    Exec(ExpandConstant('{app}\RedGiant.exe'), '--after-update', '', SW_SHOW, ewNoWait, Code);
end;

{ An update ends by itself: RedGiant was opened again at ssDone (CurStepChanged). }
procedure CurPageChanged(CurPageID: Integer);
begin
  if Updating and (CurPageID = wpFinished) then
    WizardForm.NextButton.OnClick(WizardForm.NextButton);
end;

{ A folder RedGiant made for itself (its name says so): only those are deleted whole. A folder
  the person chose (D:\, Documents) keeps everything that is not RedGiant's. }
function Ours(Dir: String): Boolean;
begin
  Result := (Dir <> '') and (Pos('redgiant', Lowercase(Dir)) > 0) and
    (Length(RemoveBackslashUnlessRoot(Dir)) > 3);
end;

procedure DeleteOurs(Dir: String);
begin
  if Ours(Dir) then DelTree(Dir, True, True, True);
end;

{ Bytes in a folder and everything under it. }
function FolderBytes(Dir: String): Extended;
var
  F: TFindRec;
begin
  Result := 0;
  if FindFirst(AddBackslash(Dir) + '*', F) then
    try
      repeat
        if (F.Name <> '.') and (F.Name <> '..') then begin
          if F.Attributes and FILE_ATTRIBUTE_DIRECTORY <> 0 then
            Result := Result + FolderBytes(AddBackslash(Dir) + F.Name)
          else
            Result := Result + F.SizeHigh * 4294967296.0 + F.SizeLow;
        end;
      until not FindNext(F);
    finally
      FindClose(F);
    end;
end;

{ The folders where models are kept outside the program's folder (an SSD chosen for streaming). }
function ModelDirs(): TArrayOfString;
var
  List: String;
  P: Integer;
begin
  SetArrayLength(Result, 0);
  if not RegQueryStringValue(HKCU, 'Software\RedGiant', 'ModelDirs', List) then Exit;
  while List <> '' do begin
    P := Pos(';', List);
    if P = 0 then P := Length(List) + 1;
    if Trim(Copy(List, 1, P - 1)) <> '' then begin
      SetArrayLength(Result, GetArrayLength(Result) + 1);
      Result[GetArrayLength(Result) - 1] := Trim(Copy(List, 1, P - 1));
    end;
    Delete(List, 1, P);
  end;
end;

{ How big the models are: those of the engine on Windows and those on other disks. }
function ModelsBytes(): Extended;
var
  Dirs: TArrayOfString;
  I: Integer;
begin
  Result := FolderBytes(ExpandConstant('{app}\engine'));
  Dirs := ModelDirs();
  for I := 0 to GetArrayLength(Dirs) - 1 do
    Result := Result + FolderBytes(Dirs[I]);
end;

function GbText(Bytes: Extended): String;
begin
  Result := Format('%.1f GB', [Bytes / 1073741824.0]);
end;

{ The models and the engines: the engine folder and the disks chosen for them. }
procedure DeleteModels();
var
  Dirs: TArrayOfString;
  I: Integer;
begin
  DelTree(ExpandConstant('{app}\engine'), True, True, True);
  Dirs := ModelDirs();
  for I := 0 to GetArrayLength(Dirs) - 1 do
    DeleteOurs(Dirs[I]);
  RegDeleteValue(HKCU, 'Software\RedGiant', 'ModelDirs');
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Data: String;
begin
  if CurUninstallStep <> usUninstall then Exit;
  StopRedGiant();
  CliPathOut();
  { Silent (2026-11-05: a plain MsgBox waited forever for an answer nobody could give): the
    data and the models stay. }
  if SuppressibleMsgBox(CustomMessage('KeepData'), mbConfirmation, MB_YESNO or MB_DEFBUTTON1, IDYES) = IDYES then begin
    { The projects stay; the models (often the biggest part) are asked about on their own. }
    if SuppressibleMsgBox(FmtMessage(CustomMessage('DeleteModels'), [GbText(ModelsBytes())]), mbConfirmation,
      MB_YESNO or MB_DEFBUTTON2, IDNO) = IDYES then
      DeleteModels();
    Exit;
  end;
  { Nothing stays: the models, the data folder (database included), the settings in the registry. }
  DeleteModels();
  if RegQueryStringValue(HKCU, 'Software\RedGiant', 'DataDir', Data) then begin
    DeleteOurs(Data);
    RemoveDir(Data);
  end;
  RegDeleteKeyIncludingSubkeys(HKCU, 'Software\RedGiant');
end;

{ What setup left beside the installed files (logs, the engine, caches): gone with the program
  when nothing was kept. }
procedure DeinitializeUninstall();
begin
  if not RegKeyExists(HKCU, 'Software\RedGiant') then
    DeleteOurs(ExpandConstant('{app}'));
end;
