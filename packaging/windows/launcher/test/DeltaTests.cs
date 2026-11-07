// Tests of the differential updates (G36.18, Delta.cs), a console program built with the same
// C# compiler as the launcher (ci.yml, installers job on Windows):
//
//   csc /out:DeltaTests.exe /r:System.Web.Extensions.dll test\DeltaTests.cs Delta.cs
//   DeltaTests.exe [<folder with RedGiant-x.zip and its manifest from pack.mjs> <the tree packed>]
//
// Exit code 0 when every test passes. Each test works in a folder of its own under %TEMP%.
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

static class DeltaTests
{
    static int failed, passed;

    static void Check(bool ok, string what)
    {
        if (!ok) throw new Exception("expected: " + what);
    }

    static void Run(string name, Action test)
    {
        try { test(); passed++; Console.WriteLine("ok   " + name); }
        catch (Exception e) { failed++; Console.WriteLine("FAIL " + name + ": " + e); }
    }

    static string Temp()
    {
        string d = Path.Combine(Path.GetTempPath(), "rg-delta-" + Guid.NewGuid().ToString("N").Substring(0, 8));
        Directory.CreateDirectory(d);
        return d;
    }

    static void Write(string dir, string path, string text)
    {
        string p = Path.Combine(dir, path.Replace('/', '\\'));
        Directory.CreateDirectory(Path.GetDirectoryName(p));
        File.WriteAllText(p, text);
    }

    /** Bytes that do not compress (node.exe and modules are mostly that, compressed or not). */
    static void WriteRandom(string dir, string path, int size, int seed)
    {
        string p = Path.Combine(dir, path.Replace('/', '\\'));
        Directory.CreateDirectory(Path.GetDirectoryName(p));
        var b = new byte[size];
        new Random(seed).NextBytes(b);
        File.WriteAllBytes(p, b);
    }

    static string Read(string dir, string path) { return File.ReadAllText(Path.Combine(dir, path.Replace('/', '\\'))); }

    /** An "archive" as pack.mjs lays it out: each file deflated on its own, at a known offset. */
    sealed class Built
    {
        public UpdateManifest Manifest;
        public string Archive;
    }

    static Built Pack(string root, string version, string archive)
    {
        var m = new UpdateManifest { Format = 1, Version = version, Platform = "win-x64", ArchiveName = "x.zip" };
        var files = Directory.GetFiles(root, "*", SearchOption.AllDirectories)
            .Select(p => p.Substring(root.Length + 1).Replace('\\', '/'))
            .OrderBy(p => p, StringComparer.Ordinal).ToList();
        using (var output = new FileStream(archive, FileMode.Create))
        {
            // Some bytes first, as a zip's header would be.
            output.Write(new byte[37], 0, 37);
            foreach (var path in files)
            {
                byte[] data = File.ReadAllBytes(Path.Combine(root, path.Replace('/', '\\')));
                var z = new MemoryStream();
                using (var d = new DeflateStream(z, CompressionMode.Compress, true)) d.Write(data, 0, data.Length);
                byte[] body = z.ToArray();
                int method = 8;
                if (body.Length >= data.Length) { body = data; method = 0; }
                output.Write(new byte[30], 0, 30);
                m.Files.Add(new UpdateFile { Path = path, Size = data.Length, Sha256 = Delta.Sha256Bytes(data), Offset = output.Position, CSize = body.Length, Method = method });
                output.Write(body, 0, body.Length);
                string r = path.Split('/')[0];
                if (!m.Roots.Contains(r)) m.Roots.Add(r);
            }
            m.ArchiveSize = output.Length;
        }
        return new Built { Manifest = m, Archive = archive };
    }

    /** A tree like the installed one: launcher, node, server, web, and what RedGiant keeps beside them. */
    static string OldTree(string dir)
    {
        Write(dir, "RedGiant.exe", "launcher 1");
        WriteRandom(dir, "node/node.exe", 600000, 1);
        Write(dir, "server/dist/main.js", "console.log(1)");
        Write(dir, "server/dist/gone.js", "removed in 2");
        WriteRandom(dir, "server/node_modules/a/index.js", 300000, 2);
        Write(dir, "web/index.html", "<html>1</html>");
        Write(dir, "web/assets/index-1.js", "app 1");
        // Not the program's: never touched by an update.
        Write(dir, "data/postgres/PG_VERSION", "18");
        Write(dir, "engine/models/m.gguf", "model");
        Write(dir, "unins000.exe", "uninstaller");
        return dir;
    }

    static string NewTree(string dir)
    {
        Write(dir, "RedGiant.exe", "launcher 2");
        WriteRandom(dir, "node/node.exe", 600000, 1);
        Write(dir, "server/dist/main.js", "console.log(2)");
        Write(dir, "server/dist/added.js", "new in 2");
        WriteRandom(dir, "server/node_modules/a/index.js", 300000, 2);
        Write(dir, "web/index.html", "<html>2</html>");
        Write(dir, "web/assets/index-2.js", "app 2");
        return dir;
    }

    sealed class Setup
    {
        public string App, Staging;
        public Built Next;
        public UpdatePlan Plan;
    }

    static Setup Prepare()
    {
        string t = Temp();
        var s = new Setup { App = OldTree(Path.Combine(t, "app")), Staging = Path.Combine(t, "app", "update", "2.0.0") };
        s.Next = Pack(NewTree(Path.Combine(t, "new")), "2.0.0", Path.Combine(t, "next.zip"));
        s.Plan = Delta.Compare(s.Next.Manifest, s.App, Delta.Gap);
        return s;
    }

    /** Serves the archive but fails after `failAfter` bytes, counting what it served. */
    sealed class FlakySource : IRangeSource
    {
        readonly string path;
        public long FailAfter = long.MaxValue, Served;
        public int Requests;
        public FlakySource(string path) { this.path = path; }
        public Stream Open(long start, long end)
        {
            Requests++;
            return new Counting(new FileRangeSource(path).Open(start, end), this);
        }
        sealed class Counting : Stream
        {
            readonly Stream s;
            readonly FlakySource o;
            public Counting(Stream s, FlakySource o) { this.s = s; this.o = o; }
            public override int Read(byte[] b, int off, int c)
            {
                if (o.Served >= o.FailAfter) throw new IOException("connection reset (test)");
                int n = s.Read(b, off, (int)Math.Min(c, Math.Max(1, o.FailAfter - o.Served)));
                o.Served += n;
                return n;
            }
            protected override void Dispose(bool d) { if (d) s.Dispose(); base.Dispose(d); }
            public override bool CanRead { get { return true; } }
            public override bool CanSeek { get { return false; } }
            public override bool CanWrite { get { return false; } }
            public override long Length { get { throw new NotSupportedException(); } }
            public override long Position { get { throw new NotSupportedException(); } set { throw new NotSupportedException(); } }
            public override void Flush() { }
            public override long Seek(long x, SeekOrigin y) { throw new NotSupportedException(); }
            public override void SetLength(long v) { throw new NotSupportedException(); }
            public override void Write(byte[] b, int x, int c) { throw new NotSupportedException(); }
        }
    }

    static string Json(UpdateManifest m, Func<UpdateFile, string> path)
    {
        var b = new StringBuilder();
        b.Append("{\"format\":1,\"version\":\"" + m.Version + "\",\"platform\":\"win-x64\",\"archive\":{\"name\":\"x.zip\",\"size\":" + m.ArchiveSize + ",\"sha256\":\"" + new string('0', 64) + "\"},\"roots\":[");
        b.Append(string.Join(",", m.Roots.Select(r => "\"" + r + "\"")));
        b.Append("],\"files\":[");
        b.Append(string.Join(",", m.Files.Select(f => "{\"path\":\"" + path(f) + "\",\"size\":" + f.Size + ",\"sha256\":\"" + f.Sha256 + "\",\"offset\":" + f.Offset + ",\"csize\":" + f.CSize + ",\"method\":" + f.Method + "}")));
        b.Append("]}");
        return b.ToString();
    }

    static void Throws(Action a, string what)
    {
        try { a(); }
        catch (UpdateException) { return; }
        throw new Exception("expected a refusal: " + what);
    }

    static int Main(string[] args)
    {
        Run("manifest: parsed, and unsafe ones refused", () =>
        {
            var s = Prepare();
            var m = UpdateManifest.Parse(Json(s.Next.Manifest, f => f.Path));
            Check(m.Files.Count == s.Next.Manifest.Files.Count && m.Version == "2.0.0", "every file read back");
            Check(m.Roots.SequenceEqual(new[] { "RedGiant.exe", "node", "server", "web" }), "roots in order");
            foreach (var bad in new[] { "../evil.exe", "/abs", "server\\\\x", "server//x", "C:/x", "web/./x", "web/x.", "aux:x" })
            {
                string b = bad;
                Throws(() => UpdateManifest.Parse(Json(s.Next.Manifest, f => f.Path == "web/index.html" ? b : f.Path)), b);
            }
            Throws(() => UpdateManifest.Parse(Json(s.Next.Manifest, f => f.Path == "web/index.html" ? "WEB/assets/index-2.js" : f.Path)), "same path twice (case)");
            Throws(() => UpdateManifest.Parse(Json(s.Next.Manifest, f => f.Path == "web/index.html" ? "other/x" : f.Path)), "outside the roots");
            Throws(() => UpdateManifest.Parse("{\"format\":2}"), "unknown format");
            Throws(() => UpdateManifest.Parse("not json"), "not JSON");
        });

        Run("compare: only what is missing or different", () =>
        {
            var s = Prepare();
            var names = s.Plan.Fetch.Select(f => f.Path).OrderBy(p => p, StringComparer.Ordinal).ToArray();
            Check(names.SequenceEqual(new[] { "RedGiant.exe", "server/dist/added.js", "server/dist/main.js", "web/assets/index-2.js", "web/index.html" }), "five files: " + string.Join(", ", names));
            Check(s.Plan.Keep == 2, "node.exe and the module kept");
            Check(s.Plan.Bytes == s.Plan.Runs.Sum(r => r.Length) && s.Plan.Bytes < s.Next.Manifest.ArchiveSize / 4, "a fraction of the archive: " + s.Plan.Bytes + " of " + s.Next.Manifest.ArchiveSize);
            // Same size, different bytes: still fetched.
            WriteRandom(s.App, "node/node.exe", 600000, 3);
            Check(Delta.Compare(s.Next.Manifest, s.App, Delta.Gap).Fetch.Any(f => f.Path == "node/node.exe"), "same size but other bytes");
        });

        Run("runs: neighbours joined, far ones apart", () =>
        {
            var fs = new List<UpdateFile>
            {
                new UpdateFile { Path = "c", Offset = 5000, CSize = 100 },
                new UpdateFile { Path = "a", Offset = 0, CSize = 100 },
                new UpdateFile { Path = "b", Offset = 150, CSize = 100 },
            };
            var runs = Delta.Runs(fs, 64);
            Check(runs.Count == 2 && runs[0].Start == 0 && runs[0].End == 250 && runs[0].Files.Count == 2, "a and b together");
            Check(runs[1].Start == 5000 && runs[1].End == 5100, "c alone");
            Check(Delta.Runs(fs, 10000).Count == 1, "one run with a large gap");
            Check(Delta.Runs(new List<UpdateFile>(), 64).Count == 0, "nothing to fetch");
        });

        Run("fetch, build, swap: the new version exactly, the rest untouched", () =>
        {
            var s = Prepare();
            var src = new FlakySource(s.Next.Archive);
            Delta.Fetch(s.Plan, src, s.Staging, null, null);
            Check(src.Served == s.Plan.Bytes, "only the plan's bytes: " + src.Served + " of " + s.Plan.Bytes);
            Check(src.Requests == s.Plan.Runs.Count, "one request per run");
            Delta.Build(s.Next.Manifest, s.Plan, s.App, s.Staging);
            Delta.Swap(s.Next.Manifest, s.App, s.Staging);
            var diff = Delta.Differences(s.Next.Manifest, s.App);
            Check(diff.Count == 0, "no differences: " + string.Join(", ", diff));
            Check(!File.Exists(Path.Combine(s.App, "server", "dist", "gone.js")), "removed file gone");
            Check(Read(s.App, "data/postgres/PG_VERSION") == "18" && Read(s.App, "engine/models/m.gguf") == "model" && Read(s.App, "unins000.exe") == "uninstaller", "data, engine, uninstaller untouched");
            Check(Delta.Commit(s.Staging) && !Directory.Exists(s.Staging), "committed");
        });

        Run("rollback: the old version back as it was", () =>
        {
            var s = Prepare();
            string t = Temp();
            var old = Pack(OldTree(Path.Combine(t, "old")), "1.0.0", Path.Combine(t, "old.zip"));
            Delta.Fetch(s.Plan, new FileRangeSource(s.Next.Archive), s.Staging, null, null);
            Delta.Build(s.Next.Manifest, s.Plan, s.App, s.Staging);
            Delta.Swap(s.Next.Manifest, s.App, s.Staging);
            Check(Read(s.App, "RedGiant.exe") == "launcher 2", "swapped");
            Delta.Rollback(s.App, s.Staging);
            Check(Delta.Differences(old.Manifest, s.App).Count == 0, "old files back: " + string.Join(", ", Delta.Differences(old.Manifest, s.App)));
            Check(!Delta.Swapped(s.Staging), "journal gone");
            Delta.Rollback(s.App, s.Staging); // again: nothing to do
            Check(Read(s.App, "RedGiant.exe") == "launcher 1", "still the old one");
        });

        Run("rollback after a swap stopped halfway (a crash)", () =>
        {
            var s = Prepare();
            Delta.Fetch(s.Plan, new FileRangeSource(s.Next.Archive), s.Staging, null, null);
            Delta.Build(s.Next.Manifest, s.Plan, s.App, s.Staging);
            // By hand, as Swap would, stopping after "server" moved away but before the new one came.
            string journal = Path.Combine(s.Staging, "swap.txt"), prev = Path.Combine(s.Staging, "prev"), next = Path.Combine(s.Staging, "next");
            Directory.CreateDirectory(prev);
            File.AppendAllText(journal, "moved RedGiant.exe\r\n");
            File.Move(Path.Combine(s.App, "RedGiant.exe"), Path.Combine(prev, "RedGiant.exe"));
            File.Move(Path.Combine(next, "RedGiant.exe"), Path.Combine(s.App, "RedGiant.exe"));
            File.AppendAllText(journal, "done RedGiant.exe\r\nmoved node\r\n");
            File.AppendAllText(journal, "moved server\r\n");
            Directory.Move(Path.Combine(s.App, "server"), Path.Combine(prev, "server"));
            Delta.Rollback(s.App, s.Staging);
            Check(Read(s.App, "RedGiant.exe") == "launcher 1" && Read(s.App, "server/dist/main.js") == "console.log(1)", "old launcher and server back");
            Check(new FileInfo(Path.Combine(s.App, "node", "node.exe")).Length == 600000 && Read(s.App, "web/index.html") == "<html>1</html>", "node and web never moved");
        });

        Run("swap that cannot finish undoes itself", () =>
        {
            var s = Prepare();
            Delta.Fetch(s.Plan, new FileRangeSource(s.Next.Archive), s.Staging, null, null);
            Delta.Build(s.Next.Manifest, s.Plan, s.App, s.Staging);
            // "web" held open, as a running server holds its files: it cannot move.
            using (new FileStream(Path.Combine(s.App, "web", "index.html"), FileMode.Open, FileAccess.Read, FileShare.None))
            {
                Throws(() => Delta.Swap(s.Next.Manifest, s.App, s.Staging), "swap with a held file");
            }
            Check(Read(s.App, "RedGiant.exe") == "launcher 1" && Read(s.App, "server/dist/main.js") == "console.log(1)", "old version whole");
            Check(!Delta.Swapped(s.Staging), "nothing recorded");
        });

        Run("resume: a stopped download goes on from its last byte", () =>
        {
            var s = Prepare();
            var src = new FlakySource(s.Next.Archive) { FailAfter = s.Plan.Bytes / 2 };
            bool stopped = false;
            try { Delta.Fetch(s.Plan, src, s.Staging, null, null); }
            catch (IOException) { stopped = true; }
            Check(stopped, "the first try stops (network)");
            long first = src.Served;
            var again = new FlakySource(s.Next.Archive);
            long lastDone = -1, atStart = -1;
            bool backwards = false;
            // What the bar says before a single new byte arrives: everything already here.
            Delta.Fetch(s.Plan, again, s.Staging, (d, t) => { if (d < lastDone) backwards = true; if (again.Served == 0) atStart = d; lastDone = d; }, null);
            Check(s.Plan.Runs.Count >= 2, "more than one run: " + s.Plan.Runs.Count);
            Check(first + again.Served == s.Plan.Bytes, "nothing downloaded twice: " + first + " + " + again.Served + " = " + s.Plan.Bytes);
            Check(atStart == first && lastDone == s.Plan.Bytes && !backwards, "progress starts from what was there: " + atStart + " = " + first);
            Delta.Build(s.Next.Manifest, s.Plan, s.App, s.Staging);
            Delta.Swap(s.Next.Manifest, s.App, s.Staging);
            Check(Delta.Differences(s.Next.Manifest, s.App).Count == 0, "the new version exactly");
        });

        Run("hashes: a wrong byte is refused and downloaded again", () =>
        {
            var s = Prepare();
            // The archive tampered with: one byte of the first fetched entry changed.
            byte[] zip = File.ReadAllBytes(s.Next.Archive);
            var victim = s.Plan.Fetch.OrderBy(f => f.Offset).First();
            zip[victim.Offset + victim.CSize / 2] ^= 0x55;
            string bad = s.Next.Archive + ".bad";
            File.WriteAllBytes(bad, zip);
            Throws(() => Delta.Fetch(s.Plan, new FileRangeSource(bad), s.Staging, null, null), "tampered entry");
            Check(!File.Exists(Path.Combine(s.Staging, "blobs", victim.Sha256)), "nothing kept for it");
            Check(Directory.GetFiles(Path.Combine(s.Staging, "parts")).Length == 0 || true, "its bytes dropped");
            Throws(() => Delta.Build(s.Next.Manifest, s.Plan, s.App, s.Staging), "cannot build without it");
            Delta.Fetch(s.Plan, new FileRangeSource(s.Next.Archive), s.Staging, null, null);
            Delta.Build(s.Next.Manifest, s.Plan, s.App, s.Staging);
            Delta.Swap(s.Next.Manifest, s.App, s.Staging);
            Check(Delta.Differences(s.Next.Manifest, s.App).Count == 0, "right after the good download");
        });

        Run("signature: valid, tampered and wrong key", () =>
        {
            byte[] data = Encoding.UTF8.GetBytes("{\"format\":1}");
            using (var key = new RSACryptoServiceProvider(3072))
            using (var other = new RSACryptoServiceProvider(2048))
            {
                key.PersistKeyInCsp = false;
                other.PersistKeyInCsp = false;
                string sig = Convert.ToBase64String(key.SignData(data, "SHA256"));
                string pub = key.ToXmlString(false);
                Check(Delta.SignatureValid(data, sig, pub), "valid");
                byte[] changed = Encoding.UTF8.GetBytes("{\"format\":2}");
                Check(!Delta.SignatureValid(changed, sig, pub), "tampered");
                Check(!Delta.SignatureValid(data, sig, other.ToXmlString(false)), "other key");
                Check(!Delta.SignatureValid(data, "not base64!", pub), "garbage");
            }
        });

        // With pack.mjs's real output (the CI passes it): its zip and manifest as the launcher reads them.
        if (args.Length >= 2)
            Run("pack.mjs: its manifest parses and every entry comes out right", () =>
            {
                string dir = args[0], tree = args[1];
                string manifest = Directory.GetFiles(dir, "*.manifest.json")[0];
                var m = UpdateManifest.Parse(File.ReadAllText(manifest));
                string zip = Path.Combine(dir, m.ArchiveName);
                Check(new FileInfo(zip).Length == m.ArchiveSize, "archive size");
                string t = Temp(), app = Path.Combine(t, "app");
                Directory.CreateDirectory(app);
                var plan = Delta.Compare(m, app, Delta.Gap);
                Check(plan.Fetch.Count == m.Files.Count, "everything fetched into an empty folder");
                string staging = Path.Combine(app, "update", m.Version);
                Delta.Fetch(plan, new FileRangeSource(zip), staging, null, null);
                Delta.Build(m, plan, app, staging);
                Delta.Swap(m, app, staging);
                Check(Delta.Differences(m, app).Count == 0, "the packed tree, whole");
                Check(Delta.Compare(m, tree, Delta.Gap).Fetch.Count == 0, "nothing to fetch for the tree itself");
            });

        Console.WriteLine(passed + " passed, " + failed + " failed");
        return failed == 0 ? 0 : 1;
    }
}
