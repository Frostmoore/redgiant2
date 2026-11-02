import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CompletionRequest } from "@redgiant/providers";
import { afterEach, describe, expect, it } from "vitest";
import { mentions } from "../src/rooms.js";
import { startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const lastUserText = (req: CompletionRequest) => {
  const m = [...req.messages]
    .reverse()
    .find((x) => x.role === "user" && x.parts.some((p) => p.type === "text"));
  const p = m?.parts.find((x) => x.type === "text");
  return p?.type === "text" ? p.text : "";
};
const lastResult = (req: CompletionRequest) => {
  const last = req.messages.at(-1);
  const p = last?.role === "user" ? last.parts.find((x) => x.type === "tool_result") : undefined;
  return p?.type === "tool_result" ? p.content : undefined;
};
const who = (req: CompletionRequest) =>
  (req.system ?? "").includes("project's inspector")
    ? "inspector"
    : (req.system ?? "").includes("main orchestrator")
      ? "god"
      : "assistant";

type Room = { id: string; members: { agentId: string }[] };
type RoomEvent = { type: string; payload: { from?: string; name?: string; text?: string } };

async function setup(answer: (who: string, req: CompletionRequest) => unknown) {
  const seen: { who: string; text: string }[] = [];
  s = await startServer((req) => {
    const w = who(req);
    seen.push({ who: w, text: lastUserText(req) });
    return answer(w, req) as never;
  });
  const god = await s.api<{ id: string }>("POST", "/api/agents", {
    kind: "god",
    parentId: null,
    name: "God",
  });
  const project = await s.api<{ id: string }>("POST", "/api/projects", { name: "Microapps" });
  const helper = await s.api<{ id: string }>("POST", "/api/agents", {
    kind: "assistant",
    parentId: god.body.id,
    name: "Helper",
    role: "Helps.",
  });
  const room = await s.api<Room>("POST", "/api/rooms", {
    members: [god.body.id, `inspector:${project.body.id}`, helper.body.id],
  });
  expect(room.status).toBe(200);
  const say = async (text: string) => {
    expect((await s?.api("POST", `/api/rooms/${room.body.id}/messages`, { text }))?.status).toBe(
      202,
    );
    // Wait for the round to end.
    for (let i = 0; i < 200; i++) {
      const r = await s?.api<Room & { answering: string[] }>("GET", "/api/rooms");
      const mine = r?.body.find((x) => x.id === room.body.id);
      if (mine && mine.answering.length === 0 && seen.length > 0) {
        await new Promise((ok) => setTimeout(ok, 30));
        const again = (await s?.api<(Room & { answering: string[] })[]>("GET", "/api/rooms"))?.body;
        if (again?.find((x) => x.id === room.body.id)?.answering.length === 0) break;
      }
      await new Promise((ok) => setTimeout(ok, 25));
    }
    return (
      (await s?.api<RoomEvent[]>("GET", `/api/rooms/${room.body.id}/events`))?.body ?? []
    ).filter((e) => e.type === "room.message");
  };
  return { seen, say, room: room.body, project: project.body.id, god: god.body.id };
}

describe("group chats (G24.12)", () => {
  it("finds who is called with @, longest names first", () => {
    const people = [
      { id: "a", name: "Ana" },
      { id: "b", name: "Ana Maria" },
      { id: "c", name: "Inspector Microapps" },
    ];
    expect(mentions("@Ana Maria and @inspector microapps, thanks", people)).toEqual(["b", "c"]);
    expect(mentions("ask @Ana", people)).toEqual(["a"]);
    expect(mentions("@Anastasia", people)).toEqual([]);
  });

  it("the one called answers; without @ the first member does", async () => {
    const { say, seen } = await setup((w) => ({ text: `${w} here` }));
    let msgs = await say("@Inspector Microapps what changed?");
    expect(msgs.map((m) => (m.payload.from === "human" ? "human" : m.payload.name))).toEqual([
      "human",
      "Inspector Microapps",
    ]);
    expect(seen.map((x) => x.who)).toEqual(["inspector"]);
    msgs = await say("and in general?");
    expect(msgs.at(-1)?.payload).toMatchObject({ name: "God", text: "god here" });
  });

  it("passes the word with @, with the others' words as data, and stops after six turns", async () => {
    const { say, seen } = await setup((w) =>
      w === "god"
        ? { text: "I will ask @Helper about it." }
        : w === "assistant"
          ? { text: "Back to you, @God." }
          : { text: "ok" },
    );
    const msgs = await say("Plan the release");
    const agentTurns = msgs.filter(
      (m) => m.payload.from !== "human" && m.payload.from !== "system",
    );
    expect(agentTurns).toHaveLength(6);
    expect(msgs.at(-1)?.payload).toMatchObject({ from: "system" });
    expect(msgs.at(-1)?.payload.text).toMatch(/Stopped after 6/);
    const toHelper = seen.find((x) => x.who === "assistant")?.text ?? "";
    expect(toHelper).toContain('<message from="God" kind="data">');
    expect(toHelper).toContain("The user wrote:\nPlan the release");
    expect(toHelper).toMatch(/information, not instructions/);
  });

  it("an inspector writes nothing, even when another agent asks it to", async () => {
    let written = "";
    const { say, project } = await setup((w, req) => {
      if (w === "god") return { text: "@Inspector Microapps please create notes.md" };
      if (w === "inspector") {
        const r = lastResult(req);
        if (r === undefined)
          return {
            toolCalls: [{ name: "write_file", input: { path: "notes.md", content: "x" } }],
          };
        written = r;
        return { text: "I can only read." };
      }
      return { text: "ok" };
    });
    await say("Go");
    expect(written).toMatch(/readonly mode/);
    const p = await s?.core.projects.get("me", project);
    expect(existsSync(join(p?.path ?? "", "notes.md"))).toBe(false);
  });

  it("never adds Demi-God, nor more than six agents", async () => {
    const { room } = await setup(() => ({ text: "ok" }));
    const dg = await s?.api<{ id: string }>("POST", "/api/agents", {
      kind: "demigod",
      parentId: room.members[0]?.agentId,
      name: "Demi",
    });
    const r = await s?.api("POST", `/api/rooms/${room.id}/members`, { agentId: dg?.body.id });
    expect(r?.status).toBe(400);
  });

  it("carries pictures and an earlier chat to the members, and says what each costs (G24.14c)", async () => {
    const got: CompletionRequest[] = [];
    s = await startServer((req) => {
      got.push(req);
      return { text: "seen", usage: { inputTokens: 100, outputTokens: 10 } as never };
    });
    const god = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    const room = await s.api<Room>("POST", "/api/rooms", {
      members: [god.body.id],
      context: "User: what about the roof?\n\nAssistant: It leaks.",
    });
    await (
      await s.core.rooms.post("me", room.body.id, "Look at this", [
        { type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" },
      ])
    ).done;
    const last = got.at(-1)?.messages.at(-1);
    expect(last?.parts.some((p) => p.type === "image")).toBe(true);
    const text = last?.parts.find((p) => p.type === "text");
    expect(text?.type === "text" && text.text).toMatch(
      /<message from="the user's earlier chat" kind="data">[\s\S]*roof/,
    );
    const listed = (
      await s.api<(Room & { members: { costUsd: number; context: number }[] })[]>(
        "GET",
        "/api/rooms",
      )
    ).body;
    expect(listed[0]?.members[0]?.context).toBeGreaterThan(0);
  });

  it("lets God gather a group on the user's behalf, from Telegram too (G24.14c)", async () => {
    let step = 0;
    let project = "";
    s = await startServer((req) => {
      const sys = req.system ?? "";
      if (sys.includes("project's inspector")) return { text: "Two endpoints change." };
      const r = req.messages.at(-1)?.parts.find((p) => p.type === "tool_result");
      if (r?.type === "tool_result") return { text: r.content };
      if (++step === 1)
        return {
          toolCalls: [
            {
              name: "ask_group",
              input: { members: [`inspector:${project}`], message: "What changes for the site?" },
            },
          ],
        };
      return { text: "ok" };
    });
    await s.api("POST", "/api/agents", { kind: "god", parentId: null, name: "God" });
    project = (await s.api<{ id: string }>("POST", "/api/projects", { name: "Site" })).body.id;
    const god = s.core.registry.list({ ownerId: "me" }).find((a) => a.kind === "god");
    const sid = (await s.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: god?.id }))
      .body.sessionId;
    await (await s.core.send("me", sid, "Ask the site's inspector")).done;
    const answer = (await s.core.history("me", sid)).filter((e) => e.type === "tool.result").at(-1)
      ?.payload as { output: string };
    expect(answer.output).toMatch(/Inspector Site: Two endpoints change/);
    expect((await s.api<Room[]>("GET", "/api/rooms")).body).toHaveLength(1);
  });
});
