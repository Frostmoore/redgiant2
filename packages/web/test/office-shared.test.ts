// @vitest-environment jsdom
// One LibreOffice for every document tab (3.5.2): the tab the person looks at takes the page's one
// frame, the tab before saves first; closing the last tab ends the engine; without
// Element.moveBefore the frame is made again (still one engine). And the frame's Ctrl+S.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  type FrameMsg,
  NotHolderError,
  type OfficeChannel,
  type OfficeEnv,
  type OfficeTenant,
  SharedOffice,
} from "../src/viewers/office-shared.js";

/** A frame that answers like frame.js: check, start (once), open, export. */
function fakeEnv(canMove: boolean) {
  const log: string[] = [];
  const frames: HTMLElement[] = [];
  let n = 0;
  const env: OfficeEnv = {
    frame(id) {
      const el = document.createElement("iframe");
      el.dataset.id = id;
      frames.push(el);
      return el;
    },
    channel(name) {
      const ch: OfficeChannel = {
        onmessage: null,
        close: () => log.push(`close ${name}`),
        postMessage(m) {
          const q = m as FrameMsg;
          log.push(`${name} ${q.t}${q.path ? ` ${q.path}` : ""}`);
          const answer = (a: Record<string, unknown>) =>
            queueMicrotask(() => ch.onmessage?.({ data: { ...a, req: q.req, from: "frame" } }));
          if (q.t === "check") answer({ t: "check", secure: true, isolated: true, webgl: true });
          else if (q.t === "start") answer({ t: "ready" });
          else if (q.t === "open") answer({ t: "opened" });
          else if (q.t === "export") answer({ t: "exported", bytes: new ArrayBuffer(1) });
        },
      };
      return ch;
    },
    move(frame, into) {
      if (!canMove) return false;
      into.appendChild(frame);
      return true;
    },
    park: () => document.body,
    id: () => `f${++n}`,
  };
  return { env, log, frames };
}

function tab(shared: SharedOffice, name: string, log: string[]) {
  const slot = document.createElement("div");
  slot.className = name;
  document.body.appendChild(slot);
  const got: FrameMsg[] = [];
  let dirty = false;
  const t: OfficeTenant = {
    slot: () => slot,
    async release() {
      if (dirty) {
        await shared.ask(t, { t: "export" });
        log.push(`${name} saved`);
        dirty = false;
      }
      log.push(`${name} released`);
    },
    message: (m) => got.push(m),
  };
  shared.join(t);
  const open = async () => {
    await shared.acquire(t);
    await shared.check(t);
    await shared.start(t);
    await shared.ask(t, { t: "open", path: name });
  };
  return { t, slot, got, open, edit: () => (dirty = true) };
}

describe("SharedOffice", () => {
  it("one engine for three documents, each tab saved before the next one opens", async () => {
    const { env, log, frames } = fakeEnv(true);
    const shared = new SharedOffice(env);
    const a = tab(shared, "a", log);
    const b = tab(shared, "b", log);
    const c = tab(shared, "c", log);
    await a.open();
    expect(a.slot.contains(frames[0] as Node)).toBe(true);
    a.edit();
    await b.open();
    await c.open();
    expect(shared.engines).toBe(1);
    expect(frames).toHaveLength(1);
    expect(c.slot.contains(frames[0] as Node)).toBe(true);
    expect(log.filter((l) => l.endsWith(" start"))).toHaveLength(1);
    expect(log).toEqual([
      "rg-office-f1 check",
      "rg-office-f1 start",
      "rg-office-f1 open a",
      "rg-office-f1 export",
      "a saved",
      "a released",
      "rg-office-f1 open b",
      "b released",
      "rg-office-f1 open c",
    ]);
    // Back to the first: same engine, no new start.
    expect(await shared.acquire(a.t)).toBe("moved");
    expect(await shared.acquire(a.t)).toBe("same");
    expect(shared.engines).toBe(1);
  });

  it("refuses a tab that no longer holds the engine", async () => {
    const { env, log } = fakeEnv(true);
    const shared = new SharedOffice(env);
    const a = tab(shared, "a", log);
    const b = tab(shared, "b", log);
    await a.open();
    await b.open();
    await expect(shared.ask(a.t, { t: "apply" })).rejects.toBeInstanceOf(NotHolderError);
  });

  it("only the holder hears the frame (progress, typing, Ctrl+S)", async () => {
    const { env, log } = fakeEnv(true);
    const shared = new SharedOffice(env);
    const a = tab(shared, "a", log);
    const b = tab(shared, "b", log);
    let channel: OfficeChannel | undefined;
    const real = env.channel;
    env.channel = (name) => (channel = real(name));
    await a.open();
    channel?.onmessage?.({ data: { t: "save-key", from: "frame" } });
    await b.open();
    channel?.onmessage?.({ data: { t: "typing", from: "frame" } });
    expect(a.got.map((m) => m.t)).toEqual(["save-key"]);
    expect(b.got.map((m) => m.t)).toEqual(["typing"]);
  });

  it("closing a tab saves it out of sight; closing the last one ends the engine", async () => {
    const { env, log, frames } = fakeEnv(true);
    const shared = new SharedOffice(env);
    const a = tab(shared, "a", log);
    const b = tab(shared, "b", log);
    await a.open();
    a.edit();
    const left = shared.leave(a.t);
    // Out of the closing tab at once (its page goes away right after).
    expect(a.slot.contains(frames[0] as Node)).toBe(false);
    expect(frames[0]?.isConnected).toBe(true);
    await left;
    expect(log.slice(-2)).toEqual(["a saved", "a released"]);
    expect(shared.owner).toBeUndefined();
    await b.open();
    expect(shared.engines).toBe(1);
    await shared.leave(b.t);
    expect(frames[0]?.isConnected).toBe(false);
    expect(log.at(-1)).toBe("close rg-office-f1");
    expect(shared.element).toBeUndefined();
  });

  it("without moveBefore the frame is made again: never two engines at once", async () => {
    const { env, log, frames } = fakeEnv(false);
    const shared = new SharedOffice(env);
    const a = tab(shared, "a", log);
    const b = tab(shared, "b", log);
    await a.open();
    a.edit();
    await b.open();
    expect(shared.engines).toBe(2);
    expect(frames[0]?.isConnected).toBe(false);
    expect(frames.filter((f) => f.isConnected)).toHaveLength(1);
    expect(log.indexOf("a saved")).toBeLessThan(log.indexOf("close rg-office-f1"));
    expect(log.indexOf("close rg-office-f1")).toBeLessThan(log.indexOf("rg-office-f2 check"));
  });
});

describe("frame.js: Ctrl+S inside the frame", () => {
  it("is the page's save, never LibreOffice's (Cmd+S too; Alt or Shift left alone)", () => {
    const posted: FrameMsg[] = [];
    class FakeChannel {
      onmessage: unknown = null;
      postMessage(m: FrameMsg) {
        posted.push(m);
      }
    }
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    document.body.innerHTML = '<canvas id="qtcanvas"></canvas>';
    const src = readFileSync(join(__dirname, "../public/zeta/frame.js"), "utf8");
    new Function(src)();
    // What LibreOffice would see (registered after ours, as soffice.js is).
    const engine = vi.fn();
    window.addEventListener("keydown", engine, true);
    const press = (init: KeyboardEventInit) => {
      const e = new KeyboardEvent("keydown", { cancelable: true, bubbles: true, ...init });
      document.getElementById("qtcanvas")?.dispatchEvent(e);
      return e;
    };
    const ctrl = press({ key: "s", ctrlKey: true });
    const cmd = press({ key: "S", metaKey: true });
    const repeat = press({ key: "s", ctrlKey: true, repeat: true });
    const shift = press({ key: "S", ctrlKey: true, shiftKey: true });
    const alt = press({ key: "s", ctrlKey: true, altKey: true });
    const plain = press({ key: "s" });
    expect(posted.filter((m) => m.t === "save-key")).toEqual([
      { t: "save-key", from: "frame" },
      { t: "save-key", from: "frame" },
    ]);
    expect([ctrl, cmd, repeat].map((e) => e.defaultPrevented)).toEqual([true, true, true]);
    expect([shift, alt, plain].map((e) => e.defaultPrevented)).toEqual([false, false, false]);
    expect(engine).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
  });
});
