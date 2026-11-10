// When RedGiant.exe opens RedGiant's page (3.5.3). Before, the page opened as soon as the server
// answered, while the update question was still on screen or the update was downloading, and
// the new version opened a second page when it started. Now:
//
//  - at start the page waits for the update check: at most a few seconds (Limit) when nothing
//    is asked, as long as the person needs when a question is on screen;
//  - «Update» means this RedGiant never opens it (the new one will, or the open page reloads);
//  - started by an update (--after-update, --rolled-back) it opens one only when no page came
//    back by itself within a few seconds (pages that reload on a new version, GET /api/pages).
//
// Pure functions, tested as a table (test/PageGateTests.cs).
static class PageGate
{
    public enum Step
    {
        /** Not yet: the server is not answering, the update check is not over, or an update runs. */
        Wait,
        /** Never at this start (--background). */
        Skip,
        /** Open it now. */
        Open,
        /** Look whether a page came back by itself (Wait seconds), and open one only if none did. */
        OpenUnlessPage,
    }

    /** Seconds the page waits for the update check when no question is on screen. */
    public const int Limit = 4;
    /**
     * Seconds a launcher started by an update waits for an open page to come back (5 s at most
     * between its tries). 15 (3.5.5, was 7): three of the page's tries, so a slow PC or a browser
     * slow to wake a tab in the background does not get a second page; the wait ends as soon as a
     * page is back, so only a person with no page open waits the whole of it.
     */
    public const int Wait = 15;

    /** The update check is over for the page: an answer, or Limit seconds with no question on screen. */
    public static bool Settled(bool decided, bool asking, bool timedOut)
    {
        return decided || (timedOut && !asking);
    }

    /**
     * wanted: the page was asked for (not --background, or a breaking release's guide); ready: the
     * server answers; updating: this RedGiant is updating (it leaves; reopened only if that gives up);
     * handover: started by an update.
     */
    public static Step Decide(bool wanted, bool ready, bool settled, bool updating, bool handover)
    {
        if (!wanted) return Step.Skip;
        if (updating || !ready || !settled) return Step.Wait;
        return handover ? Step.OpenUnlessPage : Step.Open;
    }

    /** After the wait: open one only when no page came back (an unreadable answer counts as none). */
    public static bool OpenAfterWait(int pages)
    {
        return pages <= 0;
    }
}
