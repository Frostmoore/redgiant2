import type { CompletionRequest } from "@redgiant/providers";
import { afterEach, describe, expect, it } from "vitest";
import { expandPrompt, type PromptView, toPlaceholders } from "../src/index.js";
import { OTHER, startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

describe("names as placeholders", () => {
  const names = { name: "Zeus", god: "Zeus", demigod: "Demi-Zeus", role: "Keeps the diary" };
  const all = new Set(["name", "god", "demigod", "role"] as const);

  it("takes whole names only, the longest first", () => {
    expect(toPlaceholders("Zeus and Demi-Zeus; Zeus's job; Zeusian; {name}", names, all)).toBe(
      "{name} and {demigod}; {name}'s job; Zeusian; {name}",
    );
    expect(
      toPlaceholders("Ask God, not Demi-God.", { name: "X", god: "God", demigod: "Demi-God" }, all),
    ).toBe("Ask {god}, not {demigod}.");
  });

  it("keeps {name} out unless the built-in text uses it, and the role only after «Your job:»", () => {
    const n = { name: "Chat", god: "God", demigod: "Demi-God", role: "chat" };
    expect(toPlaceholders("Chat with God. Your job: chat", n, new Set(["god"]))).toBe(
      "Chat with {god}. Your job: chat",
    );
    expect(toPlaceholders("Your job: chat. Chat on.", n, new Set(["name", "role"]))).toBe(
      "Your job: {role}. {name} on.",
    );
  });

  it("puts the names back as they are now", () => {
    expect(
      expandPrompt("{name} asks {god} and {demigod}. Your job: {role}", {
        name: "Ada",
        god: "Odin",
        demigod: "Loki",
      }),
    ).toBe("Ada asks Odin and Loki. Your job: ");
  });
});

describe("agents' instructions (2026-11-06)", () => {
  it("shows the built-in text with the names, keeps edits with placeholders, follows renames", async () => {
    s = await startServer({ text: "ok" });
    const god = (
      await s.api<{ id: string }>("POST", "/api/agents", {
        kind: "god",
        parentId: null,
        name: "Zeus",
      })
    ).body;
    const demi = (
      await s.api<{ id: string }>("POST", "/api/agents", {
        kind: "demigod",
        parentId: god.id,
        name: "Hermes",
      })
    ).body;
    const first = (await s.api<PromptView>("GET", `/api/agents/${demi.id}/prompt`)).body;
    expect(first.isDefault).toBe(true);
    expect(first.text).toBe(first.defaultText);
    expect(first.text).toMatch(/^You are Hermes, .*Pass every request to Zeus with ask_god/);

    const edited = `${first.text} Always greet the user.`;
    const saved = (
      await s.api<PromptView>("PUT", `/api/agents/${demi.id}/prompt`, { text: edited })
    ).body;
    expect(saved).toMatchObject({ isDefault: false, text: edited });
    const kept = s.core.registry.get(demi.id)?.systemPrompt ?? "";
    expect(kept).toMatch(/^You are \{name\}, .*to \{god\} with ask_god/);
    expect(kept).not.toContain("Zeus");

    await s.api("PATCH", `/api/agents/${god.id}`, { name: "Odin" });
    await s.api("PATCH", `/api/agents/${demi.id}`, { name: "Loki" });
    const after = (await s.api<PromptView>("GET", `/api/agents/${demi.id}/prompt`)).body;
    expect(after.text).toMatch(/^You are Loki, .*Pass every request to Odin with ask_god.*greet/);
    const agent = s.core.registry.get(demi.id);
    expect(agent && s.core.systemFor(agent)).toBe(after.text);

    // The built-in text again: by null, or by saving it unchanged.
    expect(
      (await s.api<PromptView>("PUT", `/api/agents/${demi.id}/prompt`, { text: null })).body
        .isDefault,
    ).toBe(true);
    expect(s.core.registry.get(demi.id)?.systemPrompt).toBeUndefined();
    await s.api("PUT", `/api/agents/${demi.id}/prompt`, { text: after.defaultText });
    expect(s.core.registry.get(demi.id)?.systemPrompt).toBeUndefined();
  });

  it("is another owner's business only for that owner", async () => {
    s = await startServer({ text: "ok" });
    const god = (
      await s.api<{ id: string }>("POST", "/api/agents", {
        kind: "god",
        parentId: null,
        name: "God",
      })
    ).body;
    expect((await s.api("GET", `/api/agents/${god.id}/prompt`, undefined, OTHER)).status).toBe(404);
    expect((await s.api("PUT", `/api/agents/${god.id}/prompt`, { text: "Hi" }, OTHER)).status).toBe(
      404,
    );
    expect((await s.api("PUT", `/api/agents/${god.id}/prompt`, { text: 3 })).status).toBe(400);
  });

  it("never changes the system prompt of a conversation already open", async () => {
    const seen: CompletionRequest[] = [];
    s = await startServer((req) => {
      seen.push(req);
      return { text: "ok" };
    });
    const god = (
      await s.api<{ id: string }>("POST", "/api/agents", {
        kind: "god",
        parentId: null,
        name: "God",
      })
    ).body;
    const open = async () =>
      (await s?.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: god.id }))?.body
        .sessionId as string;
    const me = s.core.registry.get(god.id)?.ownerId as string;
    const sid = await open();
    await (await s.core.send(me, sid, "One")).done;
    const before = seen.at(-1)?.system;
    expect(before).toMatch(/^You are God, the main orchestrator/);

    await s.api("PUT", `/api/agents/${god.id}/prompt`, { text: "You are God. Be brief." });
    await (await s.core.send(me, sid, "Two")).done;
    expect(seen.at(-1)?.system).toBe(before);
    const started = (await s.core.store.list({ sessionId: sid })).filter(
      (e) => e.type === "session.started",
    );
    expect(started).toHaveLength(1);

    // A new conversation starts with the new instructions.
    const next = await open();
    await (await s.core.send(me, next, "Three")).done;
    expect(seen.at(-1)?.system).toMatch(/^You are God\. Be brief\./);
  });

  it("does the same for the everyday Chat, through its agent or its own route", async () => {
    const seen: CompletionRequest[] = [];
    s = await startServer((req) => {
      seen.push(req);
      return { text: "ok" };
    });
    await s.api("POST", "/api/agents", { kind: "god", parentId: null, name: "Zeus" });
    const chat = (await s.api<PromptView>("GET", "/api/chat/prompt")).body;
    expect(chat.isDefault).toBe(true);
    expect(chat.text).toContain("suggest asking Zeus");
    const a = (await s.api<{ id: string }>("GET", "/api/chat/agent")).body;
    expect((await s.api<PromptView>("GET", `/api/agents/${a.id}/prompt`)).body).toEqual(chat);

    const saved = (
      await s.api<PromptView>("PUT", `/api/agents/${a.id}/prompt`, {
        text: "Be brief. Ask Zeus for projects.",
      })
    ).body;
    expect(saved.isDefault).toBe(false);
    expect((await s.api("GET", "/api/chat/settings")).body).toEqual({
      systemPrompt: "Be brief. Ask {god} for projects.",
    });
    const { sessionId } = (
      await s.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: a.id })
    ).body;
    const me = s.core.registry.get(a.id)?.ownerId as string;
    await (await s.core.send(me, sessionId, "Ciao")).done;
    expect(seen.at(-1)?.system).toMatch(/^Be brief\. Ask Zeus for projects\./);

    const back = (await s.api<PromptView>("PUT", "/api/chat/prompt", { text: null })).body;
    expect(back.isDefault).toBe(true);
    expect((await s.api("GET", "/api/chat/settings")).body).toEqual({});
    expect(s.core.registry.get(a.id)?.systemPrompt).toContain("{god}");
  });
});
