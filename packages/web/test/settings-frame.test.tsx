// @vitest-environment jsdom
// Settings drawn as the wizard (2026-11-06): the list of sections in groups (a sheet on a phone),
// General's rows and squares with their windows, Code's squares and the agents' page with its
// switch and windows. Nothing the pages could do before may be missing.
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SetupState } from "../src/api.js";
import { lang } from "../src/i18n.js";

const calls: string[] = [];
const setup = {
  config: {
    completed: true,
    instructions: "Answer in Italian.",
    backupModel: null,
    searchProvider: "brave",
    git: { github: { login: "mario" } },
  },
  secretsSet: { keys: [], server: false, telegram: false, images: false },
  locked: {},
  providers: [],
  names: { god: null, demigod: null, godPrompt: null },
  policy: { humanOnly: [], disabledDanger: [], dangers: [] },
  canRunSearch: true,
} as unknown as SetupState;

/** A fake server: every method answers something plausible and is written down. */
const fakeApi = new Proxy(
  {},
  {
    get: (_t, name: string) => {
      if (name === "then") return undefined;
      return () => {
        calls.push(name);
        if (name === "setup") return Promise.resolve(setup);
        if (name === "emailSettings") return Promise.resolve({ configured: false });
        if (name === "debugState")
          return Promise.resolve({ enabled: false, forced: false, bytes: 0, files: 0 });
        if (name === "models" || name === "telegramLinks" || name === "gitSync")
          return Promise.resolve([]);
        if (name === "telegramPair") return new Promise(() => {});
        return Promise.resolve({});
      };
    },
  },
);
vi.mock("../src/state.js", async (orig) => ({
  ...(await orig<typeof import("../src/state.js")>()),
  getApi: () => fakeApi,
}));

const { Settings } = await import("../src/components/Settings.js");
const { General } = await import("../src/components/General.js");
const { CodeSettings } = await import("../src/components/CodeSettings.js");
const { Hierarchy } = await import("../src/components/Hierarchy.js");
const { agents } = await import("../src/state.js");

beforeEach(() => {
  lang.value = "it";
  calls.length = 0;
});
afterEach(cleanup);

describe("Settings drawn as the wizard", () => {
  it("lists every section in groups, the current one lit, and the same list in a sheet", async () => {
    const r = render(<Settings section="telegram" />);
    const nav = r.container.querySelector(".settings-nav") as HTMLElement;
    // 16 with Shared memory (G33.2), the Keychain (G33.4) and Tools (G34.5).
    // 17 with Import (G36.7), 19 with Commands and Requests to you (G36.16, G36.17), 20 with
    // Knowledge (G36.5), 21 with Projects (archiving one, 2026-11-09), 22 with Artifacts (3.5.9),
    // 23 with Machines (G38.2), 24 with External agents (ACP, G38.6), 25 with Voice (G38.4).
    expect(nav.querySelectorAll(".st-nav-item")).toHaveLength(25);
    expect(nav.querySelectorAll(".wz-grp")).toHaveLength(5);
    expect(nav.querySelector(".st-nav-item.cur")?.textContent).toBe("Telegram");
    expect(r.container.querySelector(".st-pick")?.textContent).toContain("Telegram");
    fireEvent.click(r.container.querySelector(".st-pick") as HTMLElement);
    const sheet = r.container.querySelector(".ui-modal") as HTMLElement;
    expect(sheet.querySelectorAll(".st-nav-item")).toHaveLength(25);
  });

  it("General: theme and language in segments, and a window for each square", async () => {
    const r = render(<General />);
    await waitFor(() => expect(r.container.querySelector(".wz-q")).not.toBeNull());
    expect(r.container.querySelectorAll(".wz-seg button")).toHaveLength(5);
    const tiles = [...r.container.querySelectorAll(".wz-tile")];
    const titles = tiles.map((x) => x.querySelector(".wz-tile-title")?.textContent);
    expect(titles).toEqual([
      "Istruzioni per tutti gli agenti",
      "Modello di riserva per i task",
      "Ricerca sul web",
      "Messaggi vocali",
      "Immagini",
      "Aggiornamenti",
      "Diagnostica",
    ]);
    // Lit by border and background when set, never with a check mark.
    expect(tiles[0]?.classList.contains("on")).toBe(true);
    expect(tiles[1]?.classList.contains("on")).toBe(false);
    expect(r.container.querySelector(".wz-tile svg path[d='M20 6L9 17l-5-5']")).toBeNull();
    fireEvent.click(tiles[0] as HTMLElement);
    const box = r.container.querySelector(".ui-modal textarea") as HTMLTextAreaElement;
    expect(box.value).toBe("Answer in Italian.");
    fireEvent.input(box, { target: { value: "Answer in English." } });
    fireEvent.click(r.getByText("Salva"));
    await waitFor(() => expect(calls).toContain("setupInstructions"));
    expect(r.getByText("Esci")).toBeTruthy();
    expect(calls).toEqual(expect.arrayContaining(["setup", "debugState"]));
    // The mailbox serves automations only and lives with them (2026-11-07).
    expect(calls).not.toContain("emailSettings");
  });

  it("General: voice messages are saved alone", async () => {
    const r = render(<General />);
    await waitFor(() => expect(r.container.querySelector(".wz-tile")).not.toBeNull());
    fireEvent.click(r.getByText("Messaggi vocali"));
    fireEvent.click(r.getByText("Salva"));
    await waitFor(() => expect(calls).toContain("setupModels"));
  });

  it("Code: GitHub and Gitea as squares, GitHub lit, and the projects' repositories", async () => {
    const r = render(<CodeSettings />);
    await waitFor(() => expect(r.container.querySelector(".wz-tile")).not.toBeNull());
    const tiles = r.container.querySelectorAll(".wz-tile");
    expect(tiles).toHaveLength(2);
    expect(tiles[0]?.classList.contains("on")).toBe(true);
    fireEvent.click(r.getByText("Crea adesso le repository"));
    await waitFor(() => expect(calls).toContain("gitSync"));
    fireEvent.click(tiles[0] as HTMLElement);
    expect(r.container.querySelector(".ui-modal")).not.toBeNull();
  });

  it("Agents: the view in segments, the stopped ones behind a switch, new agents in a window", () => {
    agents.value = [
      { id: "g", kind: "god", name: "God", parentId: null, projectId: null, status: "active" },
      {
        id: "s",
        kind: "assistant",
        name: "Old",
        parentId: "g",
        projectId: null,
        status: "stopped",
      },
    ] as never;
    const r = render(<Hierarchy />);
    expect(r.getByText("God")).toBeTruthy();
    expect(r.queryByText("Old")).toBeNull();
    fireEvent.click(r.getByRole("switch"));
    expect(r.getByText("Old")).toBeTruthy();
    fireEvent.click(r.getByText("Schede"));
    expect(r.container.querySelector(".agent-tile")).not.toBeNull();
    fireEvent.click(r.getByText("Nuovo agente"));
    expect(r.container.querySelector(".ui-modal")).not.toBeNull();
  });
});
