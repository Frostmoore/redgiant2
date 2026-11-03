import type { EngineTurn } from "@redgiant/agent";
import { describe, expect, it } from "vitest";
import {
  type ClaudeSdk,
  ClaudeSubscriptionProvider,
  claudeWindows,
  eventWindows,
} from "../src/index.js";

type Tool = {
  name: string;
  handler: (args: unknown, extra: unknown) => Promise<{ content: { text: string }[] }>;
};

/**
 * The Agent SDK in miniature: one assistant message calling a tool, the tool through the MCP
 * server the engine passed, then the answer and the result. It records the options it got.
 */
function fakeSdk(script: "tools" | "refused") {
  const asked: Record<string, unknown>[] = [];
  const sdk: ClaudeSdk = {
    tool: (name, _d, _s, handler) => ({ name, handler }),
    createSdkMcpServer: (o) => o,
    query({ prompt, options }) {
      asked.push(options);
      const server = (options.mcpServers as Record<string, { tools: Tool[] }> | undefined)
        ?.redgiant;
      async function* run() {
        for await (const _ of prompt) break;
        if (script === "refused") {
          yield {
            type: "result",
            subtype: "success",
            is_error: true,
            result: "Not logged in · Please run /login",
            session_id: "s-x",
          };
          return;
        }
        yield { type: "system", subtype: "init", session_id: "sess-1" };
        yield {
          type: "assistant",
          parent_tool_use_id: null,
          session_id: "sess-1",
          message: {
            model: "claude-opus-5-5",
            usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 },
            content: [
              { type: "thinking", thinking: "Let me check." },
              {
                type: "tool_use",
                id: "toolu_1",
                name: "mcp__redgiant__read_file",
                input: { path: "a.txt" },
              },
            ],
          },
        };
        const out = await server?.tools
          .find((t) => t.name === "read_file")
          ?.handler({ path: "a.txt" }, {});
        yield {
          type: "assistant",
          parent_tool_use_id: null,
          session_id: "sess-1",
          message: {
            model: "claude-opus-5-5",
            usage: { input_tokens: 3, cache_read_input_tokens: 120, output_tokens: 7 },
            content: [{ type: "text", text: `It says: ${out?.content[0]?.text}` }],
          },
        };
        yield {
          type: "rate_limit_event",
          rate_limit_info: {
            unifiedWindows: { seven_day: { utilization: 0.1, resetsAt: 1793728800 } },
          },
        };
        yield { type: "result", subtype: "success", session_id: "sess-1", result: "done" };
      }
      const it = run() as ReturnType<ClaudeSdk["query"]>;
      it.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = async () => ({
        rate_limits: {
          five_hour: { utilization: 36.4, resets_at: "2026-11-01T18:00:00Z" },
          seven_day: { utilization: 12, resets_at: null },
          model_scoped: [{ display_name: "Fable", utilization: 80 }],
        },
      });
      return it;
    },
  };
  return { sdk, asked };
}

const turn = (over: Partial<EngineTurn> = {}) => {
  const log: string[] = [];
  const t: EngineTurn = {
    text: "What is in a.txt?",
    images: [],
    system: "You are God.",
    tools: [
      {
        name: "read_file",
        description: "Read",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ],
    model: { provider: "claude-subscription", model: "claude-opus-5-5", effort: "high" },
    resume: undefined,
    runTool: async (c) => {
      log.push(`tool ${c.callId} ${c.name} ${JSON.stringify(c.input)}`);
      return { content: "hello", isError: false };
    },
    onMessage: async (m) => {
      log.push(
        `message ${m.stopReason} ${m.parts.map((p) => p.type).join(",")} ctx=${m.metrics.contextUsed}`,
      );
    },
    ...over,
  };
  return { t, log };
};

describe("Claude on a subscription", () => {
  it("runs the turn in the engine with RedGiant's tools only, and continues the same session", async () => {
    const { sdk, asked } = fakeSdk("tools");
    const p = new ClaudeSubscriptionProvider({
      token: "sk-ant-oat01-x",
      configDir: "/tmp/c",
      cwd: "/tmp",
      sdk,
    });
    const { t, log } = turn();
    expect(await p.engine.turn(t)).toEqual({ resume: "sess-1", stopReason: "end_turn" });
    expect(log).toEqual([
      "message tool_use thinking,tool_call ctx=105",
      'tool toolu_1 read_file {"path":"a.txt"}',
      "message end_turn text ctx=130",
    ]);
    expect(asked[0]).toMatchObject({
      model: "claude-opus-5-5",
      effort: "high",
      tools: ["WebSearch"],
      skills: [],
      strictMcpConfig: true,
      permissionMode: "dontAsk",
      settingSources: [],
      systemPrompt: "You are God.",
      allowedTools: ["mcp__redgiant__read_file", "WebSearch"],
      env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x", CLAUDE_CONFIG_DIR: "/tmp/c" },
    });
    expect(asked[0]).not.toHaveProperty("resume");
    await p.engine.turn(turn({ resume: "sess-1" }).t);
    expect(asked[1]).toMatchObject({ resume: "sess-1" });
  });

  it("reports a refused token as a rejected key", async () => {
    const { sdk } = fakeSdk("refused");
    const p = new ClaudeSubscriptionProvider({
      token: "bad",
      configDir: "/tmp/c",
      cwd: "/tmp",
      sdk,
    });
    await expect(p.engine.turn(turn().t)).rejects.toMatchObject({ rejectedKey: true });
  });

  it("keeps the plan's limits the turns report: events first, then the full reading", async () => {
    const { sdk, asked } = fakeSdk("tools");
    const p = new ClaudeSubscriptionProvider({ token: "t", configDir: "/tmp/c", cwd: "/tmp", sdk });
    expect(await p.limits()).toEqual([]);
    await p.engine.turn(turn().t);
    expect(await p.limits()).toEqual([
      { id: "5h", label: "5h", usedPct: 36, resetsAt: "2026-11-01T18:00:00Z" },
      { id: "7d", label: "7g", usedPct: 12 },
      { id: "model:Fable", label: "Fable", usedPct: 80 },
    ]);
    // Reading them made no extra request.
    expect(asked).toHaveLength(1);
    expect(
      eventWindows({ unifiedWindows: { seven_day: { utilization: 0.36, resetsAt: 1793728800 } } }),
    ).toEqual([{ id: "7d", label: "7g", usedPct: 36, resetsAt: "2026-11-03T18:00:00.000Z" }]);
    expect(claudeWindows({})).toEqual([]);
  });
});
