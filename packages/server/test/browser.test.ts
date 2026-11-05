import { describe, expect, it } from "vitest";
import {
  AgentBrowser,
  type BrowserLauncher,
  Browsers,
  browserAddress,
  browserTools,
  type Focused,
  type PageLike,
  withoutSecrets,
} from "../src/browser.js";
import { startServer } from "./helpers.js";

const launcher: BrowserLauncher = {
  endpoint: async () => "http://127.0.0.1:1",
  stop: async () => {},
};

type FakePage = PageLike & {
  typed: string[];
  clicked: string[];
  pressed: string[];
  scrolled: string[];
  chosen: string[];
  focus: Focused;
  text: string;
  appears: Record<string, number>;
};

function fakePage(): FakePage {
  let at = "about:blank";
  const typed: string[] = [];
  const clicked: string[] = [];
  const pressed: string[] = [];
  const scrolled: string[] = [];
  const chosen: string[] = [];
  const page: FakePage = {
    typed,
    clicked,
    pressed,
    scrolled,
    chosen,
    focus: { kind: "none", name: "" },
    text: '- textbox "Email": marta@example.com\n- textbox "Password": hunter2\n- button "Pay"',
    /** Text that shows up after so many ms. */
    appears: {},
    goto: async (u) => {
      at = u;
    },
    url: () => at,
    title: async () => "Shop",
    snapshot: async () => page.text,
    secrets: async () => ["hunter2"],
    click: async (t) => {
      clicked.push(t.name);
    },
    isPassword: async (f) => /password/i.test(f),
    fill: async (f, text) => {
      typed.push(`${f}=${text}`);
    },
    back: async () => {},
    screenshot: async () => "SCREENSHOT",
    scroll: async (to) => {
      scrolled.push("text" in to ? `to ${to.text}` : to.direction);
    },
    press: async (key) => {
      pressed.push(key);
    },
    focused: async () => page.focus,
    select: async (field, option) => {
      chosen.push(`${field}=${option}`);
    },
    waitForText: async (text, timeoutMs) => {
      const after = page.appears[text];
      if (after === undefined || after > timeoutMs) {
        await new Promise((r) => setTimeout(r, Math.min(timeoutMs, 50)));
        return false;
      }
      await new Promise((r) => setTimeout(r, after));
      return true;
    },
  };
  return page;
}

const run = async (
  tools: ReturnType<typeof browserTools>,
  name: string,
  input: unknown,
  signal?: AbortSignal,
) => {
  const t = tools.find((x) => x.def.name === name);
  const parsed = t?.schema ? t.schema.parse(input) : input;
  const out = await t?.run(parsed as never, { signal } as never);
  return typeof out === "string" ? { content: out, isError: false } : out;
};

describe("the agents' browser (G24.14b)", () => {
  it("never reads back a password, never types one", async () => {
    expect(withoutSecrets("a hunter2 b hunter2", ["hunter2", ""])).toBe("a •••••• b ••••••");
    const page = fakePage();
    const tools = browserTools(new AgentBrowser(launcher, "me", page));
    await run(tools, "browser_open", { url: "shop.example" });
    expect(page.url()).toBe("https://shop.example/");
    const read = await run(tools, "browser_read", {});
    expect(read?.content).toContain("marta@example.com");
    expect(read?.content).not.toContain("hunter2");
    const typed = await run(tools, "browser_type", { field: "Password", text: "x" });
    expect(typed?.isError).toBe(true);
    expect(typed?.content).toMatch(/take control/);
    await run(tools, "browser_type", { field: "Email", text: "a@b.c", submit: true });
    expect(page.typed).toEqual(["Email=a@b.c"]);
  });

  it("waits while the person has control, then says so", async () => {
    const page = fakePage();
    const b = new AgentBrowser(launcher, "me", page);
    b.setControl("person");
    const r = await run(browserTools(b, { waitMs: 50 }), "browser_click", { name: "Pay" });
    expect(r?.isError).toBe(true);
    expect(r?.content).toMatch(/has control/);
    expect(page.clicked).toEqual([]);
    // Given back: the click goes through.
    b.setControl("agents");
    await run(browserTools(b), "browser_click", { name: "Next" });
    expect(page.clicked).toEqual(["Next"]);
  });

  it("is given to personal agents only, and a click that pays asks the person", async () => {
    const calls: string[] = [];
    const s = await startServer((req) => {
      const done = req.messages.at(-1)?.parts.some((p) => p.type === "tool_result");
      calls.push(req.tools.map((t) => t.name).join(","));
      return done
        ? { text: "ok" }
        : { toolCalls: [{ name: "browser_click", input: { name: "Pay now" } }] };
    });
    try {
      const page = fakePage();
      s.core.browsers = new Browsers(launcher, { fake: page });
      const asked: string[][] = [];
      s.core.approvals.on("request", (owner, info) => {
        asked.push(info.danger);
        s.core.approvals.decide(owner, info.requestId, "deny");
      });
      const god = await s.api<{ id: string }>("POST", "/api/agents", {
        kind: "god",
        parentId: null,
        name: "God",
      });
      const a = await s.api<{ id: string }>("POST", "/api/agents", {
        kind: "assistant",
        parentId: god.body.id,
        name: "Shopper",
        role: "Buys things",
      });
      const sid = (
        await s.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: a.body.id })
      ).body.sessionId;
      await (await s.core.send("me", sid, "buy it")).done;
      expect(calls[0]).toContain("browser_click");
      expect(asked).toEqual([["outgoing-browser"]]);
      expect(page.clicked).toEqual([]);
      const gsid = (
        await s.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: god.body.id })
      ).body.sessionId;
      calls.length = 0;
      await (await s.core.send("me", gsid, "hi")).done;
      expect(calls[0]).not.toContain("browser_");
      await s.core.browsers.shutdown();
    } finally {
      await s.close();
    }
  });

  it("hands the task the person showed to the agent, which writes it as a skill", async () => {
    const asked: string[] = [];
    const s = await startServer((req) => {
      const last = req.messages.at(-1)?.parts[0];
      if (last?.type === "text") asked.push(last.text);
      return { text: "Saved as a skill." };
    });
    try {
      s.core.browsers = new Browsers(launcher, { fake: fakePage() });
      const god = await s.api<{ id: string }>("POST", "/api/agents", {
        kind: "god",
        parentId: null,
        name: "God",
      });
      const a = await s.api<{ id: string }>("POST", "/api/agents", {
        kind: "assistant",
        parentId: god.body.id,
        name: "Barista",
        role: "Orders coffee",
      });
      s.core.teachStart("me", a.body.id);
      const b = s.core.browsers.get("me");
      expect(b.state()).toMatchObject({ control: "person", teaching: a.body.id });
      await b.goto("coffee.example");
      const r = await s.core.teachStop("me", "Order my coffee");
      await r?.done;
      expect(b.state().control).toBe("agents");
      const msg = asked.find((x) => x.includes("showed you a task")) ?? "";
      expect(msg).toContain("Order my coffee");
      expect(msg).toContain("open https://coffee.example");
      expect(msg).toMatch(/propose_extension \(kind skill\)/);
      await s.core.browsers.shutdown();
    } finally {
      await s.close();
    }
  });

  it("offers screenshots only to models that see", async () => {
    const b = new AgentBrowser(launcher, "me", fakePage());
    expect(browserTools(b).map((t) => t.def.name)).not.toContain("browser_screenshot");
    const tools = browserTools(b, { vision: true });
    const out = (await tools
      .find((t) => t.def.name === "browser_screenshot")
      ?.run({} as never, {} as never)) as { content: string; images: { data: string }[] };
    expect(out.images[0]?.data).toBe("SCREENSHOT");
    expect(tools.map((t) => t.def.name)).toContain("browser_tabs");
  });

  it("opens only web pages", async () => {
    expect(browserAddress("shop.example")).toBe("https://shop.example/");
    expect(browserAddress("localhost:3000/x")).toBe("https://localhost:3000/x");
    expect(browserAddress("http://a.example/b")).toBe("http://a.example/b");
    expect(browserAddress("about:blank")).toBe("about:blank");
    for (const bad of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<b>x</b>",
      "chrome://settings",
      "view-source:https://a.example",
      "about:config",
      "ftp://a.example",
    ])
      expect(browserAddress(bad), bad).toBeUndefined();
    const page = fakePage();
    const tools = browserTools(new AgentBrowser(launcher, "me", page));
    const r = await run(tools, "browser_open", { url: "file:///etc/passwd" });
    expect(r?.isError).toBe(true);
    expect(r?.content).toMatch(/Only web addresses/);
    expect(
      (await run(tools, "browser_tabs", { action: "open", url: "javascript:x" }))?.isError,
    ).toBe(true);
    expect(page.url()).toBe("about:blank");
  });

  it("lets one agent at a time drive the browser", async () => {
    const page = fakePage();
    const log: string[] = [];
    let gate = () => {};
    page.click = async (t) => {
      log.push(`start ${t.name}`);
      if (t.name === "First") await new Promise<void>((r) => (gate = r));
      log.push(`end ${t.name}`);
    };
    const b = new AgentBrowser(launcher, "me", page);
    // Two agents of the same person: their own tools, the same browser.
    const one = run(browserTools(b), "browser_click", { name: "First" });
    const two = run(browserTools(b), "browser_click", { name: "Second" });
    await new Promise((r) => setTimeout(r, 20));
    expect(log).toEqual(["start First"]);
    gate();
    await Promise.all([one, two]);
    expect(log).toEqual(["start First", "end First", "start Second", "end Second"]);
  });

  it("stops waiting when the turn is stopped", async () => {
    const page = fakePage();
    const b = new AgentBrowser(launcher, "me", page);
    b.setControl("person");
    const stop = new AbortController();
    const waiting = run(browserTools(b), "browser_click", { name: "Next" }, stop.signal);
    // Queued behind it, another agent's action is stopped too, and frees its place.
    const queued = new AbortController();
    const behind = run(browserTools(b), "browser_back", {}, queued.signal);
    await new Promise((r) => setTimeout(r, 20));
    stop.abort();
    queued.abort();
    await expect(waiting).rejects.toThrow();
    await expect(behind).rejects.toThrow();
    expect(page.clicked).toEqual([]);
    b.setControl("agents");
    await run(browserTools(b), "browser_click", { name: "Next" });
    expect(page.clicked).toEqual(["Next"]);
  });

  it("scrolls, presses keys, chooses options and waits for text", async () => {
    const page = fakePage();
    const tools = browserTools(new AgentBrowser(launcher, "me", page));
    await run(tools, "browser_scroll", { direction: "down" });
    await run(tools, "browser_scroll", { to: "Reviews" });
    expect(page.scrolled).toEqual(["down", "to Reviews"]);
    expect(() => tools.find((t) => t.def.name === "browser_scroll")?.schema?.parse({})).toThrow();

    page.focus = { kind: "field", name: "Search", submit: "Search" };
    expect((await run(tools, "browser_press", { key: "Enter" }))?.isError).toBe(false);
    await run(tools, "browser_press", { key: "Escape" });
    expect(page.pressed).toEqual(["Enter", "Escape"]);
    // Only named keys: nothing can be typed with it.
    expect(() =>
      tools.find((t) => t.def.name === "browser_press")?.schema?.parse({ key: "a" }),
    ).toThrow();

    await run(tools, "browser_select", { field: "Size", option: "Large" });
    expect(page.chosen).toEqual(["Size=Large"]);

    page.appears = { "Order placed": 20 };
    const seen = await run(tools, "browser_wait", { text: "Order placed", timeout: 1 });
    expect(seen?.isError).toBe(false);
    const never = await run(tools, "browser_wait", { text: "Never", timeout: 1 });
    expect(never?.isError).toBe(true);
    expect(never?.content).toMatch(/did not show up within 1 s/);
  });

  it("never presses a button that pays or sends with a key: that click asks", async () => {
    const page = fakePage();
    const tools = browserTools(new AgentBrowser(launcher, "me", page));
    page.focus = { kind: "button", name: "Pay now" };
    const r = await run(tools, "browser_press", { key: "Enter" });
    expect(r?.isError).toBe(true);
    expect(r?.content).toMatch(/use browser_click/);
    expect((await run(tools, "browser_press", { key: "Space" }))?.isError).toBe(true);
    // In a form, Enter presses its button.
    page.focus = { kind: "field", name: "Card", submit: "Conferma ordine" };
    expect((await run(tools, "browser_press", { key: "Enter" }))?.isError).toBe(true);
    const typed = await run(tools, "browser_type", { field: "Card", text: "x", submit: true });
    expect(typed?.isError).toBe(true);
    expect(typed?.content).toMatch(/not submitted/);
    // Tab is harmless; a button with an ordinary name is pressed.
    await run(tools, "browser_press", { key: "Tab" });
    page.focus = { kind: "button", name: "Next" };
    await run(tools, "browser_press", { key: "Enter" });
    expect(page.pressed).toEqual(["Tab", "Enter"]);
    expect(page.clicked).toEqual([]);
  });

  it("reads a long page in parts, never a password", async () => {
    const page = fakePage();
    const tools = browserTools(new AgentBrowser(launcher, "me", page));
    page.text = `${"a".repeat(30_000)}hunter2${"b".repeat(25_000)}`;
    const first = await run(tools, "browser_read", {});
    expect(first?.content).toMatch(/read the rest with browser_read from 30000\]$/);
    const second = await run(tools, "browser_read", { from: 30_000 });
    expect(second?.content).toContain("[characters 30000-55006 of 55006]");
    expect(second?.content).toContain("••••••bbb");
    expect(second?.content).not.toContain("hunter2");
    expect(second?.content).not.toMatch(/goes on/);
    const past = await run(tools, "browser_read", { from: 90_000 });
    expect(past?.content).toMatch(/past the end/);
  });
});
