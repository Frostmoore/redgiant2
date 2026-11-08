// p3.4.0 (the benchmark on Windows, 2026-11-08): on this computer an agent always knows where its
// project is (one had moved away with cd, lost it and searched the whole disk), and `bash`
// answers a walk of a whole disk at once instead of running it for many minutes.

import type { CompletionRequest } from "@redgiant/providers";
import { LocalWorkspace, shellPath } from "@redgiant/tools";
import { afterEach, describe, expect, it } from "vitest";
import { yourFolder } from "../src/index.js";
import { startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

describe("the project's folder on this computer", () => {
  it("is in the system prompt of a conversation, fixed from its start", async () => {
    const seen: CompletionRequest[] = [];
    let call = 0;
    s = await startServer((req) => {
      seen.push(req);
      call++;
      return call === 1
        ? {
            text: "Looking.",
            toolCalls: [{ name: "bash", input: { command: "find / -name gregorian.hpp" } }],
          }
        : { text: "done" };
    });
    const api = s.api;
    const god = (
      await api<{ id: string }>("POST", "/api/agents", { kind: "god", parentId: null, name: "God" })
    ).body;
    const project = (
      await api<{ id: string; path: string }>("POST", "/api/projects", { name: "Meetup" })
    ).body;
    const orch = (
      await api<{ id: string }>("POST", "/api/agents", {
        kind: "orchestrator",
        parentId: god.id,
        projectId: project.id,
        name: "Orchestrator",
      })
    ).body;
    const sid = (await api<{ sessionId: string }>("POST", "/api/sessions", { agentId: orch.id }))
      .body.sessionId;
    await (await s.core.send("me", sid, "Solve it")).done;
    const system = seen[0]?.system ?? "";
    expect(system).toContain("## Your folder\nYour project is ");
    expect(system).toContain(shellPath(project.path));
    expect(seen.every((r) => r.system === system)).toBe(true);
    // The walk of the whole disk was answered at once, with the same folder.
    const result = seen[1]?.messages.at(-1)?.parts[0];
    expect(result?.type === "tool_result" && result.content).toMatch(
      /^Not run: this command searches a whole disk[\s\S]*Your project is /,
    );
  });

  it("says where commands start and that nothing carries over between them", () => {
    const text = yourFolder(new LocalWorkspace(process.cwd()));
    expect(text).toMatch(/^## Your folder\n/);
    expect(text).toContain("$OLDPWD too, do not carry over");
    expect(text).toContain("never search a whole disk");
  });
});
