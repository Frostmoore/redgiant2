// The memory Windows has free right now (2026-11-04, for SSD stream). Inside WSL RedGiant sees
// only the distribution's memory; the other programs on Windows (the person's services) are
// invisible there. Every few seconds this writes memory.json in the engine's folder:
//   { "totalGb": 63.7, "availableGb": 31.2, "engineGb": 0.0 }
// availableGb is what Windows can hand out now (free plus its file cache), engineGb what the
// Windows engine holds (it goes when the engine starts another model).
using System;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;

static class Memory
{
    [StructLayout(LayoutKind.Sequential)]
    class MemoryStatusEx
    {
        public uint dwLength = (uint)Marshal.SizeOf(typeof(MemoryStatusEx));
        public uint dwMemoryLoad;
        public ulong ullTotalPhys;
        public ulong ullAvailPhys;
        public ulong ullTotalPageFile;
        public ulong ullAvailPageFile;
        public ulong ullTotalVirtual;
        public ulong ullAvailVirtual;
        public ulong ullAvailExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GlobalMemoryStatusEx([In, Out] MemoryStatusEx buffer);

    static System.Threading.Timer timer;
    static System.Threading.Timer dropTimer;
    static string lastDrop;

    public static void Watch()
    {
        timer = new System.Threading.Timer(_ => Write(), null, 0, 5000);
        dropTimer = new System.Threading.Timer(_ => DropCaches(), null, 2000, 2000);
    }

    /**
     * The local model turned off (2026-11-04): its file stayed in the distribution's cache and
     * Windows did not get the memory back. RedGiant asks through dropcache.json; the cache of
     * files inside WSL is emptied and Windows takes the free memory back.
     */
    static void DropCaches()
    {
        string json;
        try { json = File.ReadAllText(Path.Combine(WinEngine.Dir, "dropcache.json")); } catch (Exception) { return; }
        var m = System.Text.RegularExpressions.Regex.Match(json, "\"id\"\\s*:\\s*\"([^\"]+)\"");
        if (!m.Success || m.Groups[1].Value == lastDrop) return;
        lastDrop = m.Groups[1].Value;
        try
        {
            var p = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("wsl.exe",
                "-d RedGiant -u root -- sh -c \"sync; echo 1 > /proc/sys/vm/drop_caches\"")
            { UseShellExecute = false, CreateNoWindow = true });
            p.WaitForExit(30000);
            Diag.Log("memory", "cache of files in WSL emptied (model turned off)");
        }
        catch (Exception e) { Diag.Log("memory", "could not empty the cache: " + e.Message); }
    }

    static void Write()
    {
        var m = new MemoryStatusEx();
        if (!GlobalMemoryStatusEx(m)) return;
        const double GB = 1024.0 * 1024 * 1024;
        string json = string.Format(CultureInfo.InvariantCulture,
            "{{\"totalGb\":{0:0.0},\"availableGb\":{1:0.0},\"engineGb\":{2:0.0}}}",
            m.ullTotalPhys / GB, m.ullAvailPhys / GB, WinEngine.EngineBytes() / GB);
        string file = Path.Combine(WinEngine.Dir, "memory.json");
        try { File.WriteAllText(file + ".tmp", json); File.Copy(file + ".tmp", file, true); } catch (Exception) { }
    }
}
