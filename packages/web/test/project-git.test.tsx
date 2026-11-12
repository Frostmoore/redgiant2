// @vitest-environment jsdom
// A git repository in every project (3.5.12): Settings > Projects marks a project without one and
// offers «Inizializza git»; a project made without it says so, never a repository claimed.
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lang } from "../src/i18n.js";

const calls: [string, unknown[]][] = [];
let refreshed = 0;
const fakeApi = new Proxy(
  {},
  {
    get: (_t, name: string) => {
      if (name === "then") return undefined;
      return (...args: unknown[]) => {
        calls.push([name, args]);
        if (name === "initProjectGit") return Promise.resolve({ git: "created" });
        return Promise.resolve({});
      };
    },
  },
);
vi.mock("../src/state.js", async (orig) => ({
  ...(await orig<typeof import("../src/state.js")>()),
  getApi: () => fakeApi,
  refreshProjects: () => {
    refreshed++;
    return Promise.resolve();
  },
}));

const { ProjectsPage, noGitNotice } = await import("../src/components/ProjectArchive.js");
const { projects } = await import("../src/state.js");

const base = {
  path: "C:\\Users\\Me\\RedGiant\\workspaces\\me\\x",
  createdAt: "2026-11-12T00:00:00Z",
};

beforeEach(() => {
  calls.length = 0;
  refreshed = 0;
  lang.value = "it";
});
afterEach(cleanup);

describe("noGitNotice", () => {
  it("speaks only when the project has no repository, and says why", () => {
    expect(noGitNotice({ ...base, id: "a", name: "A", git: true })).toBeUndefined();
    expect(noGitNotice({ ...base, id: "a", name: "A" })).toBeUndefined();
    expect(
      noGitNotice({
        ...base,
        id: "a",
        name: "Sito",
        git: false,
        gitError: "git is not installed on this computer yet (RedGiant downloads…)",
      }),
    ).toBe(
      "Progetto «Sito» creato, ma senza repository git: git non è ancora installato su questo computer. Crealo da Impostazioni › Progetti («Inizializza git») appena git funziona.",
    );
    expect(
      noGitNotice({ ...base, id: "a", name: "Sito", git: false, gitError: "git init: fatal: x" }),
    ).toMatch(/senza repository git: git init: fatal: x\./);
    expect(noGitNotice({ ...base, id: "a", name: "Note", git: false })).toMatch(
      /sulla sua cartella, che non ha un repository git/,
    );
  });
});

describe("Settings > Projects (3.5.12)", () => {
  it("marks the project without git and «Inizializza git» creates its repository", async () => {
    projects.value = [
      { ...base, id: "shop", name: "Shop", git: true },
      { ...base, id: "notes", name: "Note", git: false },
    ];
    const r = render(<ProjectsPage />);
    expect(r.getAllByText("Senza repository git")).toHaveLength(1);
    const buttons = r.getAllByRole("button", { name: /Inizializza git/ });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0] as HTMLElement);
    await waitFor(() =>
      expect(r.getByText("Repository git creato per «Note» (branch main).")).toBeTruthy(),
    );
    expect(calls).toContainEqual(["initProjectGit", ["notes"]]);
    expect(refreshed).toBe(1);
    // The Windows path is shown as it is.
    expect(r.getAllByText("C:\\Users\\Me\\RedGiant\\workspaces\\me\\x")).toHaveLength(2);
  });
});
