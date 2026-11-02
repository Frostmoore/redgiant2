// RedGiant.exe (G22): what the desktop icon opens on Windows. It starts the "RedGiant" WSL
// distribution, shows what it is doing the first time, opens the browser already signed in, and
// stays next to the clock with "Open RedGiant" and "Quit". Built with the C# compiler of .NET
// Framework 4, which every Windows has: no runtime to install.
//
//   RedGiant.exe               start (or, if already running, just open the browser)
//   RedGiant.exe --background  start without opening the browser (start with Windows)
using System;
using System.Diagnostics;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

static class Texts
{
    static readonly bool It = CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "it";
    public static string Title { get { return "RedGiant"; } }
    public static string Starting { get { return It ? "Avvio di RedGiant…" : "Starting RedGiant…"; } }
    public static string Open { get { return It ? "Apri RedGiant" : "Open RedGiant"; } }
    public static string Restart { get { return It ? "Riavvia" : "Restart"; } }
    public static string Quit { get { return It ? "Esci" : "Quit"; } }
    public static string Running { get { return It ? "RedGiant è acceso" : "RedGiant is running"; } }
    public static string Of { get { return It ? "di" : "of"; } }
    public static string Downloaded { get { return It ? "Scaricati" : "Downloaded"; } }
    public static string Left(double seconds)
    {
        if (seconds < 60) return It ? "manca meno di un minuto" : "less than a minute left";
        int min = (int)Math.Round(seconds / 60);
        if (min < 60) return It ? ("mancano circa " + min + " min") : ("about " + min + " min left");
        int h = min / 60, m = min % 60;
        return It ? ("mancano circa " + h + " h " + m + " min") : ("about " + h + " h " + m + " min left");
    }
    public static string Details { get { return It ? "Dettagli per chi ti aiuta:" : "Details for whoever helps you:"; } }
    public static string NotInstalled
    {
        get
        {
            return It
                ? "RedGiant non è installato bene su questo computer. Reinstallalo con RedGiant-Setup.exe."
                : "RedGiant is not installed correctly on this computer. Install it again with RedGiant-Setup.exe.";
        }
    }
    public static string Failed
    {
        get
        {
            return It
                ? "RedGiant non è riuscito a partire. Riprova; se succede ancora, chiedi aiuto."
                : "RedGiant could not start. Try again; if it happens again, ask for help.";
        }
    }
}

sealed class Launcher : ApplicationContext
{
    const string Distro = "RedGiant";
    readonly bool background;
    readonly NotifyIcon tray;
    readonly Form splash;
    readonly Label status;
    readonly Label detail;
    readonly ProgressBar bar;
    // The last seconds of the download (time, bytes): the speed is their average, so it does not jump.
    readonly Queue<KeyValuePair<DateTime, long>> samples =
        new Queue<KeyValuePair<DateTime, long>>();
    Process engine;
    string url;
    readonly StringBuilder log = new StringBuilder();

    public Launcher(bool background)
    {
        this.background = background;
        Icon icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);

        splash = new Form
        {
            Text = Texts.Title,
            Icon = icon,
            FormBorderStyle = FormBorderStyle.FixedDialog,
            MaximizeBox = false,
            MinimizeBox = false,
            StartPosition = FormStartPosition.CenterScreen,
            ClientSize = new Size(480, 150),
            BackColor = Color.FromArgb(21, 23, 28),
            ForeColor = Color.FromArgb(232, 230, 227),
            Font = new Font("Segoe UI", 11f),
        };
        status = new Label { Text = Texts.Starting, Dock = DockStyle.Top, Height = 58, Padding = new Padding(18, 20, 18, 0) };
        detail = new Label { Text = "", Dock = DockStyle.Top, Height = 40, Padding = new Padding(18, 4, 18, 0), Font = new Font("Segoe UI", 9.5f), ForeColor = Color.FromArgb(160, 166, 178) };
        bar = new ProgressBar { Style = ProgressBarStyle.Marquee, Dock = DockStyle.Bottom, Height = 10, MarqueeAnimationSpeed = 30, Maximum = 1000 };
        splash.Controls.Add(detail);
        splash.Controls.Add(status);
        splash.Controls.Add(bar);
        splash.FormClosing += (s, e) =>
        {
            // Closing the window only hides it: RedGiant keeps starting next to the clock.
            if (e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; splash.Hide(); }
        };

        var menu = new ContextMenuStrip();
        menu.Items.Add(Texts.Open, null, (s, e) => OpenBrowser());
        menu.Items.Add(Texts.Restart, null, (s, e) => { StopEngine(); StartEngine(); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(Texts.Quit, null, (s, e) => Quit());
        tray = new NotifyIcon { Icon = icon, Text = Texts.Title, ContextMenuStrip = menu, Visible = true };
        tray.DoubleClick += (s, e) => OpenBrowser();

        if (!DistroInstalled())
        {
            MessageBox.Show(Texts.NotInstalled, Texts.Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            Quit();
            return;
        }
        if (!background) splash.Show();
        StartEngine();
    }

    static bool DistroInstalled()
    {
        try
        {
            var p = Process.Start(new ProcessStartInfo("wsl.exe", "--list --quiet")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                // wsl.exe writes its own messages in UTF-16.
                StandardOutputEncoding = Encoding.Unicode,
            });
            string list = p.StandardOutput.ReadToEnd();
            p.WaitForExit();
            foreach (var line in list.Split('\n'))
                if (line.Trim().Trim('\0') == Distro) return true;
        }
        catch (Exception) { }
        return false;
    }

    // Windows' display adapters (G24.3): every GPU, NVIDIA or not, with its real memory, as
    // "name:GB;name:GB". The registry keeps the memory as a 64-bit number (WMI stops at 4 GB).
    static string WindowsGpus()
    {
        var list = new List<string>();
        try
        {
            using (var cls = Registry.LocalMachine.OpenSubKey(
                @"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}"))
            {
                if (cls == null) return "";
                foreach (var sub in cls.GetSubKeyNames())
                {
                    if (sub.Length != 4) continue;
                    using (var k = cls.OpenSubKey(sub))
                    {
                        if (k == null) continue;
                        var name = k.GetValue("DriverDesc") as string;
                        if (string.IsNullOrEmpty(name) || name.Contains("Microsoft") || name.Contains("Remote")) continue;
                        long bytes = 0;
                        object q = k.GetValue("HardwareInformation.qwMemorySize");
                        object d = k.GetValue("HardwareInformation.MemorySize");
                        if (q is long) bytes = (long)q;
                        else if (d is int) bytes = (uint)(int)d;
                        else if (d is byte[] && ((byte[])d).Length >= 4) bytes = BitConverter.ToUInt32((byte[])d, 0);
                        string gb = (bytes / 1073741824.0).ToString("0.0", CultureInfo.InvariantCulture);
                        list.Add(name.Replace(":", " ").Replace(";", " ").Trim() + ":" + gb);
                    }
                }
            }
        }
        catch (Exception) { }
        return string.Join(";", list.ToArray());
    }

    void StartEngine()
    {
        url = null;
        var info = new ProcessStartInfo("wsl.exe", "-d " + Distro + " -u root -- /usr/local/bin/redgiant-wsl run")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            // The script inside writes UTF-8.
            StandardOutputEncoding = Encoding.UTF8,
        };
        // The GPUs reach the distribution through WSLENV (only the variables it names cross over).
        info.EnvironmentVariables["REDGIANT_WIN_GPUS"] = WindowsGpus();
        string wslenv = Environment.GetEnvironmentVariable("WSLENV") ?? "";
        info.EnvironmentVariables["WSLENV"] = (wslenv.Length > 0 ? wslenv + ":" : "") + "REDGIANT_WIN_GPUS/u";
        engine = new Process { StartInfo = info, EnableRaisingEvents = true };
        string port = "7600", token = "";
        engine.OutputDataReceived += (s, e) =>
        {
            if (e.Data == null) return;
            string line = e.Data.Trim();
            lock (log) log.AppendLine(line);
            if (line.StartsWith("STEP "))
                Ui(() =>
                {
                    status.Text = line.Substring(5);
                    detail.Text = "";
                    bar.Style = ProgressBarStyle.Marquee;
                });
            else if (line.StartsWith("PROGRESS ")) Progress(line);
            else if (line.StartsWith("PORT=")) port = line.Substring(5);
            else if (line.StartsWith("TOKEN=")) token = line.Substring(6);
            else if (line == "READY")
            {
                url = "http://localhost:" + port + "/#token=" + token;
                Ui(() =>
                {
                    splash.Hide();
                    tray.Text = Texts.Running;
                    if (!background) OpenBrowser();
                });
            }
            else if (line.StartsWith("FAIL ")) Ui(() => ShowFailure(line.Substring(5)));
        };
        engine.ErrorDataReceived += (s, e) => { if (e.Data != null) lock (log) log.AppendLine(e.Data); };
        engine.Exited += (s, e) =>
        {
            // It stops only on failure or when we stop it.
            if (url == null) Ui(() => ShowFailure(""));
        };
        engine.Start();
        engine.BeginOutputReadLine();
        engine.BeginErrorReadLine();
    }

    static string Mb(long bytes)
    {
        return (bytes / 1048576.0).ToString(bytes < 10 * 1048576L ? "0.0" : "0", CultureInfo.CurrentCulture) + " MB";
    }

    /// "PROGRESS done total": the bar, the amounts, the speed of the last seconds and the time left.
    void Progress(string line)
    {
        var parts = line.Split(' ');
        long done, total;
        if (parts.Length < 3 || !long.TryParse(parts[1], out done) || !long.TryParse(parts[2], out total) || total <= 0) return;
        var now = DateTime.UtcNow;
        string speedText = "", leftText = "";
        lock (samples)
        {
            samples.Enqueue(new KeyValuePair<DateTime, long>(now, done));
            while (samples.Count > 1 && (now - samples.Peek().Key).TotalSeconds > 8) samples.Dequeue();
            var first = samples.Peek();
            double secs = (now - first.Key).TotalSeconds;
            if (secs >= 1.5 && done > first.Value)
            {
                double speed = (done - first.Value) / secs;
                speedText = (speed / 1048576.0).ToString(speed < 1048576 ? "0.00" : "0.0", CultureInfo.CurrentCulture) + " MB/s";
                leftText = done >= total ? "" : Texts.Left((total - done) / speed);
            }
        }
        string text = Texts.Downloaded + " " + Mb(done) + " " + Texts.Of + " " + Mb(total)
            + (speedText != "" ? " · " + speedText : "") + (leftText != "" ? " · " + leftText : "");
        int value = (int)Math.Min(1000, done * 1000 / total);
        Ui(() =>
        {
            bar.Style = ProgressBarStyle.Continuous;
            bar.Value = value;
            detail.Text = text;
        });
    }

    void ShowFailure(string why)
    {
        splash.Hide();
        string details;
        lock (log) details = log.ToString();
        MessageBox.Show(
            Texts.Failed + "\n\n" + Texts.Details + "\n" + why + "\n" + Tail(details, 1200),
            Texts.Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    static string Tail(string s, int n) { return s.Length <= n ? s : s.Substring(s.Length - n); }

    void OpenBrowser()
    {
        if (url == null) { splash.Show(); splash.Activate(); return; }
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch (Exception) { }
    }

    void StopEngine()
    {
        try { if (engine != null && !engine.HasExited) engine.Kill(); } catch (Exception) { }
        engine = null;
    }

    void Quit()
    {
        StopEngine();
        // The distribution (and everything in it) stops; the data stays.
        try
        {
            var p = Process.Start(new ProcessStartInfo("wsl.exe", "--terminate " + Distro) { UseShellExecute = false, CreateNoWindow = true });
            p.WaitForExit(15000);
        }
        catch (Exception) { }
        tray.Visible = false;
        ExitThread();
    }

    void Ui(Action a)
    {
        if (splash.IsHandleCreated) splash.BeginInvoke(a);
        else a();
    }

    [STAThread]
    static void Main(string[] args)
    {
        bool background = Array.IndexOf(args, "--background") >= 0;
        bool first;
        using (var single = new Mutex(true, "RedGiant.Launcher", out first))
        {
            if (!first)
            {
                // Already running: the icon just opens the browser through the running one.
                if (!background) Signal();
                return;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            var launcher = new Launcher(background);
            ListenForSignals(launcher);
            Application.Run(launcher);
        }
    }

    // A second click on the icon tells the running launcher to open the browser (an event).
    static void Signal()
    {
        try { using (var e = EventWaitHandle.OpenExisting("RedGiant.Launcher.Open")) e.Set(); } catch (Exception) { }
    }

    static void ListenForSignals(Launcher l)
    {
        var e = new EventWaitHandle(false, EventResetMode.AutoReset, "RedGiant.Launcher.Open");
        var t = new Thread(() =>
        {
            while (true) { e.WaitOne(); l.Ui(() => l.OpenBrowser()); }
        }) { IsBackground = true };
        t.Start();
    }
}
