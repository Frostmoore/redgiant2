// RedGiant.exe (G22): what the desktop icon opens on Windows. It starts the "RedGiant" WSL
// distribution, shows what it is doing the first time, opens the browser already signed in, and
// stays next to the clock with "Open RedGiant" and "Quit". Built with the C# compiler of .NET
// Framework 4, which every Windows has: no runtime to install.
//
//   RedGiant.exe               start (or, if already running, just open the browser)
//   RedGiant.exe --background  start without opening the browser (start with Windows)
//   RedGiant.exe --engine-only only the engine on Windows (G24.3b), without WSL
using System;
using System.Diagnostics;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Management;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using System.IO.Compression;
using System.Net;
using System.Text.RegularExpressions;
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
        WinEngine.Watch();
        StartEngine();
        // The first start of the day looks for a newer RedGiant (Updates.cs); its questions are
        // asked on the splash's thread, whose handle exists even when the splash stays hidden.
        if (!splash.IsHandleCreated) { var unused = splash.Handle; }
        Updates.Start(splash);
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
    /**
     * The computer's disks (2026-11-03), for the models streamed from an SSD: "letter|ssd|bus|
     * free GB|total GB" separated by ";" (ssd: ssd, hdd or ? when Windows does not say; bus:
     * nvme, sata, usb…). Read from Windows' storage classes; a failure leaves the list empty.
     */
    static string WindowsDisks()
    {
        var list = new List<string>();
        try
        {
            var media = new Dictionary<string, string>();
            var bus = new Dictionary<string, string>();
            var scope = new ManagementScope(@"\\.\root\Microsoft\Windows\Storage");
            using (var q = new ManagementObjectSearcher(scope, new ObjectQuery("SELECT DeviceId, MediaType, BusType FROM MSFT_PhysicalDisk")))
                foreach (ManagementObject d in q.Get())
                {
                    string id = Convert.ToString(d["DeviceId"]);
                    int mt = Convert.ToInt32(d["MediaType"]);
                    int bt = Convert.ToInt32(d["BusType"]);
                    media[id] = mt == 4 ? "ssd" : mt == 3 ? "hdd" : "?";
                    bus[id] = bt == 17 ? "nvme" : bt == 11 ? "sata" : bt == 7 ? "usb" : bt == 8 ? "raid" : "other";
                    // NVMe is solid state even when Windows leaves the media type unspecified.
                    if (bt == 17) media[id] = "ssd";
                }
            using (var q = new ManagementObjectSearcher(scope, new ObjectQuery("SELECT DriveLetter, DiskNumber FROM MSFT_Partition")))
                foreach (ManagementObject p in q.Get())
                {
                    char letter = Convert.ToChar(p["DriveLetter"]);
                    if (letter == '\0' || !char.IsLetter(letter)) continue;
                    string disk = Convert.ToString(p["DiskNumber"]);
                    var drive = new DriveInfo(letter + ":\\");
                    if (!drive.IsReady || drive.DriveType != DriveType.Fixed) continue;
                    list.Add(string.Format(CultureInfo.InvariantCulture, "{0}|{1}|{2}|{3:0.0}|{4:0.0}",
                        char.ToUpperInvariant(letter),
                        media.ContainsKey(disk) ? media[disk] : "?",
                        bus.ContainsKey(disk) ? bus[disk] : "other",
                        drive.AvailableFreeSpace / 1073741824.0,
                        drive.TotalSize / 1073741824.0));
                }
        }
        catch (Exception) { }
        return string.Join(";", list.ToArray());
    }

    /** The data folder the installer chose (registry), or the default one. */
    static string DataDir()
    {
        try
        {
            using (var k = Registry.CurrentUser.OpenSubKey(@"Software\RedGiant"))
            {
                var v = k == null ? null : k.GetValue("DataDir") as string;
                if (!string.IsNullOrEmpty(v)) return v;
            }
        }
        catch (Exception) { }
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RedGiant", "wsl");
    }

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
        info.EnvironmentVariables["REDGIANT_WIN_DISKS"] = WindowsDisks();
        // Where the distribution's disk is (its models among the data): the installer's choice.
        info.EnvironmentVariables["REDGIANT_WIN_DATA_DIR"] = DataDir();
        // The folder of the engine on Windows (/p: WSL sees it as /mnt/c/...).
        info.EnvironmentVariables["REDGIANT_WIN_ENGINE_DIR"] = WinEngine.Dir;
        string wslenv = Environment.GetEnvironmentVariable("WSLENV") ?? "";
        info.EnvironmentVariables["WSLENV"] = (wslenv.Length > 0 ? wslenv + ":" : "")
            + "REDGIANT_WIN_GPUS/u:REDGIANT_WIN_DISKS/u:REDGIANT_WIN_DATA_DIR/u:REDGIANT_WIN_ENGINE_DIR/up";
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
        WinEngine.Shutdown();
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
        // Only the engine on Windows, without WSL: for checking it (CI) and for whoever helps.
        if (Array.IndexOf(args, "--engine-only") >= 0)
        {
            WinEngine.Watch();
            new ManualResetEvent(false).WaitOne();
            return;
        }
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

// The engine on Windows itself (G24.3b): llama.cpp's official Vulkan build, for the GPUs that
// WSL cannot reach (AMD, Intel, built-in ones). RedGiant, inside WSL, writes what it wants in
// engine.json; this class runs it and writes what it is doing in engine-status.json, in a folder
// both see. The program is kept at a fixed path, the one the installer's firewall rule names.
static class WinEngine
{
    public static readonly string Dir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RedGiant", "engine");
    const int Port = 8091;
    static string Bin { get { return Path.Combine(Dir, "bin", "current"); } }
    static string Exe { get { return Path.Combine(Bin, "llama-server.exe"); } }
    static readonly object gate = new object();
    static System.Threading.Timer timer;
    static string lastId;
    static int generation;
    static Process server;
    static readonly Queue<string> log = new Queue<string>();

    public static void Watch()
    {
        foreach (var d in new[] { "models", "kv", "bin" }) Directory.CreateDirectory(Path.Combine(Dir, d));
        timer = new System.Threading.Timer(_ => Check(), null, 1000, 1000);
    }

    public static void Shutdown()
    {
        if (timer != null) timer.Dispose();
        lock (gate) { generation++; Kill(); }
    }

    static string Field(string json, string name)
    {
        var m = Regex.Match(json, "\"" + name + "\"\\s*:\\s*(\"((?:[^\"\\\\]|\\\\.)*)\"|null|-?\\d+)");
        if (!m.Success || m.Groups[1].Value == "null") return null;
        return m.Groups[2].Success && m.Groups[2].Length > 0 ? m.Groups[2].Value : m.Groups[1].Value.Trim('"');
    }

    static void Check()
    {
        string json;
        try { json = File.ReadAllText(Path.Combine(Dir, "engine.json")); } catch (Exception) { return; }
        string id = Field(json, "id");
        if (id == null || id == lastId) return;
        lastId = id;
        int gen;
        lock (gate) gen = ++generation;
        var t = new Thread(() => Handle(gen, id, Field(json, "model"), Field(json, "build"),
            Field(json, "ctx") ?? "65536", Field(json, "parallel") ?? "4")) { IsBackground = true };
        t.Start();
    }

    static string Esc(string s)
    {
        var b = new StringBuilder();
        foreach (char c in s ?? "")
        {
            if (c == '"' || c == '\\') b.Append('\\').Append(c);
            else if (c == '\n') b.Append("\\n");
            else if (c < ' ') b.Append(' ');
            else b.Append(c);
        }
        return b.ToString();
    }

    static void Status(int gen, string id, string state, string extra)
    {
        lock (gate)
        {
            if (gen != generation) return;
            string json = "{\"id\":\"" + Esc(id) + "\",\"state\":\"" + state + "\"" + (extra ?? "") + "}";
            string file = Path.Combine(Dir, "engine-status.json");
            try { File.WriteAllText(file + ".tmp", json); File.Copy(file + ".tmp", file, true); } catch (Exception) { }
        }
    }

    static string Tail()
    {
        lock (log) return string.Join("\n", log.ToArray());
    }

    static void Kill()
    {
        try { if (server != null && !server.HasExited) server.Kill(); } catch (Exception) { }
        server = null;
    }

    static void Handle(int gen, string id, string model, string build, string ctx, string parallel)
    {
        lock (gate) { if (gen != generation) return; Kill(); }
        if (model == null) { Status(gen, id, "stopped", null); return; }
        string phase = "download";
        try
        {
            string marker = Path.Combine(Bin, "build.txt");
            bool ready = File.Exists(Exe) && File.Exists(marker) && File.ReadAllText(marker).Trim() == build;
            if (!ready) Download(gen, id, build);
            phase = "firewall";
            Status(gen, id, "starting", null);
            if (!FirewallAllows()) AllowInFirewall();
            phase = "start";
            lock (log) log.Clear();
            var info = new ProcessStartInfo(Exe,
                "-m \"" + Path.Combine(Dir, "models", model) + "\" --host 0.0.0.0 --port " + Port
                + " -c " + ctx + " --parallel " + parallel + " --slot-save-path \"" + Path.Combine(Dir, "kv")
                + "\" --swa-full --kv-unified --jinja --n-gpu-layers 999")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = Bin,
            };
            var p = new Process { StartInfo = info };
            DataReceivedEventHandler keep = (s, e) =>
            {
                if (e.Data == null) return;
                lock (log) { log.Enqueue(e.Data); while (log.Count > 60) log.Dequeue(); }
            };
            p.OutputDataReceived += keep;
            p.ErrorDataReceived += keep;
            lock (gate) { if (gen != generation) return; p.Start(); server = p; }
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            Status(gen, id, "loading", null);
            for (;;)
            {
                Thread.Sleep(1000);
                lock (gate) if (gen != generation) return;
                string tail = Tail();
                // llama.cpp goes on with the CPU when it finds no GPU, saying so only here.
                if (tail.Contains("no usable GPU found"))
                {
                    lock (gate) Kill();
                    Status(gen, id, "failed", ",\"error\":\"no_gpu\",\"log\":\"" + Esc(tail) + "\"");
                    return;
                }
                if (p.HasExited)
                {
                    Status(gen, id, "failed", ",\"log\":\"" + Esc(tail) + "\"");
                    return;
                }
                if (Healthy())
                {
                    Status(gen, id, "ready", ",\"port\":" + Port);
                    return;
                }
            }
        }
        catch (Exception e)
        {
            Status(gen, id, "failed", ",\"error\":\"" + phase + "\",\"log\":\"" + Esc(e.Message + "\n" + Tail()) + "\"");
        }
    }

    const string Rule = "RedGiant local engine";

    static int Netsh(string args, bool elevated)
    {
        var info = new ProcessStartInfo("netsh.exe", args)
        {
            UseShellExecute = elevated,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
        };
        if (elevated) info.Verb = "runas";
        using (var p = Process.Start(info)) { p.WaitForExit(60000); return p.ExitCode; }
    }

    static bool FirewallAllows()
    {
        try { return Netsh("advfirewall firewall show rule name=\"" + Rule + "\"", false) == 0; }
        catch (Exception) { return false; }
    }

    /** RedGiant, inside WSL, reaches the engine through Windows' firewall: one rule, asked once. */
    static void AllowInFirewall()
    {
        int code = Netsh("advfirewall firewall add rule name=\"" + Rule + "\" dir=in action=allow"
            + " program=\"" + Exe + "\" protocol=TCP localport=" + Port + " remoteip=localsubnet profile=any", true);
        if (code != 0) throw new Exception("The firewall rule was not added (" + code + ")");
    }

    static bool Healthy()
    {
        try
        {
            var r = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + Port + "/health");
            r.Timeout = 2000;
            using (var res = (HttpWebResponse)r.GetResponse()) return res.StatusCode == HttpStatusCode.OK;
        }
        catch (Exception) { return false; }
    }

    /** llama.cpp's Vulkan build for Windows, from its GitHub release, into bin\current. */
    static void Download(int gen, string id, string build)
    {
        ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; // TLS 1.2
        string url = "https://github.com/ggml-org/llama.cpp/releases/download/" + build
            + "/llama-" + build + "-bin-win-vulkan-x64.zip";
        string zip = Path.Combine(Dir, "bin", build + ".zip");
        var req = (HttpWebRequest)WebRequest.Create(url);
        req.UserAgent = "RedGiant";
        using (var res = (HttpWebResponse)req.GetResponse())
        using (var input = res.GetResponseStream())
        using (var output = File.Create(zip))
        {
            long total = res.ContentLength, done = 0;
            var buf = new byte[1 << 16];
            var last = DateTime.MinValue;
            int n;
            while ((n = input.Read(buf, 0, buf.Length)) > 0)
            {
                output.Write(buf, 0, n);
                done += n;
                if ((DateTime.UtcNow - last).TotalMilliseconds > 500)
                {
                    last = DateTime.UtcNow;
                    Status(gen, id, "downloading", ",\"done\":" + done + (total > 0 ? ",\"total\":" + total : ""));
                }
                lock (gate) if (gen != generation) return;
            }
        }
        string fresh = Path.Combine(Dir, "bin", build);
        if (Directory.Exists(fresh)) Directory.Delete(fresh, true);
        ZipFile.ExtractToDirectory(zip, fresh);
        File.Delete(zip);
        // The program may sit in a folder of the archive: its folder becomes bin\current.
        string[] found = Directory.GetFiles(fresh, "llama-server.exe", SearchOption.AllDirectories);
        if (found.Length == 0) throw new Exception("llama-server.exe is not in " + url);
        if (Directory.Exists(Bin)) Directory.Delete(Bin, true);
        Directory.Move(Path.GetDirectoryName(found[0]), Bin);
        if (Directory.Exists(fresh)) Directory.Delete(fresh, true);
        File.WriteAllText(Path.Combine(Bin, "build.txt"), build);
    }
}

