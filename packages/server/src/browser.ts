// The agents' computer (G24.14b, D11): one real browser per person, shared by their personal
// agents like Grok Bot's (one sign-in serves them all), in its own container with its profile
// in a volume. Agents read pages as text and click by name; the person watches the screen live
// and takes control for sign-ins: what they type never reaches a model or the log, and password
// fields are never read back. Clicks that send, publish, pay or delete ask first (danger
// `outgoing-browser`).

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import type { Tool, ToolContext } from "@redgiant/agent";
import { classify, DEFAULT_DANGER_RULES } from "@redgiant/hierarchy";
import { agentEnv } from "@redgiant/tools";
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
      /** Pulls a missing image showing its progress to the person; without it, a plain pull. */
      pull?: (image: string) => Promise<void>;
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
      if (!present && this.o.pull) await this.o.pull(image);
      else if (!present)
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

/** Where Chrome, Chromium or Edge usually are, by system (G29.8). */
export function browserCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME ?? env.USERPROFILE ?? "";
  if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean);
    return roots.flatMap((r) => [
      `${r}\\Google\\Chrome\\Application\\chrome.exe`,
      `${r}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${r}\\Chromium\\Application\\chrome.exe`,
    ]);
  }
  if (platform === "darwin")
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      `${home}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
    ];
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
    "/snap/bin/chromium",
  ];
}

/** The first browser present: REDGIANT_BROWSER_PATH, then the usual places. */
export function findBrowser(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): string | undefined {
  if (env.REDGIANT_BROWSER_PATH) return env.REDGIANT_BROWSER_PATH;
  return browserCandidates(platform, env).find((p) => exists(p));
}

/**
 * The browser on this computer (G29.8, RedGiant 2.0: no container needed): Chrome, Chromium or
 * Edge with a profile of its own in RedGiant's data, so sign-ins stay and the person's own
 * profile is never touched. Headless unless asked to show its window (the person can watch
 * it work on their screen).
 */
export class LocalBrowserLauncher implements BrowserLauncher {
  private readonly running = new Map<string, { child: ChildProcess; url: string }>();

  constructor(
    private readonly o: {
      executable: string;
      /** Profiles live here, one folder per person. */
      profilesDir: string;
      headless?: boolean;
      /** Extra arguments (tests). */
      args?: string[];
    },
  ) {}

  async endpoint(ownerId: string): Promise<string> {
    const live = this.running.get(ownerId);
    if (live && live.child.exitCode === null) return live.url;
    const profile = join(this.o.profilesDir, slug(ownerId) || "owner");
    mkdirSync(profile, { recursive: true });
    const port = await freePort();
    const child = spawn(
      this.o.executable,
      [
        `--remote-debugging-port=${port}`,
        "--remote-debugging-address=127.0.0.1",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        ...(this.o.headless !== false ? ["--headless=new"] : []),
        ...(this.o.args ?? []),
        "about:blank",
      ],
      {
        stdio: "ignore",
        // Never the server's secrets; the screen's variables only to show its window.
        env: {
          ...agentEnv(),
          ...(this.o.headless === false &&
            Object.fromEntries(
              ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"].flatMap((k) =>
                process.env[k] ? [[k, process.env[k]]] : [],
              ),
            )),
        },
      },
    );
    const url = `http://127.0.0.1:${port}`;
    this.running.set(ownerId, { child, url });
    for (let i = 0; i < 60; i++) {
      if (child.exitCode !== null) break;
      if (
        await fetch(`${url}/json/version`).then(
          (r) => r.ok,
          () => false,
        )
      )
        return url;
      await new Promise((r) => setTimeout(r, 500));
    }
    child.kill();
    this.running.delete(ownerId);
    throw new Error(`The agents' browser did not start (${this.o.executable})`);
  }

  async stop(ownerId: string): Promise<void> {
    const live = this.running.get(ownerId);
    this.running.delete(ownerId);
    // The profile stays: sign-ins survive.
    live?.child.kill();
  }
}

function freePort(): Promise<number> {
  return new Promise((ok, ko) => {
    const srv = createNetServer();
    srv.once("error", ko);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => ok(port));
    });
  });
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
  /** The visible page as a JPEG, base64 (for models that see). */
  screenshot(): Promise<string>;
  /** A screen up or down, or until an element with this text is in view. */
  scroll(to: { direction: "up" | "down" } | { text: string }): Promise<void>;
  /** One key (a name from BROWSER_KEYS) on whatever has the focus. */
  press(key: string): Promise<void>;
  /** What has the focus, and what a form's Enter would press (the agents' Enter is checked). */
  focused(): Promise<Focused>;
  /** Chooses an option of a list (`<select>`) by its label. */
  select(field: string, option: string): Promise<void>;
  /** Whether the text shows up on the page within `timeoutMs`. */
  waitForText(text: string, timeoutMs: number): Promise<boolean>;
}

/** The element with the focus, in words. */
export interface Focused {
  kind: "none" | "field" | "password" | "button" | "link" | "other";
  /** Its name (never a field's value). */
  name: string;
  /** In a form: the name of the button Enter would press. */
  submit?: string | undefined;
}

/** The keys an agent may press: named keys only, so nothing can be typed with them. */
export const BROWSER_KEYS = [
  "Enter",
  "Escape",
  "Tab",
  "Shift+Tab",
  "Space",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "Backspace",
  "Delete",
] as const;

/** The focused element (runs in the page): a password field gives its kind and nothing more. */
const FOCUSED = `(() => {
  const words = (n) => n ? (n.getAttribute("aria-label") || (n.labels && n.labels[0] && n.labels[0].innerText) ||
    n.innerText || (n.tagName === "INPUT" && ["submit", "button", "reset"].includes(n.type) ? n.value : "") ||
    n.getAttribute("title") || n.getAttribute("placeholder") || n.getAttribute("name") || "").trim().replace(/\\s+/g, " ").slice(0, 120) : "";
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return { kind: "none", name: "" };
  const form = el.form || el.closest("form");
  const button = form && form.querySelector("button[type=submit],input[type=submit],input[type=image],button:not([type])");
  const submit = form ? (button ? words(button) || "(unnamed submit button)" : "(the form)") : undefined;
  const tag = el.tagName, type = (el.getAttribute("type") || "").toLowerCase(), role = el.getAttribute("role");
  if (tag === "INPUT" && type === "password") return { kind: "password", name: "", submit };
  if (tag === "BUTTON" || role === "button" || tag === "SUMMARY" || (tag === "INPUT" && ["submit", "button", "reset", "image"].includes(type)))
    return { kind: "button", name: words(el) };
  if ((tag === "A" && el.hasAttribute("href")) || role === "link") return { kind: "link", name: words(el) };
  if (tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable || (tag === "INPUT" && !["checkbox", "radio", "range", "color", "file"].includes(type)))
    return { kind: "field", name: words(el), submit: tag === "TEXTAREA" ? undefined : submit };
  return { kind: "other", name: words(el) };
})()`;

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
  async screenshot() {
    // Password fields are already dots on screen; the picture holds nothing a reading would not.
    const png = await this.page.screenshot({ type: "jpeg", quality: 70, timeout: 15_000 });
    return png.toString("base64");
  }
  async scroll(to: { direction: "up" | "down" } | { text: string }) {
    if ("text" in to) {
      await this.page.getByText(to.text).first().scrollIntoViewIfNeeded({ timeout: 10_000 });
      return;
    }
    const size = this.page.viewportSize() ?? { width: 1280, height: 800 };
    // The wheel scrolls what is under the pointer: the middle of the page.
    await this.page.mouse.move(size.width / 2, size.height / 2);
    await this.page.mouse.wheel(0, (to.direction === "down" ? 0.8 : -0.8) * size.height);
    await this.page.waitForTimeout(300);
  }
  async press(key: string) {
    await this.page.keyboard.press(key);
  }
  focused(): Promise<Focused> {
    return this.page.evaluate(FOCUSED) as Promise<Focused>;
  }
  async select(field: string, option: string) {
    await this.page
      .getByLabel(field)
      .or(this.page.getByRole("combobox", { name: field }))
      .or(this.page.getByRole("listbox", { name: field }))
      .first()
      .selectOption({ label: option }, { timeout: 10_000 });
  }
  waitForText(text: string, timeoutMs: number) {
    return this.page
      .getByText(text)
      .first()
      .waitFor({ state: "visible", timeout: timeoutMs })
      .then(
        () => true,
        () => false,
      );
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
    | {
        type: "state";
        control: "agents" | "person";
        url: string;
        /** The agent being taught a task, while the person shows it (G24.14b, release 2). */
        teaching?: string | undefined;
      },
) => void;

/**
 * What the element under a click is, in words: its role and its name. Runs in the page; a
 * password field says so and nothing more.
 */
const DESCRIBE_AT = (x: number, y: number) => `(() => {
  const el = document.elementFromPoint(${x}, ${y});
  if (!el) return "";
  const t = el.closest("a,button,input,select,textarea,label,[role],summary") || el;
  if (t instanceof HTMLInputElement && t.type === "password") return "the password field";
  const label = (t.getAttribute("aria-label") || (t.labels && t.labels[0] && t.labels[0].innerText) ||
    t.getAttribute("placeholder") || t.innerText || t.getAttribute("value") || t.getAttribute("title") || "").trim().replace(/\\s+/g, " ").slice(0, 80);
  const role = t.getAttribute("role") || ({ A: "link", BUTTON: "button", INPUT: "field", SELECT: "list", TEXTAREA: "field" })[t.tagName] || "text";
  return role + (label ? ' "' + label + '"' : "");
})()`;

/** The focused element is a password field (its typing is the person's alone). */
const FOCUS_IS_PASSWORD = `(() => { const el = document.activeElement; return !!el && el.tagName === "INPUT" && el.type === "password"; })()`;

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
  /** The last action queued: agents sharing the browser take turns, one action at a time. */
  private lock: Promise<void> = Promise.resolve();

  /**
   * Runs one agent's action alone: another agent's waits for it (two agents must never drive
   * the same tab at once). A stopped turn stops waiting, and its place goes to the next.
   */
  async exclusive<T>(f: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const before = this.lock;
    let release = () => {};
    const mine = new Promise<void>((r) => {
      release = r;
    });
    this.lock = before.then(() => mine);
    try {
      await untilAborted(before, signal);
      return await f();
    } finally {
      release();
    }
  }

  /** Files downloaded, newest last, as paths in the agents' desk. */
  readonly downloads: string[] = [];

  constructor(
    private readonly launcher: BrowserLauncher,
    private readonly ownerId: string,
    /** A page for tests; Playwright over CDP otherwise. */
    private readonly fake?: PageLike,
    /** Where downloads are kept (the agents' desk), and how they are named there. */
    private readonly saveTo?: { dir: string; prefix: string },
  ) {}

  /** Downloads land in the agents' desk, under downloads/ (G24.14c). */
  private watchDownloads(page: Page): void {
    page.on("download", (d) => {
      const dir = this.saveTo;
      if (!dir) return;
      const name =
        d
          .suggestedFilename()
          .replace(/[\\/:*?"<>|]+/g, "_")
          .slice(0, 120) || "file";
      const rel = `${dir.prefix}/${Date.now().toString(36)}-${name}`;
      // The browser runs elsewhere (its own container): the file is fetched here, with the
      // page's cookies (a signed-in site works too), and the browser's own copy is dropped.
      const url = d.url();
      void (async () => {
        let body: Buffer;
        if (url.startsWith("data:")) {
          const [meta = "", data = ""] = url.slice(5).split(",", 2);
          body = meta.endsWith(";base64")
            ? Buffer.from(data, "base64")
            : Buffer.from(decodeURIComponent(data));
        } else {
          const r = await page.context().request.get(url, { timeout: 120_000 });
          if (!r.ok()) throw new Error(`HTTP ${r.status()}`);
          body = await r.body();
        }
        await writeFile(`${dir.dir}/${rel}`, body);
        this.downloads.push(rel);
      })()
        .catch(() => {})
        .finally(() => void d.cancel().catch(() => {}));
    });
  }

  /** The tabs: their address and title, the current one marked. */
  async tabs(): Promise<{ url: string; title: string; current: boolean }[]> {
    if (this.fake) return [{ url: this.fake.url(), title: await this.fake.title(), current: true }];
    const page = await this.live();
    return Promise.all(
      page
        .context()
        .pages()
        .map(async (p) => ({
          url: p.url(),
          title: await p.title().catch(() => ""),
          current: p === this.page,
        })),
    );
  }

  /** Opens a tab (with an address) or goes to one; the screen follows it. */
  async useTab(action: "open" | "switch" | "close", index?: number, url?: string): Promise<void> {
    if (this.fake) return;
    const page = await this.live();
    const pages = page.context().pages();
    let next: Page | undefined;
    if (action === "open") {
      next = await page.context().newPage();
      await next.setViewportSize(this.size).catch(() => {});
      if (url) await next.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    } else {
      const target = pages[index ?? -1];
      if (!target) throw new Error(`No tab ${index}: there are ${pages.length}`);
      if (action === "switch") next = target;
      else {
        await target.close();
        if (target === this.page)
          next = page.context().pages()[0] ?? (await page.context().newPage());
      }
    }
    if (next && next !== this.page) {
      void this.cdp?.send("Page.stopScreencast").catch(() => {});
      this.page = next;
      this.cdp = undefined;
      if (this.viewers.size > 0) await this.startScreen();
      this.emit({ type: "state", ...this.state() });
    }
  }

  /** The page, the browser started if needed. */
  private async live(): Promise<Page> {
    if (this.page && !this.page.isClosed() && this.browser?.isConnected()) return this.page;
    this.connecting ??= (async () => {
      const endpoint = await this.launcher.endpoint(this.ownerId);
      this.browser = await chromium.connectOverCDP(endpoint);
      const context = this.browser.contexts()[0] ?? (await this.browser.newContext());
      const page = context.pages()[0] ?? (await context.newPage());
      await page.setViewportSize(this.size).catch(() => {});
      // Downloads are allowed (a browser joined over CDP refuses them by default).
      await this.browser
        .newBrowserCDPSession()
        .then((s) =>
          s.send("Browser.setDownloadBehavior", {
            behavior: "allowAndName",
            downloadPath: "/tmp/rg-downloads",
            eventsEnabled: true,
          }),
        )
        .catch(() => {});
      for (const p of context.pages()) this.watchDownloads(p);
      context.on("page", (p) => this.watchDownloads(p));
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

  /** A task being shown to an agent: the steps so far, in words (release 2). */
  private teaching: { agentId: string; steps: string[] } | undefined;

  state(): { control: "agents" | "person"; url: string; teaching?: string | undefined } {
    return {
      control: this.control,
      url: this.page?.url() ?? "about:blank",
      ...(this.teaching && { teaching: this.teaching.agentId }),
    };
  }

  private step(text: string): void {
    const steps = this.teaching?.steps;
    if (!steps) return;
    // Typing comes key by key: one step per field.
    const last = steps.at(-1);
    if (text.startsWith("type ") && last?.startsWith("type ")) {
      steps[steps.length - 1] = `${last.slice(0, -1)}${text.slice(6, -1)}"`;
      return;
    }
    if (steps.at(-1) !== text) steps.push(text);
  }

  /**
   * "Teach a task": the person takes control and does it once; each click, page and text is
   * written down in words (never what goes into a password field). `stopTeaching` returns the
   * steps, and the browser goes back to the agents.
   */
  startTeaching(agentId: string): void {
    this.teaching = { agentId, steps: this.page ? [`start at ${this.page.url()}`] : [] };
    this.setControl("person");
  }

  stopTeaching(): { agentId: string; steps: string[] } | undefined {
    const t = this.teaching;
    this.teaching = undefined;
    this.setControl("agents");
    return t;
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
    // Given back without "Done": the task being shown is dropped.
    if (who === "agents") this.teaching = undefined;
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
    if (e.kind === "text") {
      if (this.teaching) {
        const secret = await page.evaluate(FOCUS_IS_PASSWORD).catch(() => true);
        this.step(secret ? "the person typed their password (ask them)" : `type "${e.text}"`);
      }
      await page.keyboard.insertText(e.text);
    } else if (e.kind === "key") {
      if (this.teaching && ["Enter", "Tab", "Escape"].includes(e.key)) this.step(`press ${e.key}`);
      await page.keyboard.press(e.key);
    } else {
      const x = e.x * this.size.width;
      const y = e.y * this.size.height;
      if (e.kind === "click") {
        if (this.teaching) {
          const what = await page.evaluate(DESCRIBE_AT(x, y)).catch(() => "");
          if (what) this.step(`click ${what}`);
        }
        await page.mouse.click(x, y);
      } else {
        await page.mouse.move(x, y);
        await page.mouse.wheel(0, e.dy);
      }
    }
  }

  async goto(url: string): Promise<void> {
    if (this.control !== "person") return;
    const target = /^[a-z]+:/i.test(url) ? url : `https://${url}`;
    this.step(`open ${target}`);
    await (await this.pageLike()).goto(target);
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
    private readonly o: {
      idleMs?: number;
      fake?: PageLike;
      /** The agents' desk of a person: downloads go to its downloads/ folder. */
      desk?: (ownerId: string) => string;
    } = {},
  ) {
    this.timer = setInterval(() => void this.sweep(), 60_000);
    this.timer.unref();
  }

  get(ownerId: string): AgentBrowser {
    let b = this.all.get(ownerId);
    if (!b) {
      const desk = this.o.desk?.(ownerId);
      if (desk) mkdirSync(`${desk}/downloads`, { recursive: true });
      b = new AgentBrowser(
        this.launcher,
        ownerId,
        this.o.fake,
        desk ? { dir: desk, prefix: "downloads" } : undefined,
      );
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

const stopped = (signal: AbortSignal) =>
  signal.reason instanceof Error ? signal.reason : new Error("Stopped");

/** `p`, unless the signal stops the wait first. */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(stopped(signal));
  return new Promise<T>((ok, ko) => {
    const stop = () => ko(stopped(signal));
    signal.addEventListener("abort", stop, { once: true });
    p.then(ok, ko).finally(() => signal.removeEventListener("abort", stop));
  });
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  return untilAborted(
    new Promise<void>((r) => {
      timer = setTimeout(r, ms);
    }),
    signal,
  ).finally(() => clearTimeout(timer));
}

/**
 * An address for the agents' browser: a bare name becomes https; only web pages (http, https)
 * and the empty page. Undefined for anything else (file:, javascript:, data:, chrome:…).
 */
export function browserAddress(url: string): string | undefined {
  const u = url.trim();
  const schemed =
    /^[a-z][a-z0-9+.-]*:\/\//i.test(u) ||
    /^(about|javascript|data|file|blob|chrome|edge|view-source|vbscript|mailto|filesystem|ws|wss|ftp|devtools|intent):/i.test(
      u,
    );
  let parsed: URL;
  try {
    parsed = new URL(schemed ? u : `https://${u}`);
  } catch {
    return undefined;
  }
  if (parsed.href === "about:blank") return "about:blank";
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : undefined;
}

const NOT_WEB = "Only web addresses (http or https) can be opened in the browser.";

/** A button's name that sends, pays, publishes or deletes: clicked only through browser_click. */
const outgoing = (name: string) =>
  classify(
    { callId: "", name: "browser_click", input: { name } },
    DEFAULT_DANGER_RULES.filter((r) => r.id === "outgoing-browser"),
  ).length > 0;

/**
 * The browser tools of a personal agent. While the person has control they wait (up to ten
 * minutes), then say so; passwords are never typed by an agent nor read back. Each action runs
 * alone: agents sharing the browser take turns.
 */
export function browserTools(
  b: AgentBrowser,
  o: {
    waitMs?: number /** The model reads images: screenshots are offered. */;
    vision?: boolean;
  } = {},
): Tool[] {
  const ready = async (signal: AbortSignal | undefined): Promise<PageLike | string> => {
    const until = Date.now() + (o.waitMs ?? 10 * 60_000);
    while (b.control === "person") {
      if (Date.now() > until)
        return "The person has control of the browser right now. Try again later, or ask them.";
      await sleep(Math.min(1000, Math.max(10, until - Date.now())), signal);
    }
    return b.pageLike();
  };
  const page = <T>(ctx: ToolContext | undefined, f: (p: PageLike) => Promise<T>) =>
    b.exclusive(async () => {
      const p = await ready(ctx?.signal);
      if (typeof p === "string") return { content: p, isError: true };
      return f(p);
    }, ctx?.signal);
  const where = async (p: PageLike) => `${await p.title().catch(() => "")} — ${p.url()}`;
  const tool = (
    def: Tool["def"],
    schema: z.ZodType,
    run: (i: never, ctx: ToolContext) => Promise<unknown>,
  ): Tool => ({ def, schema, run }) as unknown as Tool;
  /**
   * Enter or Space on what has the focus: refused when it would press a button that sends,
   * pays or deletes (that click asks the user, through browser_click), or when unknown.
   */
  const activates = async (p: PageLike, key: string): Promise<string | undefined> => {
    if (key !== "Enter" && key !== "Space") return undefined;
    const f = await p.focused().catch(() => undefined);
    if (!f) return "Could not tell what has the focus: use browser_click on the button instead.";
    const pressed =
      f.kind === "button" || f.kind === "link"
        ? f.name
        : key === "Enter" && (f.kind === "field" || f.kind === "password")
          ? f.submit
          : undefined;
    if (pressed && outgoing(pressed))
      return `That would press "${pressed}", which needs the user's approval: use browser_click with that name instead.`;
    return undefined;
  };
  return [
    tool(
      {
        name: "browser_open",
        description:
          "Open a web address (http or https) in the browser you share with the user's other personal agents (sign-ins are kept). Then read it with browser_read.",
        inputSchema: {
          type: "object",
          properties: { url: { type: "string" } },
          required: ["url"],
        },
      },
      z.object({ url: z.string().min(1) }),
      ({ url }: { url: string }, ctx) => {
        const target = browserAddress(url);
        if (!target) return Promise.resolve({ content: NOT_WEB, isError: true });
        return page(ctx, async (p) => {
          await p.goto(target);
          return `Opened ${await where(p)}.`;
        });
      },
    ),
    tool(
      {
        name: "browser_read",
        description: `Read the open page as text: its headings, links, buttons and fields with their names. Use those names with browser_click and browser_type. Long pages come in parts of ${READ_LIMIT} characters: read the next one with from.`,
        inputSchema: {
          type: "object",
          properties: {
            from: {
              type: "integer",
              minimum: 0,
              description: "Character to start from (given at the end of the previous part)",
            },
          },
        },
      },
      z.object({ from: z.number().int().min(0).optional() }),
      ({ from = 0 }: { from?: number }, ctx) =>
        page(ctx, async (p) => {
          const text = withoutSecrets(await p.snapshot(), await p.secrets().catch(() => []));
          if (from > 0 && from >= text.length)
            return `${await where(p)}\n\nThe page has ${text.length} characters: from ${from} is past the end.`;
          const end = Math.min(text.length, from + READ_LIMIT);
          const part = text.slice(from, end);
          const head = from > 0 ? `[characters ${from}-${end} of ${text.length}]\n` : "";
          const more =
            end < text.length
              ? `\n[… the page goes on: read the rest with browser_read from ${end}]`
              : "";
          return `${await where(p)}\n\n${head}${part}${more}`;
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
      ({ name, role }: { name: string; role?: string }, ctx) =>
        page(ctx, async (p) => {
          const before = b.downloads.length;
          await p.click({ role, name });
          // A click may start a download: give it a moment to land in the desk.
          await new Promise((r) => setTimeout(r, 1500));
          const got = b.downloads.slice(before);
          return `Clicked "${name}". Now at ${await where(p)}.${got.length ? ` Downloaded to the agents' desk: ${got.join(", ")}.` : ""}`;
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
      ({ field, text, submit }: { field: string; text: string; submit?: boolean }, ctx) =>
        page(ctx, async (p) => {
          if (await p.isPassword(field))
            return {
              content:
                "That is a password field: passwords are typed by the user. Ask them to take control of the browser (its screen in RedGiant) and sign in.",
              isError: true,
            };
          await p.fill(field, text, false);
          if (submit) {
            // Enter presses the form's button: one that pays or sends asks, through browser_click.
            const refused = await activates(p, "Enter");
            if (refused)
              return { content: `Typed into "${field}", not submitted. ${refused}`, isError: true };
            await p.press("Enter");
          }
          return `Typed into "${field}"${submit ? " and submitted" : ""}. Now at ${await where(p)}.`;
        }),
    ),
    tool(
      {
        name: "browser_press",
        description: `Press one key on what has the focus: ${BROWSER_KEYS.join(", ")}. Not for typing text (use browser_type). Enter or Space on a button that sends, pays or deletes is refused: click it with browser_click.`,
        inputSchema: {
          type: "object",
          properties: { key: { type: "string", enum: [...BROWSER_KEYS] } },
          required: ["key"],
        },
      },
      z.object({ key: z.enum(BROWSER_KEYS) }),
      ({ key }: { key: string }, ctx) =>
        page(ctx, async (p) => {
          const refused = await activates(p, key);
          if (refused) return { content: refused, isError: true };
          await p.press(key);
          return `Pressed ${key}. Now at ${await where(p)}.`;
        }),
    ),
    tool(
      {
        name: "browser_scroll",
        description:
          "Scroll the page a screen up or down, or until an element with the given text is in view.",
        inputSchema: {
          type: "object",
          properties: {
            direction: { type: "string", enum: ["up", "down"] },
            to: { type: "string", description: "Text of the element to bring into view" },
          },
        },
      },
      z
        .object({ direction: z.enum(["up", "down"]).optional(), to: z.string().min(1).optional() })
        .refine((x) => (x.direction === undefined) !== (x.to === undefined), {
          message: "Give either direction or to",
        }),
      ({ direction, to }: { direction?: "up" | "down"; to?: string }, ctx) =>
        page(ctx, async (p) => {
          await p.scroll(to !== undefined ? { text: to } : { direction: direction ?? "down" });
          return `Scrolled ${to !== undefined ? `to "${to}"` : direction}. Read the page again with browser_read.`;
        }),
    ),
    tool(
      {
        name: "browser_select",
        description:
          "Choose an option of a drop-down list (a select) by the list's label and the option's visible text.",
        inputSchema: {
          type: "object",
          properties: { field: { type: "string" }, option: { type: "string" } },
          required: ["field", "option"],
        },
      },
      z.object({ field: z.string().min(1), option: z.string().min(1) }),
      ({ field, option }: { field: string; option: string }, ctx) =>
        page(ctx, async (p) => {
          await p.select(field, option);
          return `Chose "${option}" in "${field}". Now at ${await where(p)}.`;
        }),
    ),
    tool(
      {
        name: "browser_wait",
        description:
          "Wait until a text shows up on the page (a result, a confirmation), up to timeout seconds (default 10, at most 60).",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
            timeout: { type: "integer", minimum: 1, maximum: 60 },
          },
          required: ["text"],
        },
      },
      z.object({ text: z.string().min(1), timeout: z.number().int().min(1).max(60).optional() }),
      ({ text, timeout = 10 }: { text: string; timeout?: number }, ctx) =>
        page(ctx, async (p) => {
          const seen = await untilAborted(p.waitForText(text, timeout * 1000), ctx?.signal);
          return seen
            ? `"${text}" is on the page. At ${await where(p)}.`
            : {
                content: `"${text}" did not show up within ${timeout} s. At ${await where(p)}.`,
                isError: true,
              };
        }),
    ),
    tool(
      {
        name: "browser_tabs",
        description:
          "The browser's tabs: list them, open one (optionally at an address), switch to one or close one by its number from the list.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["list", "open", "switch", "close"] },
            index: { type: "integer" },
            url: { type: "string" },
          },
          required: ["action"],
        },
      },
      z.object({
        action: z.enum(["list", "open", "switch", "close"]),
        index: z.number().int().min(0).optional(),
        url: z.string().optional(),
      }),
      (
        {
          action,
          index,
          url,
        }: {
          action: "list" | "open" | "switch" | "close";
          index?: number;
          url?: string;
        },
        ctx,
      ) => {
        const target = url ? browserAddress(url) : undefined;
        if (url && !target) return Promise.resolve({ content: NOT_WEB, isError: true });
        return page(ctx, async () => {
          if (action !== "list") await b.useTab(action, index, target);
          const tabs = await b.tabs();
          return tabs
            .map((t, i) => `${i}${t.current ? " (current)" : ""}: ${t.title} — ${t.url}`)
            .join("\n");
        });
      },
    ),
    ...(o.vision
      ? [
          tool(
            {
              name: "browser_screenshot",
              description:
                "See the open page as a picture, for what text alone does not tell (layout, images, charts).",
              inputSchema: { type: "object", properties: {} },
            },
            z.object({}),
            (_: never, ctx) =>
              page(ctx, async (p) => ({
                content: `Screenshot of ${await where(p)}.`,
                images: [
                  {
                    type: "image" as const,
                    mediaType: "image/jpeg" as const,
                    data: await p.screenshot(),
                  },
                ],
              })),
          ),
        ]
      : []),
    tool(
      {
        name: "browser_back",
        description: "Go back to the previous page.",
        inputSchema: { type: "object", properties: {} },
      },
      z.object({}),
      (_: never, ctx) =>
        page(ctx, async (p) => {
          await p.back();
          return `Back at ${await where(p)}.`;
        }),
    ),
  ];
}
