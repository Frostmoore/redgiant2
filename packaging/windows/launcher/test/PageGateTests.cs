// Tests of PageGate.cs (3.5.3), a console program built like the others (ci.yml):
//
//   csc /out:PageGateTests.exe test\PageGateTests.cs PageGate.cs
//
// Exit code 0 when all pass.
using System;

static class PageGateTests
{
    static int failed, passed;

    static void Check(bool ok, string what)
    {
        if (ok) passed++;
        else { failed++; Console.WriteLine("FAIL " + what); }
    }

    static void Row(string name, bool wanted, bool ready, bool settled, bool updating, bool handover, PageGate.Step want)
    {
        var got = PageGate.Decide(wanted, ready, settled, updating, handover);
        Check(got == want, name + ": " + got + " instead of " + want);
    }

    static int Main()
    {
        // The update check, for the page.
        Check(!PageGate.Settled(false, false, false), "still looking, within the limit: wait");
        Check(PageGate.Settled(false, false, true), "still looking past the limit, nothing asked: open");
        Check(!PageGate.Settled(false, true, true), "a question on screen: wait for the answer, whatever the time");
        Check(PageGate.Settled(true, false, false), "answered (nothing to update, later, update): settled");

        Row("background start", false, true, true, false, false, PageGate.Step.Skip);
        Row("background, started by an update", false, true, true, false, true, PageGate.Step.Skip);
        Row("server not answering yet", true, false, true, false, false, PageGate.Step.Wait);
        Row("update check not over", true, true, false, false, false, PageGate.Step.Wait);
        Row("nothing to update", true, true, true, false, false, PageGate.Step.Open);
        Row("update chosen: never from this RedGiant", true, true, true, true, false, PageGate.Step.Wait);
        Row("update chosen before the server answered", true, false, true, true, false, PageGate.Step.Wait);
        Row("after an update", true, true, true, false, true, PageGate.Step.OpenUnlessPage);
        Row("after an update, server not answering yet", true, false, true, false, true, PageGate.Step.Wait);

        Check(PageGate.OpenAfterWait(0), "no page came back: open one");
        Check(!PageGate.OpenAfterWait(1), "a page came back: no second one");
        Check(!PageGate.OpenAfterWait(3), "pages came back: no other one");
        Check(PageGate.OpenAfterWait(-1), "the server could not say: open one");
        Check(PageGate.Wait >= 6, "the wait covers the page's 5 s between tries");
        Check(PageGate.Limit >= 3 && PageGate.Limit <= 5, "the update check delays the page a few seconds at most");

        Console.WriteLine(passed + " passed, " + failed + " failed");
        return failed == 0 ? 0 : 1;
    }
}
