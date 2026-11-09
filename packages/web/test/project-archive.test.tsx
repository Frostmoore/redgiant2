// @vitest-environment jsdom
// Archiving a whole project (2026-11-09): the window says who is working and which automations
// pause, and asks in our window (never the browser's confirm); the archived list restores with one
// click; a conversation of an archived project shows the read-only line.
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lang } from "../src/i18n.js";

const calls: [string, unknown[]][] = [];
const fakeApi = new Proxy(
  {},
  {
    get: (_t, name: string) => {
      if (name === "then") return undefined;
      return (...args: unknown[]) => {
        calls.push([name, args]);
        if (name === "projectWork")
          return Promise.resolve({
            working: [
              { sessionId: "s1", agentId: "o1", agentName: "Shop lead", title: "Schede" },
              { sessionId: "s2", agentId: "a1", agentName: "Coder", title: null },
            ],
            automations: [{ id: "auto1", name: "nightly" }],
          });
        return Promise.resolve({});
      };
    },
  },
);
vi.mock("../src/state.js", async (orig) => ({
  ...(await orig<typeof import("../src/state.js")>()),
  getApi: () => fakeApi,
  refreshProjects: () => Promise.resolve(),
  refreshConversations: () => Promise.resolve(),
}));

const { ArchiveProjectDialog, ArchivedList, ArchivedNotice } = await import(
  "../src/components/ProjectArchive.js"
);
const { archivedProjects } = await import("../src/state.js");

const shop = { id: "shop", name: "Shop", path: "/w/shop", createdAt: "2026-11-01T00:00:00Z" };
const old = { ...shop, id: "old", name: "Old site", archivedAt: "2026-11-09T10:00:00Z" };

beforeEach(() => {
  calls.length = 0;
  lang.value = "it";
  archivedProjects.value = [old];
});
afterEach(cleanup);

describe("archiving a project (2026-11-09)", () => {
  it("says who will be stopped and asks in our window before archiving", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const closed: boolean[] = [];
    const r = render(<ArchiveProjectDialog project={shop} onClose={(a) => closed.push(a)} />);
    await waitFor(() =>
      expect(r.getByText("2 agenti stanno lavorando: verranno fermati")).toBeTruthy(),
    );
    expect(r.getByText(/Shop lead/)).toBeTruthy();
    expect(r.getByText(/1 automazione verrà messa in pausa \(nightly\)/)).toBeTruthy();
    expect(r.container.closest("body")?.querySelector(".ui-modal")).not.toBeNull();
    expect(calls.some(([n]) => n === "archiveProject")).toBe(false);
    fireEvent.click(r.getByText("Ferma e archivia"));
    await waitFor(() => expect(closed).toEqual([true]));
    expect(calls.find(([n]) => n === "archiveProject")?.[1]).toEqual(["shop"]);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("lists the archived projects and restores one with a click", async () => {
    const r = render(<ArchivedList />);
    expect(r.getByText("Old site")).toBeTruthy();
    fireEvent.click(r.getByText("Ripristina"));
    await waitFor(() => expect(calls.find(([n]) => n === "restoreProject")?.[1]).toEqual(["old"]));
  });

  it("puts the read-only line where the composer was", () => {
    const r = render(<ArchivedNotice projectId="old" />);
    expect(r.getByText("Archiviato · sola lettura")).toBeTruthy();
    expect(
      r.getByText(/«Old site» è archiviato: questa conversazione è in sola lettura/),
    ).toBeTruthy();
    expect(r.container.querySelector("input[type=checkbox]")).toBeNull();
  });
});
