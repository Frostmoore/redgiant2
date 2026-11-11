// Whether a look for updates may put a window on screen (3.5.4). Before, every look that found a
// newer version opened its own window: the start's look, then the page's «is there an update?»
// (update.json), and a stale update.json left by an earlier session, so the person saw the same
// question twice; after «Later» the page's look opened it again. Now:
//
//  - one update window at a time: a look that finds one on screen leaves it there (the page's
//    look brings it to the front, the automatic ones do nothing);
//  - an update running (its progress window, or the installer downloading) is never interrupted;
//  - what the person already answered in this session («Later», a snooze, a breaking release's
//    window closed) is not asked again: the page gets the state («available» and the version)
//    and shows it its own way. A mandatory release cannot be answered but by updating: its
//    window comes back whenever it is not on screen;
//  - a normal release is asked about only by the first start of the day and by the page; the
//    other starts and the six-hourly look ask only about mandatory and breaking ones.
//
// Pure function, tested as a table (test/AskGateTests.cs).
static class AskGate
{
    public enum From
    {
        /** The first start of the day (or one with a question left open): every kind is asked. */
        Morning,
        /** Any other start, and the look every six hours: mandatory and breaking only. */
        Background,
        /** The page asked (Settings > Look for updates, update.json): every kind. */
        Page,
    }

    public enum Step
    {
        /** No window: the state is reported (to the page) and nothing else happens. */
        None,
        /** Open the release's window (question, mandatory or breaking). */
        Show,
        /** The update window on screen comes to the front; no other one opens. */
        Front,
    }

    /**
     * gate: the release's kind (normal, mandatory, breaking, unchecked, none); open: an update
     * window is on screen; answered: the person already answered this release (kind and version)
     * in this session; updating: an update runs.
     */
    public static Step Decide(From from, string gate, bool open, bool answered, bool updating)
    {
        if (gate != "normal" && gate != "mandatory" && gate != "breaking") return Step.None;
        if (updating || open) return from == From.Page ? Step.Front : Step.None;
        if (gate == "mandatory") return Step.Show;
        if (answered) return Step.None;
        if (gate == "normal" && from == From.Background) return Step.None;
        return Step.Show;
    }

    /** A request in update.json counts only when it was written after this RedGiant started. */
    public static bool Fresh(System.DateTime writtenUtc, System.DateTime startedUtc)
    {
        return writtenUtc >= startedUtc;
    }

    /**
     * update-status.json as a start finds it (3.5.7). It is written only when the page asks, so
     * after an update it still said «available 3.5.5» with 3.5.6 installed. A state about another
     * version does not survive the change: «available» for a version not newer than the installed
     * one, or «latest» for another version, becomes «installed» with the installed version (the
     * id stays: no request of the server waits for it). Returns the text to write, or null when
     * the file still holds (nothing there, unreachable, a newer version still available).
     */
    public static string StatusAfterStart(string json, string installed)
    {
        if (string.IsNullOrEmpty(json) || string.IsNullOrEmpty(installed)) return null;
        var state = System.Text.RegularExpressions.Regex.Match(json, "\"state\"\\s*:\\s*\"([^\"]*)\"");
        var version = System.Text.RegularExpressions.Regex.Match(json, "\"version\"\\s*:\\s*\"([^\"]*)\"");
        var id = System.Text.RegularExpressions.Regex.Match(json, "\"id\"\\s*:\\s*\"([^\"]*)\"");
        if (!state.Success) return null;
        string v = version.Success ? version.Groups[1].Value : "";
        bool stale =
            (state.Groups[1].Value == "available" && CompareVersions(v, installed) <= 0) ||
            (state.Groups[1].Value == "latest" && CompareVersions(v, installed) != 0);
        if (!stale) return null;
        return "{\"id\":\"" + (id.Success ? id.Groups[1].Value : "") + "\",\"state\":\"installed\",\"version\":\"" + installed + "\"}";
    }

    /** As Updates.Compare: dotted numbers, an optional leading v. */
    static int CompareVersions(string a, string b)
    {
        var x = (a ?? "0").TrimStart('v').Split('.');
        var y = (b ?? "0").TrimStart('v').Split('.');
        for (int i = 0; i < System.Math.Max(x.Length, y.Length); i++)
        {
            int p = 0, q = 0;
            if (i < x.Length) int.TryParse(x[i], out p);
            if (i < y.Length) int.TryParse(y[i], out q);
            if (p != q) return p.CompareTo(q);
        }
        return 0;
    }
}
