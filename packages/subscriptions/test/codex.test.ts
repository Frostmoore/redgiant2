import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineTurn } from "@redgiant/agent";
import { afterEach, describe, expect, it } from "vitest";
import { ChatgptSubscriptionProvider, codexWindows } from "../src/index.js";

const fake = join(import.meta.dirname, "fake-codex.mjs");
let providers: ChatgptSubscriptionProvider[] = [];
afterEach(() => {
  for (const p of providers) p.stop();
  providers = [];
});

async function provider() {
  const home = await mkdtemp(join(tmpdir(), "rg-codex-"));
  const p = new ChatgptSubscriptionProvider({
    home,
    cwd: join(home, "work"),
    command: { file: process.execPath, args: [fake] },
  });
  providers.push(p);
  return p;
}

const turn = (text: string, log: string[]): EngineTurn => ({
  text,
  images: [],
  system: "You are God.",
  tools: [{ name: "read_file", description: "Read", inputSchema: { type: "object" } }],
  model: { provider: "chatgpt-subscription", model: "gpt-6", effort: "max" },
  resume: undefined,
  runTool: async (c) => {
    log.push(`tool ${c.callId} ${c.name} ${JSON.stringify(c.input)}`);
    return { content: "hello", isError: false };
  },
  onMessage: async (m) => {
    log.push(
      `${m.stopReason} ${m.parts.map((p) => (p.type === "text" ? p.text : p.type)).join(",")}`,
    );
  },
});

describe("ChatGPT on a subscription", () => {
  it("runs the turn in Codex with RedGiant's tools as dynamic tools, and keeps the plan's limits", async () => {
    const p = await provider();
    const log: string[] = [];
    expect(await p.engine.turn(turn("What is in a.txt?", log))).toEqual({
      resume: "th-1",
      stopReason: "end_turn",
    });
    expect(log).toEqual([
      "end_turn thinking",
      "tool_use tool_call",
      'tool call_1 read_file {"path":"a.txt"}',
      "end_turn Tool said hello (true)",
    ]);
    expect(await p.limits()).toEqual([
      { id: "5h", label: "5h", usedPct: 21, resetsAt: "2026-11-02T06:13:20.000Z" },
      { id: "7d", label: "7g", usedPct: 48 },
    ]);
    expect(await p.models()).toEqual(["gpt-6"]);
  });

  it("starts the thread with Codex's own shell off and a read-only sandbox", async () => {
    const p = await provider();
    // The fake echoes thread/start's parameters on stderr; read them through the protocol's own answer.
    const started: unknown[] = [];
    const conn = (
      p as unknown as {
        conn: { listeners: Set<unknown>; request: (m: string, x: unknown) => Promise<unknown> };
      }
    ).conn;
    const original = conn.request.bind(conn);
    conn.request = async (m: string, x: unknown) => {
      if (m === "thread/start") started.push(x);
      return original(m, x);
    };
    await p.engine.turn(turn("go", []));
    expect(started[0]).toMatchObject({
      model: "gpt-6",
      approvalPolicy: "never",
      sandbox: "read-only",
      baseInstructions: "You are God.",
      dynamicTools: [{ type: "function", name: "read_file" }],
      config: {
        "features.shell_tool": false,
        "features.unified_exec": false,
        web_search: "live",
      },
    });
  });

  it("reports a failed login as a rejected key, and logs in with a device code", async () => {
    const p = await provider();
    await expect(p.engine.turn(turn("fail", []))).rejects.toMatchObject({ rejectedKey: true });
    const login = await p.login();
    expect([login.url, login.code]).toEqual(["https://auth.openai.com/codex/device", "ABCD-1234"]);
    expect(await login.done).toBe(true);
  });

  it("reads windows from Codex's snapshot", () => {
    expect(
      codexWindows({ primary: { usedPercent: 99.6, windowDurationMins: 300 }, secondary: null }),
    ).toEqual([{ id: "5h", label: "5h", usedPct: 100 }]);
    expect(codexWindows(null)).toEqual([]);
  });
});
