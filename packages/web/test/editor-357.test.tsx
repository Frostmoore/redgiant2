// @vitest-environment jsdom
// p3.5.7, the person's test of 3.5.6: the sentence about what «Modifica» brings down vanished as
// the copy opened, before it could be read. It stays until the editor is ready, with the
// download's bar (amounts, speed, time left), and then a short line stays until it is closed.
import { act, cleanup, fireEvent, render } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import { EditCopyNote } from "../src/components/viewers/OfficeEditor.js";
import { setLang } from "../src/i18n.js";
import { officeLoad, officeLoadStep, setOfficeLoad } from "../src/state.js";

const MB = 1024 * 1024;

afterEach(() => {
  cleanup();
  officeLoad.value = undefined;
});

describe("the editor coming down, measured (p3.5.7)", () => {
  it("speed and time left from the amounts seen, a real download remembered", () => {
    let s = officeLoadStep(undefined, { at: "checking" }, 0);
    s = officeLoadStep(s, { at: "browser", done: 0, total: 50 * MB }, 1000);
    expect(s.progress).toEqual({ done: 0, total: 50 * MB, rate: null, secondsLeft: null });
    s = officeLoadStep(s, { at: "browser", done: 10 * MB, total: 50 * MB }, 3000);
    expect(s.progress?.rate).toBe(5 * MB);
    expect(s.progress?.secondsLeft).toBe(8);
    s = officeLoadStep(s, { at: "opening" }, 11_000);
    expect(s.downloaded).toBe(true);
    s = officeLoadStep(s, { at: "ready" }, 12_000);
    expect(s).toEqual({ at: "ready", downloaded: true });
  });

  it("a copy from the browser's storage is no download; the server's always is", () => {
    let s = officeLoadStep(undefined, { at: "browser", done: 0, total: 50 * MB }, 0);
    s = officeLoadStep(s, { at: "browser", done: 50 * MB, total: 50 * MB }, 300);
    expect(officeLoadStep(s, { at: "ready" }, 400).downloaded).toBeUndefined();
    let r = officeLoadStep(undefined, { at: "server", job: "j1" }, 0);
    r = officeLoadStep(r, { at: "browser", done: 0, total: 50 * MB }, 100);
    r = officeLoadStep(r, { at: "browser", done: 50 * MB, total: 50 * MB }, 200);
    expect(officeLoadStep(r, { at: "opening" }, 300).downloaded).toBe(true);
    expect(officeLoadStep(r, { at: "fallback" }, 300).downloaded).toBeUndefined();
  });
});

describe("the line under the canvas's head (p3.5.7)", () => {
  it("stays on the copy's tab while the editor comes down, with a real bar", async () => {
    setLang("it");
    const { container, findByRole, queryByRole } = render(<EditCopyNote editing />);
    // Nothing coming yet on the copy's tab: no line.
    expect(queryByRole("note")).toBeNull();
    act(() => {
      officeLoad.value = officeLoadStep(undefined, { at: "browser", done: 0, total: 50 * MB }, 0);
      officeLoad.value = officeLoadStep(
        officeLoad.value,
        { at: "browser", done: 12 * MB, total: 50 * MB },
        4000,
      );
    });
    const note = await findByRole("note");
    expect(note.querySelector('[role="progressbar"]')).not.toBeNull();
    // MB done and total, speed, time left.
    expect(container.textContent).toMatch(/12(\.0)? MB di 50(\.0)? MB/);
    expect(container.textContent).toMatch(/3(\.0)? MB\/s/);
    expect(container.textContent).toMatch(/minut/);
    // Opening: the sentence is still there.
    act(() => {
      officeLoad.value = officeLoadStep(officeLoad.value, { at: "opening" }, 20_000);
    });
    expect(queryByRole("note")).not.toBeNull();
    expect(container.textContent).toMatch(/Apro il documento/);
  });

  it("after the download a short line stays until it is closed", async () => {
    setLang("it");
    act(() => {
      setOfficeLoad({ at: "server", job: "j1" });
      setOfficeLoad({ at: "opening" });
      setOfficeLoad({ at: "ready" });
    });
    const { getByRole, queryByRole, getByLabelText } = render(<EditCopyNote editing />);
    const done = getByRole("status");
    expect(done.textContent).toMatch(/Editor completo scaricato/);
    // Still there a while later: only the person closes it.
    act(() => {
      setOfficeLoad({ at: "ready" });
    });
    expect(queryByRole("status")).not.toBeNull();
    fireEvent.click(getByLabelText("Chiudi"));
    expect(queryByRole("status")).toBeNull();
    expect(queryByRole("note")).toBeNull();
  });

  it("in English too", () => {
    setLang("en");
    act(() => {
      setOfficeLoad({ at: "server", job: "j1" });
      setOfficeLoad({ at: "ready" });
    });
    const { getByRole } = render(<EditCopyNote />);
    expect(getByRole("status").textContent).toMatch(/Full editor downloaded/);
    setLang("it");
  });
});
