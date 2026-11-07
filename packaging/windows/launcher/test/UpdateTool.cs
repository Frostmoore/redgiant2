// UpdateTool (G36.18): Delta.cs from the command line, for trying a differential update on a real
// tree without the launcher (its registry, its mutex, its windows). The CI and the tests on a PC
// use it; RedGiant itself never ships it.
//
//   csc /out:UpdateTool.exe /r:System.Web.Extensions.dll test\UpdateTool.cs Delta.cs
//   UpdateTool plan     <manifest> <app>
//   UpdateTool fetch    <manifest> <app> <staging> <zip URL or file> [stop-after-bytes]
//   UpdateTool build    <manifest> <app> <staging>
//   UpdateTool swap     <manifest> <app> <staging>
//   UpdateTool rollback <app> <staging>
//   UpdateTool commit   <staging>
//   UpdateTool verify   <manifest> <app>         exit 1 when anything differs
//   UpdateTool range    <URL> <start> <end>      one Range request, its sha256
//   UpdateTool checksig <manifest> <.sig> <public key XML file>   exit 1 unless valid
using System;
using System.Diagnostics;
using System.IO;

static class UpdateTool
{
    static UpdateManifest Load(string path) { return UpdateManifest.Parse(File.ReadAllText(path)); }

    /** As the launcher does: the hashes of the installed files remembered in update\hashes.txt. */
    static UpdatePlan Compare(UpdateManifest m, string app)
    {
        return Delta.Compare(m, app, Delta.Gap, Path.Combine(app, "update", "hashes.txt"));
    }

    static string Mb(long n) { return (n / 1048576.0).ToString("0.0") + " MB"; }

    static IRangeSource Source(string s)
    {
        return s.StartsWith("http://") || s.StartsWith("https://") ? (IRangeSource)new HttpRangeSource(s) : new FileRangeSource(s);
    }

    /** Stops the download after `limit` bytes, as a dropped connection would. */
    sealed class Limited : IRangeSource
    {
        readonly IRangeSource inner;
        readonly long limit;
        long served;
        public Limited(IRangeSource inner, long limit) { this.inner = inner; this.limit = limit; }
        public Stream Open(long start, long end)
        {
            if (served >= limit) throw new IOException("stopped on purpose after " + served + " bytes");
            long n = Math.Min(end - start, limit - served);
            served += n;
            return new Slice(inner.Open(start, start + n), n);
        }
    }

    static int Main(string[] a)
    {
        var watch = Stopwatch.StartNew();
        try
        {
            switch (a.Length > 0 ? a[0] : "")
            {
                case "plan":
                    {
                        var m = Load(a[1]);
                        var p = Compare(m, a[2]);
                        Console.WriteLine(m.Version + ": " + p.Fetch.Count + " of " + m.Files.Count + " files to download, " + Mb(p.Bytes) + " in " + p.Runs.Count + " requests (zip " + Mb(m.ArchiveSize) + ")");
                        break;
                    }
                case "fetch":
                    {
                        var m = Load(a[1]);
                        var p = Compare(m, a[2]);
                        IRangeSource src = Source(a[4]);
                        if (a.Length > 5) src = new Limited(src, long.Parse(a[5]));
                        long lastPrinted = -1;
                        Delta.Fetch(p, src, a[3], (d, t) =>
                        {
                            long pct = t > 0 ? d * 100 / t : 100;
                            if (pct / 10 != lastPrinted / 10) { Console.WriteLine("  " + Mb(d) + " of " + Mb(t) + " (" + pct + "%)"); lastPrinted = pct; }
                        }, null);
                        Console.WriteLine("fetched " + Mb(p.Bytes) + " in " + p.Runs.Count + " requests");
                        break;
                    }
                case "build":
                    {
                        var m = Load(a[1]);
                        Delta.Build(m, Compare(m, a[2]), a[2], a[3]);
                        Console.WriteLine("built " + m.Version);
                        break;
                    }
                case "swap":
                    Delta.Swap(Load(a[1]), a[2], a[3]);
                    Console.WriteLine("swapped");
                    break;
                case "rollback":
                    Delta.Rollback(a[1], a[2]);
                    Console.WriteLine("rolled back");
                    break;
                case "commit":
                    Console.WriteLine(Delta.Commit(a[1]) ? "committed" : "not yet (busy)");
                    break;
                case "verify":
                    {
                        var bad = Delta.Differences(Load(a[1]), a[2]);
                        foreach (var b in bad) Console.WriteLine("  differs: " + b);
                        Console.WriteLine(bad.Count == 0 ? "the same as the manifest" : bad.Count + " differences");
                        if (bad.Count > 0) return 1;
                        break;
                    }
                case "range":
                    {
                        long start = long.Parse(a[2]), end = long.Parse(a[3]);
                        using (var s = new HttpRangeSource(a[1]).Open(start, end))
                        using (var ms = new MemoryStream())
                        {
                            s.CopyTo(ms);
                            Console.WriteLine("206: " + ms.Length + " bytes, sha256 " + Delta.Sha256Bytes(ms.ToArray()));
                        }
                        break;
                    }
                case "checksig":
                    {
                        bool ok = Delta.SignatureValid(File.ReadAllBytes(a[1]), File.ReadAllText(a[2]), File.ReadAllText(a[3]));
                        Console.WriteLine(ok ? "signature valid" : "signature NOT valid");
                        if (!ok) return 1;
                        break;
                    }
                default:
                    Console.Error.WriteLine("usage: UpdateTool plan|fetch|build|swap|rollback|commit|verify|range …");
                    return 2;
            }
        }
        catch (Exception e)
        {
            Console.Error.WriteLine(e.GetType().Name + ": " + e.Message);
            return e is IOException ? 3 : 1;
        }
        Console.WriteLine("(" + watch.ElapsedMilliseconds + " ms)");
        return 0;
    }
}
