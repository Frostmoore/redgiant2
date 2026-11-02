import { describe, expect, it } from "vitest";
import {
  AgentBrowser,
  type BrowserLauncher,
  Browsers,
  browserTools,
  type PageLike,
  withoutSecrets,
} from "../src/browser.js";
import { startServer } from "./helpers.js";

const launcher: BrowserLauncher = {
  endpoint: async () => "http://127.0.0.1:1",
  stop: async () => {},
};

function fakePage(): PageLike & { typed: string[]; clicked: string[] } {
  let at = "about:blank";
  const typed: string[] = [];
  const clicked: string[] = [];
  return {
    typed,
    clicked,
    goto: async (u) => {
      at = u;
    },
    url: () => at,
    title: async () => "Shop",
    snapshot: async () =>
      '- textbox "Email": marta@example.com\n- textbox "Password": hunter2\n- button "Pay"',
    secrets: async () => ["hunter2"],
    click: async (t) => {
      clicked.push(t.name);
    },
    isPassword: async (f) => /password/i.test(f),
    fill: async (f, text) => {
      typed.push(`${f}=${text}`);
    },
    back: async () => {},
  };
}

const run = async (tools: ReturnType<typeof browserTools>, name: string, input: unknown) => {
  const t = tools.find((x) => x.def.name === name);
  const out = await t?.run(input as never, {} as never);
  return typeof out === "string" ? { content: out, isError: false } : out;
};

describe("the agents' browser (G24.14b)", () => {
  it("never reads back a password, never types one", async () => {
    expect(withoutSecrets("a hunter2 b hunter2", ["hunter2", ""])).toBe("a •••••• b ••••••");
    const page = fakePage();
    const tools = browserTools(new AgentBrowser(launcher, "me", page));
    await run(tools, "browser_open", { url: "shop.example" });
    expect(page.url()).toBe("https://shop.example");
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
});
