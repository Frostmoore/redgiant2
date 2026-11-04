// Debug mode on the Windows side (2026-11-04). While RedGiant's debug mode is on, the server
// keeps a file debug.on in the engine's folder; then this program writes what it does into
// launcher-YYYY-MM-DD.log there (starting WSL, the distribution's own lines, updates, the
// Windows engine's phases with their times) and the Windows engine's whole output into
// engine-windows-YYYY-MM-DD.log. The server puts these files in the archive to download.
// Never the access token: lines that carry it are left out.
using System;
using System.Globalization;
using System.IO;

static class Diag
{
    static readonly object gate = new object();
    static DateTime checkedAt = DateTime.MinValue;
    static bool on;

    static bool On
    {
        get
        {
            // The switch looked at every few seconds, not at every line.
            if ((DateTime.Now - checkedAt).TotalSeconds > 3)
            {
                try { on = File.Exists(Path.Combine(WinEngine.Dir, "debug.on")); } catch (Exception) { on = false; }
                checkedAt = DateTime.Now;
            }
            return on;
        }
    }

    static void Append(string name, string text)
    {
        if (!On) return;
        string file = Path.Combine(WinEngine.Dir, name + "-" + DateTime.Now.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) + ".log");
        lock (gate)
        {
            try { File.AppendAllText(file, text); } catch (Exception) { }
        }
    }

    static string Now() { return DateTime.Now.ToString("yyyy-MM-ddTHH:mm:ss.fff", CultureInfo.InvariantCulture); }

    /** One event of the launcher. */
    public static void Log(string area, string message)
    {
        if (message == null || message.StartsWith("TOKEN=") || message.Contains("#token=")) return;
        Append("launcher", Now() + " [" + area + "] " + message + "\r\n");
    }

    /** One line of the Windows engine (llama-server), as it prints it. */
    public static void Engine(string line)
    {
        if (line == null) return;
        Append("engine-windows", Now() + " " + line + "\r\n");
    }
}
