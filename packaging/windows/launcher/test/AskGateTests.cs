// Tests of AskGate.cs (3.5.4), a console program built like the others (ci.yml):
//
//   csc /out:AskGateTests.exe test\AskGateTests.cs AskGate.cs
//
// Exit code 0 when all pass.
using System;

static class AskGateTests
{
    static int failed, passed;

    static void Check(bool ok, string what)
    {
        if (ok) passed++;
        else { failed++; Console.WriteLine("FAIL " + what); }
    }

    const AskGate.From Morning = AskGate.From.Morning, Background = AskGate.From.Background, Page = AskGate.From.Page;
    const AskGate.Step None = AskGate.Step.None, Show = AskGate.Step.Show, Front = AskGate.Step.Front;

    static void Row(string name, AskGate.From from, string gate, bool open, bool answered, bool updating, AskGate.Step want)
    {
        var got = AskGate.Decide(from, gate, open, answered, updating);
        Check(got == want, name + ": " + got + " instead of " + want);
    }

    static int Main()
    {
        //  name                                                        from        gate         open   answered updating want
        Row("first start of the day, a normal release",                 Morning,    "normal",    false, false, false, Show);
        Row("the page looks while the start's question is on screen",   Page,       "normal",    true,  false, false, Front);
        Row("the start looks while the page's question is on screen",   Morning,    "normal",    true,  false, false, None);
        Row("the page looks after «Later»",                             Page,       "normal",    false, true,  false, None);
        Row("another start of the day: a normal release waits",         Background, "normal",    false, false, false, None);
        Row("six-hourly look, a normal release",                        Background, "normal",    false, false, false, None);
        Row("the page looks, never asked yet in this session",          Page,       "normal",    false, false, false, Show);
        Row("the page looks while the update downloads",                Page,       "normal",    false, false, true,  Front);
        Row("six-hourly look while the update downloads",               Background, "mandatory", false, false, true,  None);
        Row("a mandatory release at any start",                         Background, "mandatory", false, false, false, Show);
        Row("a mandatory window on screen, six-hourly look",            Background, "mandatory", true,  false, false, None);
        Row("a mandatory window on screen, the page looks",             Page,       "mandatory", true,  false, false, Front);
        Row("a mandatory release comes back after an update gave up",   Page,       "mandatory", false, true,  false, Show);
        Row("a breaking release at any start",                          Background, "breaking",  false, false, false, Show);
        Row("a breaking window on screen, the page looks",              Page,       "breaking",  true,  false, false, Front);
        Row("a breaking window closed, six-hourly look",                Background, "breaking",  false, true,  false, None);
        Row("a breaking window closed, the page looks",                 Page,       "breaking",  false, true,  false, None);
        Row("a breaking window closed, the next morning's look",        Morning,    "breaking",  false, true,  false, None);
        Row("release.json unreadable: no window",                       Page,       "unchecked", false, false, false, None);
        Row("nothing newer",                                            Page,       "none",      false, false, false, None);
        Row("nothing newer, a window on screen",                        Page,       "none",      true,  false, false, None);

        var start = new DateTime(2026, 11, 10, 10, 20, 10, DateTimeKind.Utc);
        Check(!AskGate.Fresh(start.AddHours(-20), start), "update.json of an earlier session: ignored");
        Check(!AskGate.Fresh(start.AddMilliseconds(-1), start), "written just before this start: ignored");
        Check(AskGate.Fresh(start.AddSeconds(16), start), "written by this session's server: read");
        Check(AskGate.Fresh(start, start), "written as it started: read");

        Console.WriteLine(passed + " passed, " + failed + " failed");
        return failed == 0 ? 0 : 1;
    }
}
