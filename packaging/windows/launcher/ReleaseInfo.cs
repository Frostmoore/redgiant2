// What a release says about itself (G36.19): release.json, signed with the update key (the same
// as the manifests', UpdateKey.cs) and attached to the release. "normal", "mandatory" (it must be
// installed before RedGiant is used again) or "breaking" (a clean install: never updated in
// place). Without a valid signature it counts for nothing. The same rules as assessRelease in
// packages/protocol/src/release.ts (tested as a table there and in test/ReleaseInfoTests.cs).
// Pure: no windows, no registry (C# 5, .NET Framework 4).
using System;
using System.Collections.Generic;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

public sealed class ReleaseInfo
{
    public const string Asset = "release.json";
    static readonly Regex VersionRe = new Regex(@"^\d+\.\d+\.\d+$");

    public string Version;
    public string Kind;
    public string MinVersion;
    public string RequiredBelow;
    public string CleanInstallBelow;
    public string NoteIt;
    public string NoteEn;

    /** The file's content, or null when it is not a valid release.json (format 1). */
    public static ReleaseInfo Parse(string json)
    {
        try
        {
            var d = new JavaScriptSerializer().DeserializeObject(json) as Dictionary<string, object>;
            if (d == null) return null;
            object format;
            if (!d.TryGetValue("format", out format) || !(format is int) || (int)format != 1) return null;
            var r = new ReleaseInfo
            {
                Version = Str(d, "version"),
                Kind = Str(d, "kind"),
                MinVersion = Str(d, "minVersion"),
                RequiredBelow = Str(d, "requiredBelow"),
                CleanInstallBelow = Str(d, "cleanInstallBelow"),
            };
            if (r.Version == null || !VersionRe.IsMatch(r.Version)) return null;
            if (r.Kind != "normal" && r.Kind != "mandatory" && r.Kind != "breaking") return null;
            foreach (var v in new[] { r.MinVersion, r.RequiredBelow, r.CleanInstallBelow })
                if (v != null && !VersionRe.IsMatch(v)) return null;
            object note;
            if (d.TryGetValue("note", out note) && note is Dictionary<string, object>)
            {
                var n = (Dictionary<string, object>)note;
                r.NoteIt = Str(n, "it");
                r.NoteEn = Str(n, "en");
            }
            return r;
        }
        catch (Exception) { return null; }
    }

    static string Str(Dictionary<string, object> d, string key)
    {
        object v;
        return d.TryGetValue(key, out v) ? v as string : null;
    }

    /** The release.json bytes when `signature` is the key's signature of them; null otherwise (or with no key). */
    public static ReleaseInfo Verified(byte[] bytes, string signature, string publicKeyXml)
    {
        if (string.IsNullOrEmpty(publicKeyXml) || bytes == null || signature == null) return null;
        if (!Delta.SignatureValid(bytes, signature, publicKeyXml)) return null;
        return Parse(Encoding.UTF8.GetString(bytes));
    }

    /** "3.4.0" against "3.10.0": negative when a is older. */
    public static int Compare(string a, string b)
    {
        var x = (a ?? "0").TrimStart('v').Split('.');
        var y = (b ?? "0").TrimStart('v').Split('.');
        for (int i = 0; i < Math.Max(x.Length, y.Length); i++)
        {
            int p = 0, q = 0;
            if (i < x.Length) int.TryParse(x[i], out p);
            if (i < y.Length) int.TryParse(y[i], out q);
            if (p != q) return p < q ? -1 : 1;
        }
        return 0;
    }

    /**
     * What `latest` means for the installed version: "none", "normal", "mandatory" or
     * "breaking". `info` null (missing, unsigned, forged) or about another version: only "normal".
     */
    public static string Assess(ReleaseInfo info, string installed, string latest)
    {
        if (Compare(installed, latest) >= 0) return "none";
        if (info == null || info.Version != latest) return "normal";
        string own = info.MinVersion ?? info.Version;
        Func<string, bool> below = v => v != null && Compare(installed, v) < 0;
        if (below(info.CleanInstallBelow) || (info.Kind == "breaking" && below(own))) return "breaking";
        if (below(info.RequiredBelow) || (info.Kind == "mandatory" && below(own))) return "mandatory";
        return "normal";
    }

    /** The reason in the person's language, when the release gives one for its own kind. */
    public string Note(bool italian, string gate)
    {
        if (Kind != gate) return null;
        string n = italian ? NoteIt : NoteEn;
        return string.IsNullOrEmpty(n) ? null : n;
    }
}
