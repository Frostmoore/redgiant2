import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CompletionRequest } from "@redgiant/providers";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const lastResult = (req: CompletionRequest) => {
  const p = req.messages.at(-1)?.parts.find((x) => x.type === "tool_result");
  return p?.type === "tool_result" ? p.content : undefined;
};

const PY = `
from rg import call, ToolError
for n in range(3):
    call("write_file", path=f"notes/{n}.md", content=f"note {n} TODO\\n")
found = call("grep", pattern="TODO", path="notes")
try:
    call("delegate", agent_id="x", title="t", task="t")
except ToolError as e:
    print("refused:", e)
print("files with TODO:", found.count("TODO"))
`;

describe("run_script (G29.7)", () => {
  it("lets a program call the agent's tools; only what it prints comes back", async () => {
    let result = "";
    s = await startServer((req) => {
      const r = lastResult(req);
      if (r !== undefined) {
        result = r;
        return { text: "Done." };
      }
      return { toolCalls: [{ name: "run_script", input: { language: "python", code: PY } }] };
    });
    await s.api("POST", "/api/projects", { name: "Scripted" });
    const god = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    const orch = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "orchestrator",
      parentId: god.body.id,
      projectId: "scripted",
      name: "O",
    });
    const coder = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "agent",
      parentId: orch.body.id,
      name: "Coder",
    });
    const sid = (
      await s.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: coder.body.id })
    ).body.sessionId;
    await (await s.core.send("me", sid, "go")).done;
    expect(result).toContain('refused: No tool "delegate" for scripts.');
    expect(result).toContain("files with TODO: 3");
    expect(result).toContain("(5 tool calls)");
    const tree = join(
      s.dir,
      "workspaces",
      "me",
      "scripted",
      ".worktrees",
      coder.body.id.toLowerCase(),
    );
    expect(await readFile(join(tree, "notes", "2.md"), "utf8")).toBe("note 2 TODO\n");
    // Every call the program made is in the log, apart from the model's history.
    const calls = (await s?.core.history("me", sid))?.filter((e) => e.type === "script.call") ?? [];
    expect(calls.map((e) => (e.payload as { name: string }).name)).toEqual([
      "write_file",
      "write_file",
      "write_file",
      "grep",
    ]);
  });
});
