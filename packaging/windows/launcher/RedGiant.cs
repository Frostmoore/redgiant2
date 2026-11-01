// RedGiant.exe (G22): what the desktop icon opens on Windows. It starts the "RedGiant" WSL
// distribution, shows what it is doing the first time, opens the browser already signed in, and
// stays next to the clock with "Open RedGiant" and "Quit". Built with the C# compiler of .NET
// Framework 4, which every Windows has: no runtime to install.
//
//   RedGiant.exe               start (or, if already running, just open the browser)
//   RedGiant.exe --background  start without opening the browser (start with Windows)
using System;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class Texts
{
    static readonly bool It = CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "it";
    public static string Title { get { return "RedGiant"; } }
    public static string Starting { get { return It ? "Avvio di RedGiant…" : "Starting RedGiant…"; } }
    public static string Open { get { return It ? "Apri RedGiant" : "Open RedGiant"; } }
    public static string Restart { get { return It ? "Riavvia" : "Restart"; } }
    public static string Quit { get { return It ? "Esci" : "Quit"; } }
    public static string Running { get { return It ? "RedGiant è acceso" : "RedGiant is running"; } }
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
            ClientSize = new Size(440, 130),
            BackColor = Color.FromArgb(21, 23, 28),
            ForeColor = Color.FromArgb(232, 230, 227),
            Font = new Font("Segoe UI", 11f),
        };
        status = new Label { Text = Texts.Starting, Dock = DockStyle.Top, Height = 70, Padding = new Padding(18, 22, 18, 0) };
        var bar = new ProgressBar { Style = ProgressBarStyle.Marquee, Dock = DockStyle.Bottom, Height = 8, MarqueeAnimationSpeed = 30 };
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

    void StartEngine()
    {
        url = null;
        engine = new Process
        {
            StartInfo = new ProcessStartInfo("wsl.exe", "-d " + Distro + " -u root -- /usr/local/bin/redgiant-wsl run")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                // The script inside writes UTF-8.
                StandardOutputEncoding = Encoding.UTF8,
            },
            EnableRaisingEvents = true,
        };
        string port = "7600", token = "";
        engine.OutputDataReceived += (s, e) =>
        {
            if (e.Data == null) return;
            string line = e.Data.Trim();
            lock (log) log.AppendLine(line);
            if (line.StartsWith("STEP ")) Ui(() => status.Text = line.Substring(5));
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
