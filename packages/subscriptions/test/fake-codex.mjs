// A `codex app-server` in miniature for the tests: JSON-RPC lines on stdio, one scripted turn
// that calls a dynamic tool, then answers with what the tool returned.
import { createInterface } from "node:readline";

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const log = [];
let toolCall;
let threads = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method) log.push(m.method);
  if (m.id !== undefined && !m.method) {
    // Our answer to the dynamic tool call.
    const text = m.result.contentItems[0].text;
    send({
      method: "item/completed",
      params: {
        threadId: "th-1",
        turnId: "tu-1",
        completedAtMs: 0,
        item: { type: "agentMessage", id: "i2", text: `Tool said ${text} (${m.result.success})` },
      },
    });
    send({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "th-1",
        turnId: "tu-1",
        tokenUsage: {
          modelContextWindow: 272000,
          total: {},
          last: {
            totalTokens: 1500,
            inputTokens: 1400,
            cachedInputTokens: 1000,
            cacheWriteInputTokens: 0,
            outputTokens: 100,
            reasoningOutputTokens: 10,
          },
        },
      },
    });
    send({
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          primary: { usedPercent: 21, windowDurationMins: 300, resetsAt: 1793600000 },
          secondary: { usedPercent: 48, windowDurationMins: 10080, resetsAt: null },
        },
      },
    });
    send({
      method: "turn/completed",
      params: { threadId: "th-1", turn: { id: "tu-1", status: "completed", items: [] } },
    });
    return;
  }
  switch (m.method) {
    case "initialize":
      return send({ id: m.id, result: { userAgent: "fake" } });
    case "thread/start":
      threads++;
      process.stderr.write(JSON.stringify(m.params));
      return send({
        id: m.id,
        result: { thread: { id: "th-1" }, model: m.params.model, echo: m.params },
      });
    case "thread/resume":
      return send({ id: m.id, result: { thread: { id: m.params.threadId } } });
    case "turn/start":
      send({ id: m.id, result: { turn: { id: "tu-1", status: "inProgress", items: [] } } });
      send({
        method: "item/completed",
        params: {
          threadId: m.params.threadId,
          turnId: "tu-1",
          completedAtMs: 0,
          item: { type: "reasoning", id: "i0", summary: ["Need the tool."], content: [] },
        },
      });
      if (m.params.input[0].text === "fail") {
        send({
          method: "turn/completed",
          params: {
            threadId: m.params.threadId,
            turn: {
              id: "tu-1",
              status: "failed",
              error: { message: "401 Unauthorized: log in again" },
              items: [],
            },
          },
        });
        return;
      }
      toolCall = {
        id: 900,
        method: "item/tool/call",
        params: {
          threadId: m.params.threadId,
          turnId: "tu-1",
          callId: "call_1",
          namespace: null,
          tool: "read_file",
          arguments: { path: "a.txt" },
        },
      };
      return send(toolCall);
    case "model/list":
      return send({
        id: m.id,
        result: {
          data: [
            { id: "gpt-6", model: "gpt-6", hidden: false },
            { id: "old", model: "old", hidden: true },
          ],
          nextCursor: null,
        },
      });
    case "account/rateLimits/read":
      return send({
        id: m.id,
        result: {
          rateLimits: {
            primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: null },
            secondary: null,
          },
        },
      });
    case "account/login/start":
      setTimeout(
        () =>
          send({
            method: "account/login/completed",
            params: { loginId: "L1", success: true, error: null },
          }),
        20,
      );
      return send({
        id: m.id,
        result: {
          type: "chatgptDeviceCode",
          loginId: "L1",
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "ABCD-1234",
        },
      });
    case "debug/log":
      return send({ id: m.id, result: { log, threads } });
  }
});
