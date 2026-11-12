// @vitest-environment jsdom
// «Le novità» by release (3.5.12, the person's test of 3.5.11): the version next to every item,
// newest first, and after several updates (3.5.6 -> 3.5.11) only what is newer than the last
// version this browser saw, grouped by version.
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lang, t } from "../src/i18n.js";

let sessions: unknown[] = [{ id: "s1" }];
vi.mock("../src/state.js", async (orig) => ({
  ...(await orig<typeof import("../src/state.js")>()),
  getApi: () => ({ sessions: () => Promise.resolve(sessions) }),
}));

const { compareVersions, ITEMS, NEWS_VERSION, newsSince, WhatsNew } = await import(
  "../src/components/WhatsNew.js"
);

beforeEach(() => {
  lang.value = "it";
  localStorage.clear();
  sessions = [{ id: "s1" }];
});
afterEach(cleanup);

describe("compareVersions", () => {
  const table: [string, string, number][] = [
    ["3.5.9", "3.5.10", -1],
    ["3.5.11", "3.5.6", 1],
    ["3.4.0", "3.3.2", 1],
    ["3.2.0", "3.2.0", 0],
    ["3.2", "3.2.0", 0],
    ["4.0.0", "3.9.9", 1],
  ];
  it.each(table)("%s vs %s -> %d", (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b))).toBe(sign);
  });
});

describe("the items", () => {
  it("each carries the release its key names, none beyond NEWS_VERSION, keys unique", () => {
    for (const i of ITEMS) {
      // news3511… is 3.5.11, news359… 3.5.9, news32… 3.2.0.
      const digits = i.version.replaceAll(".", "");
      const named = i.title.match(/^news(\d+)[A-Z]/)?.[1];
      expect([digits, digits.replace(/0$/, "")], i.title).toContain(named);
      expect(compareVersions(i.version, NEWS_VERSION)).toBeLessThanOrEqual(0);
    }
    expect(new Set(ITEMS.map((i) => i.title)).size).toBe(ITEMS.length);
    expect(ITEMS.some((i) => i.version === NEWS_VERSION)).toBe(true);
  });
});

describe("newsSince", () => {
  it("keeps only what is newer than the version seen, grouped, newest first", () => {
    const groups = newsSince("3.5.6");
    expect(groups.map((g) => g.version)).toEqual(["3.5.11", "3.5.10", "3.5.9", "3.5.8", "3.5.7"]);
    expect(groups[0]?.items.map((i) => i.title)).toEqual([
      "news3511Phone",
      "news3511Keys",
      "news3511Fast",
    ]);
    expect(groups.flatMap((g) => g.items).some((i) => i.version === "3.5.6")).toBe(false);
  });

  it("orders by release even when the items are written out of order", () => {
    const items = [
      { version: "3.5.9", title: "news359Widgets", text: "news359WidgetsText" },
      { version: "3.5.11", title: "news3511Phone", text: "news3511PhoneText" },
      { version: "3.5.10", title: "news3510Webrtc", text: "news3510WebrtcText" },
      { version: "3.5.11", title: "news3511Keys", text: "news3511KeysText" },
    ] as const;
    expect(
      newsSince(null, [...items]).map((g) => [g.version, g.items.map((i) => i.title)]),
    ).toEqual([
      ["3.5.11", ["news3511Phone", "news3511Keys"]],
      ["3.5.10", ["news3510Webrtc"]],
      ["3.5.9", ["news359Widgets"]],
    ]);
  });

  it("has nothing for whoever saw this version, or a newer one", () => {
    expect(newsSince(NEWS_VERSION)).toEqual([]);
    expect(newsSince("9.0.0")).toEqual([]);
  });

  it("without a version seen shows everything, newest first", () => {
    const all = newsSince(null);
    expect(all.flatMap((g) => g.items)).toHaveLength(ITEMS.length);
    const versions = all.map((g) => g.version);
    expect([...versions].sort((a, b) => compareVersions(b, a))).toEqual(versions);
  });
});

describe("the window", () => {
  it("after 3.5.6 shows the versions since, each item with its chip, and remembers", async () => {
    localStorage.setItem("rg.newsSeen", "3.5.6");
    const r = render(<WhatsNew />);
    await waitFor(() => expect(r.getByText(t("news3511Phone"))).toBeTruthy());
    const heads = [...r.container.querySelectorAll(".news-group-head")].map((h) => h.textContent);
    expect(heads).toEqual([
      "Versione 3.5.11",
      "Versione 3.5.10",
      "Versione 3.5.9",
      "Versione 3.5.8",
      "Versione 3.5.7",
    ]);
    const chips = [...r.container.querySelectorAll(".news-chip")].map((c) => c.textContent);
    expect(chips.slice(0, 4)).toEqual(["3.5.11", "3.5.11", "3.5.11", "3.5.10"]);
    expect(chips).toHaveLength(newsSince("3.5.6").flatMap((g) => g.items).length);
    expect(r.queryByText(t("news356Steps"))).toBeNull();
    fireEvent.click(r.getByText("Ho capito"));
    expect(localStorage.getItem("rg.newsSeen")).toBe(NEWS_VERSION);
    expect(r.container.querySelector(".whats-new")).toBeNull();
  });

  it("one version only: its items with their chip, no group heading", async () => {
    const prev = [...ITEMS]
      .map((i) => i.version)
      .filter((v) => compareVersions(v, NEWS_VERSION) < 0)
      .sort((a, b) => compareVersions(b, a))[0] as string;
    localStorage.setItem("rg.newsSeen", prev);
    const r = render(<WhatsNew />);
    await waitFor(() => expect(r.container.querySelector(".news-chip")).toBeTruthy());
    expect(r.container.querySelector(".news-group-head")).toBeNull();
    expect(
      [...r.container.querySelectorAll(".news-chip")].every((c) => c.textContent === NEWS_VERSION),
    ).toBe(true);
  });

  it("stays shut for a new installation and for whoever is up to date", async () => {
    sessions = [];
    const r = render(<WhatsNew />);
    await waitFor(() => expect(localStorage.getItem("rg.newsSeen")).toBe(NEWS_VERSION));
    expect(r.container.querySelector(".whats-new")).toBeNull();
    cleanup();
    sessions = [{ id: "s1" }];
    const again = render(<WhatsNew />);
    await new Promise((ok) => setTimeout(ok, 20));
    expect(again.container.querySelector(".whats-new")).toBeNull();
  });
});
