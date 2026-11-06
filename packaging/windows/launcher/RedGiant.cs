// RedGiant.exe (G22; RedGiant 3.0, G30.2: no WSL): what the desktop icon opens on Windows. It
// starts RedGiant's server with the Node that came with the installer (the server starts its own
// Postgres), waits until it answers, opens the browser already signed in, and stays next to the
// clock with "Open RedGiant" and "Quit". Built with the C# compiler of .NET Framework 4, which
// every Windows has: no runtime to install.
//
//   RedGiant.exe               start (or, if already running, just open the browser)
//   RedGiant.exe --background  start without opening the browser (start with Windows)
//   RedGiant.exe --engine-only only the engine on Windows (G24.3b), without the server
//   RedGiant.exe --quit        asks the running RedGiant to stop (server and database), and waits
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
    public static string Moving(string to, long percent)
    {
        return (It ? "Sposto RedGiant in " : "Moving RedGiant to ") + to + " · " + percent + "%";
    }
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

        if (!File.Exists(NodeExe) || !File.Exists(ServerMain))
        {
            MessageBox.Show(Texts.NotInstalled, Texts.Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            Quit();
            return;
        }
        if (!background) splash.Show();
        WinEngine.Watch();
        // Models moved to another SSD (Moves.cs), the splash saying how far it is.
        Moves.Say = (text) => Ui(() => { status.Text = text; bar.Style = ProgressBarStyle.Marquee; splash.Show(); });
        Moves.Watch();
        Memory.Watch();
        StartEngine();
        // The first start of the day looks for a newer RedGiant (Updates.cs); its questions are
        // asked on the splash's thread, whose handle exists even when the splash stays hidden.
        if (!splash.IsHandleCreated) { var unused = splash.Handle; }
        Updates.Start(splash);
        Updates.Watch(splash, WinEngine.Dir);
    }

    /** Where the installer put Node, the server and the web page (next to RedGiant.exe). */
    static string AppDir { get { return Path.GetDirectoryName(Application.ExecutablePath); } }
    static string NodeExe { get { return Path.Combine(AppDir, "node", "node.exe"); } }
    static string ServerMain { get { return Path.Combine(AppDir, "server", "dist", "main.js"); } }

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
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RedGiant", "data");
    }

    /** The server's token: made the first time, kept in the data folder (only this user reads it). */
    static string Token()
    {
        string dir = DataDir();
        Directory.CreateDirectory(dir);
        string file = Path.Combine(dir, "token.txt");
        try { string t = File.ReadAllText(file).Trim(); if (t.Length >= 32) return t; } catch (Exception) { }
        var bytes = new byte[30];
        using (var rng = System.Security.Cryptography.RandomNumberGenerator.Create()) rng.GetBytes(bytes);
        string token = BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant();
        File.WriteAllText(file, token);
        return token;
    }

    /** 7600 when free; otherwise the next free port (an older RedGiant or another program). */
    static int FreePort()
    {
        for (int port = 7600; port < 7700; port++)
        {
            try
            {
                var l = new System.Net.Sockets.TcpListener(IPAddress.Loopback, port);
                l.Start();
                l.Stop();
                return port;
            }
            catch (Exception) { }
        }
        return 7600;
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
        string token = Token();
        int port = FreePort();
        var info = new ProcessStartInfo(NodeExe, "\"" + ServerMain + "\"")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            // Closing it is how the server is asked to stop (Postgres with it).
            RedirectStandardInput = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            WorkingDirectory = AppDir,
        };
        var env = info.EnvironmentVariables;
        env["REDGIANT_TOKEN"] = token;
        env["DATABASE_URL"] = "embedded";
        env["REDGIANT_DATA_DIR"] = DataDir();
        env["REDGIANT_PORT"] = port.ToString(CultureInfo.InvariantCulture);
        env["REDGIANT_HOST"] = "127.0.0.1";
        env["REDGIANT_WEB_DIR"] = Path.Combine(AppDir, "web");
        env["REDGIANT_WIN_ENGINE_DIR"] = WinEngine.Dir;
        env["REDGIANT_HOST_ENGINE_DIR"] = WinEngine.Dir;
        env["REDGIANT_WIN_HOST"] = "127.0.0.1";
        env["REDGIANT_HOST_GPUS"] = WindowsGpus();
        env["REDGIANT_HOST_DISKS"] = WindowsDisks();
        env["REDGIANT_HOST_DATA_DIR"] = DataDir();
        env["REDGIANT_STOP_ON_STDIN_END"] = "1";
        // The installed version: its release has the patched engine (G32.2, «next layer ahead»).
        env["REDGIANT_VERSION"] = Updates.Installed ?? "";
        env["NODE_ENV"] = "production";
        engine = new Process { StartInfo = info, EnableRaisingEvents = true };
        var startedAt = DateTime.Now;
        Diag.Log("server", "starting RedGiant's server on port " + port);
        DataReceivedEventHandler keep = (s, e) =>
        {
            if (e.Data == null) return;
            lock (log) log.AppendLine(e.Data);
            Diag.Log("server", e.Data);
        };
        engine.OutputDataReceived += keep;
        engine.ErrorDataReceived += keep;
        var self = engine;
        engine.Exited += (s, e) =>
        {
            // It stops only on failure or when we stop it.
            if (url == null && engine == self) Ui(() => ShowFailure(""));
        };
        engine.Start();
        engine.BeginOutputReadLine();
        engine.BeginErrorReadLine();
        // Ready when it answers (the first start makes the database: a few seconds more).
        var t = new Thread(() =>
        {
            for (int i = 0; i < 600 && engine == self && !self.HasExited; i++)
            {
                try
                {
                    var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/health");
                    req.Timeout = 2000;
                    using (var r = (HttpWebResponse)req.GetResponse())
                        if (r.StatusCode == HttpStatusCode.OK)
                        {
                            Diag.Log("server", "ready after " + (int)(DateTime.Now - startedAt).TotalMilliseconds + " ms");
                            url = "http://localhost:" + port + "/#token=" + token;
                            Ui(() =>
                            {
                                splash.Hide();
                                tray.Text = Texts.Running;
                                if (!background) OpenBrowser();
                            });
                            return;
                        }
                }
                catch (Exception) { }
                Thread.Sleep(500);
            }
        }) { IsBackground = true };
        t.Start();
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

    /** Asks the server to stop (it closes Postgres too); after 30 seconds it is stopped by force. */
    void StopEngine()
    {
        var p = engine;
        engine = null;
        url = null;
        if (p == null) return;
        try
        {
            if (!p.HasExited)
            {
                p.StandardInput.Close();
                if (!p.WaitForExit(30000)) p.Kill();
            }
        }
        catch (Exception) { try { p.Kill(); } catch (Exception) { } }
    }

    void Quit()
    {
        WinEngine.Shutdown();
        StopEngine();
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
        // The installer and the uninstaller stop RedGiant this way: killing it would leave the
        // server and Postgres running, holding the files they must replace.
        if (Array.IndexOf(args, "--quit") >= 0)
        {
            try { using (var e = EventWaitHandle.OpenExisting("RedGiant.Launcher.Quit")) e.Set(); }
            catch (Exception) { return; }
            using (var m = new Mutex(false, "RedGiant.Launcher"))
            {
                try { if (m.WaitOne(60000)) m.ReleaseMutex(); }
                catch (AbandonedMutexException) { }
            }
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
        var quit = new EventWaitHandle(false, EventResetMode.AutoReset, "RedGiant.Launcher.Quit");
        var q = new Thread(() => { quit.WaitOne(); l.Ui(() => l.Quit()); }) { IsBackground = true };
        q.Start();
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
    /**
     * Which llama.cpp build runs (2026-11-04): "cuda" for NVIDIA cards, natively on Windows
     * (in WSL the card sits behind a virtualisation layer), "vulkan" for the others.
     */
    static string flavor = "vulkan";
    /**
     * "cuda-prefetch" (G32.2, «next layer ahead»): llama.cpp with RedGiant's patch, from
     * RedGiant's release of the version asked, in a folder of its own next to the official build.
     */
    static string Bin
    {
        get
        {
            return Path.Combine(Dir, "bin", flavor == "cuda-prefetch" ? "current-cuda-prefetch" : flavor == "cuda" ? "current-cuda" : "current");
        }
    }
    const string PrefetchZip = "llama-redgiant-win-cuda12.8-x64.zip";
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

    /** The memory the engine's process holds now (Memory.cs), 0 when it is not running. */
    public static long EngineBytes()
    {
        lock (gate)
        {
            try
            {
                if (server == null || server.HasExited) return 0;
                server.Refresh();
                return server.WorkingSet64;
            }
            catch (Exception) { return 0; }
        }
    }

    /** Stops the engine now (its models are being moved); a new request starts it again. */
    public static void Stop()
    {
        lock (gate) { generation++; Kill(); }
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
        string wanted = Field(json, "flavor") == "cuda" ? "cuda" : "vulkan";
        // The patched build only for CUDA, and only of a version written as one ("3.2.0").
        string release = Field(json, "release");
        if (release != null && !Regex.IsMatch(release, @"^\d+\.\d+\.\d+$")) release = null;
        if (wanted == "cuda" && Field(json, "prefetch") == "1" && release != null) wanted = "cuda-prefetch";
        var t = new Thread(() => Handle(gen, id, Field(json, "model"), Field(json, "build"),
            Field(json, "ctx") ?? "65536", Field(json, "parallel") ?? "4", Field(json, "args"),
            Field(json, "fit"), Field(json, "preload"), Field(json, "draft"), wanted,
            Field(json, "template"), release)) { IsBackground = true };
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

    /** Extra flags for llama-server from RedGiant (SSD stream, 2026-11-03): plain words only. */
    static string SafeArgs(string args)
    {
        if (string.IsNullOrEmpty(args)) return "";
        return Regex.IsMatch(args, "^[A-Za-z0-9 _.=-]*$") ? " " + args.Trim() : "";
    }

    /** Every file of a model: one, or all the parts of a split one ("x-00001-of-00003.gguf"). */
    static string[] ModelParts(string model)
    {
        string dir = Path.Combine(Dir, "models");
        var m = Regex.Match(model, @"^(.*)-\d{5}-of-(\d{5})\.gguf$");
        if (!m.Success) return new[] { Path.Combine(dir, model) };
        int of = int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture);
        var parts = new string[of];
        for (int i = 0; i < of; i++)
            parts[i] = Path.Combine(dir, string.Format(CultureInfo.InvariantCulture, "{0}-{1:00000}-of-{2:00000}.gguf", m.Groups[1].Value, i + 1, of));
        return parts;
    }

    /**
     * The model read once from start to end before the engine starts (2026-11-04): it stays in
     * Windows' cache, and the first message does not wait for the disk. Progress in bytes.
     */
    static void Preload(int gen, string id, string model)
    {
        var parts = ModelParts(model);
        long total = 0;
        foreach (var f in parts) total += new FileInfo(f).Length;
        long done = 0;
        var buffer = new byte[16 << 20];
        var last = DateTime.MinValue;
        foreach (var f in parts)
        {
            using (var src = new FileStream(f, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 20, FileOptions.SequentialScan))
            {
                int n;
                while ((n = src.Read(buffer, 0, buffer.Length)) > 0)
                {
                    done += n;
                    if ((DateTime.Now - last).TotalMilliseconds > 500)
                    {
                        lock (gate) if (gen != generation) return;
                        Status(gen, id, "preloading", string.Format(CultureInfo.InvariantCulture, ",\"done\":{0},\"total\":{1}", done, total));
                        last = DateTime.Now;
                    }
                }
            }
        }
    }

    /**
     * The small model of speculative decoding (2026-11-04): a file name in models\ only, all of
     * it in the card, up to 8 tokens proposed at a time.
     */
    static string DraftArgs(string draft)
    {
        if (string.IsNullOrEmpty(draft) || !Regex.IsMatch(draft, @"^[A-Za-z0-9_.-]+\.gguf$")) return "";
        return " --spec-type draft-simple -md \"" + Path.Combine(Dir, "models", draft) + "\" -ngld 99 --spec-draft-n-max 8 --spec-draft-p-min 0.75";
    }

    /**
     * A chat template RedGiant put in templates/ (2026-11-05: gpt-oss keeping its reasoning, so
     * the engine reuses its cache). Only a plain file name that is there.
     */
    static string TemplateArgs(string template)
    {
        if (string.IsNullOrEmpty(template) || !Regex.IsMatch(template, @"^[A-Za-z0-9_.-]+\.jinja$")) return "";
        string path = Path.Combine(Dir, "templates", template);
        return File.Exists(path) ? " --chat-template-file \"" + path + "\"" : "";
    }

    static void Handle(int gen, string id, string model, string build, string ctx, string parallel, string args, string fit, string preload, string draft, string wanted, string template, string release)
    {
        lock (gate) { if (gen != generation) return; Kill(); flavor = wanted; }
        if (model == null) { Status(gen, id, "stopped", null); Diag.Log("engine", "stop asked"); return; }
        var t0 = DateTime.Now;
        Diag.Log("engine", "asked: model=" + model + " flavor=" + wanted + " build=" + build + " ctx=" + ctx + " args=" + (args ?? "") + " preload=" + (preload ?? "") + " draft=" + (draft ?? ""));
        string phase = "download";
        try
        {
            string marker = Path.Combine(Bin, "build.txt");
            // The patched build is RedGiant's: a new version of RedGiant brings its own.
            string want = wanted == "cuda-prefetch" ? build + "+redgiant-" + release : build;
            bool ready = File.Exists(Exe) && File.Exists(marker) && File.ReadAllText(marker).Trim() == want;
            if (!ready) Download(gen, id, build, release);
            // RedGiant 3.0: the server runs on this computer, so the engine listens on 127.0.0.1
            // only and needs no firewall rule.
            Status(gen, id, "starting", null);
            Diag.Log("engine", "engine binaries ready after " + (int) (DateTime.Now - t0).TotalMilliseconds + " ms");
            phase = "preload";
            if (preload == "1") { Preload(gen, id, model); Diag.Log("engine", "preload done after " + (int) (DateTime.Now - t0).TotalMilliseconds + " ms"); }
            lock (gate) if (gen != generation) return;
            phase = "start";
            lock (log) log.Clear();
            var info = new ProcessStartInfo(Exe,
                "-m \"" + Path.Combine(Dir, "models", model) + "\" --host 127.0.0.1 --port " + Port
                + " -c " + ctx + " --parallel " + parallel + " --slot-save-path \"" + Path.Combine(Dir, "kv")
                + "\" --swa-full --kv-unified --jinja"
                // SSD stream: llama.cpp fits the layers to the card itself (--fit, its default).
                + (fit == "1" ? "" : " --n-gpu-layers 999") + SafeArgs(args) + DraftArgs(draft) + TemplateArgs(template))
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = Bin,
            };
            // The patch does nothing without it (G32.2).
            if (wanted == "cuda-prefetch") info.EnvironmentVariables["LLAMA_MOE_PREFETCH"] = "1";
            var p = new Process { StartInfo = info };
            DataReceivedEventHandler keep = (s, e) =>
            {
                if (e.Data == null) return;
                Diag.Engine(e.Data);
                lock (log) { log.Enqueue(e.Data); while (log.Count > 60) log.Dequeue(); }
            };
            p.OutputDataReceived += keep;
            p.ErrorDataReceived += keep;
            lock (gate) { if (gen != generation) return; p.Start(); server = p; }
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            Status(gen, id, "loading", null);
            Diag.Log("engine", "llama-server started after " + (int) (DateTime.Now - t0).TotalMilliseconds + " ms: " + info.Arguments);
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
                    Diag.Log("engine", "ready after " + (int) (DateTime.Now - t0).TotalMilliseconds + " ms");
                    Status(gen, id, "ready", ",\"port\":" + Port);
                    return;
                }
            }
        }
        catch (Exception e)
        {
            Diag.Log("engine", "failed in " + phase + ": " + e.Message);
            Status(gen, id, "failed", ",\"error\":\"" + phase + "\",\"log\":\"" + Esc(e.Message + "\n" + Tail()) + "\"");
        }
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

    /** One file of a release, with its progress on the status. */
    static void Fetch(int gen, string id, string url, string zip)
    {
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
    }

    /**
     * llama.cpp for Windows from its GitHub release, into bin\current (Vulkan) or
     * bin\current-cuda (CUDA 12.4 with its runtime libraries, 2026-11-04).
     */
    static void Download(int gen, string id, string build, string release)
    {
        ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; // TLS 1.2
        string base_ = "https://github.com/ggml-org/llama.cpp/releases/download/" + build + "/";
        // The patched build (G32.2) is one zip with CUDA's libraries inside.
        string url = flavor == "cuda-prefetch"
            ? "https://github.com/Frostmoore/redgiant2/releases/download/v" + release + "/" + PrefetchZip
            : base_ + "llama-" + build + (flavor == "cuda" ? "-bin-win-cuda-12.4-x64.zip" : "-bin-win-vulkan-x64.zip");
        string fresh = Path.Combine(Dir, "bin", build + "-" + flavor);
        if (Directory.Exists(fresh)) Directory.Delete(fresh, true);
        string zip = Path.Combine(Dir, "bin", build + "-" + flavor + ".zip");
        Fetch(gen, id, url, zip);
        lock (gate) if (gen != generation) return;
        ZipFile.ExtractToDirectory(zip, Path.Combine(fresh, "llama"));
        File.Delete(zip);
        if (flavor == "cuda")
        {
            // CUDA's own libraries are a second archive of the same release.
            string rt = Path.Combine(Dir, "bin", build + "-cudart.zip");
            Fetch(gen, id, base_ + "cudart-llama-bin-win-cuda-12.4-x64.zip", rt);
            lock (gate) if (gen != generation) return;
            ZipFile.ExtractToDirectory(rt, Path.Combine(fresh, "cudart"));
            File.Delete(rt);
        }
        // The program may sit in a folder of the archive: its folder becomes the engine's.
        string[] found = Directory.GetFiles(Path.Combine(fresh, "llama"), "llama-server.exe", SearchOption.AllDirectories);
        if (found.Length == 0) throw new Exception("llama-server.exe is not in " + url);
        if (Directory.Exists(Bin)) Directory.Delete(Bin, true);
        Directory.Move(Path.GetDirectoryName(found[0]), Bin);
        if (flavor == "cuda")
            foreach (var dll in Directory.GetFiles(Path.Combine(fresh, "cudart"), "*.dll", SearchOption.AllDirectories))
                File.Copy(dll, Path.Combine(Bin, Path.GetFileName(dll)), true);
        if (Directory.Exists(fresh)) Directory.Delete(fresh, true);
        File.WriteAllText(Path.Combine(Bin, "build.txt"), flavor == "cuda-prefetch" ? build + "+redgiant-" + release : build);
    }
}

