// Updates (2026-11-03): at the first start of the day RedGiant looks for a newer version on
// GitHub. If there is one it asks: update now, later (asked again at the next start), or not for
// 1, 3 or 7 days.
//
// Updating (G36.18, differential): only what changed is downloaded. The release's manifest
// (checked against the sha256 GitHub's API gives for it, and against UpdateKey's signature when
// there is one) names every file; the ones missing here come down from the release's zip with
// Range requests (Delta.cs), with the bar every download has ("Downloading 4.2 MB instead of
// 85 MB", speed, time left), and the new version is put together beside the installed one. Then
// RedGiant stops its server and Postgres, swaps the folders and starts again as the new version,
// on trial: when its server answers the update stays, when it does not (or it does not start
// twice) the previous version is put back and the next update uses the installer. A stopped
// download goes on next time from where it was. Anything that does not add up (no manifest, a
// file that is not what the manifest says, most of the app changed) falls back to the old way:
// the whole installer, downloaded and run silently.
//
// Mandatory and breaking updates (G36.19): the release's release.json, signed with UpdateKey,
// says its kind. It is read at every start and every six hours. Mandatory: a window that does
// not close, «Update now» or «Close RedGiant». Breaking: never updated in place (no differential,
// no installer over it); a window opens RedGiant's page, where the backup is made and the clean
// install guided. A release.json that is listed but cannot be read or checked stops the update
// this time (it is never taken for normal).
//
// One window at a time (3.5.4, AskGate.cs): the start's look, the page's look and the six-hourly
// one never put a second update window on screen, and what the person answered in this session
// is not asked again. «Looking at what changed» hashes the installed files on several threads
// with a real count on the bar, and hashes.txt is filled in the background after an install or
// an update, so the next update reads none of them again.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

static class Updates
{
    const string Key = @"Software\RedGiant";
    const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\{6F0E3B52-8D4A-4C1E-9B7A-2E1D5C9F4A10}_is1";
    const string Latest = "https://api.github.com/repos/Frostmoore/redgiant2/releases/latest";
    const string Platform = "win-x64";
    const string ManifestAsset = "RedGiant-win-x64.manifest.json";
    const string ArchiveAsset = "RedGiant-win-x64.zip";
    static readonly bool It = CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "it";

    public sealed class Release
    {
        public string Version;
        public string Url;
        public long Size;
        public string ManifestUrl;
        /** The manifest's sha256 as GitHub's API gives it ("digest"), null when it does not. */
        public string ManifestSha256;
        public string SignatureUrl;
        public string ArchiveUrl;
        /** The same manifest gzipped (2026-11-08): about a quarter of the bytes; preferred. */
        public string ManifestGzUrl;
        public string ManifestGzSha256;
        /** G36.19: the release's signed metadata (null: none, or not validly signed). */
        public string InfoUrl;
        public string InfoSigUrl;
        public ReleaseInfo Info;
        /** "normal", "mandatory", "breaking", or "unchecked" (listed but unreadable: no update now). */
        public string Gate = "normal";
    }

    /** Set by the launcher: server, Postgres and engine stopped, so their files can be moved. */
    public static Action StopAll;
    /** Set by the launcher: leave now, nothing more to stop (another RedGiant is starting). */
    public static Action Exit;
    /** Set by the launcher: stop everything and leave (a mandatory update's «Close RedGiant»). */
    public static Action Quit;
    /** Set by the launcher: RedGiant's page in the browser (a breaking update's guide is there). */
    public static Action OpenPage;
    /** Where the installer put RedGiant (RedGiant.exe's folder). */
    public static string AppDir;
    /**
     * Set by the launcher (3.5.3, PageGate.cs): the update check's answer for the page. False:
     * nothing to update, «Later», a window closed, or an update that gave up; true: updating
     * (this RedGiant opens no page). Called on the UI thread.
     */
    public static Action<bool> Decided;
    /** An update question is on screen: the page waits for its answer. */
    public static bool Asking;
    /** Added to the arguments of the RedGiant started after an update (" --background" or ""). */
    public static string CarryArgs = "";
    static bool updating;
    /** The update window on screen (question, mandatory, breaking, progress), or null (AskGate.cs). */
    static Form window;
    /** Releases («kind version») the person already answered in this session: not asked again. */
    static readonly HashSet<string> answered = new HashSet<string>();
    /** Closing a mandatory window for the page's «Update now»: the only time it closes by itself. */
    static bool replacing;

    static string KeyOf(Release r) { return r.Gate + " " + r.Version; }

    /** UI thread: `f` is the update window on screen until it closes. */
    static void Track(Form f)
    {
        window = f;
        f.FormClosed += (s, e) => { if (window == f) window = null; };
    }

    /** UI thread: the update window on screen comes to the front. */
    static void Front()
    {
        var f = window;
        if (f == null || f.IsDisposed) return;
        try
        {
            if (f.WindowState == FormWindowState.Minimized) f.WindowState = FormWindowState.Normal;
            f.Show();
            f.Activate();
            f.BringToFront();
        }
        catch (Exception) { }
    }

    /**
     * UI thread: a look found `r` newer than the installed version; AskGate.cs says whether a
     * window opens. When none opens and none is on screen, the page may open (PageGate.cs).
     */
    static void Offer(Release r, AskGate.From from)
    {
        var step = AskGate.Decide(from, r.Gate, window != null, answered.Contains(KeyOf(r)), updating);
        Diag.Log("update", "found " + r.Version + " (" + r.Gate + ", " + from + "): " + (step == AskGate.Step.Show ? "asking" : step == AskGate.Step.Front ? "the window on screen comes forward" : "no window"));
        if (step == AskGate.Step.Front) { Front(); return; }
        if (step == AskGate.Step.None) { if (window == null) Decide(false); return; }
        if (r.Gate == "mandatory") Required(r);
        else if (r.Gate == "breaking") Breaking(r);
        else Ask(r);
    }

    /** The answer for the page; a «no» while an update runs counts for nothing (it gives up through GaveUp). */
    static void Decide(bool update)
    {
        Asking = false;
        if (update) updating = true;
        else if (updating) return;
        if (Decided != null) Decided(update);
    }

    /** UI thread: the update stopped here. A mandatory one asks again (the page still waits); otherwise the page opens. */
    static void GaveUp(Release r)
    {
        updating = false;
        if (r.Gate == "mandatory") { Required(r); return; }
        Decide(false);
    }

    /** The version the installer (or the last update) wrote, null before the first install. */
    public static string Installed { get { return Get("Version"); } }

    /** The CI points this at a release of its own (installers job); everyone else at GitHub. */
    static string Feed
    {
        get
        {
            string f = Environment.GetEnvironmentVariable("REDGIANT_UPDATE_FEED");
            return string.IsNullOrEmpty(f) ? Latest : f;
        }
    }

    static string Get(string name)
    {
        using (var k = Registry.CurrentUser.OpenSubKey(Key))
            return k == null ? null : k.GetValue(name) as string;
    }

    static void Set(string name, string value)
    {
        using (var k = Registry.CurrentUser.CreateSubKey(Key))
        {
            if (value == null) k.DeleteValue(name, false);
            else k.SetValue(name, value);
        }
    }

    /** The version Windows' list of programs shows (and the installer reads to know it updates). */
    static void SetListedVersion(string version)
    {
        try
        {
            using (var k = Registry.CurrentUser.OpenSubKey(UninstallKey, true))
                if (k != null) k.SetValue("DisplayVersion", version);
        }
        catch (Exception) { }
    }

    static string Today { get { return DateTime.Now.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture); } }

    /** Due: never snoozed past today, and not looked at today unless a question was left open. */
    static bool Due()
    {
        DateTime until;
        var snooze = Get("UpdateSnoozeUntil");
        if (snooze != null && DateTime.TryParse(snooze, CultureInfo.InvariantCulture, DateTimeStyles.None, out until)
            && DateTime.Now < until)
            return false;
        return Get("UpdatePending") != null || Get("UpdateLastCheck") != Today;
    }

    /** "1.56.0" against "1.57.0": negative when a is older. */
    public static int Compare(string a, string b)
    {
        var x = (a ?? "0").TrimStart('v').Split('.');
        var y = (b ?? "0").TrimStart('v').Split('.');
        for (int i = 0; i < Math.Max(x.Length, y.Length); i++)
        {
            int p = 0, q = 0;
            if (i < x.Length) int.TryParse(x[i], out p);
            if (i < y.Length) int.TryParse(y[i], out q);
            if (p != q) return p.CompareTo(q);
        }
        return 0;
    }

    static WebClient Client()
    {
        ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072; // TLS 1.2
        var w = new WebClient();
        w.Headers[HttpRequestHeader.UserAgent] = "RedGiant-Updates";
        return w;
    }

    static Release Find()
    {
        string json;
        using (var w = Client()) json = w.DownloadString(Feed);
        var d = new JavaScriptSerializer { MaxJsonLength = int.MaxValue }.DeserializeObject(json) as Dictionary<string, object>;
        if (d == null || !(d.ContainsKey("tag_name") && d["tag_name"] is string)) return null;
        var r = new Release { Version = ((string)d["tag_name"]).TrimStart('v') };
        if (!Regex.IsMatch(r.Version, @"^\d+\.\d+\.\d+$")) return null;
        var assets = d.ContainsKey("assets") ? d["assets"] as object[] : null;
        foreach (var o in assets ?? new object[0])
        {
            var a = o as Dictionary<string, object>;
            if (a == null || !(a.ContainsKey("name") && a["name"] is string)) continue;
            string name = (string)a["name"];
            string url = a.ContainsKey("browser_download_url") ? a["browser_download_url"] as string : null;
            if (name == "RedGiant-Setup.exe")
            {
                r.Url = url;
                if (a.ContainsKey("size") && a["size"] != null) r.Size = Convert.ToInt64(a["size"], CultureInfo.InvariantCulture);
            }
            else if (name == ManifestAsset)
            {
                r.ManifestUrl = url;
                string digest = a.ContainsKey("digest") ? a["digest"] as string : null;
                if (digest != null && digest.StartsWith("sha256:")) r.ManifestSha256 = digest.Substring(7).ToLowerInvariant();
            }
            else if (name == ManifestAsset + ".gz")
            {
                r.ManifestGzUrl = url;
                string digest = a.ContainsKey("digest") ? a["digest"] as string : null;
                if (digest != null && digest.StartsWith("sha256:")) r.ManifestGzSha256 = digest.Substring(7).ToLowerInvariant();
            }
            else if (name == ManifestAsset + ".sig") r.SignatureUrl = url;
            else if (name == ReleaseInfo.Asset) r.InfoUrl = url;
            else if (name == ReleaseInfo.Asset + ".sig") r.InfoSigUrl = url;
            else if (name == ArchiveAsset) r.ArchiveUrl = url;
        }
        if (r.Url == null) return null;
        Kind(r);
        Diag.Log("update", "latest release: " + r.Version + " (installer " + r.Size + " bytes, manifest " + (r.ManifestUrl != null ? "yes" : "no") + ", " + r.Gate + ")");
        return r;
    }

    /** The release's kind from its signed release.json (G36.19). */
    static void Kind(Release r)
    {
        if (r.InfoUrl == null)
        {
            // Releases before G36.19 (or a test feed): nothing says otherwise.
            r.Gate = ReleaseInfo.Assess(null, Installed, r.Version);
            return;
        }
        try
        {
            byte[] bytes;
            string sig = null;
            using (var w = Client()) bytes = w.DownloadData(r.InfoUrl);
            if (r.InfoSigUrl != null) using (var w = Client()) sig = w.DownloadString(r.InfoSigUrl);
            r.Info = ReleaseInfo.Verified(bytes, sig, UpdateKey.PublicKeyXml);
            if (r.Info == null && UpdateKey.PublicKeyXml != "")
                Diag.Log("update", "release.json of " + r.Version + " is not validly signed: its kind is ignored");
            r.Gate = ReleaseInfo.Assess(r.Info, Installed, r.Version);
        }
        catch (Exception e)
        {
            // Listed but not readable now: it could be a breaking release; no update this time.
            Diag.Log("update", "release.json of " + r.Version + " could not be read: " + e.Message);
            r.Gate = "unchecked";
        }
    }

    static System.Threading.Timer watcher;
    static string lastAsk;
    static bool askNow;

    /**
     * «Look for updates» from RedGiant's settings (2026-11-04): update.json in the engine's
     * folder asks for a look now (snoozes ignored); the answer goes to update-status.json and,
     * when there is a newer version, the same question as every morning appears.
     */
    public static void Watch(Control owner, string folder)
    {
        // A state written for another version (before an update, or a rollback) goes at once.
        string status = Path.Combine(folder, "update-status.json");
        try
        {
            string fresh = File.Exists(status) ? AskGate.StatusAfterStart(File.ReadAllText(status), Get("Version")) : null;
            if (fresh != null)
            {
                File.WriteAllText(status + ".tmp", fresh);
                File.Copy(status + ".tmp", status, true);
                Diag.Log("update", "update-status.json refreshed for " + Get("Version"));
            }
        }
        catch (Exception e) { Diag.Log("update", "update-status.json not refreshed: " + e.Message); }
        watcher = new System.Threading.Timer(_ =>
        {
            string json, request = Path.Combine(folder, "update.json");
            try
            {
                // Left by an earlier session (3.5.4: it opened a second question at every start,
                // and an old «quit» would have closed RedGiant): only this session's server asks.
                if (!AskGate.Fresh(File.GetLastWriteTimeUtc(request), startedUtc)) return;
                json = File.ReadAllText(request);
            }
            catch (Exception) { return; }
            var m = Regex.Match(json, "\"id\"\\s*:\\s*\"([^\"]+)\"");
            if (!m.Success || m.Groups[1].Value == lastAsk) return;
            lastAsk = m.Groups[1].Value;
            string id = lastAsk;
            // The update window's buttons in the page (G36.19): update now, quit, uninstall.
            var act = Regex.Match(json, "\"action\"\\s*:\\s*\"([a-z]+)\"");
            if (act.Success)
            {
                Act(owner, act.Groups[1].Value);
                return;
            }
            string state, version = "";
            try
            {
                Release r = Find();
                Set("UpdateLastCheck", Today);
                if (r != null && Compare(Get("Version"), r.Version) < 0 && r.Gate != "unchecked")
                {
                    state = "available";
                    version = r.Version;
                    Set("UpdateSnoozeUntil", null);
                    // One window at a time; what was answered in this session is only reported.
                    try { owner.BeginInvoke(new Action(() => Offer(r, AskGate.From.Page))); } catch (Exception) { }
                }
                else
                {
                    state = "latest";
                    version = Get("Version") ?? "";
                }
            }
            catch (Exception e)
            {
                // Why, for whoever helps (2026-11-05: «GitHub non ha risposto» with no trace).
                state = "unreachable";
                Diag.Log("update", "check failed: " + e.GetType().Name + ": " + e.Message);
            }
            string answer = "{\"id\":\"" + id + "\",\"state\":\"" + state + "\",\"version\":\"" + version + "\"}";
            string file = Path.Combine(folder, "update-status.json");
            try { File.WriteAllText(file + ".tmp", answer); File.Copy(file + ".tmp", file, true); } catch (Exception) { }
        }, null, 2000, 2000);
    }

    /**
     * Looks in the background; asks on the UI thread of `owner` when a newer version is out.
     * `now` (RedGiant.exe --update-now, the CI's check): looks whatever the day and updates
     * without asking.
     */
    public static void Start(Control owner, bool now)
    {
        askNow = now;
        // Every start looks (a mandatory or breaking release must not wait for tomorrow); a
        // normal one is asked about only at the first start of the day, as before.
        bool due = now || Due();
        Look(owner, due);
        // And every six hours while RedGiant runs, for mandatory and breaking releases only.
        periodic = new System.Threading.Timer(_ => Look(owner, false), null, 6 * 3600 * 1000, 6 * 3600 * 1000);
    }

    static System.Threading.Timer periodic;
    /** When this RedGiant started: an update.json older than that is an earlier session's. */
    static readonly DateTime startedUtc = StartedUtc();

    static DateTime StartedUtc()
    {
        try { return Process.GetCurrentProcess().StartTime.ToUniversalTime(); }
        catch (Exception) { return DateTime.UtcNow; }
    }

    static void Look(Control owner, bool askNormal)
    {
        var t = new Thread(() =>
        {
            Release r = null;
            // Nothing to ask: the page may open (PageGate.cs).
            Action nothing = () => { try { owner.BeginInvoke(new Action(() => Decide(false))); } catch (Exception) { } };
            try { r = Find(); } catch (Exception e) { Diag.Log("update", "check failed: " + e.Message); nothing(); return; }
            if (askNormal) Set("UpdateLastCheck", Today);
            if (r == null || Compare(Get("Version"), r.Version) >= 0 || r.Gate == "none")
            {
                Set("UpdatePending", null);
                nothing();
                return;
            }
            if (r.Gate == "unchecked") { nothing(); return; }
            var from = askNormal ? AskGate.From.Morning : AskGate.From.Background;
            try
            {
                owner.BeginInvoke(new Action(() =>
                {
                    if (askNow && r.Gate != "breaking" && !updating && window == null) Update(r);
                    else Offer(r, from);
                }));
            }
            catch (Exception) { }
        });
        t.IsBackground = true;
        t.Start();
    }

    /** The page's buttons (update.json with an action), on the UI thread of `owner`. */
    static void Act(Control owner, string action)
    {
        Diag.Log("update", "the page asked: " + action);
        if (action == "quit") { try { owner.BeginInvoke(new Action(() => { if (Quit != null) Quit(); })); } catch (Exception) { } return; }
        if (action == "uninstall") { try { owner.BeginInvoke(new Action(Uninstall)); } catch (Exception) { } return; }
        if (action != "update") return;
        var t = new Thread(() =>
        {
            Release r = null;
            try { r = Find(); } catch (Exception e) { Diag.Log("update", "check failed: " + e.Message); return; }
            if (r == null || r.Gate == "none" || r.Gate == "unchecked") return;
            try
            {
                owner.BeginInvoke(new Action(() =>
                {
                    // Already updating: its window comes forward, nothing starts twice.
                    if (updating) { Front(); return; }
                    if (r.Gate == "breaking") { Offer(r, AskGate.From.Page); return; }
                    // A question on screen gives way to the update the page asked for.
                    var old = window;
                    Update(r);
                    if (old != null && old != window) { replacing = true; try { old.Close(); } finally { replacing = false; } }
                }));
            }
            catch (Exception) { }
        });
        t.IsBackground = true;
        t.Start();
    }

    /** Text of the release's reason for this window, or none. */
    static string NoteFor(Release r)
    {
        string n = r.Info != null ? r.Info.Note(It, r.Gate) : null;
        return n == null ? "" : "\n\n" + n;
    }

    /**
     * A mandatory update (G36.19): the window does not close; RedGiant updates now or closes.
     * Until then the server refuses the agents' work (nothing is lost).
     */
    static void Required(Release r)
    {
        Asking = true;
        var f = Dialog(It ? "È necessario aggiornare RedGiant" : "RedGiant must be updated", 500, 250);
        f.ControlBox = false;
        bool leaving = false;
        f.FormClosing += (s, e) => { if (!leaving && !replacing && e.CloseReason == CloseReason.UserClosing) e.Cancel = true; };
        Track(f);
        var text = new Label
        {
            Text = (It
                ? "Serve RedGiant " + r.Version + " (hai la " + (Installed ?? "?") + "): questo aggiornamento non può aspettare. Finché non aggiorni, agenti e automazioni restano fermi; conversazioni e progetti sono al sicuro."
                : "RedGiant " + r.Version + " is needed (you have " + (Installed ?? "?") + "): this update cannot wait. Until you update, agents and automations wait; conversations and projects are safe.") + NoteFor(r),
            Location = new Point(18, 16),
            Size = new Size(464, 160),
        };
        var now = Button(It ? "Aggiorna ora" : "Update now", 18, 196, 170, true);
        var close = Button(It ? "Chiudi RedGiant" : "Close RedGiant", 196, 196, 170, false);
        f.Controls.AddRange(new Control[] { text, now, close });
        now.Click += (s, e) => { leaving = true; Decide(true); f.Close(); Update(r); };
        close.Click += (s, e) => { leaving = true; f.Close(); if (Quit != null) Quit(); };
        f.Show();
        f.Activate();
    }

    /** A breaking update (G36.19): never applied here; the page makes the backup and guides the clean install. */
    static void Breaking(Release r)
    {
        Asking = true;
        var f = Dialog(It ? "Questa versione richiede un'installazione pulita" : "This version needs a clean install", 500, 250);
        var text = new Label
        {
            Text = (It
                ? "RedGiant " + r.Version + " non si può installare sopra la " + (Installed ?? "?") + ": è cambiato troppo dentro. Nella pagina di RedGiant faccio prima un backup di tutto nella cartella Documenti, poi ti guido a disinstallare e installare la versione nuova, che rimette tutto a posto."
                : "RedGiant " + r.Version + " cannot be installed over " + (Installed ?? "?") + ": too much changed inside. In RedGiant's page a backup of everything goes into your Documents first, then you are guided to uninstall and install the new version, which puts everything back.") + NoteFor(r),
            Location = new Point(18, 16),
            Size = new Size(464, 160),
        };
        var open = Button(It ? "Apri la guida" : "Open the guide", 18, 196, 170, true);
        var later = Button(It ? "Più tardi" : "Later", 196, 196, 120, false);
        f.Controls.AddRange(new Control[] { text, open, later });
        bool guide = false;
        open.Click += (s, e) => { guide = true; f.Close(); };
        later.Click += (s, e) => f.Close();
        // However it closes, the page may open; the guide asks for it even at a start in the background.
        // Answered for this session: the page shows the guide its own way from now on (AskGate.cs).
        Track(f);
        f.FormClosed += (s, e) => { answered.Add(KeyOf(r)); if (guide && OpenPage != null) OpenPage(); Decide(false); };
        f.Show();
        f.Activate();
    }

    /** The uninstaller, after a yes on the desktop: RedGiant stops and leaves while it runs. */
    static void Uninstall()
    {
        string unins = AppDir != null ? Path.Combine(AppDir, "unins000.exe") : null;
        if (unins == null || !File.Exists(unins))
        {
            MessageBox.Show(It ? "Non trovo il disinstallatore: disinstalla RedGiant da Impostazioni di Windows > App." : "The uninstaller was not found: uninstall RedGiant from Windows Settings > Apps.", "RedGiant", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        var yes = MessageBox.Show(
            It ? "Chiudo RedGiant e apro il suo disinstallatore. Il backup che hai fatto resta nella cartella Documenti. Continuo?" : "RedGiant closes and its uninstaller opens. The backup you made stays in your Documents. Go on?",
            "RedGiant", MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2, (MessageBoxOptions)0x40000);
        if (yes != DialogResult.Yes) return;
        Diag.Log("update", "starting the uninstaller for a clean install");
        if (StopAll != null) StopAll();
        try { Process.Start(new ProcessStartInfo(unins) { UseShellExecute = true }); }
        catch (Exception e) { Diag.Log("update", "the uninstaller did not start: " + e.Message); }
        if (Exit != null) Exit();
    }

    static void Ask(Release r)
    {
        Asking = true;
        var f = Dialog(It ? "Aggiornamento di RedGiant" : "RedGiant update", 470, 210);
        var text = new Label
        {
            Text = It
                ? "È disponibile RedGiant " + r.Version + " (hai la " + (Get("Version") ?? "?") + ").\n\nVuoi aggiornarlo adesso? Scarico solo quello che è cambiato e riavvio RedGiant: le tue conversazioni e i tuoi progetti restano."
                : "RedGiant " + r.Version + " is out (you have " + (Get("Version") ?? "?") + ").\n\nUpdate now? Only what changed is downloaded, then RedGiant restarts: your conversations and projects stay.",
            Location = new Point(18, 16),
            Size = new Size(434, 96),
        };
        var now = Button(It ? "Aggiorna adesso" : "Update now", 18, 150, 150, true);
        var later = Button(It ? "Più tardi" : "Later", 176, 150, 110, false);
        var days = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Location = new Point(294, 152), Size = new Size(158, 28) };
        days.Items.AddRange(It
            ? new object[] { "Rimanda di…", "1 giorno", "3 giorni", "7 giorni" }
            : new object[] { "Snooze for…", "1 day", "3 days", "7 days" });
        days.SelectedIndex = 0;
        f.Controls.AddRange(new Control[] { text, now, later, days });
        bool chose = false;
        now.Click += (s, e) => { chose = true; Set("UpdatePending", null); Decide(true); f.Close(); Update(r); };
        // Later: asked again at the next start.
        later.Click += (s, e) => { Set("UpdatePending", r.Version); f.Close(); };
        days.SelectedIndexChanged += (s, e) =>
        {
            int[] n = { 0, 1, 3, 7 };
            if (days.SelectedIndex == 0) return;
            Set("UpdateSnoozeUntil", DateTime.Now.AddDays(n[days.SelectedIndex]).ToString("s", CultureInfo.InvariantCulture));
            Set("UpdatePending", r.Version);
            f.Close();
        };
        // «Later», a snooze or the window closed: the page opens (after «Update now» this is ignored),
        // and this release is not asked about again in this session (AskGate.cs).
        Track(f);
        f.FormClosed += (s, e) => { if (!chose) answered.Add(KeyOf(r)); Decide(false); };
        f.Show();
        f.Activate();
    }

    static string Mb(long bytes)
    {
        return (bytes / 1048576.0).ToString(bytes < 10 * 1048576L ? "0.0" : "0", CultureInfo.CurrentCulture) + " MB";
    }

    /** The bar's line: amount, speed of the last seconds, time left (the person's rule for every download). */
    sealed class Speed
    {
        readonly Queue<KeyValuePair<DateTime, long>> samples = new Queue<KeyValuePair<DateTime, long>>();
        public string Line(long done, long total)
        {
            var now = DateTime.Now;
            samples.Enqueue(new KeyValuePair<DateTime, long>(now, done));
            while (samples.Count > 1 && (now - samples.Peek().Key).TotalSeconds > 8) samples.Dequeue();
            double secs = (now - samples.Peek().Key).TotalSeconds;
            string speed = "", left = "";
            if (secs >= 1.5 && done > samples.Peek().Value)
            {
                double bps = (done - samples.Peek().Value) / secs;
                speed = " · " + (bps / 1048576.0).ToString(bps < 1048576 ? "0.00" : "0.0", CultureInfo.CurrentCulture) + " MB/s";
                if (total > done) left = " · " + Texts.Left((total - done) / bps);
            }
            return Texts.Downloaded + " " + Mb(done) + (total > 0 ? " " + Texts.Of + " " + Mb(total) : "") + speed + left;
        }
    }

    /** The bar's line while the installed files are compared: how many of how many, time left. */
    static string ScanLine(int done, int total, double seconds)
    {
        var c = CultureInfo.CurrentCulture;
        string left = "";
        if (seconds >= 3 && done > 0 && total > done) left = " · " + Texts.Left((total - done) * seconds / done);
        return (It ? "Cerco cosa è cambiato: " : "Looking at what changed: ") + done.ToString("N0", c) + " " + Texts.Of + " " + total.ToString("N0", c) + (It ? " file" : " files") + left;
    }

    static string HashesFile { get { return Path.Combine(AppDir, "update", "hashes.txt"); } }

    static Thread warmer;
    static volatile bool warmStop;

    /** The fill of hashes.txt stops (an update is about to compare) and its work is saved. */
    static void StopWarm()
    {
        warmStop = true;
        var t = warmer;
        if (t != null) t.Join(15000);
    }

    /**
     * hashes.txt filled in the background (3.5.4), so the next update's «Looking at what changed»
     * reads none of the installed files: a while after the server answered (after an install with
     * the whole installer, or an update), one file at a time, at the background priority of
     * processor and disk, pausing while the PC is busy. Nothing is done when every file is
     * remembered already (only their sizes and times are read).
     */
    static void StartWarm()
    {
        if (warmer != null || AppDir == null) return;
        // A minute and a half after the server answered. The CI sets it shorter, and its runner is
        // always busy starting things: there the fill does not wait for a quiet PC.
        int delay;
        bool ci = int.TryParse(Environment.GetEnvironmentVariable("REDGIANT_WARM_DELAY_MS"), out delay);
        if (!ci) delay = 90000;
        var t = new Thread(() =>
        {
            Thread.Sleep(Math.Max(0, delay));
            if (warmStop || updating || trial || File.Exists(StateFile)) return;
            Delta.BackgroundMode();
            var started = DateTime.Now;
            int looked = 0, pauses = 0;
            Diag.Log("update", "filling hashes.txt in the background");
            var unread = new List<string>();
            int hashed = Delta.Warm(AppDir, HashesFile, () =>
            {
                if (warmStop || updating) return false;
                // Every 500 files: while the PC is busy (an agent, a build, a game) wait a little,
                // a minute at most each time and half an hour in all, then go on anyway.
                if (++looked % 500 == 0 && !ci)
                    for (int i = 0; i < 6 && pauses < 180 && !warmStop && Busy(); i++, pauses++) Thread.Sleep(10000);
                return !warmStop && !updating;
            }, unread);
            Diag.Log("update", "hashes of the installed files: " + hashed + " hashed now, " + looked + " looked at, in " + (int)(DateTime.Now - started).TotalSeconds + " s, " + pauses + " pauses" + (warmStop ? " (stopped for an update)" : "") + (unread.Count > 0 ? ", " + unread.Count + " could not be read (" + string.Join("; ", unread.GetRange(0, Math.Min(3, unread.Count))) + ")" : ""));
        });
        t.IsBackground = true;
        t.Priority = ThreadPriority.Lowest;
        warmer = t;
        t.Start();
    }

    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    static extern bool GetSystemTimes(out long idle, out long kernel, out long user);

    /** The processors more than three quarters busy over the last second (false when Windows cannot say). */
    static bool Busy()
    {
        try
        {
            long i1, k1, u1, i2, k2, u2;
            if (!GetSystemTimes(out i1, out k1, out u1)) return false;
            Thread.Sleep(1000);
            if (!GetSystemTimes(out i2, out k2, out u2)) return false;
            long all = (k2 - k1) + (u2 - u1), idle = i2 - i1;
            return all > 0 && idle * 4 < all;
        }
        catch (Exception) { return false; }
    }

    static string Staging(string version) { return Path.Combine(AppDir, "update", version); }
    static string StateFile { get { return Path.Combine(AppDir, "update", "state.txt"); } }

    /** The manifest of `r`, refused unless it is the one GitHub lists and (with a key) signed. */
    static UpdateManifest Manifest(Release r)
    {
        byte[] bytes;
        if (r.ManifestGzUrl != null)
        {
            // The gzipped copy: its digest is the .gz's; the signature is over the JSON inside.
            byte[] gz;
            using (var w = Client()) gz = w.DownloadData(r.ManifestGzUrl);
            if (r.ManifestGzSha256 != null && Delta.Sha256Bytes(gz) != r.ManifestGzSha256)
                throw new UpdateException("the manifest is not the one the release lists");
            using (var input = new GZipStream(new MemoryStream(gz), CompressionMode.Decompress))
            using (var output = new MemoryStream())
            {
                input.CopyTo(output);
                bytes = output.ToArray();
            }
            if (r.ManifestGzSha256 == null && r.ManifestSha256 != null && Delta.Sha256Bytes(bytes) != r.ManifestSha256)
                throw new UpdateException("the manifest is not the one the release lists");
            if (r.ManifestGzSha256 != null) r.ManifestSha256 = r.ManifestGzSha256;
        }
        else
        {
            using (var w = Client()) bytes = w.DownloadData(r.ManifestUrl);
            if (r.ManifestSha256 != null && Delta.Sha256Bytes(bytes) != r.ManifestSha256)
                throw new UpdateException("the manifest is not the one the release lists");
        }
        if (UpdateKey.PublicKeyXml != "")
        {
            if (r.SignatureUrl == null) throw new UpdateException("the manifest is not signed");
            string sig;
            using (var w = Client()) sig = w.DownloadString(r.SignatureUrl);
            if (!Delta.SignatureValid(bytes, sig, UpdateKey.PublicKeyXml)) throw new UpdateException("the manifest's signature is not valid");
        }
        else if (r.ManifestSha256 == null) throw new UpdateException("the manifest cannot be checked (no digest, no key)");
        var m = UpdateManifest.Parse(System.Text.Encoding.UTF8.GetString(bytes));
        if (m.Version != r.Version || m.Platform != Platform) throw new UpdateException("the manifest is for " + m.Platform + " " + m.Version);
        return m;
    }

    /** Older downloads that will never be used (another version), unless a swap is on trial. */
    static void CleanOthers(string keep)
    {
        try
        {
            string root = Path.Combine(AppDir, "update");
            if (!Directory.Exists(root) || File.Exists(StateFile)) return;
            foreach (var d in Directory.GetDirectories(root))
                if (Path.GetFileName(d) != keep && !Delta.Swapped(d)) Directory.Delete(d, true);
        }
        catch (Exception) { }
    }

    /** "Aggiorna adesso": the differential way when it can be, the installer otherwise. */
    static void Update(Release r)
    {
        // A breaking release is never put over the installed one (G36.19), not even by the installer.
        if (r.Gate == "breaking") { Breaking(r); return; }
        if (r.Gate == "unchecked") { Decide(false); return; }
        // From here this RedGiant leaves for the new one: it opens no page (PageGate.cs).
        Decide(true);
        if (r.ManifestUrl == null || r.ArchiveUrl == null || AppDir == null || Installed == null || Get("UpdateBroken") == r.Version)
        {
            Diag.Log("update", "the whole installer: " + (r.ManifestUrl == null ? "no manifest in the release" : Get("UpdateBroken") == r.Version ? "this version was rolled back once" : "no differential update here"));
            Download(r);
            return;
        }
        var f = Dialog(It ? "Scarico l'aggiornamento" : "Downloading the update", 470, 150);
        var what = new Label { Text = "RedGiant " + r.Version, Location = new Point(18, 16), Size = new Size(434, 24) };
        var detail = new Label { Text = It ? "Cerco cosa è cambiato…" : "Looking at what changed…", Location = new Point(18, 48), Size = new Size(434, 40), ForeColor = Color.FromArgb(160, 166, 178), Font = new Font("Segoe UI", 9.5f) };
        var bar = new ProgressBar { Location = new Point(18, 100), Size = new Size(434, 14), Maximum = 1000, Style = ProgressBarStyle.Marquee, MarqueeAnimationSpeed = 30 };
        f.Controls.AddRange(new Control[] { what, detail, bar });
        Track(f);
        f.Show();
        Action<Action> ui = a => { try { f.BeginInvoke(a); } catch (Exception) { } };
        var t = new Thread(() =>
        {
            string staging = Staging(r.Version);
            var started = DateTime.Now;
            try
            {
                var m = Manifest(r);
                // The fill in the background gives way (what it hashed is in hashes.txt by now).
                StopWarm();
                // «Looking at what changed: 12,000 of 27,374 files», with the download's bar (3.5.4).
                var scanStarted = DateTime.Now;
                var lastScan = DateTime.MinValue;
                object scanLock = new object();
                ui(() => { bar.Style = ProgressBarStyle.Continuous; bar.Value = 0; });
                Action<int, int> scanned = (done, total) =>
                {
                    lock (scanLock)
                    {
                        if ((DateTime.Now - lastScan).TotalMilliseconds < 250 && done < total) return;
                        lastScan = DateTime.Now;
                    }
                    string line = ScanLine(done, total, (DateTime.Now - scanStarted).TotalSeconds);
                    int value = total > 0 ? (int)Math.Min(1000, (long)done * 1000 / total) : 1000;
                    ui(() => { detail.Text = line; bar.Value = value; });
                };
                int threads = Delta.HashThreads;
                var plan = Delta.Compare(m, AppDir, Delta.Gap, HashesFile, threads, scanned);
                Diag.Log("update", "looked at " + m.Files.Count + " installed files in " + (int)(DateTime.Now - scanStarted).TotalMilliseconds + " ms on " + threads + " threads");
                long full = r.Size > 0 ? r.Size : m.InstallerSize;
                Diag.Log("update", "differential " + Installed + " -> " + r.Version + ": " + plan.Fetch.Count + " of " + m.Files.Count + " files, " + plan.Bytes + " bytes in " + plan.Runs.Count + " requests (installer " + full + ")");
                // Most of the app changed: one installer is quicker than many requests.
                if (full > 0 && plan.Bytes > full * 6 / 10) throw new UpdateException("most of the app changed");
                CleanOthers(r.Version);
                ui(() =>
                {
                    what.Text = It
                        ? "RedGiant " + r.Version + " · scarico " + Mb(plan.Bytes) + " invece di " + Mb(full)
                        : "RedGiant " + r.Version + " · downloading " + Mb(plan.Bytes) + " instead of " + Mb(full);
                    bar.Style = ProgressBarStyle.Continuous;
                });
                var speed = new Speed();
                var last = DateTime.MinValue;
                Action<long, long> progress = (done, total) =>
                {
                    if ((DateTime.Now - last).TotalMilliseconds < 250 && done < total) return;
                    last = DateTime.Now;
                    string line = speed.Line(done, total);
                    int value = total > 0 ? (int)Math.Min(1000, done * 1000 / total) : 1000;
                    ui(() => { detail.Text = line; bar.Value = value; });
                };
                // A file that is not what the manifest says is downloaded once more, then given up.
                try { Delta.Fetch(plan, new HttpRangeSource(r.ArchiveUrl), staging, progress, null); }
                catch (UpdateException e)
                {
                    Diag.Log("update", "once more: " + e.Message);
                    Delta.Fetch(plan, new HttpRangeSource(r.ArchiveUrl), staging, progress, null);
                }
                ui(() => { detail.Text = It ? "Metto insieme la versione nuova…" : "Putting the new version together…"; bar.Style = ProgressBarStyle.Marquee; });
                Delta.Build(m, plan, AppDir, staging);
                Diag.Log("update", "downloaded and checked in " + (int)(DateTime.Now - started).TotalSeconds + " s");
                ui(() =>
                {
                    detail.Text = It ? "Riavvio RedGiant con la versione nuova…" : "Restarting RedGiant as the new version…";
                    Apply(r, m, staging, f);
                });
            }
            catch (IOException e) { Network(r, f, e); }
            catch (WebException e) { Network(r, f, e); }
            catch (Exception e)
            {
                Diag.Log("update", "differential update given up, the whole installer instead: " + e.GetType().Name + ": " + e.Message);
                ui(() => { f.Close(); Download(r); });
            }
        });
        t.IsBackground = true;
        t.Start();
    }

    /** The network went away: what came down stays, the next try goes on from there. */
    static void Network(Release r, Form f, Exception e)
    {
        Diag.Log("update", "download stopped: " + e.Message);
        Set("UpdatePending", r.Version);
        try
        {
            f.BeginInvoke(new Action(() =>
            {
                f.Close();
                MessageBox.Show((It ? "Non sono riuscito a scaricare l'aggiornamento. Riprovo la prossima volta, da dove ero arrivato.\n\n" : "The update could not be downloaded. It is tried again next time, from where it stopped.\n\n") + e.Message, "RedGiant", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                // A mandatory update stays mandatory: its window comes back. Otherwise the page opens.
                GaveUp(r);
            }));
        }
        catch (Exception) { }
    }

    static void SaveState(string phase, string version, string from, int starts)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(StateFile));
        File.WriteAllText(StateFile + ".tmp", "phase=" + phase + "\r\nversion=" + version + "\r\nfrom=" + from + "\r\nstarts=" + starts + "\r\n");
        if (File.Exists(StateFile)) File.Delete(StateFile);
        File.Move(StateFile + ".tmp", StateFile);
    }

    static Dictionary<string, string> LoadState()
    {
        var d = new Dictionary<string, string>();
        try
        {
            foreach (var line in File.ReadAllLines(StateFile))
            {
                int eq = line.IndexOf('=');
                if (eq > 0) d[line.Substring(0, eq)] = line.Substring(eq + 1);
            }
        }
        catch (Exception) { return null; }
        return d.ContainsKey("phase") && d.ContainsKey("version") && d.ContainsKey("from") ? d : null;
    }

    /** UI thread: the new version in place of the old one, then RedGiant again, as the new one. */
    static void Apply(Release r, UpdateManifest m, string staging, Form f)
    {
        string from = Installed;
        Diag.Log("update", "stopping RedGiant to swap " + from + " -> " + m.Version);
        if (StopAll != null) StopAll();
        try
        {
            SaveState("swapping", m.Version, from, 0);
            Delta.Swap(m, AppDir, staging);
        }
        catch (Exception e)
        {
            // Undone already (Delta.Swap): the installed version starts again, the installer next time.
            Diag.Log("update", "swap failed: " + e.Message);
            try { File.Delete(StateFile); } catch (Exception) { }
            Set("UpdateBroken", m.Version);
            Set("UpdatePending", m.Version);
            // Started by an update all the same: it waits for this one to leave, and for the open page.
            Relaunch("--after-update");
            return;
        }
        SaveState("trial", m.Version, from, 0);
        Set("Version", m.Version);
        SetListedVersion(m.Version);
        Diag.Log("update", "swapped in " + m.Version + ", starting it on trial");
        try { f.Close(); } catch (Exception) { }
        Relaunch("--after-update");
    }

    /** RedGiant.exe of the folder (new or old, whichever is there now) starts; this one leaves. */
    static void Relaunch(string args)
    {
        try { Process.Start(new ProcessStartInfo(Path.Combine(AppDir, "RedGiant.exe"), args + CarryArgs) { UseShellExecute = false }); }
        catch (Exception e) { Diag.Log("update", "could not start RedGiant again: " + e.Message); }
        if (Exit != null) Exit();
    }

    static bool trial;
    static string trialVersion, trialFrom;

    /**
     * Before anything starts (Main): a swap interrupted halfway is undone; a version on trial that
     * already failed to start twice is rolled back. False: this RedGiant must leave (the one in the
     * folder now was started instead).
     */
    public static bool BeforeStart(string appDir, bool background)
    {
        AppDir = appDir;
        var s = LoadState();
        if (s == null) { Housekeeping(); return true; }
        string staging = Staging(s["version"]);
        int starts = 0;
        if (s.ContainsKey("starts")) int.TryParse(s["starts"], out starts);
        if (s["phase"] == "trial" && starts < 2)
        {
            SaveState("trial", s["version"], s["from"], starts + 1);
            trial = true;
            trialVersion = s["version"];
            trialFrom = s["from"];
            return true;
        }
        Diag.Log("update", s["phase"] == "trial" ? "the new version did not start twice: rolling back" : "a swap was interrupted: undoing it");
        try { Delta.Rollback(AppDir, staging); }
        catch (Exception e) { Diag.Log("update", "rollback failed: " + e.Message); return true; }
        Set("Version", s["from"]);
        SetListedVersion(s["from"]);
        if (s["phase"] == "trial") Set("UpdateBroken", s["version"]);
        try { File.Delete(StateFile); } catch (Exception) { }
        try { Process.Start(new ProcessStartInfo(Path.Combine(AppDir, "RedGiant.exe"), "--rolled-back " + s["version"] + (background ? " --background" : "")) { UseShellExecute = false }); }
        catch (Exception) { return true; }
        return false;
    }

    /** Left behind by a finished update (the old version still running then, or busy). */
    static void Housekeeping()
    {
        var t = new Thread(() =>
        {
            Thread.Sleep(30000);
            try
            {
                string root = Path.Combine(AppDir, "update");
                if (!Directory.Exists(root) || File.Exists(StateFile)) return;
                foreach (var d in Directory.GetDirectories(root))
                    if (Directory.Exists(Path.Combine(d, "prev")) && !Delta.Swapped(d)) Delta.Commit(d);
            }
            catch (Exception) { }
        });
        t.IsBackground = true;
        t.Start();
    }

    /** The server answered: an update on trial stays. */
    public static void Healthy()
    {
        if (!trial) { StartWarm(); return; }
        trial = false;
        Diag.Log("update", "RedGiant " + trialVersion + " answered: the update stays");
        try { File.Delete(StateFile); } catch (Exception) { }
        Set("UpdateBroken", null);
        string staging = Staging(trialVersion);
        var t = new Thread(() =>
        {
            // The old RedGiant.exe may still be closing.
            for (int i = 0; i < 10 && !Delta.Commit(staging); i++) Thread.Sleep(3000);
            // The files that came with the update are not in hashes.txt yet. Only now: they are
            // hard links to staging's blobs, and hashing one while Commit deletes its other name
            // fails (3.5.5, the CI's «hashes.txt holds 27393 of 27395 files»).
            StartWarm();
        });
        t.IsBackground = true;
        t.Start();
    }

    /**
     * UI thread: the server of a version on trial stopped before answering (or never answered).
     * The previous version comes back and starts; true when that happened (no failure message:
     * the old version will say what went on).
     */
    public static bool Failed()
    {
        if (!trial) return false;
        trial = false;
        Diag.Log("update", "RedGiant " + trialVersion + " did not start: putting " + trialFrom + " back");
        if (StopAll != null) StopAll();
        try { Delta.Rollback(AppDir, Staging(trialVersion)); }
        catch (Exception e) { Diag.Log("update", "rollback failed: " + e.Message); return false; }
        Set("Version", trialFrom);
        SetListedVersion(trialFrom);
        Set("UpdateBroken", trialVersion);
        try { File.Delete(StateFile); } catch (Exception) { }
        Relaunch("--rolled-back " + trialVersion);
        return true;
    }

    /** RedGiant.exe --rolled-back <version>: says so, once, without stopping anything. */
    public static void RolledBack(Control owner, string version)
    {
        try
        {
            owner.BeginInvoke(new Action(() =>
            {
                var f = Dialog(It ? "Aggiornamento di RedGiant" : "RedGiant update", 470, 170);
                var text = new Label
                {
                    Text = It
                        ? "L'aggiornamento a RedGiant " + version + " non è partito: ho rimesso la " + (Installed ?? "?") + ", come prima.\n\nLa prossima volta lo aggiorno con l'installazione completa."
                        : "The update to RedGiant " + version + " did not start: " + (Installed ?? "?") + " is back, as before.\n\nNext time it is updated with the whole installer.",
                    Location = new Point(18, 16),
                    Size = new Size(434, 96),
                };
                var ok = Button("OK", 342, 122, 110, true);
                ok.Click += (s, e) => f.Close();
                f.Controls.AddRange(new Control[] { text, ok });
                f.Show();
            }));
        }
        catch (Exception) { }
    }

    /** The installer, with the bar every download has: amount, speed of the last seconds, time left. */
    static void Download(Release r)
    {
        if (r.Gate == "breaking" || r.Gate == "unchecked") return;
        Decide(true);
        var f = Dialog(It ? "Scarico l'aggiornamento" : "Downloading the update", 470, 150);
        var what = new Label { Text = "RedGiant " + r.Version, Location = new Point(18, 16), Size = new Size(434, 24) };
        var detail = new Label { Text = "", Location = new Point(18, 48), Size = new Size(434, 40), ForeColor = Color.FromArgb(160, 166, 178), Font = new Font("Segoe UI", 9.5f) };
        var bar = new ProgressBar { Location = new Point(18, 100), Size = new Size(434, 14), Maximum = 1000 };
        f.Controls.AddRange(new Control[] { what, detail, bar });
        Track(f);
        f.Show();
        string file = Path.Combine(Path.GetTempPath(), "RedGiant-Setup-" + r.Version + ".exe");
        var speed = new Speed();
        var w = Client();
        var downloadStarted = DateTime.Now;
        Diag.Log("update", "downloading " + r.Version + " from " + r.Url);
        w.DownloadProgressChanged += (s, e) =>
        {
            long total = e.TotalBytesToReceive > 0 ? e.TotalBytesToReceive : r.Size;
            detail.Text = speed.Line(e.BytesReceived, total);
            if (total > 0) bar.Value = (int)Math.Min(1000, e.BytesReceived * 1000 / total);
        };
        w.DownloadFileCompleted += (s, e) =>
        {
            if (e.Error != null || e.Cancelled)
            {
                Diag.Log("update", "download failed: " + (e.Error != null ? e.Error.Message : "cancelled"));
                f.Close();
                MessageBox.Show((It ? "Non sono riuscito a scaricare l'aggiornamento. Riprovo la prossima volta.\n\n" : "The update could not be downloaded. It is tried again next time.\n\n") + (e.Error != null ? e.Error.Message : ""), "RedGiant", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                Set("UpdatePending", r.Version);
                GaveUp(r);
                return;
            }
            Diag.Log("update", "downloaded in " + (int) (DateTime.Now - downloadStarted).TotalSeconds + " s, starting the installer");
            detail.Text = It ? "Apro l'installazione…" : "Opening the installer…";
            // The installer closes this RedGiant, updates without questions and opens it again
            // (--after-update: a page still open comes back by itself, otherwise it opens one).
            Process.Start(new ProcessStartInfo(file, "/SILENT /SUPPRESSMSGBOXES /NORESTART") { UseShellExecute = true });
        };
        w.DownloadFileAsync(new Uri(r.Url), file);
    }

    static Form Dialog(string title, int width, int height)
    {
        return new Form
        {
            Text = title,
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath),
            FormBorderStyle = FormBorderStyle.FixedDialog,
            MaximizeBox = false,
            MinimizeBox = false,
            StartPosition = FormStartPosition.CenterScreen,
            ClientSize = new Size(width, height),
            BackColor = Color.FromArgb(21, 23, 28),
            ForeColor = Color.FromArgb(232, 230, 227),
            Font = new Font("Segoe UI", 10.5f),
            TopMost = true,
        };
    }

    static Button Button(string text, int x, int y, int width, bool primary)
    {
        return new Button
        {
            Text = text,
            Location = new Point(x, y),
            Size = new Size(width, 32),
            FlatStyle = FlatStyle.Flat,
            BackColor = primary ? Color.FromArgb(239, 75, 58) : Color.FromArgb(37, 41, 50),
            ForeColor = Color.White,
        };
    }
}
