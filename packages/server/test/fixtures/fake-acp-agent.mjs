#!/usr/bin/env node
// A fake external ACP agent for tests (G38.6): a real program on stdio, never a model. Each line
// of a prompt is a command it plays, calling back into its client (RedGiant) like a real agent:
//   env                 says which variables it sees (FOO, and whether any secret leaked in)
//   say <text>          says the text
//   think <text>        thinks the text
//   tool <id> <title>   a tool call of its own, completed at once
//   read <path>         fs/read_text_file, says what came back (or "refused: …")
//   write <path> <text> fs/write_text_file
//   ask <command>       session/request_permission for a command, says the option chosen
//   run <prog> <args…>  terminal/create, waits, says the exit code and the output
//   hang                waits until cancelled
//   done <command>      ends with RedGiant's task-closing line with that verifier
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const SECRETS = ["REDGIANT_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DATABASE_URL"];
const cancels = new Map();
let n = 0;

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));

acp
  .agent({ name: "fake-acp-agent" })
  .onRequest("initialize", () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: true },
    agentInfo: { name: "fake-acp-agent", title: "Fake ACP agent", version: "0.0.1" },
    authMethods: [],
  }))
  .onRequest("session/new", () => ({ sessionId: `fake_${process.pid}_${++n}` }))
  .onRequest("session/load", async (ctx) => {
    await ctx.client.notify("session/update", {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "REPLAYED HISTORY" },
      },
    });
    return {};
  })
  .onNotification("session/cancel", (ctx) => cancels.get(ctx.params.sessionId)?.abort())
  .onRequest("session/prompt", async (ctx) => {
    const sessionId = ctx.params.sessionId;
    const stop = new AbortController();
    cancels.set(sessionId, stop);
    const say = (text) =>
      ctx.client.notify("session/update", {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      });
    const text = ctx.params.prompt.map((b) => (b.type === "text" ? b.text : "")).join("");
    // Only the task itself: RedGiant's prelude comes before a "---" line.
    const body = text.includes("\n---\n") ? text.slice(text.lastIndexOf("\n---\n") + 5) : text;
    for (const line of body.split("\n").map((l) => l.trim())) {
      if (stop.signal.aborted) break;
      const [cmd, ...rest] = line.split(" ");
      const arg = rest.join(" ");
      if (cmd === "env") {
        const leaked = SECRETS.filter((k) => process.env[k] !== undefined);
        await say(`FOO=${process.env.FOO ?? "-"} leaked=${leaked.join(",") || "none"}\n`);
      } else if (cmd === "say") await say(`${arg}\n`);
      else if (cmd === "think")
        await ctx.client.notify("session/update", {
          sessionId,
          update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: arg } },
        });
      else if (cmd === "tool") {
        const [id, ...title] = rest;
        await ctx.client.notify("session/update", {
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: id,
            title: title.join(" "),
            kind: "search",
            status: "in_progress",
          },
        });
        await ctx.client.notify("session/update", {
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: id,
            status: "completed",
            content: [{ type: "content", content: { type: "text", text: "3 matches" } }],
          },
        });
      } else if (cmd === "read") {
        try {
          const r = await ctx.client.request("fs/read_text_file", { sessionId, path: abs(arg) });
          await say(`read: ${r.content}\n`);
        } catch (err) {
          await say(`refused: ${err.message}\n`);
        }
      } else if (cmd === "write") {
        const [path, ...content] = rest;
        try {
          await ctx.client.request("fs/write_text_file", {
            sessionId,
            path: abs(path),
            content: content.join(" "),
          });
          await say(`wrote ${path}\n`);
        } catch (err) {
          await say(`refused: ${err.message}\n`);
        }
      } else if (cmd === "ask") {
        const id = `ask_${Date.now()}`;
        await ctx.client.notify("session/update", {
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: id,
            title: arg,
            kind: "execute",
            status: "pending",
            rawInput: { command: arg },
          },
        });
        const r = await ctx.client.request("session/request_permission", {
          sessionId,
          toolCall: { toolCallId: id },
          options: [
            { optionId: "yes", name: "Allow", kind: "allow_once" },
            { optionId: "no", name: "Reject", kind: "reject_once" },
          ],
        });
        const chosen = r.outcome.outcome === "selected" ? r.outcome.optionId : "cancelled";
        await ctx.client.notify("session/update", {
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: id,
            status: chosen === "yes" ? "completed" : "failed",
          },
        });
        await say(`permission: ${chosen}\n`);
      } else if (cmd === "run") {
        const [program, ...args] = rest;
        try {
          const t = await ctx.client.request("terminal/create", {
            sessionId,
            command: program === "node" ? process.execPath : program,
            args,
          });
          const exit = await ctx.client.request("terminal/wait_for_exit", {
            sessionId,
            terminalId: t.terminalId,
          });
          const out = await ctx.client.request("terminal/output", {
            sessionId,
            terminalId: t.terminalId,
          });
          await ctx.client.request("terminal/release", { sessionId, terminalId: t.terminalId });
          await say(`exit ${exit.exitCode}: ${out.output.trim()}\n`);
        } catch (err) {
          await say(`refused: ${err.message}\n`);
        }
      } else if (cmd === "hang") {
        await say("working…\n");
        await new Promise((ok) => stop.signal.addEventListener("abort", ok, { once: true }));
      } else if (cmd === "done") {
        await say(`All done.\nRG_COMPLETE_TASK ${JSON.stringify({ verify_command: arg })}\n`);
      }
    }
    cancels.delete(sessionId);
    return { stopReason: stop.signal.aborted ? "cancelled" : "end_turn" };
  })
  .connect(stream);

function abs(p) {
  return p.startsWith("/") || /^[A-Za-z]:/.test(p) ? p : `${process.cwd()}/${p}`;
}
