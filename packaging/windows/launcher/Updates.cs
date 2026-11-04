// Updates (2026-11-03): at the first start of the day RedGiant looks for a newer version on
// GitHub. If there is one it asks: update now, later (asked again at the next start), or not for
// 1, 3 or 7 days. Updating downloads the installer with a real bar (amount, speed, time left)
// and runs it; the installer sees RedGiant is there, updates without questions and opens it again.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

static class Updates
{
    const string Key = @"Software\RedGiant";
    const string Latest = "https://api.github.com/repos/Frostmoore/redgiant2/releases/latest";
    static readonly bool It = CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "it";

    public sealed class Release
    {
        public string Version;
        public string Url;
        public long Size;
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

    static Release Find()
    {
        ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
        using (var w = new WebClient())
        {
            w.Headers[HttpRequestHeader.UserAgent] = "RedGiant-Updates";
            string json = w.DownloadString(Latest);
            var tag = Regex.Match(json, "\"tag_name\"\\s*:\\s*\"v?([0-9.]+)\"");
            var url = Regex.Match(json, "\"browser_download_url\"\\s*:\\s*\"([^\"]*RedGiant-Setup\\.exe)\"");
            if (!tag.Success || !url.Success) return null;
            long size = 0;
            var asset = Regex.Match(json, "\"size\"\\s*:\\s*(\\d+)[^{}]*RedGiant-Setup\\.exe|RedGiant-Setup\\.exe\"[^{}]*\"size\"\\s*:\\s*(\\d+)");
            if (asset.Success) long.TryParse(asset.Groups[1].Success ? asset.Groups[1].Value : asset.Groups[2].Value, out size);
            Diag.Log("update", "latest release on GitHub: " + tag.Groups[1].Value + " (" + size + " bytes)");
            return new Release { Version = tag.Groups[1].Value, Url = url.Groups[1].Value, Size = size };
        }
    }

    static System.Threading.Timer watcher;
    static string lastAsk;

    /**
     * «Look for updates» from RedGiant's settings (2026-11-04): update.json in the engine's
     * folder asks for a look now (snoozes ignored); the answer goes to update-status.json and,
     * when there is a newer version, the same question as every morning appears.
     */
    public static void Watch(Control owner, string folder)
    {
        watcher = new System.Threading.Timer(_ =>
        {
            string json;
            try { json = File.ReadAllText(Path.Combine(folder, "update.json")); } catch (Exception) { return; }
            var m = Regex.Match(json, "\"id\"\\s*:\\s*\"([^\"]+)\"");
            if (!m.Success || m.Groups[1].Value == lastAsk) return;
            lastAsk = m.Groups[1].Value;
            string id = lastAsk;
            string state, version = "";
            try
            {
                Release r = Find();
                Set("UpdateLastCheck", Today);
                if (r != null && Compare(Get("Version"), r.Version) < 0)
                {
                    state = "available";
                    version = r.Version;
                    Set("UpdateSnoozeUntil", null);
                    try { owner.BeginInvoke(new Action(() => Ask(r))); } catch (Exception) { }
                }
                else
                {
                    state = "latest";
                    version = Get("Version") ?? "";
                }
            }
            catch (Exception) { state = "unreachable"; }
            string answer = "{\"id\":\"" + id + "\",\"state\":\"" + state + "\",\"version\":\"" + version + "\"}";
            string file = Path.Combine(folder, "update-status.json");
            try { File.WriteAllText(file + ".tmp", answer); File.Copy(file + ".tmp", file, true); } catch (Exception) { }
        }, null, 2000, 2000);
    }

    /** Looks in the background; asks on the UI thread of `owner` when a newer version is out. */
    public static void Start(Control owner)
    {
        if (!Due()) return;
        var t = new Thread(() =>
        {
            Release r = null;
            try { r = Find(); } catch (Exception) { return; }
            Set("UpdateLastCheck", Today);
            if (r == null || Compare(Get("Version"), r.Version) >= 0)
            {
                Set("UpdatePending", null);
                return;
            }
            try { owner.BeginInvoke(new Action(() => Ask(r))); } catch (Exception) { }
        });
        t.IsBackground = true;
        t.Start();
    }

    static void Ask(Release r)
    {
        var f = Dialog(It ? "Aggiornamento di RedGiant" : "RedGiant update", 470, 210);
        var text = new Label
        {
            Text = It
                ? "È disponibile RedGiant " + r.Version + " (hai la " + (Get("Version") ?? "?") + ").\n\nVuoi aggiornarlo adesso? Scarico l'installazione e la apro: le tue conversazioni e i tuoi progetti restano."
                : "RedGiant " + r.Version + " is out (you have " + (Get("Version") ?? "?") + ").\n\nUpdate now? The installer is downloaded and run: your conversations and projects stay.",
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
        now.Click += (s, e) => { Set("UpdatePending", null); f.Close(); Download(r); };
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
        f.Show();
        f.Activate();
    }

    /** The installer, with the bar every download has: amount, speed of the last seconds, time left. */
    static void Download(Release r)
    {
        var f = Dialog(It ? "Scarico l'aggiornamento" : "Downloading the update", 470, 150);
        var what = new Label { Text = "RedGiant " + r.Version, Location = new Point(18, 16), Size = new Size(434, 24) };
        var detail = new Label { Text = "", Location = new Point(18, 48), Size = new Size(434, 40), ForeColor = Color.FromArgb(160, 166, 178), Font = new Font("Segoe UI", 9.5f) };
        var bar = new ProgressBar { Location = new Point(18, 100), Size = new Size(434, 14), Maximum = 1000 };
        f.Controls.AddRange(new Control[] { what, detail, bar });
        f.Show();
        string file = Path.Combine(Path.GetTempPath(), "RedGiant-Setup-" + r.Version + ".exe");
        var samples = new Queue<KeyValuePair<DateTime, long>>();
        var w = new WebClient();
        w.Headers[HttpRequestHeader.UserAgent] = "RedGiant-Updates";
        var downloadStarted = DateTime.Now;
        Diag.Log("update", "downloading " + r.Version + " from " + r.Url);
        w.DownloadProgressChanged += (s, e) =>
        {
            long total = e.TotalBytesToReceive > 0 ? e.TotalBytesToReceive : r.Size;
            long done = e.BytesReceived;
            var now = DateTime.Now;
            samples.Enqueue(new KeyValuePair<DateTime, long>(now, done));
            while (samples.Count > 1 && (now - samples.Peek().Key).TotalSeconds > 8) samples.Dequeue();
            double secs = (now - samples.Peek().Key).TotalSeconds;
            string speed = "", left = "";
            if (secs >= 1.5 && done > samples.Peek().Value)
            {
                double bps = (done - samples.Peek().Value) / secs;
                speed = " · " + (bps / 1048576.0).ToString("0.0", CultureInfo.CurrentCulture) + " MB/s";
                if (total > 0) left = " · " + Texts.Left((total - done) / bps);
            }
            detail.Text = Texts.Downloaded + " " + (done / 1048576) + " MB" + (total > 0 ? " " + Texts.Of + " " + (total / 1048576) + " MB" : "") + speed + left;
            if (total > 0) bar.Value = (int)Math.Min(1000, done * 1000 / total);
        };
        w.DownloadFileCompleted += (s, e) =>
        {
            if (e.Error != null || e.Cancelled)
            {
                Diag.Log("update", "download failed: " + (e.Error != null ? e.Error.Message : "cancelled"));
                f.Close();
                MessageBox.Show((It ? "Non sono riuscito a scaricare l'aggiornamento. Riprovo la prossima volta.\n\n" : "The update could not be downloaded. It is tried again next time.\n\n") + (e.Error != null ? e.Error.Message : ""), "RedGiant", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                Set("UpdatePending", r.Version);
                return;
            }
            Diag.Log("update", "downloaded in " + (int) (DateTime.Now - downloadStarted).TotalSeconds + " s, starting the installer");
            detail.Text = It ? "Apro l'installazione…" : "Opening the installer…";
            // The installer closes this RedGiant, updates without questions and opens it again.
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
