// @vitest-environment jsdom
// 3.5.6: a permission card says first what happens, in the person's words and with the real
// arguments; the policy's English reasons and the raw input stay folded in «Dettagli»; and its
// buttons ignore clicks for a moment after they appear (the person approved an archive and a
// restore in seconds without knowing it: «non mi pare di aver cliccato consenti»).
import type { PermissionRequestInfo } from "@redgiant/protocol";
import { act, cleanup, fireEvent, render } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lang } from "../src/i18n.js";

const sent: Record<string, unknown>[] = [];
vi.mock("../src/state.js", async (orig) => ({
  ...(await orig<typeof import("../src/state.js")>()),
  getLive: () => ({ send: (m: Record<string, unknown>) => sent.push(m) }),
  getApi: () => new Proxy({}, { get: () => () => Promise.resolve([]) }) as never,
}));

const state = await import("../src/state.js");
const { Bell } = await import("../src/components/Bell.js");
const { PermissionCard } = await import("../src/components/Chat.js");
const { ARM_MS } = await import("../src/components/armed.js");
const { agents, approvals, archivedProjects, projects, questions, sessionRows } = state;

const archive: PermissionRequestInfo = {
  requestId: "p1",
  agentId: "god",
  agentName: "God",
  projectId: null,
  tool: "platform_project",
  input: { action: "archive", project_id: "proj_7" },
  reasons: ["Changes the platform"],
  danger: ["platform"],
  createdAt: "2026-11-10T10:00:00.000Z",
  sessionId: "sess_a",
};

const buttons = (root: Element) =>
  [...root.querySelectorAll<HTMLButtonElement>(".permission-actions button")].filter(
    (b) => !b.classList.contains("link"),
  );

beforeEach(() => {
  lang.value = "it";
  sent.length = 0;
  questions.value = [];
  sessionRows.value = [];
  approvals.value = [archive];
  agents.value = [{ id: "god", name: "God", kind: "god" }] as never;
  projects.value = [];
  archivedProjects.value = [{ id: "proj_7", name: "Collaudo 3.5.3" }] as never;
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
});

describe("what the card says (3.5.6)", () => {
  it("says what happens first, with the project's name, and the danger in Italian", () => {
    const { container } = render(<PermissionCard r={archive} />);
    const card = container.querySelector(".permission") as HTMLElement;
    expect(card.querySelector(".permission-who")?.textContent).toBe("God chiede il tuo sì");
    expect(card.querySelector(".permission-what")?.textContent).toBe(
      "Archivia il progetto «Collaudo 3.5.3»: i suoi agenti si fermano e nessuno ne cambia i file finché non lo ripristini",
    );
    // The policy's own label is said by the danger chip, in Italian.
    const because = card.querySelector(".permission-because") as HTMLElement;
    expect(because.textContent).toBe("Cambiare RedGiant stesso");
    // The raw input and the English reason are only in the folded details.
    const details = card.querySelector("details.permission-details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("Dettagli");
    expect(details.textContent).toContain("platform_project");
    expect(details.textContent).toContain("Changes the platform");
    expect(details.querySelector("pre")?.textContent).toContain('"project_id": "proj_7"');
    const outside = [...card.children].filter((c) => c !== details).map((c) => c.textContent);
    expect(outside.join(" ")).not.toMatch(/Changes the platform|proj_7|platform_project/);
    expect(card.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("uses the names the server sent, translates the reasons, and speaks English", () => {
    const r: PermissionRequestInfo = {
      ...archive,
      requestId: "p2",
      input: { action: "restore", project_id: "proj_9" },
      names: { proj_9: "Sito" },
      reasons: ["manual mode", "My own rule"],
      danger: [],
    };
    const { container, rerender } = render(<PermissionCard r={r} />);
    expect(container.querySelector(".permission-what")?.textContent).toMatch(
      /^Ripristina il progetto «Sito»/,
    );
    expect(container.querySelector(".permission-because")?.textContent).toBe(
      "Perché te lo chiede: L'agente è in modalità manuale: chiede prima di ogni modifica",
    );
    lang.value = "en";
    rerender(
      <PermissionCard r={{ ...r, tool: "bash", input: { command: "git push origin main" } }} />,
    );
    expect(container.querySelector(".permission-what")?.textContent).toBe(
      "Runs the command: git push origin main",
    );
    expect(container.querySelector(".permission-who")?.textContent).toBe("God asks for your yes");
  });
});

describe("the click guard (3.5.6)", () => {
  it("ignores clicks for a moment, visibly, then one click decides", () => {
    const { container } = render(<PermissionCard r={archive} />);
    const [allow, deny] = buttons(container);
    expect(allow?.textContent).toBe("Consenti");
    expect(allow?.disabled).toBe(true);
    expect(deny?.disabled).toBe(true);
    expect(container.querySelector(".permission-actions.arming")).toBeTruthy();
    // A click right away does nothing (a disabled button gets no click; the handler checks too).
    fireEvent.click(allow as HTMLElement);
    act(() => {
      vi.advanceTimersByTime(ARM_MS - 1);
    });
    expect(allow?.disabled).toBe(true);
    expect(sent).toEqual([]);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(allow?.disabled).toBe(false);
    expect(container.querySelector(".permission-actions.arming")).toBeNull();
    fireEvent.click(allow as HTMLElement);
    expect(sent).toEqual([
      {
        type: "permission.resolve",
        requestId: "p1",
        decision: "allow",
        remember: false,
        scope: "once",
      },
    ]);
  });

  it("Enter never approves; a new request in the same place starts off again", () => {
    const { container, rerender } = render(<PermissionCard r={archive} />);
    act(() => {
      vi.advanceTimersByTime(ARM_MS);
    });
    const [allow] = buttons(container);
    // The keydown that would click a focused button is stopped.
    expect(fireEvent.keyDown(allow as HTMLElement, { key: "Enter" })).toBe(false);
    expect(fireEvent.keyDown(allow as HTMLElement, { key: " " })).toBe(true);
    expect(sent).toEqual([]);
    rerender(<PermissionCard r={{ ...archive, requestId: "p3" }} />);
    const [again] = buttons(container);
    expect(again?.disabled).toBe(true);
    act(() => {
      vi.advanceTimersByTime(ARM_MS);
    });
    expect(again?.disabled).toBe(false);
  });

  it("waits until the buttons are in view, and again when they come back", () => {
    let seen: ((entries: { isIntersecting: boolean }[]) => void) | undefined;
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
      constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
        seen = cb;
      }
      observe() {}
      disconnect() {}
    };
    const { container } = render(<PermissionCard r={archive} />);
    const [allow] = buttons(container);
    act(() => {
      vi.advanceTimersByTime(ARM_MS * 3);
    });
    expect(allow?.disabled).toBe(true);
    act(() => seen?.([{ isIntersecting: true }]));
    act(() => {
      vi.advanceTimersByTime(ARM_MS);
    });
    expect(allow?.disabled).toBe(false);
    act(() => seen?.([{ isIntersecting: false }]));
    expect(allow?.disabled).toBe(true);
    act(() => seen?.([{ isIntersecting: true }]));
    act(() => {
      vi.advanceTimersByTime(ARM_MS - 100);
    });
    expect(allow?.disabled).toBe(true);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(allow?.disabled).toBe(false);
  });

  it("is the same in the bell", () => {
    const { container } = render(<Bell close={() => {}} />);
    expect(container.querySelector(".permission-what")?.textContent).toMatch(
      /^Archivia il progetto «Collaudo 3\.5\.3»/,
    );
    const [allow] = buttons(container);
    fireEvent.click(allow as HTMLElement);
    expect(sent).toEqual([]);
    act(() => {
      vi.advanceTimersByTime(ARM_MS);
    });
    fireEvent.click(allow as HTMLElement);
    expect(sent).toHaveLength(1);
  });
});
