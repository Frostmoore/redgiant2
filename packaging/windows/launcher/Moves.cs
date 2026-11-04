// Moving the models to the SSD the person chose (2026-11-03, for SSD stream). RedGiant asks
// through move.json in the engine's folder; this program does the work, because it sees every
// disk, and writes its progress in move-status.json.
//   models: the Windows engine's models go to the chosen folder (copied with progress, then the
//           old folder becomes a junction to the new one, so every path keeps working).
//   distro: the distribution (RedGiant's data with the models of the engines in Docker) moves to
//           (RedGiant 3.0: no WSL distribution any more; refused with a message).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32;

static class Moves
{
    static System.Threading.Timer timer;
    static string lastId;
    static int busy;
    /** Stops RedGiant inside WSL, runs the action, starts it again (set by the launcher). */
    public static Action<Action> WithDistroStopped;
    /** Says on the splash what is happening (set by the launcher). */
    public static Action<string> Say;

    static string Folder { get { return WinEngine.Dir; } }

    public static void Watch()
    {
        timer = new System.Threading.Timer(_ => Check(), null, 1500, 1500);
    }

    static string Field(string json, string name)
    {
        var m = Regex.Match(json, "\"" + name + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
        return m.Success ? Regex.Unescape(m.Groups[1].Value) : null;
    }

    static void Check()
    {
        string json;
        try { json = File.ReadAllText(Path.Combine(Folder, "move.json")); } catch (Exception) { return; }
        string id = Field(json, "id");
        if (id == null || id == lastId || Interlocked.CompareExchange(ref busy, 1, 0) != 0) return;
        lastId = id;
        string kind = Field(json, "kind");
        string to = Field(json, "to");
        var t = new Thread(() =>
        {
            try
            {
                if (to == null || !Regex.IsMatch(to, @"^[A-Za-z]:\\[^""<>|?*]*$")) throw new Exception("bad target folder");
                if (kind == "models") MoveModels(id, to);
                else if (kind == "distro") MoveDistro(id, to);
                else throw new Exception("unknown move");
            }
            catch (Exception e) { Status(id, "failed", 0, 0, e.Message); }
            finally { Interlocked.Exchange(ref busy, 0); }
        }) { IsBackground = true };
        t.Start();
    }

    static void Status(string id, string state, long done, long total, string error)
    {
        string json = string.Format(CultureInfo.InvariantCulture,
            "{{\"id\":\"{0}\",\"state\":\"{1}\",\"done\":{2},\"total\":{3}{4}}}",
            id, state, done, total,
            error == null ? "" : ",\"error\":\"" + error.Replace("\\", "\\\\").Replace("\"", "'") + "\"");
        string file = Path.Combine(Folder, "move-status.json");
        try { File.WriteAllText(file + ".tmp", json); File.Copy(file + ".tmp", file, true); } catch (Exception) { }
    }

    /** The folder's real place: a junction's target, or the folder itself. */
    static string RealPath(string dir)
    {
        try
        {
            var info = new DirectoryInfo(dir);
            if ((info.Attributes & FileAttributes.ReparsePoint) == 0) return dir;
            var p = new ProcessStartInfo("cmd.exe", "/c dir /AL \"" + Path.GetDirectoryName(dir) + "\"")
            { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true };
            using (var proc = Process.Start(p))
            {
                string output = proc.StandardOutput.ReadToEnd();
                proc.WaitForExit();
                var m = Regex.Match(output, Regex.Escape(Path.GetFileName(dir)) + @" \[([^\]]+)\]");
                if (m.Success) return m.Groups[1].Value;
            }
        }
        catch (Exception) { }
        return dir;
    }

    static void AddModelDir(string dir)
    {
        using (var k = Registry.CurrentUser.CreateSubKey(@"Software\RedGiant"))
        {
            var list = new List<string>(((k.GetValue("ModelDirs") as string) ?? "").Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries));
            if (!list.Contains(dir)) list.Add(dir);
            k.SetValue("ModelDirs", string.Join(";", list.ToArray()));
        }
    }

    static void MoveModels(string id, string to)
    {
        string link = Path.Combine(Folder, "models");
        string from = RealPath(link);
        if (string.Equals(Path.GetFullPath(from).TrimEnd('\\'), Path.GetFullPath(to).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
        {
            Status(id, "done", 0, 0, null);
            return;
        }
        // The engine reads the models: it stops (RedGiant starts it again afterwards).
        WinEngine.Stop();
        var files = Directory.Exists(from) ? Directory.GetFiles(from, "*", SearchOption.AllDirectories) : new string[0];
        long total = 0;
        foreach (var f in files) total += new FileInfo(f).Length;
        var drive = new DriveInfo(Path.GetPathRoot(to));
        if (drive.AvailableFreeSpace < total + 1073741824L)
            throw new Exception(string.Format(CultureInfo.InvariantCulture, "not enough room on {0}: {1:0.0} GB needed",
                drive.Name, (total + 1073741824L) / 1073741824.0));
        Directory.CreateDirectory(to);
        long done = 0;
        var buffer = new byte[4 << 20];
        var last = DateTime.MinValue;
        foreach (var f in files)
        {
            string rel = f.Substring(from.Length).TrimStart('\\');
            string dest = Path.Combine(to, rel);
            Directory.CreateDirectory(Path.GetDirectoryName(dest));
            using (var src = File.OpenRead(f))
            using (var dst = File.Create(dest))
            {
                int n;
                while ((n = src.Read(buffer, 0, buffer.Length)) > 0)
                {
                    dst.Write(buffer, 0, n);
                    done += n;
                    if ((DateTime.Now - last).TotalMilliseconds > 500)
                    {
                        Status(id, "moving", done, total, null);
                        last = DateTime.Now;
                    }
                }
            }
        }
        // Copied whole: the old place goes and points to the new one.
        if (from == link) Directory.Delete(link, true);
        else
        {
            RunCmd("rmdir \"" + link + "\"");
            if (Directory.Exists(from)) Directory.Delete(from, true);
        }
        RunCmd("mklink /J \"" + link + "\" \"" + to + "\"");
        if (!Directory.Exists(link)) throw new Exception("the link to the new folder could not be made");
        AddModelDir(to);
        Status(id, "done", done, total, null);
    }

    static void RunCmd(string args)
    {
        var p = new ProcessStartInfo("cmd.exe", "/c " + args) { UseShellExecute = false, CreateNoWindow = true };
        using (var proc = Process.Start(p)) proc.WaitForExit();
    }

    /** RedGiant 3.0 has no WSL distribution to move: its data folder moves with a new install. */
    static void MoveDistro(string id, string to)
    {
        throw new Exception("Moving RedGiant's data is not available in this version");
    }

    static string DataDirNow()
    {
        using (var k = Registry.CurrentUser.OpenSubKey(@"Software\RedGiant"))
        {
            var v = k == null ? null : k.GetValue("DataDir") as string;
            if (!string.IsNullOrEmpty(v)) return v;
        }
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RedGiant", "data");
    }
}
