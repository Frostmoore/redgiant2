// @vitest-environment jsdom
// Settings drawn as the wizard (2026-11-06): chats on other apps, budgets, backup and the
// platform's history keep every action they had, now as squares, boxes, cards and windows.
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Budget, PlatformChange } from "../src/api.js";
import { lang } from "../src/i18n.js";

const calls: [string, unknown[]][] = [];
const now = new Date().toISOString();
const changes: PlatformChange[] = [
  {
    id: "c1",
    kind: "config",
    change: "budget:global:local",
    stage: "promoted",
    target: null,
    before: { usd: 5 },
    after: { usd: 20 },
    detail: null,
    by: "human",
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "k1",
    kind: "code",
    change: "code",
    stage: "tested",
    target: null,
    before: null,
    after: null,
    detail: "diff",
    by: "human",
    createdAt: now,
    updatedAt: now,
  },
];
/** A fake server: every method answers something plausible and is written down. */
const fakeApi = new Proxy(
  {},
  {
    get: (_t, name: string) => {
      if (name === "then") return undefined;
      return (...args: unknown[]) => {
        calls.push([name, args]);
        if (name === "setup")
          return Promise.resolve({ secretsSet: { chats: ["discord"] }, locked: {}, config: {} });
        if (name === "chatLinks")
          return Promise.resolve([{ userId: "u1", username: "ada", linkedAt: now }]);
        if (name === "chatPair") return Promise.resolve({ code: "ABC123" });
        if (name === "budgets") return Promise.resolve(budgetRows);
        if (name === "spendDaily")
          return Promise.resolve([
            { day: now.slice(0, 10), scope: "global", id: "local", usd: 3, tokens: 10 },
          ]);
        if (name === "platformChanges") return Promise.resolve(changes);
        if (name === "platform")
          return Promise.resolve({
            sandbox: "docker",
            metal: false,
            supervised: true,
            lastGood: null,
            releases: [],
          });
        if (name === "chatUnlink" || name === "setBudget" || name === "setupChat")
          return Promise.resolve({});
        return Promise.resolve({});
      };
    },
  },
);
const budgetRows: Budget[] = [
  { scope: "global", id: "local", limit: { usd: 20 }, used: { usd: 25, tokens: 0 } },
  { scope: "project", id: "p1", limit: {}, used: { usd: 1, tokens: 0 } },
];
vi.mock("../src/state.js", async (orig) => ({
  ...(await orig<typeof import("../src/state.js")>()),
  getApi: () => fakeApi,
}));

const state = await import("../src/state.js");
const { ChatPlatforms } = await import("../src/components/ChatPlatforms.js");
const { Budgets } = await import("../src/components/Budgets.js");
const { Backup } = await import("../src/components/Backup.js");
const { Platform } = await import("../src/components/Platform.js");

const called = (name: string) => calls.filter(([n]) => n === name).map(([, a]) => a);

beforeEach(() => {
  lang.value = "it";
  calls.length = 0;
  state.projects.value = [{ id: "p1", name: "Sito", path: "/p", createdAt: now }];
  state.agents.value = [];
});
afterEach(cleanup);

describe("Settings drawn as the wizard: chats, budgets, backup, platform", () => {
  it("chats: a square per platform, lit when on; the window links, unlinks, changes, turns off", async () => {
    const r = render(<ChatPlatforms />);
    const tile = (name: RegExp) => r.getByRole("button", { name });
    await waitFor(() => expect(tile(/^Discord/).getAttribute("aria-pressed")).toBe("true"));
    expect(tile(/^Slack/).getAttribute("aria-pressed")).toBe("false");
    await waitFor(() => expect(tile(/^Discord/).textContent).toContain("Collegato: ada"));
    // Only the platform's own icon: never a check mark.
    for (const x of r.container.querySelectorAll(".wz-tile"))
      expect(x.querySelectorAll("svg")).toHaveLength(1);

    fireEvent.click(tile(/^Discord/));
    await waitFor(() => expect(r.getByText("/start ABC123")).toBeTruthy());
    expect(r.getByText("ada")).toBeTruthy();
    fireEvent.click(r.getByRole("button", { name: "Scollega" }));
    await waitFor(() => expect(called("chatUnlink")).toEqual([["discord", "u1"]]));
    fireEvent.click(r.getByRole("button", { name: "Spegni" }));
    await waitFor(() => expect(called("setupChat")).toEqual([["discord", null]]));

    fireEvent.click(r.getByRole("button", { name: /Cambia le impostazioni/ }));
    const input = r.getByRole("dialog").querySelector("input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "tok" } });
    fireEvent.click(r.getByRole("button", { name: "Collega" }));
    await waitFor(() => expect(called("setupChat").at(-1)).toEqual(["discord", { token: "tok" }]));

    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(tile(/^WhatsApp/));
    expect(r.getByRole("dialog").querySelectorAll("input")).toHaveLength(4);
  });

  it("budgets: the month big, a lit box per limit, the window sets and removes it", async () => {
    const r = render(<Budgets />);
    await waitFor(() => expect(r.getByRole("heading", { level: 1 }).textContent).toBe("$3.00"));
    const all = r.getByRole("button", { name: /^Tutto/ });
    expect(all.className).toContain("on");
    expect(all.className).toContain("warn");
    expect(all.textContent).toContain("Limite raggiunto: fermo");
    const site = r.getByRole("button", { name: /^Sito/ });
    expect(site.className).not.toContain(" on");

    fireEvent.click(site);
    fireEvent.click(r.getByRole("button", { name: "$50" }));
    fireEvent.click(r.getByRole("button", { name: "Salva" }));
    await waitFor(() =>
      expect(called("setBudget")).toEqual([[{ scope: "project", id: "p1", usd: 50 }]]),
    );
    await waitFor(() => expect(r.queryByRole("dialog")).toBeNull());

    fireEvent.click(all);
    fireEvent.click(r.getByRole("button", { name: "Nessun limite" }));
    await waitFor(() =>
      expect(called("setBudget").at(-1)).toEqual([{ scope: "global", id: "local" }]),
    );
    fireEvent.click(r.getByRole("button", { name: "Come funzionano i limiti" }));
    expect(r.getByRole("dialog").textContent).toContain("Gli abbonamenti");
  });

  it("backup: the two halves as cards, each with its button", () => {
    const r = render(<Backup />);
    expect(r.container.querySelectorAll(".wz-scard")).toHaveLength(2);
    fireEvent.click(r.getByRole("button", { name: /Prepara il backup/ }));
    expect(called("exportBackup")).toHaveLength(1);
    expect(r.getByRole("button", { name: /Scegli il file del backup/ })).toBeTruthy();
    expect(r.container.querySelector("input[type=file]")).toBeTruthy();
  });

  it("platform: undo, discard, and promote asked in a window instead of confirm()", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const r = render(<Platform />);
    await waitFor(() => expect(r.getByRole("button", { name: "Annulla" })).toBeTruthy());
    fireEvent.click(r.getByRole("button", { name: "Annulla" }));
    await waitFor(() => expect(called("undoChange")).toEqual([["c1"]]));
    fireEvent.click(r.getByRole("button", { name: "Scarta" }));
    await waitFor(() => expect(called("discardChange")).toEqual([["k1"]]));
    fireEvent.click(r.getByRole("button", { name: "Promuovi" }));
    const dialog = r.getByRole("dialog");
    fireEvent.click(dialog.querySelector(".wz-btn.primary") as HTMLElement);
    await waitFor(() => expect(called("promoteChange")).toEqual([["k1"]]));
    expect(confirm).not.toHaveBeenCalled();
    // The raw data of each change and the platform's state stay under "Technical details".
    expect(r.container.querySelectorAll("details.ui-advanced")).toHaveLength(3);
  });
});
