// Chains of steps that do not fill the context (G29.7, like Hermes' execute_code): the agent
// writes a short Python or JavaScript program that calls its own tools through a local RPC
// endpoint; only what the program prints comes back. Every call goes through the same
// permission broker as a call the model makes (the guardian included), so a script can do no
// more than the agent itself.

import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool, ToolContext } from "@redgiant/agent";
import type { AgentRecord, PermissionBroker } from "@redgiant/hierarchy";
import type { Workspace } from "@redgiant/tools";
import { z } from "zod";

/** Tools a script may not call: itself, and what hands work to other agents or the person. */
const NOT_FROM_SCRIPTS = new Set([
  "run_script",
  "run_subagent",
  "run_subagents",
  "delegate",
  "ask_user",
  "propose_plan",
  "complete_task",
]);

const MAX_CALLS = 200;
const MAX_OUTPUT = 20_000;

const PY_HELPER = `# RedGiant's tools from a script (G29.7): call("grep", pattern="TODO") returns the text.
import json, os, urllib.request
_cfg = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "rg.json")))
class ToolError(Exception):
    pass
def call(name, **args):
    req = urllib.request.Request(_cfg["url"], data=json.dumps({"name": name, "input": args}).encode(),
        headers={"content-type": "application/json", "authorization": "Bearer " + _cfg["token"]})
    out = json.load(urllib.request.urlopen(req, timeout=600))
    if out.get("isError"):
        raise ToolError(out.get("content", ""))
    return out.get("content", "")
`;

const JS_HELPER = `// RedGiant's tools from a script (G29.7): await call("grep", { pattern: "TODO" }) returns the text.
import { readFileSync } from "node:fs";
const cfg = JSON.parse(readFileSync(new URL("./rg.json", import.meta.url), "utf8"));
export async function call(name, input = {}) {
  const r = await fetch(cfg.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + cfg.token },
    body: JSON.stringify({ name, input }),
  });
  const out = await r.json();
  if (out.isError) throw new Error(out.content);
  return out.content;
}
`;

async function body(req: IncomingMessage): Promise<string> {
  let s = "";
  for await (const chunk of req) s += chunk;
  return s;
}

/**
 * `run_script`: the program runs in the agent's workspace; `tools()` is read when it runs, so it
 * sees the agent's whole tool list. Only on the host sandbox (a container would not reach the
 * endpoint, and its files would not see the helper).
 */
export function scriptTool(
  agent: AgentRecord,
  ws: Workspace,
  broker: PermissionBroker,
  tools: () => Tool[],
  onHost: boolean,
): Tool {
  const Input = z.object({
    language: z.enum(["python", "javascript"]),
    code: z.string().min(1),
    timeout_ms: z.number().int().min(1000).max(1_800_000).optional(),
  });
  return {
    def: {
      name: "run_script",
      description:
        "Run a short Python or JavaScript program that calls your tools itself, for a chain of many steps " +
        "(search, read, filter, edit in a loop) without each step filling your context: only what it prints " +
        'comes back. Python: `from rg import call` then `call("grep", pattern="TODO")`. JavaScript (ES module): ' +
        '`import { call } from "./rg.mjs"` then `await call("grep", { pattern: "TODO" })`. Each call returns ' +
        "the tool's text or raises; every call is checked like your own. Print a short summary at the end.",
      inputSchema: {
        type: "object",
        properties: {
          language: { type: "string", enum: ["python", "javascript"] },
          code: { type: "string" },
          timeout_ms: { type: "number" },
        },
        required: ["language", "code"],
      },
    },
    schema: Input,
    async run(i: z.infer<typeof Input>, ctx: ToolContext) {
      if (!onHost)
        return {
          content: "run_script works only when agents run on this computer (sandbox host).",
          isError: true,
        };
      const token = randomBytes(24).toString("hex");
      let calls = 0;
      const server = createServer(async (req, res) => {
        const reply = (status: number, out: { content: string; isError?: boolean }) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(out));
        };
        if (req.method !== "POST" || req.headers.authorization !== `Bearer ${token}`)
          return reply(403, { content: "forbidden", isError: true });
        try {
          const { name, input } = JSON.parse(await body(req)) as { name: string; input: unknown };
          if (++calls > MAX_CALLS)
            return reply(200, { content: `More than ${MAX_CALLS} calls: stopped.`, isError: true });
          const tool = tools().find((t) => t.def.name === name);
          if (!tool || NOT_FROM_SCRIPTS.has(name))
            return reply(200, { content: `No tool "${name}" for scripts.`, isError: true });
          const parsed = tool.schema
            ? tool.schema.safeParse(input)
            : { success: true, data: input };
          if (!parsed.success)
            return reply(200, { content: `Invalid input for ${name}.`, isError: true });
          const call = { callId: `script-${calls}`, name, input: parsed.data };
          // The same check as a call the model makes: rules, dangers, the guardian, approvals.
          const permission = await broker.check(agent, call, ctx.sessionId);
          if (!permission.allow)
            return reply(200, {
              content: `Not allowed: ${permission.reason ?? name}`,
              isError: true,
            });
          const out = await tool.run(parsed.data, ctx);
          return reply(
            200,
            typeof out === "string"
              ? { content: out }
              : { content: out.content, isError: out.isError === true },
          );
        } catch (err) {
          return reply(200, { content: (err as Error).message, isError: true });
        }
      });
      await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
      const dir = await mkdtemp(join(tmpdir(), "rg-script-"));
      try {
        const { port } = server.address() as AddressInfo;
        await writeFile(
          join(dir, "rg.json"),
          JSON.stringify({ url: `http://127.0.0.1:${port}/`, token }),
        );
        const py = i.language === "python";
        await writeFile(join(dir, py ? "rg.py" : "rg.mjs"), py ? PY_HELPER : JS_HELPER);
        const file = join(dir, py ? "main.py" : "main.mjs");
        // The helper is imported from the script's own folder, whatever the working directory.
        await writeFile(
          file,
          py
            ? `import sys\nsys.path.insert(0, ${JSON.stringify(dir)})\n${i.code}`
            : i.code.replaceAll("./rg.mjs", join(dir, "rg.mjs")),
        );
        const r = await ws.execFile(py ? "python3" : "node", [file], {
          timeoutMs: i.timeout_ms ?? 300_000,
          ...(ctx.signal && { signal: ctx.signal }),
        });
        const text = [
          r.stdout.trim(),
          r.stderr.trim() ? `stderr:\n${r.stderr.trim()}` : "",
          r.exitCode !== 0 ? `Exit code: ${r.exitCode}${r.timedOut ? " (timed out)" : ""}` : "",
          `(${calls} tool call${calls === 1 ? "" : "s"})`,
        ]
          .filter(Boolean)
          .join("\n\n");
        return {
          content: text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n[cut]` : text,
          isError: r.exitCode !== 0,
        };
      } finally {
        server.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
  } as Tool;
}
