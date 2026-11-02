// The agents' computer (G24.14b, D11): one real browser per person, shared by their personal
// agents like Grok Bot's (one sign-in serves them all), in its own container with its profile
// in a volume. Agents read pages as text and click by name; the person watches the screen live
// and takes control for sign-ins: what they type never reaches a model or the log, and password
// fields are never read back. Clicks that send, publish, pay or delete ask first (danger
// `outgoing-browser`).

import type { Tool } from "@redgiant/agent";
import type Docker from "dockerode";
import { type Browser, type CDPSession, chromium, type Page } from "playwright-core";
import { z } from "zod";

/** Where a person's browser runs: its DevTools address, started on demand. */
export interface BrowserLauncher {
  endpoint(ownerId: string): Promise<string>;
  stop(ownerId: string): Promise<void>;
}

/**
 * Run in the container: Chrome, and a forwarder from 9223 (every address) to its DevTools on
 * 127.0.0.1:9222. Recent Chrome ignores --remote-debugging-address and listens on 127.0.0.1
 * only. When Chrome exits, so does the container.
 */
const CDP_FORWARDER = `
const { spawn } = require("child_process"), net = require("net"), fs = require("fs");
const dir = fs.readdirSync("/ms-playwright").find((d) => /^chromium-\\d/.test(d));
const chrome = spawn("/ms-playwright/" + dir + "/chrome-linux64/chrome", [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
  "--remote-debugging-port=9222", "--user-data-dir=/profile", "--window-size=1280,800", "about:blank",
], { stdio: "inherit" });
chrome.on("exit", (code) => process.exit(code ?? 1));
net.createServer((s) => {
  const t = net.connect(9222, "127.0.0.1");
  s.pipe(t).pipe(s);
  s.on("error", () => t.destroy());
  t.on("error", () => s.destroy());
}).listen(9223, "0.0.0.0");
`;

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** Chromium in the Playwright image, its profile in a volume of its own (Docker installs). */
export class DockerBrowserLauncher implements BrowserLauncher {
  constructor(
    private readonly o: {
      docker: Docker;
      /**
       * The browser's own network: only it and this server, never the database, the engine or
       * Gitea, so a web page cannot reach them. Created when missing.
       */
      network: string;
      /** This server's container, joined to that network (Docker installs). */
      join?: string;
      image?: string;
      /** Prefix of containers and volumes (tests use their own). */
      prefix?: string;
      /** How this server reaches the container: by its address on `network` (default). */
      address?: (container: Docker.ContainerInspectInfo) => string;
    },
  ) {}

  private name(ownerId: string) {
    return `${this.o.prefix ?? "redgiant-browser"}-${slug(ownerId) || "owner"}`;
  }

  /** The browser's network exists and this server is on it. */
  private async network(): Promise<void> {
    const n = this.o.network;
    if (n.startsWith("container:") || n === "bridge" || n === "host") return;
    const net = this.o.docker.getNetwork(n);
    if (
      !(await net.inspect().then(
        () => true,
        () => false,
      ))
    )
      await this.o.docker
        .createNetwork({ Name: n, Driver: "bridge", Labels: { "io.redgiant.browser": "1" } })
        .catch(() => {});
    if (this.o.join)
      await this.o.docker
        .getNetwork(n)
        .connect({ Container: this.o.join })
        .catch(() => {}); // already there
  }

  async endpoint(ownerId: string): Promise<string> {
    const name = this.name(ownerId);
    await this.network();
    const image = this.o.image ?? "mcr.microsoft.com/playwright:v1.64.1-noble";
    let c = this.o.docker.getContainer(name);
    let info = await c.inspect().catch(() => undefined);
    if (!info?.State.Running) {
      await c.remove({ force: true }).catch(() => {});
      const present = await this.o.docker
        .getImage(image)
        .inspect()
        .then(() => true)
        .catch(() => false);
      if (!present)
        await new Promise<void>((ok, ko) =>
          this.o.docker.pull(image, (err: unknown, stream: NodeJS.ReadableStream) =>
            err ? ko(err) : this.o.docker.modem.followProgress(stream, (e) => (e ? ko(e) : ok())),
          ),
        );
      c = await this.o.docker.createContainer({
        name,
        Image: image,
        Labels: { "io.redgiant.browser": "1" },
        Cmd: ["node", "-e", CDP_FORWARDER],
        HostConfig: {
          NetworkMode: this.o.network,
          Mounts: [{ Type: "volume", Source: `${name}-profile`, Target: "/profile" }],
          ShmSize: 512 * 1024 * 1024,
        },
      });
      await c.start();
      info = await c.inspect();
    }
    const host = this.o.address
      ? this.o.address(info)
      : (info.NetworkSettings.Networks[this.o.network]?.IPAddress ?? "127.0.0.1");
    // DevTools answers only to an IP address or localhost, never to a container's name.
    const url = `http://${host}:9223`;
    for (let i = 0; i < 60; i++) {
      if (
        await fetch(`${url}/json/version`).then(
          (r) => r.ok,
          () => false,
        )
      )
        return url;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("The agents' browser did not start");
  }

  async stop(ownerId: string): Promise<void> {
    // The profile stays in its volume: sign-ins survive.
    await this.o.docker
      .getContainer(this.name(ownerId))
      .remove({ force: true })
      .catch(() => {});
  }
}

/** A page as the agents' tools see it (Playwright in the server, a fake in tests). */
export interface PageLike {
  goto(url: string): Promise<void>;
  url(): string;
  title(): Promise<string>;
  /** The page as text: roles and names of what is there (an accessibility snapshot). */
  snapshot(): Promise<string>;
  /** The values typed in password fields, to keep them out of anything read back. */
  secrets(): Promise<string[]>;
  click(target: { role?: string | undefined; name: string }): Promise<void>;
  /** Whether a field is a password field: those are the person's. */
  isPassword(field: string): Promise<boolean>;
  fill(field: string, text: string, submit: boolean): Promise<void>;
  back(): Promise<void>;
}

/** Blanks out every password typed in the page from a text read back to a model. */
export function withoutSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets.filter((x) => x.length > 0).sort((a, b) => b.length - a.length))
    out = out.split(s).join("••••••");
  return out;
}

const READ_LIMIT = 30_000;

export class PlaywrightPage implements PageLike {
  constructor(readonly page: Page) {}
  async goto(url: string) {
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  }
  url() {
    return this.page.url();
  }
  title() {
    return this.page.title();
  }
  snapshot() {
    return this.page.locator("body").ariaSnapshot({ timeout: 10_000 });
  }
  secrets(): Promise<string[]> {
    // Runs in the page (the server has no DOM types).
    return this.page.evaluate(
      `[...document.querySelectorAll("input[type=password]")].map((i) => i.value)`,
    );
  }
  private field(name: string) {
    return this.page
      .getByLabel(name)
      .or(this.page.getByPlaceholder(name))
      .or(this.page.getByRole("textbox", { name }))
      .first();
  }
  async click(t: { role?: string | undefined; name: string }) {
    const target = t.role
      ? this.page.getByRole(t.role as Parameters<Page["getByRole"]>[0], { name: t.name })
      : this.page
          .getByRole("button", { name: t.name })
          .or(this.page.getByRole("link", { name: t.name }))
          .or(this.page.getByText(t.name, { exact: false }));
    await target.first().click({ timeout: 10_000 });
  }
  async isPassword(field: string) {
    return (
      (await this.field(field)
        .getAttribute("type", { timeout: 5_000 })
        .catch(() => null)) === "password"
    );
  }
  async fill(field: string, text: string, submit: boolean) {
    const f = this.field(field);
    await f.fill(text, { timeout: 10_000 });
    if (submit) await f.press("Enter");
  }
  async back() {
    await this.page.goBack({ timeout: 15_000 });
  }
}

export interface ScreenFrame {
  /** JPEG, base64. */
  data: string;
  width: number;
  height: number;
}

export type ScreenListener = (
  e:
    | { type: "frame"; frame: ScreenFrame }
    | { type: "state"; control: "agents" | "person"; url: string },
) => void;

/** One person's browser: the page the agents use, its screen, who has control. */
export class AgentBrowser {
  private browser: Browser | undefined;
  private page: Page | undefined;
  private cdp: CDPSession | undefined;
  private connecting: Promise<Page> | undefined;
  private readonly viewers = new Set<ScreenListener>();
  private lastUse = Date.now();
  private size = { width: 1280, height: 800 };
  control: "agents" | "person" = "agents";

  constructor(
    private readonly launcher: BrowserLauncher,
    private readonly ownerId: string,
    /** A page for tests; Playwright over CDP otherwise. */
    private readonly fake?: PageLike,
  ) {}

  /** The page, the browser started if needed. */
  private async live(): Promise<Page> {
    if (this.page && !this.page.isClosed() && this.browser?.isConnected()) return this.page;
    this.connecting ??= (async () => {
      const endpoint = await this.launcher.endpoint(this.ownerId);
      this.browser = await chromium.connectOverCDP(endpoint);
      const context = this.browser.contexts()[0] ?? (await this.browser.newContext());
      const page = context.pages()[0] ?? (await context.newPage());
      await page.setViewportSize(this.size).catch(() => {});
      this.page = page;
      this.cdp = undefined;
      if (this.viewers.size > 0) await this.startScreen();
      return page;
    })().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  async pageLike(): Promise<PageLike> {
    this.lastUse = Date.now();
    return this.fake ?? new PlaywrightPage(await this.live());
  }

  get idleMs(): number {
    return this.viewers.size > 0 ? 0 : Date.now() - this.lastUse;
  }

  private emit(e: Parameters<ScreenListener>[0]) {
    for (const v of this.viewers) v(e);
  }

  state(): { control: "agents" | "person"; url: string } {
    return { control: this.control, url: this.page?.url() ?? "about:blank" };
  }

  /** Someone watches the screen: frames start (and stop when the last one leaves). */
  async watch(listener: ScreenListener): Promise<() => void> {
    this.viewers.add(listener);
    listener({ type: "state", ...this.state() });
    if (!this.fake) {
      await this.live();
      await this.startScreen();
    }
    return () => {
      this.viewers.delete(listener);
      if (this.viewers.size === 0) {
        void this.cdp?.send("Page.stopScreencast").catch(() => {});
        this.lastUse = Date.now();
      }
    };
  }

  private async startScreen(): Promise<void> {
    const page = this.page;
    if (!page) return;
    if (!this.cdp) {
      this.cdp = await page.context().newCDPSession(page);
      this.cdp.on("Page.screencastFrame", (f) => {
        this.size = {
          width: Math.round(f.metadata.deviceWidth),
          height: Math.round(f.metadata.deviceHeight),
        };
        this.emit({ type: "frame", frame: { data: f.data, ...this.size } });
        void this.cdp?.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
      });
      page.on("framenavigated", (fr) => {
        if (fr === page.mainFrame()) this.emit({ type: "state", ...this.state() });
      });
    }
    await this.cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 60,
      maxWidth: 1280,
      maxHeight: 800,
    });
  }

  setControl(who: "agents" | "person"): void {
    this.control = who;
    this.lastUse = Date.now();
    this.emit({ type: "state", ...this.state() });
  }

  /**
   * The person's mouse and keyboard, only while they have control. Coordinates arrive as
   * fractions of the screen. Never logged.
   */
  async input(
    e:
      | { kind: "click"; x: number; y: number }
      | { kind: "scroll"; x: number; y: number; dy: number }
      | { kind: "text"; text: string }
      | { kind: "key"; key: string },
  ): Promise<void> {
    if (this.control !== "person" || this.fake) return;
    const page = await this.live();
    this.lastUse = Date.now();
    if (e.kind === "text") await page.keyboard.insertText(e.text);
    else if (e.kind === "key") await page.keyboard.press(e.key);
    else {
      const x = e.x * this.size.width;
      const y = e.y * this.size.height;
      if (e.kind === "click") await page.mouse.click(x, y);
      else {
        await page.mouse.move(x, y);
        await page.mouse.wheel(0, e.dy);
      }
    }
  }

  async goto(url: string): Promise<void> {
    if (this.control !== "person") return;
    await (await this.pageLike()).goto(url);
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => {});
    this.browser = undefined;
    this.page = undefined;
    this.cdp = undefined;
    await this.launcher.stop(this.ownerId);
  }
}

/** Every person's browser; idle ones are switched off after ten minutes. */
export class Browsers {
  private readonly all = new Map<string, AgentBrowser>();
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly launcher: BrowserLauncher,
    private readonly o: { idleMs?: number; fake?: PageLike } = {},
  ) {
    this.timer = setInterval(() => void this.sweep(), 60_000);
    this.timer.unref();
  }

  get(ownerId: string): AgentBrowser {
    let b = this.all.get(ownerId);
    if (!b) {
      b = new AgentBrowser(this.launcher, ownerId, this.o.fake);
      this.all.set(ownerId, b);
    }
    return b;
  }

  private async sweep(): Promise<void> {
    for (const [owner, b] of this.all)
      if (b.idleMs > (this.o.idleMs ?? 10 * 60_000) && b.control === "agents") {
        this.all.delete(owner);
        await b.close();
      }
  }

  async shutdown(): Promise<void> {
    clearInterval(this.timer);
    for (const b of this.all.values()) await b.close().catch(() => {});
  }
}

/**
 * The browser tools of a personal agent. While the person has control they wait (up to ten
 * minutes), then say so; passwords are never typed by an agent nor read back.
 */
export function browserTools(b: AgentBrowser, o: { waitMs?: number } = {}): Tool[] {
  const ready = async (): Promise<PageLike | string> => {
    const until = Date.now() + (o.waitMs ?? 10 * 60_000);
    while (b.control === "person") {
      if (Date.now() > until)
        return "The person has control of the browser right now. Try again later, or ask them.";
      await new Promise((r) => setTimeout(r, 1000));
    }
    return b.pageLike();
  };
  const page = async <T>(f: (p: PageLike) => Promise<T>) => {
    const p = await ready();
    if (typeof p === "string") return { content: p, isError: true };
    return f(p);
  };
  const where = async (p: PageLike) => `${await p.title().catch(() => "")} — ${p.url()}`;
  const tool = (def: Tool["def"], schema: z.ZodType, run: (i: never) => Promise<unknown>): Tool =>
    ({ def, schema, run }) as unknown as Tool;
  return [
    tool(
      {
        name: "browser_open",
        description:
          "Open a web address in the browser you share with the user's other personal agents (sign-ins are kept). Then read it with browser_read.",
        inputSchema: {
          type: "object",
          properties: { url: { type: "string" } },
          required: ["url"],
        },
      },
      z.object({ url: z.string().min(1) }),
      ({ url }: { url: string }) =>
        page(async (p) => {
          await p.goto(/^[a-z]+:/i.test(url) ? url : `https://${url}`);
          return `Opened ${await where(p)}.`;
        }),
    ),
    tool(
      {
        name: "browser_read",
        description:
          "Read the open page as text: its headings, links, buttons and fields with their names. Use those names with browser_click and browser_type.",
        inputSchema: { type: "object", properties: {} },
      },
      z.object({}),
      () =>
        page(async (p) => {
          const text = withoutSecrets(await p.snapshot(), await p.secrets().catch(() => []));
          const cut =
            text.length > READ_LIMIT ? `${text.slice(0, READ_LIMIT)}\n[… the page goes on]` : text;
          return `${await where(p)}\n\n${cut}`;
        }),
    ),
    tool(
      {
        name: "browser_click",
        description:
          "Click a button, link or other element by its visible name (and role, if several share it). Sending, publishing, paying, buying or deleting asks the user first.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" }, role: { type: "string" } },
          required: ["name"],
        },
      },
      z.object({ name: z.string().min(1), role: z.string().optional() }),
      ({ name, role }: { name: string; role?: string }) =>
        page(async (p) => {
          await p.click({ role, name });
          return `Clicked "${name}". Now at ${await where(p)}.`;
        }),
    ),
    tool(
      {
        name: "browser_type",
        description:
          "Type into a field by its label or placeholder; submit presses Enter. Never passwords or codes: for a sign-in, ask the user to take control of the browser.",
        inputSchema: {
          type: "object",
          properties: {
            field: { type: "string" },
            text: { type: "string" },
            submit: { type: "boolean" },
          },
          required: ["field", "text"],
        },
      },
      z.object({ field: z.string().min(1), text: z.string(), submit: z.boolean().optional() }),
      ({ field, text, submit }: { field: string; text: string; submit?: boolean }) =>
        page(async (p) => {
          if (await p.isPassword(field))
            return {
              content:
                "That is a password field: passwords are typed by the user. Ask them to take control of the browser (its screen in RedGiant) and sign in.",
              isError: true,
            };
          await p.fill(field, text, submit === true);
          return `Typed into "${field}"${submit ? " and submitted" : ""}. Now at ${await where(p)}.`;
        }),
    ),
    tool(
      {
        name: "browser_back",
        description: "Go back to the previous page.",
        inputSchema: { type: "object", properties: {} },
      },
      z.object({}),
      () =>
        page(async (p) => {
          await p.back();
          return `Back at ${await where(p)}.`;
        }),
    ),
  ];
}
