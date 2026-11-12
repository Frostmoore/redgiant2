// A live check of a real external agent (G38.6): Claude Code through its ACP adapter, when it is
// installed (`claude-agent-acp` on the PATH, or REDGIANT_ACP_LIVE_COMMAND). Only with
// `pnpm test:live`; it runs in an empty folder of its own, never in a project, and every action the
// agent asks for is refused except reading that folder.
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import type { EngineTurn } from "@redgiant/agent";
import { LocalWorkspace } from "@redgiant/tools";
import { describe, expect, it } from "vitest";
import { AcpEngine } from "../src/index.js";

function installed(): string[] | undefined {
  const own = process.env.REDGIANT_ACP_LIVE_COMMAND;
  if (own) return own.split(" ");
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", ["claude-agent-acp"], {
      stdio: "ignore",
    });
    return ["claude-agent-acp"];
  } catch {
    return undefined;
  }
}

const command = installed();

describe.skipIf(!command)("a real ACP agent (live, G38.6)", () => {
  it("answers a prompt in an empty folder, its actions refused", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rg-acp-live-"));
    try {
      await writeFile(join(dir, "word.txt"), "PONG");
      const ws = new LocalWorkspace(dir);
      const [file, ...args] = command as string[];
      const engine = new AcpEngine({
        name: "Claude Code (live test)",
        idleMs: Number.POSITIVE_INFINITY,
        host: {
          launch: async () => {
            const p = await ws.spawn(file as string, args, {});
            return {
              input: Writable.toWeb(p.stdin as Writable) as WritableStream<Uint8Array>,
              output: Readable.toWeb(p.stdout as Readable) as ReadableStream<Uint8Array>,
              cwd: p.cwd,
              kill: () => p.kill(),
              exited: p.exited,
            };
          },
          readText: (rel) => ws.readText(rel),
          writeText: async () => {
            throw new Error("not in a live test");
          },
          permit: async (call) =>
            call.name === "read_file" ? { allow: true } : { allow: false, reason: "live test" },
          run: async () => ({ exitCode: 1 }),
        },
      });
      let text = "";
      const t: EngineTurn = {
        text: "Read word.txt in this folder and answer with only the word it contains.",
        images: [],
        system: "",
        tools: [],
        model: { provider: "acp", model: "live" },
        resume: undefined,
        runTool: async () => ({ content: "", isError: true }),
        onMessage: async (m) => {
          for (const p of m.parts) if (p.type === "text") text += p.text;
        },
      };
      try {
        const r = await engine.turn(t);
        expect(r.stopReason).toBe("end_turn");
        expect(text).toContain("PONG");
      } finally {
        engine.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
