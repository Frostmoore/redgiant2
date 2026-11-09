// One LibreOffice in the browser for every document tab (3.5.2). Each engine is a whole
// LibreOffice in WebAssembly (1-2 GB): with one per tab a second document often could not start.
// So the page keeps ONE isolated frame and lends it to the tab the person looks at: the frame
// moves into that tab (Element.moveBefore keeps it running; Chromium has it wherever the frame's
// Document-Isolation-Policy works), the document shown before is saved and closed, and the new
// one opens in the same engine. A tab that gives the frame up opens its document again (fresh from
// the host) when the person comes back. Where a frame cannot be moved, it is closed and made
// again in the new tab: still one engine at a time. Closing the last document tab ends it.

import { t } from "../i18n.js";

/** A message from or to the frame (BroadcastChannel). */
export interface FrameMsg {
  t: string;
  req?: number;
  [k: string]: unknown;
}

/** A document tab that may hold the engine. */
export interface OfficeTenant {
  /** Where the frame goes while this tab holds it. */
  slot(): HTMLElement | null | undefined;
  /** Gives the engine up: the person's last edits saved first (never rejects). */
  release(): Promise<void>;
  /** The frame's own messages (progress, edits, Ctrl+S) while this tab holds it. */
  message(m: FrameMsg): void;
}

export interface OfficeChannel {
  postMessage(m: unknown): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  close(): void;
}

/** What the shared engine needs from the page (a fake one in tests). */
export interface OfficeEnv {
  /** A new frame for the channel `rg-office-<id>`, not in the page yet. */
  frame(id: string): HTMLElement;
  channel(name: string): OfficeChannel;
  /** Moves a running frame without reloading it; false where the browser cannot. */
  move(frame: HTMLElement, into: HTMLElement): boolean;
  /** Where the frame waits, out of sight, between two tabs. */
  park(): HTMLElement;
  /** A fresh id. */
  id(): string;
}

/** How a tab got the engine: it had it, the frame came to it, or a new engine started. */
export type Acquired = "same" | "moved" | "new";

interface Frame {
  el: HTMLElement;
  id: string;
  bc: OfficeChannel;
  pending: Map<number, (m: FrameMsg) => void>;
  check?: Promise<FrameMsg | undefined>;
  start?: Promise<void>;
  started: boolean;
}

export class NotHolderError extends Error {
  constructor() {
    super("LibreOffice is showing another document");
  }
}

export class SharedOffice {
  private frame: Frame | undefined;
  private holder: OfficeTenant | undefined;
  private readonly tenants = new Set<OfficeTenant>();
  private queue: Promise<unknown> = Promise.resolve();
  private req = 1;
  /** Frames made so far, each one an engine (tests and measurements count them). */
  engines = 0;

  constructor(private readonly env: OfficeEnv) {}

  get owner(): OfficeTenant | undefined {
    return this.holder;
  }

  /** The frame element (its class says whether it is waiting). */
  get element(): HTMLElement | undefined {
    return this.frame?.el;
  }

  /** The engine is running LibreOffice (started once per frame). */
  get started(): boolean {
    return this.frame?.started === true;
  }

  join(t: OfficeTenant): void {
    this.tenants.add(t);
  }

  /** One thing at a time: a tab's hand-over never overlaps another. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const p = this.queue.then(task);
    this.queue = p.catch(() => {});
    return p;
  }

  /** The engine for `t`: the tab holding it gives it up first (its edits saved). */
  acquire(t: OfficeTenant): Promise<Acquired> {
    return this.serial(async () => {
      if (!this.tenants.has(t)) throw new Error("the tab was closed");
      if (this.holder === t && this.frame) return "same";
      const prev = this.holder;
      if (prev) await prev.release().catch(() => {});
      this.holder = undefined;
      const slot = t.slot();
      if (!slot || !this.tenants.has(t)) throw new Error("the tab was closed");
      this.holder = t;
      if (this.frame && this.env.move(this.frame.el, slot)) return "moved";
      this.end();
      this.create(slot);
      return "new";
    });
  }

  /**
   * The tab is closing: the frame leaves its place at once (the tab's page goes away with it),
   * its last edits are saved, then the engine waits for another tab or ends with the last one.
   */
  leave(t: OfficeTenant): Promise<void> {
    this.tenants.delete(t);
    if (this.holder === t && this.frame && !this.env.move(this.frame.el, this.env.park()))
      this.end();
    return this.serial(async () => {
      if (this.holder !== t) return;
      await t.release().catch(() => {});
      this.holder = undefined;
      if (!this.tenants.size) this.end();
    });
  }

  /** A request to the frame from the tab holding it. */
  ask(t: OfficeTenant, m: FrameMsg, timeoutMs = 120_000): Promise<FrameMsg> {
    const f = this.frame;
    if (this.holder !== t || !f) return Promise.reject(new NotHolderError());
    return new Promise<FrameMsg>((resolve, reject) => {
      const r = this.req++;
      const timer = setTimeout(() => {
        f.pending.delete(r);
        reject(new Error(`${m.t}: no answer`));
      }, timeoutMs);
      f.pending.set(r, (x) => {
        clearTimeout(timer);
        if (x.t === "error") reject(new Error(String(x.message)));
        else resolve(x);
      });
      f.bc.postMessage({ ...m, req: r });
    });
  }

  /** What the frame found (an isolated, secure page, WebGL in workers): asked once per frame. */
  check(t: OfficeTenant): Promise<FrameMsg | undefined> {
    const f = this.frame;
    if (this.holder !== t || !f) return Promise.reject(new NotHolderError());
    f.check ??= (async () => {
      // The frame answers once it has loaded (asked again until then).
      for (let i = 0; i < 30 && this.frame === f; i++) {
        const c = await this.ask(t, { t: "check" }, 700).catch(() => undefined);
        if (c) return c;
      }
      return undefined;
    })();
    return f.check;
  }

  /** LibreOffice starts once per frame (the engine's files from this browser's storage). */
  start(t: OfficeTenant): Promise<void> {
    const f = this.frame;
    if (this.holder !== t || !f) return Promise.reject(new NotHolderError());
    f.start ??= this.ask(t, { t: "start" }, 600_000).then(() => {
      f.started = true;
    });
    return f.start;
  }

  private create(slot: HTMLElement): void {
    const id = this.env.id();
    const bc = this.env.channel(`rg-office-${id}`);
    const f: Frame = { el: this.env.frame(id), id, bc, pending: new Map(), started: false };
    bc.onmessage = (e) => {
      const m = e.data as FrameMsg & { from?: string };
      if (m?.from !== "frame" || this.frame !== f) return;
      if (m.req && f.pending.has(m.req)) {
        const done = f.pending.get(m.req);
        f.pending.delete(m.req);
        done?.(m);
        return;
      }
      this.holder?.message(m);
    };
    this.frame = f;
    this.engines += 1;
    slot.appendChild(f.el);
  }

  /** The engine ends: its frame goes (the browser frees its memory). */
  private end(): void {
    const f = this.frame;
    if (!f) return;
    this.frame = undefined;
    for (const done of f.pending.values()) done({ t: "error", message: "LibreOffice was closed" });
    f.pending.clear();
    f.bc.close();
    f.el.remove();
  }
}

// ---- the page's one engine ----

let shared: SharedOffice | undefined;
let parking: HTMLElement | undefined;

type Movable = HTMLElement & { moveBefore?: (node: Node, child: Node | null) => void };

/** The page's engine, made on first use. */
export function sharedOffice(): SharedOffice {
  shared ??= new SharedOffice({
    frame(id) {
      const f = document.createElement("iframe");
      f.className = "doc-office-frame waiting";
      f.title = t("officeFrameTitle");
      f.src = `/zeta/frame.html#${id}`;
      f.setAttribute("allow", "cross-origin-isolated; clipboard-read; clipboard-write; fullscreen");
      return f;
    },
    channel: (name) => new BroadcastChannel(name) as unknown as OfficeChannel,
    move(frame, into) {
      const to = into as Movable;
      if (frame.parentElement === into) return true;
      if (typeof to.moveBefore !== "function" || !frame.isConnected || !into.isConnected)
        return false;
      try {
        to.moveBefore(frame, null);
        return true;
      } catch {
        return false;
      }
    },
    park() {
      if (!parking?.isConnected) {
        parking = document.createElement("div");
        parking.className = "doc-office-parking";
        parking.setAttribute("aria-hidden", "true");
        document.body.appendChild(parking);
      }
      return parking;
    },
    id: () => Math.random().toString(36).slice(2, 12),
  });
  return shared;
}
