// Differential updates (G36.18): what changed between the installed RedGiant and a new version,
// and only that downloaded. Every release carries RedGiant-win-x64.zip (each file deflated on its
// own, packaging/update/pack.mjs) and its manifest (every file's size, sha256 and place in the
// zip). The files missing here are downloaded with HTTP Range requests, checked one by one, and a
// whole new tree is put together beside the old one (unchanged files as hard links); the swap is
// a handful of folder renames, undone by Rollback. Nothing here shows a window: Updates.cs does.
// C# 5 (the compiler every Windows has): no string interpolation, no ?. and no out var.
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

public sealed class UpdateException : Exception
{
    public UpdateException(string message) : base(message) { }
    public UpdateException(string message, Exception inner) : base(message, inner) { }
}

public sealed class UpdateFile
{
    public string Path;
    public long Size;
    public string Sha256;
    public long Offset;
    public long CSize;
    public int Method;
}

public sealed class UpdateManifest
{
    public const int KnownFormat = 1;
    public int Format;
    public string Version;
    public string Platform;
    public string ArchiveName;
    public long ArchiveSize;
    public string ArchiveSha256;
    public long InstallerSize;
    public List<string> Roots = new List<string>();
    public List<UpdateFile> Files = new List<UpdateFile>();

    static long Long(Dictionary<string, object> d, string k)
    {
        object v;
        if (!d.TryGetValue(k, out v) || v == null) throw new UpdateException("manifest: no " + k);
        long n = Convert.ToInt64(v, System.Globalization.CultureInfo.InvariantCulture);
        if (n < 0) throw new UpdateException("manifest: negative " + k);
        return n;
    }

    static string Text(Dictionary<string, object> d, string k)
    {
        object v;
        if (!d.TryGetValue(k, out v) || !(v is string)) throw new UpdateException("manifest: no " + k);
        return (string)v;
    }

    static bool Hex64(string s)
    {
        if (s == null || s.Length != 64) return false;
        foreach (char c in s) if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
        return true;
    }

    /** A path the manifest may name: relative, "/"-separated, no "..", nothing Windows refuses. */
    public static bool SafePath(string p)
    {
        if (string.IsNullOrEmpty(p) || p.StartsWith("/") || p.IndexOf('\\') >= 0) return false;
        if (p.IndexOfAny(new[] { ':', '*', '?', '"', '<', '>', '|', '\0' }) >= 0) return false;
        foreach (var s in p.Split('/'))
            if (s.Length == 0 || s == "." || s == ".." || s.EndsWith(".") || s.EndsWith(" ")) return false;
        return true;
    }

    /** The manifest, checked as pack.mjs's checkManifest does: anything odd is refused. */
    public static UpdateManifest Parse(string json)
    {
        var js = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 16 };
        Dictionary<string, object> d;
        try { d = js.DeserializeObject(json) as Dictionary<string, object>; }
        catch (Exception e) { throw new UpdateException("manifest: not JSON", e); }
        if (d == null) throw new UpdateException("manifest: not an object");
        var m = new UpdateManifest();
        m.Format = (int)Long(d, "format");
        if (m.Format != KnownFormat) throw new UpdateException("manifest: unknown format " + m.Format);
        m.Version = Text(d, "version");
        if (!System.Text.RegularExpressions.Regex.IsMatch(m.Version, @"^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$"))
            throw new UpdateException("manifest: bad version");
        m.Platform = Text(d, "platform");
        var archive = d.ContainsKey("archive") ? d["archive"] as Dictionary<string, object> : null;
        if (archive == null) throw new UpdateException("manifest: no archive");
        m.ArchiveName = Text(archive, "name");
        m.ArchiveSize = Long(archive, "size");
        m.ArchiveSha256 = Text(archive, "sha256");
        var installer = d.ContainsKey("installer") ? d["installer"] as Dictionary<string, object> : null;
        if (installer != null) m.InstallerSize = Long(installer, "size");
        var roots = d.ContainsKey("roots") ? d["roots"] as object[] : null;
        var files = d.ContainsKey("files") ? d["files"] as object[] : null;
        if (roots == null || files == null || files.Length == 0) throw new UpdateException("manifest: no files");
        foreach (var r in roots)
        {
            var s = r as string;
            if (!SafePath(s) || s.Contains("/")) throw new UpdateException("manifest: bad root");
            m.Roots.Add(s);
        }
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var o in files)
        {
            var f = o as Dictionary<string, object>;
            if (f == null) throw new UpdateException("manifest: bad file");
            var u = new UpdateFile
            {
                Path = Text(f, "path"),
                Size = Long(f, "size"),
                Sha256 = Text(f, "sha256"),
                Offset = Long(f, "offset"),
                CSize = Long(f, "csize"),
                Method = (int)Long(f, "method"),
            };
            if (!SafePath(u.Path)) throw new UpdateException("manifest: unsafe path " + u.Path);
            if (!seen.Add(u.Path)) throw new UpdateException("manifest: twice " + u.Path);
            if (!Hex64(u.Sha256)) throw new UpdateException("manifest: bad sha256 " + u.Path);
            if (u.Method != 0 && u.Method != 8) throw new UpdateException("manifest: bad method " + u.Path);
            if (u.Offset + u.CSize > m.ArchiveSize) throw new UpdateException("manifest: past the end " + u.Path);
            if (!m.Roots.Contains(u.Path.Split('/')[0])) throw new UpdateException("manifest: outside the roots " + u.Path);
            m.Files.Add(u);
        }
        return m;
    }
}

/** A stretch of the zip fetched with one request: one or more entries, end exclusive. */
public sealed class UpdateRun
{
    public long Start;
    public long End;
    public List<UpdateFile> Files = new List<UpdateFile>();
    public long Length { get { return End - Start; } }
}

public sealed class UpdatePlan
{
    public List<UpdateFile> Fetch = new List<UpdateFile>();
    public int Keep;
    public List<UpdateRun> Runs = new List<UpdateRun>();
    public long Bytes;
}

/** Where the zip's bytes come from: GitHub with Range requests, or a file (tests). */
public interface IRangeSource
{
    /** The bytes [start, end) of the zip; throws when the source cannot give exactly those. */
    Stream Open(long start, long end);
}

public sealed class FileRangeSource : IRangeSource
{
    readonly string path;
    public FileRangeSource(string path) { this.path = path; }
    public Stream Open(long start, long end)
    {
        var f = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        f.Position = start;
        return new Slice(f, end - start);
    }
}

/** At most `left` bytes of a stream, then the end. */
public sealed class Slice : Stream
{
    readonly Stream inner;
    long left;
    public Slice(Stream inner, long length) { this.inner = inner; left = length; }
    public override int Read(byte[] buffer, int offset, int count)
    {
        if (left <= 0) return 0;
        int n = inner.Read(buffer, offset, (int)Math.Min(count, left));
        left -= n;
        return n;
    }
    protected override void Dispose(bool disposing) { if (disposing) inner.Dispose(); base.Dispose(disposing); }
    public override bool CanRead { get { return true; } }
    public override bool CanSeek { get { return false; } }
    public override bool CanWrite { get { return false; } }
    public override long Length { get { throw new NotSupportedException(); } }
    public override long Position { get { throw new NotSupportedException(); } set { throw new NotSupportedException(); } }
    public override void Flush() { }
    public override long Seek(long o, SeekOrigin s) { throw new NotSupportedException(); }
    public override void SetLength(long v) { throw new NotSupportedException(); }
    public override void Write(byte[] b, int o, int c) { throw new NotSupportedException(); }
}

/**
 * The zip on GitHub (2026-11-07, checked: github.com answers 302 to a signed URL valid about an
 * hour, which answers 206 to one range; several ranges in one request are refused with 501).
 * One range per request, the redirect followed by HttpWebRequest itself.
 */
public sealed class HttpRangeSource : IRangeSource
{
    readonly string url;
    public HttpRangeSource(string url) { this.url = url; }
    public Stream Open(long start, long end)
    {
        ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072; // TLS 1.2
        var req = (HttpWebRequest)WebRequest.Create(url);
        req.UserAgent = "RedGiant-Updates";
        req.AllowAutoRedirect = true;
        req.Timeout = 30000;
        req.ReadWriteTimeout = 60000;
        req.AddRange(start, end - 1);
        var res = (HttpWebResponse)req.GetResponse();
        // A server that ignores the range would send the whole zip: refused, never read.
        string range = res.Headers["Content-Range"] ?? "";
        if (res.StatusCode != HttpStatusCode.PartialContent || !range.StartsWith("bytes " + start + "-"))
        {
            res.Close();
            throw new UpdateException("the server does not serve ranges (" + (int)res.StatusCode + " " + range + ")");
        }
        return new Slice(new ResponseStream(res), end - start);
    }

    sealed class ResponseStream : Stream
    {
        readonly HttpWebResponse res;
        readonly Stream s;
        public ResponseStream(HttpWebResponse res) { this.res = res; s = res.GetResponseStream(); }
        public override int Read(byte[] b, int o, int c) { return s.Read(b, o, c); }
        protected override void Dispose(bool disposing) { if (disposing) { s.Dispose(); res.Close(); } base.Dispose(disposing); }
        public override bool CanRead { get { return true; } }
        public override bool CanSeek { get { return false; } }
        public override bool CanWrite { get { return false; } }
        public override long Length { get { throw new NotSupportedException(); } }
        public override long Position { get { throw new NotSupportedException(); } set { throw new NotSupportedException(); } }
        public override void Flush() { }
        public override long Seek(long o, SeekOrigin so) { throw new NotSupportedException(); }
        public override void SetLength(long v) { throw new NotSupportedException(); }
        public override void Write(byte[] b, int o, int c) { throw new NotSupportedException(); }
    }
}

public static class Delta
{
    /** Two runs of missing entries closer than this are one request (pack.mjs DEFAULT_GAP). */
    public const long Gap = 256 * 1024;
    /** Attempts of one request before the update gives up (and the installer is offered). */
    public const int Attempts = 4;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateHardLink(string newFile, string existing, IntPtr security);

    public static string Hex(byte[] h)
    {
        var b = new StringBuilder(h.Length * 2);
        foreach (var x in h) b.Append(x.ToString("x2"));
        return b.ToString();
    }

    /**
     * Windows' own SHA-256 (CNG, with the CPU's instructions): SHA256.Create() is the managed one
     * on .NET Framework, ten times slower (2026-11-08: 57 s for the 372 MB of 3.3.0 on Rig).
     */
    public static HashAlgorithm NewSha256()
    {
        try { return new SHA256Cng(); }
        catch (Exception) { return SHA256.Create(); }
    }

    public static string Sha256File(string path)
    {
        using (var sha = NewSha256())
        using (var f = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 20, FileOptions.SequentialScan))
            return Hex(sha.ComputeHash(f));
    }

    public static string Sha256Bytes(byte[] data)
    {
        using (var sha = NewSha256()) return Hex(sha.ComputeHash(data));
    }

    /**
     * The sha256 of the installed files, remembered by path, size and modification time in
     * `cacheFile` (update\hashes.txt): the next look at the same files reads none of them again.
     * A file whose size or time changed is hashed again. Safe to use from several threads.
     */
    public sealed class HashCache
    {
        readonly string file;
        readonly Dictionary<string, string> known = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        readonly Dictionary<string, string> seen = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        readonly HashSet<string> seenPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        public HashCache(string file)
        {
            this.file = file;
            if (file == null) return;
            try
            {
                foreach (var line in File.ReadAllLines(file))
                {
                    int tab = line.LastIndexOf('\t');
                    if (tab > 0) known[line.Substring(0, tab)] = line.Substring(tab + 1);
                }
            }
            catch (Exception) { }
        }

        /** Entries read from the file. */
        public int Known { get { lock (this) return known.Count; } }

        static string Key(string path, FileInfo info) { return path + "|" + info.Length + "|" + info.LastWriteTimeUtc.Ticks; }

        /** True when the file's sha256 is remembered (same path, size and time). */
        public bool Has(string path, FileInfo info)
        {
            lock (this) return known.ContainsKey(Key(path, info));
        }

        public string Of(string path, FileInfo info)
        {
            string key = Key(path, info);
            string sha;
            bool have;
            lock (this) have = known.TryGetValue(key, out sha);
            // Outside the lock: the other threads hash their own files meanwhile.
            if (!have) sha = Sha256File(path);
            lock (this)
            {
                seen[key] = sha;
                seenPaths.Add(path);
            }
            return sha;
        }

        /**
         * Writes what was seen. `keepUnseen`: the entries of files not looked at this time stay
         * (a fill in the background stopped halfway); otherwise only the files looked at stay.
         */
        public void Save(bool keepUnseen)
        {
            if (file == null) return;
            try
            {
                var b = new StringBuilder();
                lock (this)
                {
                    foreach (var kv in seen) b.Append(kv.Key).Append('\t').Append(kv.Value).Append("\r\n");
                    if (keepUnseen)
                        foreach (var kv in known)
                        {
                            int bar = kv.Key.LastIndexOf('|');
                            bar = bar > 0 ? kv.Key.LastIndexOf('|', bar - 1) : -1;
                            if (bar > 0 && !seenPaths.Contains(kv.Key.Substring(0, bar)) && !seen.ContainsKey(kv.Key))
                                b.Append(kv.Key).Append('\t').Append(kv.Value).Append("\r\n");
                        }
                }
                lock (SaveLock)
                {
                    Directory.CreateDirectory(System.IO.Path.GetDirectoryName(file));
                    File.WriteAllText(file + ".tmp", b.ToString());
                    if (File.Exists(file)) File.Delete(file);
                    File.Move(file + ".tmp", file);
                }
            }
            catch (Exception) { }
        }

        public void Save() { Save(false); }
    }

    /** One writer of hashes.txt at a time (an update's look and the fill in the background). */
    static readonly object SaveLock = new object();

    static string Local(string dir, string path) { return System.IO.Path.Combine(dir, path.Replace('/', '\\')); }

    /**
     * Threads that hash the installed files while the person waits (3.5.4): half the cores, 2 to 8.
     * Opening a file costs more than reading it (the antivirus looks at each one), so several at
     * once cut the wait; more than half the cores would slow down everything else on the PC.
     */
    public static int HashThreads
    {
        get { return Math.Max(2, Math.Min(8, Environment.ProcessorCount / 2)); }
    }

    /**
     * Runs work(i) for i in [0, count) on `threads` threads at below-normal priority; `done` is
     * called after each item with how many are done (from the worker threads).
     */
    public static void InParallel(int count, int threads, Action<int> work, Action<int> done)
    {
        int next = -1, finished = 0;
        threads = Math.Max(1, Math.Min(threads, count));
        Exception failure = null;
        var all = new List<Thread>();
        for (int t = 0; t < threads; t++)
        {
            var th = new Thread(() =>
            {
                try
                {
                    for (int i = Interlocked.Increment(ref next); i < count; i = Interlocked.Increment(ref next))
                    {
                        work(i);
                        int n = Interlocked.Increment(ref finished);
                        if (done != null) done(n);
                    }
                }
                catch (Exception e) { failure = e; Interlocked.Exchange(ref next, count); }
            });
            th.IsBackground = true;
            th.Priority = ThreadPriority.BelowNormal;
            th.Start();
            all.Add(th);
        }
        foreach (var th in all) th.Join();
        if (failure != null) throw new UpdateException("hashing failed: " + failure.Message, failure);
    }

    /**
     * The files of `next` that are missing or different in `appDir` (same size and same sha256:
     * kept). Every version can update to the latest: what counts is the files here, not the
     * version they came with.
     */
    public static UpdatePlan Compare(UpdateManifest next, string appDir, long gap)
    {
        return Compare(next, appDir, gap, null);
    }

    public static UpdatePlan Compare(UpdateManifest next, string appDir, long gap, string cacheFile)
    {
        return Compare(next, appDir, gap, cacheFile, 1, null);
    }

    /**
     * The same on `threads` threads; `progress` gets (files looked at, files in all) from the
     * worker threads, after every file (the caller keeps the window from redrawing too often).
     */
    public static UpdatePlan Compare(UpdateManifest next, string appDir, long gap, string cacheFile, int threads, Action<int, int> progress)
    {
        var plan = new UpdatePlan();
        var cache = new HashCache(cacheFile);
        int total = next.Files.Count;
        var same = new bool[total];
        InParallel(total, threads, i =>
        {
            var f = next.Files[i];
            string p = Local(appDir, f.Path);
            try
            {
                var info = new FileInfo(p);
                same[i] = info.Exists && info.Length == f.Size && cache.Of(p, info) == f.Sha256;
            }
            catch (Exception) { }
        }, progress == null ? (Action<int>)null : n => progress(n, total));
        for (int i = 0; i < total; i++)
        {
            if (same[i]) plan.Keep++;
            else plan.Fetch.Add(next.Files[i]);
        }
        cache.Save();
        plan.Runs = Runs(plan.Fetch, gap);
        foreach (var r in plan.Runs) plan.Bytes += r.Length;
        return plan;
    }

    /**
     * What the installer puts in RedGiant's folder (redgiant.iss [Files], pack.mjs's roots): the
     * files the next update compares. Never data, the engine, update\ or the uninstaller.
     */
    public static readonly string[] InstalledRoots = { "RedGiant.exe", "redgiant.ico", "bin", "node", "server", "web" };

    /** The installed files under InstalledRoots, as manifest paths ("server/dist/main.js"). */
    public static List<string> InstalledFiles(string appDir)
    {
        var list = new List<string>();
        string root = System.IO.Path.GetFullPath(appDir).TrimEnd('\\', '/');
        foreach (var r in InstalledRoots)
        {
            string p = System.IO.Path.Combine(root, r);
            try
            {
                if (File.Exists(p)) list.Add(r);
                else if (Directory.Exists(p))
                    foreach (var f in Directory.GetFiles(p, "*", SearchOption.AllDirectories))
                        list.Add(f.Substring(root.Length + 1).Replace('\\', '/'));
            }
            catch (Exception) { }
        }
        list.Sort(StringComparer.Ordinal);
        return list;
    }

    /**
     * Fills update\hashes.txt in the background (3.5.4): after an install with the whole
     * installer there is none, and the first update hashed all 27,000 files while the person
     * waited (2 minutes on the user's PC). One file at a time on the calling thread (the caller
     * lowers its priority); `keepGoing` is asked before each file (false: stop, what was hashed is
     * kept). Returns the files hashed now (the remembered ones are not read).
     */
    public static int Warm(string appDir, string cacheFile, Func<bool> keepGoing)
    {
        var cache = new HashCache(cacheFile);
        int hashed = 0;
        bool stopped = false;
        foreach (var rel in InstalledFiles(appDir))
        {
            if (keepGoing != null && !keepGoing()) { stopped = true; break; }
            string p = Local(appDir, rel);
            try
            {
                var info = new FileInfo(p);
                if (!info.Exists) continue;
                if (!cache.Has(p, info)) hashed++;
                cache.Of(p, info);
            }
            catch (Exception) { }
        }
        cache.Save(stopped);
        return hashed;
    }

    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentThread();
    [DllImport("kernel32.dll")]
    static extern bool SetThreadPriority(IntPtr thread, int priority);
    const int ThreadModeBackgroundBegin = 0x00010000;

    /** This thread at background priority, for the processor and the disk (Windows only). */
    public static bool BackgroundMode()
    {
        try { return SetThreadPriority(GetCurrentThread(), ThreadModeBackgroundBegin); }
        catch (Exception) { return false; }
    }

    /** The entries in zip order, joined into one run when the bytes between them are ≤ gap. */
    public static List<UpdateRun> Runs(List<UpdateFile> fetch, long gap)
    {
        var sorted = new List<UpdateFile>(fetch);
        sorted.Sort((a, b) => a.Offset.CompareTo(b.Offset));
        var runs = new List<UpdateRun>();
        foreach (var f in sorted)
        {
            var last = runs.Count > 0 ? runs[runs.Count - 1] : null;
            if (last != null && f.Offset - last.End <= gap)
            {
                last.End = Math.Max(last.End, f.Offset + f.CSize);
                last.Files.Add(f);
            }
            else
            {
                var r = new UpdateRun { Start = f.Offset, End = f.Offset + f.CSize };
                r.Files.Add(f);
                runs.Add(r);
            }
        }
        return runs;
    }

    static string Blob(string staging, string sha) { return System.IO.Path.Combine(staging, "blobs", sha); }

    /** A blob is there and is what its name says (checked again: a disk can lie). */
    static bool HaveBlob(string staging, UpdateFile f)
    {
        string b = Blob(staging, f.Sha256);
        try { return File.Exists(b) && new FileInfo(b).Length == f.Size && Sha256File(b) == f.Sha256; }
        catch (Exception) { return false; }
    }

    /**
     * Downloads the plan's entries into staging\blobs, each named by its sha256 once checked. A
     * stopped download goes on where it was: blobs already there are not asked again, and a run
     * half downloaded (staging\parts\<start>-<end>.part) continues from its last byte. `progress`
     * gets (bytes here, bytes in all), already-downloaded ones included.
     */
    public static void Fetch(UpdatePlan plan, IRangeSource src, string staging, Action<long, long> progress, Func<bool> cancelled)
    {
        Directory.CreateDirectory(System.IO.Path.Combine(staging, "blobs"));
        Directory.CreateDirectory(System.IO.Path.Combine(staging, "parts"));
        long total = plan.Bytes, done = 0;
        var todo = new List<UpdateRun>();
        foreach (var r in plan.Runs)
        {
            bool all = true;
            foreach (var f in r.Files) if (!HaveBlob(staging, f)) { all = false; break; }
            if (all) done += r.Length;
            else todo.Add(r);
        }
        if (progress != null) progress(done, total);
        foreach (var r in todo)
        {
            string part = System.IO.Path.Combine(staging, "parts", r.Start + "-" + r.End + ".part");
            for (int attempt = 1; ; attempt++)
            {
                long have = File.Exists(part) ? new FileInfo(part).Length : 0;
                if (have > r.Length) { File.Delete(part); have = 0; }
                long before = done;
                try
                {
                    if (have < r.Length)
                    {
                        done += have;
                        if (progress != null) progress(done, total);
                        using (var input = src.Open(r.Start + have, r.End))
                        using (var output = new FileStream(part, FileMode.Append, FileAccess.Write, FileShare.Read))
                        {
                            var buf = new byte[1 << 16];
                            int n;
                            while (have < r.Length && (n = input.Read(buf, 0, (int)Math.Min(buf.Length, r.Length - have))) > 0)
                            {
                                if (cancelled != null && cancelled()) throw new OperationCanceledException();
                                output.Write(buf, 0, n);
                                have += n;
                                done += n;
                                if (progress != null) progress(done, total);
                            }
                        }
                        if (have < r.Length) throw new IOException("the download ended early");
                    }
                    else
                    {
                        done += have;
                    }
                    break;
                }
                catch (OperationCanceledException) { throw; }
                catch (UpdateException) { throw; }
                catch (Exception e)
                {
                    done = before;
                    // A network failure (IOException): the parts stay, the next try goes on from there.
                    if (attempt >= Attempts) throw new IOException("download failed: " + e.Message, e);
                    Thread.Sleep(1000 * attempt);
                }
            }
            Unpack(r, part, staging);
            File.Delete(part);
        }
    }

    /** The run's entries out of its bytes, each checked against the manifest before it is kept. */
    static void Unpack(UpdateRun r, string part, string staging)
    {
        using (var input = new FileStream(part, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            foreach (var f in r.Files)
            {
                if (HaveBlob(staging, f)) continue;
                var body = new byte[f.CSize];
                input.Position = f.Offset - r.Start;
                int got = 0;
                while (got < body.Length)
                {
                    int n = input.Read(body, got, body.Length - got);
                    if (n <= 0) break;
                    got += n;
                }
                string blob = Blob(staging, f.Sha256), tmp = blob + ".tmp";
                try
                {
                    using (var sha = NewSha256())
                    using (var output = new FileStream(tmp, FileMode.Create, FileAccess.Write))
                    using (var hashed = new CryptoStream(output, sha, CryptoStreamMode.Write))
                    {
                        if (f.Method == 8)
                            using (var z = new DeflateStream(new MemoryStream(body, 0, got), CompressionMode.Decompress))
                                z.CopyTo(hashed);
                        else
                            hashed.Write(body, 0, got);
                        hashed.FlushFinalBlock();
                        if (output.Length != f.Size || Hex(sha.Hash) != f.Sha256)
                            throw new UpdateException("not the file the manifest names: " + f.Path);
                    }
                    if (File.Exists(blob)) File.Delete(blob);
                    File.Move(tmp, blob);
                }
                catch (Exception e)
                {
                    try { File.Delete(tmp); } catch (Exception) { }
                    // The bytes were wrong: the next attempt downloads the run again.
                    try { input.Close(); File.Delete(part); } catch (Exception) { }
                    if (e is UpdateException) throw;
                    throw new UpdateException("not the file the manifest names: " + f.Path + " (" + e.Message + ")", e);
                }
            }
        }
    }

    static void LinkOrCopy(string from, string to)
    {
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(to));
        if (!CreateHardLink(to, from, IntPtr.Zero)) File.Copy(from, to, true);
    }

    /**
     * The new version whole in staging\next: downloaded files from the blobs, the others linked
     * (or copied) from the installed ones, each checked for size; the downloaded ones were checked
     * for sha256 already, the kept ones by Compare.
     */
    public static void Build(UpdateManifest next, UpdatePlan plan, string appDir, string staging)
    {
        string dir = System.IO.Path.Combine(staging, "next");
        if (Directory.Exists(dir)) Directory.Delete(dir, true);
        Directory.CreateDirectory(dir);
        var fetched = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var f in plan.Fetch) fetched.Add(f.Path);
        foreach (var f in next.Files)
        {
            string to = Local(dir, f.Path);
            string from = fetched.Contains(f.Path) ? Blob(staging, f.Sha256) : Local(appDir, f.Path);
            if (!File.Exists(from) || new FileInfo(from).Length != f.Size)
                throw new UpdateException("missing to build the new version: " + f.Path);
            LinkOrCopy(from, to);
        }
        foreach (var f in plan.Fetch)
            if (Sha256File(Local(dir, f.Path)) != f.Sha256) throw new UpdateException("changed while building: " + f.Path);
        File.WriteAllText(System.IO.Path.Combine(staging, "ready"), next.Version);
    }

    static void Retry(Action a)
    {
        // An antivirus or the indexer may hold a file for a moment.
        for (int i = 1; ; i++)
        {
            try { a(); return; }
            catch (Exception) { if (i >= 8) throw; Thread.Sleep(500 * i); }
        }
    }

    static bool Exists(string p) { return File.Exists(p) || Directory.Exists(p); }

    static void Move(string from, string to)
    {
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(to));
        Retry(() => { if (Directory.Exists(from)) Directory.Move(from, to); else File.Move(from, to); });
    }

    static void Remove(string p)
    {
        if (Directory.Exists(p)) Retry(() => Directory.Delete(p, true));
        else if (File.Exists(p)) Retry(() => File.Delete(p));
    }

    /**
     * The new version in place: for each root (RedGiant.exe, node, server, web…) the installed one
     * moves to staging\prev and the new one from staging\next takes its place. Renames on the same
     * disk, a second or two; a running RedGiant.exe can be renamed. Written down step by step in
     * staging\swap.txt, so Rollback undoes exactly what was done, even after a crash. Server and
     * Postgres must be stopped first (they hold files in server\).
     */
    public static void Swap(UpdateManifest next, string appDir, string staging)
    {
        if (!File.Exists(System.IO.Path.Combine(staging, "ready"))) throw new UpdateException("the new version is not ready");
        string journal = System.IO.Path.Combine(staging, "swap.txt");
        if (File.Exists(journal)) throw new UpdateException("a swap is already recorded: roll it back first");
        string prev = System.IO.Path.Combine(staging, "prev"), dir = System.IO.Path.Combine(staging, "next");
        Directory.CreateDirectory(prev);
        try
        {
            foreach (var root in next.Roots)
            {
                string here = System.IO.Path.Combine(appDir, root);
                bool had = Exists(here);
                File.AppendAllText(journal, (had ? "moved " : "added ") + root + "\r\n");
                if (had) Move(here, System.IO.Path.Combine(prev, root));
                Move(System.IO.Path.Combine(dir, root), here);
                File.AppendAllText(journal, "done " + root + "\r\n");
            }
            File.AppendAllText(journal, "complete\r\n");
        }
        catch (Exception e)
        {
            Rollback(appDir, staging);
            throw new UpdateException("the swap failed and was undone: " + e.Message, e);
        }
    }

    /** True when staging\swap.txt records a swap (complete or not) that has not been undone. */
    public static bool Swapped(string staging)
    {
        return File.Exists(System.IO.Path.Combine(staging, "swap.txt"));
    }

    /**
     * The installed version back as it was before Swap: each root swapped (or half swapped) goes
     * back from staging\prev; the new one moves to staging\failed. Roots the update added are
     * moved away. Safe to call again after a crash halfway.
     */
    public static void Rollback(string appDir, string staging)
    {
        string journal = System.IO.Path.Combine(staging, "swap.txt");
        if (!File.Exists(journal)) return;
        string prev = System.IO.Path.Combine(staging, "prev"), failed = System.IO.Path.Combine(staging, "failed");
        var lines = File.ReadAllLines(journal);
        for (int i = lines.Length - 1; i >= 0; i--)
        {
            string line = lines[i];
            int sp = line.IndexOf(' ');
            if (sp < 0) continue;
            string kind = line.Substring(0, sp), root = line.Substring(sp + 1);
            if (kind != "moved" && kind != "added") continue;
            string here = System.IO.Path.Combine(appDir, root), old = System.IO.Path.Combine(prev, root);
            if (kind == "moved" && !Exists(old)) continue; // never moved away, or already back
            if (Exists(here))
            {
                string away = System.IO.Path.Combine(failed, root);
                Remove(away);
                Move(here, away);
            }
            if (kind == "moved") Move(old, here);
        }
        File.Delete(journal);
        try { File.Delete(System.IO.Path.Combine(staging, "ready")); } catch (Exception) { }
    }

    /** The update stays: the old version, the blobs and the parts go. Retried later if busy. */
    public static bool Commit(string staging)
    {
        try
        {
            // The journal first: once it is gone the swap is final, even if the rest stays.
            string journal = System.IO.Path.Combine(staging, "swap.txt");
            if (File.Exists(journal)) File.Delete(journal);
            if (Directory.Exists(staging)) Directory.Delete(staging, true);
            return true;
        }
        catch (Exception) { return false; }
    }

    /** True when every file of `m` is in `appDir` with its sha256 (the check after a swap). */
    public static List<string> Differences(UpdateManifest m, string appDir)
    {
        appDir = System.IO.Path.GetFullPath(appDir).TrimEnd('\\');
        var bad = new List<string>();
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var f in m.Files)
        {
            names.Add(f.Path);
            string p = Local(appDir, f.Path);
            if (!File.Exists(p) || new FileInfo(p).Length != f.Size || Sha256File(p) != f.Sha256) bad.Add(f.Path);
        }
        // Files under a root folder that the manifest does not name: left over from before.
        foreach (var root in m.Roots)
        {
            string dir = System.IO.Path.Combine(appDir, root);
            if (!Directory.Exists(dir)) continue;
            foreach (var p in Directory.GetFiles(dir, "*", SearchOption.AllDirectories))
            {
                string rel = p.Substring(appDir.Length + 1).Replace('\\', '/');
                if (!names.Contains(rel)) bad.Add("+" + rel);
            }
        }
        return bad;
    }

    /**
     * The manifest's signature (RSA, SHA-256, PKCS #1 v1.5; packaging/update/sign.mjs) against the
     * public key built into the launcher (UpdateKey.cs).
     */
    public static bool SignatureValid(byte[] manifest, string signatureBase64, string publicKeyXml)
    {
        try
        {
            byte[] sig = Convert.FromBase64String(signatureBase64.Trim());
            using (var rsa = new RSACryptoServiceProvider())
            {
                rsa.PersistKeyInCsp = false;
                rsa.FromXmlString(publicKeyXml);
                return rsa.VerifyData(manifest, "SHA256", sig);
            }
        }
        catch (Exception) { return false; }
    }
}
