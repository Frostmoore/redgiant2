// Tests of ReleaseInfo.cs (G36.19), a console program built like DeltaTests (ci.yml):
//
//   csc /out:ReleaseInfoTests.exe /r:System.Web.Extensions.dll test\ReleaseInfoTests.cs ReleaseInfo.cs Delta.cs
//
// The table is the same as packages/protocol/test/release.test.ts. Exit code 0 when all pass.
using System;
using System.Security.Cryptography;
using System.Text;

static class ReleaseInfoTests
{
    static int failed, passed;

    static void Check(bool ok, string what)
    {
        if (ok) passed++;
        else { failed++; Console.WriteLine("FAIL " + what); }
    }

    static ReleaseInfo Info(string kind, string version, string min, string required, string clean)
    {
        return new ReleaseInfo { Kind = kind, Version = version, MinVersion = min, RequiredBelow = required, CleanInstallBelow = clean };
    }

    static void Row(string name, ReleaseInfo info, string installed, string latest, string want)
    {
        string got = ReleaseInfo.Assess(info, installed, latest);
        Check(got == want, name + ": " + got + " instead of " + want);
    }

    static int Main()
    {
        Check(ReleaseInfo.Compare("3.4.0", "3.10.0") < 0, "compare numbers, not text");
        Check(ReleaseInfo.Compare("v3.4.0", "3.4.0") == 0, "compare a leading v");

        Row("same version", Info("mandatory", "3.5.0", null, null, null), "3.5.0", "3.5.0", "none");
        Row("newer installed", Info("breaking", "3.5.0", null, null, null), "3.6.0", "3.5.0", "none");
        Row("no signed metadata", null, "3.4.0", "3.5.0", "normal");
        Row("normal release", Info("normal", "3.5.0", null, null, null), "3.4.0", "3.5.0", "normal");
        Row("mandatory for every older", Info("mandatory", "3.5.0", null, null, null), "3.4.9", "3.5.0", "mandatory");
        Row("mandatory only below minVersion", Info("mandatory", "3.5.0", "3.3.0", null, null), "3.4.0", "3.5.0", "normal");
        Row("mandatory below minVersion", Info("mandatory", "3.5.0", "3.3.0", null, null), "3.2.9", "3.5.0", "mandatory");
        Row("breaking for every older", Info("breaking", "3.5.0", null, null, null), "3.4.0", "3.5.0", "breaking");
        Row("breaking only below minVersion", Info("breaking", "3.5.0", "3.4.0", null, null), "3.4.0", "3.5.0", "normal");
        Row("carried clean install", Info("normal", "3.5.2", null, null, "3.5.0"), "3.4.0", "3.5.2", "breaking");
        Row("carried bound passed", Info("normal", "3.5.2", null, null, "3.5.0"), "3.5.1", "3.5.2", "normal");
        Row("carried mandatory", Info("normal", "3.5.2", null, "3.5.1", null), "3.5.0", "3.5.2", "mandatory");
        Row("breaking wins over mandatory", Info("mandatory", "3.5.0", null, null, "3.5.0"), "3.4.0", "3.5.0", "breaking");
        Row("metadata of another release", Info("mandatory", "3.5.0", null, null, null), "3.4.0", "3.5.1", "normal");

        // Parsing: what release-info.mjs writes, and what it never does.
        string json = "{\"format\":1,\"version\":\"3.5.0\",\"kind\":\"breaking\",\"minVersion\":\"3.4.0\",\"note\":{\"it\":\"Perché\",\"en\":\"Why\"},\"cleanInstallBelow\":\"3.4.0\",\"publishedAt\":\"2026-11-08T00:00:00.000Z\"}";
        var p = ReleaseInfo.Parse(json);
        Check(p != null && p.Kind == "breaking" && p.MinVersion == "3.4.0" && p.CleanInstallBelow == "3.4.0", "parse a release.json");
        Check(p != null && p.Note(true, "breaking") == "Perché" && p.Note(false, "breaking") == "Why" && p.Note(true, "mandatory") == null, "the note in each language");
        Check(ReleaseInfo.Parse("{\"format\":2,\"version\":\"3.5.0\",\"kind\":\"normal\"}") == null, "refuse another format");
        Check(ReleaseInfo.Parse("{\"format\":1,\"version\":\"3.5\",\"kind\":\"normal\"}") == null, "refuse a bad version");
        Check(ReleaseInfo.Parse("{\"format\":1,\"version\":\"3.5.0\",\"kind\":\"urgent\"}") == null, "refuse an unknown kind");
        Check(ReleaseInfo.Parse("not json") == null, "refuse what is not JSON");

        // Signature: valid, changed, another key, no key.
        using (var rsa = new RSACryptoServiceProvider(2048))
        using (var other = new RSACryptoServiceProvider(2048))
        {
            rsa.PersistKeyInCsp = false;
            other.PersistKeyInCsp = false;
            byte[] bytes = Encoding.UTF8.GetBytes(json);
            string sig = Convert.ToBase64String(rsa.SignData(bytes, "SHA256"));
            string pub = rsa.ToXmlString(false);
            Check(ReleaseInfo.Verified(bytes, sig, pub) != null, "a valid signature");
            byte[] forged = Encoding.UTF8.GetBytes(json.Replace("breaking", "mandatory"));
            Check(ReleaseInfo.Verified(forged, sig, pub) == null, "changed bytes refused");
            Check(ReleaseInfo.Verified(bytes, sig, other.ToXmlString(false)) == null, "another key refused");
            Check(ReleaseInfo.Verified(bytes, sig, "") == null, "no key: nothing counts");
            Check(ReleaseInfo.Verified(bytes, "%%%", pub) == null, "a signature that is not base64");
        }

        Console.WriteLine(passed + " passed, " + failed + " failed");
        return failed == 0 ? 0 : 1;
    }
}
