// The agents' models are the person's choice (G38.9, decision «Il modello degli agenti lo sceglie
// la persona»): create_agent's model and set_agent_model say so, and are used only when the person
// asked. A model must be one of the person's. set_agent_model is an ordinary request only the
// person answers (never a parent agent); with their yes the agent's model changes for its next
// conversations, and its open ones record session.model_changed and are rebuilt once, between two
// turns. Resuming reads the new model.
import { type Event, type PermissionRequestInfo, requestSentence } from "@redgiant/protocol";
import type { CompletionRequest, FakeTurn } from "@redgiant/providers";
import { afterEach, describe, expect, it } from "vitest";
import { MODEL_PARAM_DESCRIPTION, SET_AGENT_MODEL_DESCRIPTION } from "../src/orchestration.js";
import { startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  const server = s;
  s = undefined;
  await server?.close();
}, 60_000);

const textOf = (req: CompletionRequest | undefined) =>
  req?.messages
    .at(-1)
    ?.parts.flatMap((p) =>
      p.type === "text" ? [p.text] : p.type === "tool_result" ? [p.content] : [],
    )
    .join("\n") ?? "";

/**
 * Any agent: «CALL <tool> <json>» from the user makes that call; a tool's result is answered
 * with «RESULT: …»; anything else gets «ok».
 */
function script(req: CompletionRequest): FakeTurn {
  const last = req.messages.at(-1);
  if (last?.parts.some((p) => p.type === "tool_result")) return { text: `RESULT: ${textOf(req)}` };
  const m = textOf(req).match(/^CALL (\w+) ([\s\S]+)$/);
  if (m?.[1] && m[2]) return { toolCalls: [{ name: m[1], input: JSON.parse(m[2]) }] };
  return { text: "ok" };
}

async function setup(server: Server) {
  await server.api("POST", "/api/projects", { name: "Shop" });
  const god = (
    await server.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    })
  ).body.id;
  const orch = (
    await server.api<{ id: string }>("POST", "/api/agents", {
      kind: "orchestrator",
      parentId: god,
      projectId: "shop",
      name: "Orch",
    })
  ).body.id;
  const session = async (agentId: string) =>
    (await server.api<{ sessionId: string }>("POST", "/api/sessions", { agentId })).body.sessionId;
  return { god, orch, godSid: await session(god), orchSid: await session(orch), session };
}

/** Answers the person's requests as they would, from the page; keeps what they saw. */
function person(server: Server, decision: "allow" | "deny") {
  const seen: PermissionRequestInfo[] = [];
  server.core.approvals.on("request", (owner, info) => {
    seen.push(info);
    server.core.approvals.decide(
      owner,
      info.requestId,
      decision,
      decision === "deny" ? "not now" : undefined,
    );
  });
  return seen;
}

const say = async (server: Server, sid: string, text: string) => {
  await (await server.core.send("me", sid, text)).done;
  return server.provider.requests.at(-1) as CompletionRequest;
};
const callText = (tool: string, input: unknown) => `CALL ${tool} ${JSON.stringify(input)}`;
const events = async (server: Server, sid: string) =>
  (await server.api<Event[]>("GET", `/api/sessions/${sid}/events`)).body;

describe("the agents' models are the person's choice (G38.9)", () => {
  it("says so in create_agent, set_agent_model and God's and the orchestrators' instructions", async () => {
    s = await startServer(script, { models: ["m", "big"] });
    const { godSid, orchSid } = await setup(s);
    const god = await say(s, godSid, "hello");
    const def = (name: string) => god.tools.find((t) => t.name === name);
    const schema = def("create_agent")?.inputSchema as
      | { properties: { model: { description: string } } }
      | undefined;
    const model = schema?.properties.model;
    expect(model?.description).toBe(MODEL_PARAM_DESCRIPTION);
    expect(MODEL_PARAM_DESCRIPTION).toContain(
      "ONLY when the person explicitly asked for a model for this agent",
    );
    expect(MODEL_PARAM_DESCRIPTION).toContain("the person's default applies");
    expect(def("set_agent_model")?.description).toBe(SET_AGENT_MODEL_DESCRIPTION);
    expect(SET_AGENT_MODEL_DESCRIPTION).toContain("ONLY when the person explicitly asked for it");
    expect(SET_AGENT_MODEL_DESCRIPTION).toContain("never one you chose yourself");
    expect(god.system).toContain("The models are the user's choice");
    const orch = await say(s, orchSid, "hello");
    expect(orch.system).toContain("The models are the user's choice");
    expect(orch.tools.map((t) => t.name)).toContain("set_agent_model");
  });

  it("creates an agent with the person's default, or with the model the person named", async () => {
    s = await startServer(script, { models: ["m", "big"] });
    const { godSid, session } = await setup(s);
    await say(
      s,
      godSid,
      callText("create_agent", { kind: "assistant", name: "Plain", role: "Helps" }),
    );
    await say(
      s,
      godSid,
      callText("create_agent", {
        kind: "assistant",
        name: "Big",
        role: "Helps",
        model: { provider: "fake", model: "big", effort: "high" },
      }),
    );
    const byName = (n: string) =>
      s?.core.registry.list({ ownerId: "me" }).find((a) => a.name === n);
    expect(byName("Plain")?.model).toBeUndefined();
    expect(byName("Big")?.model).toEqual({ provider: "fake", model: "big", effort: "high" });
    const plain = await say(s, await session(byName("Plain")?.id ?? ""), "hi");
    expect(plain.model).toBe("m");
    const big = await say(s, await session(byName("Big")?.id ?? ""), "hi");
    expect(big).toMatchObject({ model: "big", effort: "high" });
  });

  it("refuses a model that is not one of the person's, listing theirs, and creates nothing", async () => {
    s = await startServer(script, { models: ["m", "big"] });
    const { godSid } = await setup(s);
    const before = s.core.registry.list({ ownerId: "me" }).length;
    const wrongModel = await say(
      s,
      godSid,
      callText("create_agent", {
        kind: "assistant",
        name: "X",
        role: "Helps",
        model: { provider: "fake", model: "giant" },
      }),
    );
    expect(textOf(wrongModel)).toContain(`"giant" is not one of the person's models on fake`);
    expect(textOf(wrongModel)).toContain("Available: fake/m, fake/big.");
    expect(textOf(wrongModel)).toContain("The agent was not created.");
    const wrongProvider = await say(
      s,
      godSid,
      callText("create_agent", {
        kind: "assistant",
        name: "Y",
        role: "Helps",
        model: { provider: "openai", model: "gpt" },
      }),
    );
    expect(textOf(wrongProvider)).toContain(`"openai" is not one of the person's providers`);
    expect(textOf(wrongProvider)).toContain("fake/m");
    expect(s.core.registry.list({ ownerId: "me" })).toHaveLength(before);
  });

  it("changes an agent's model with the person's yes: an event in its open conversation, rebuilt once, kept on resume", async () => {
    s = await startServer(script, { models: ["m", "big"] });
    const { god, orch, godSid, orchSid, session } = await setup(s);
    const seen = person(s, "allow");
    const first = await say(s, orchSid, "hi");
    expect(first.model).toBe("m");

    const r = await say(
      s,
      godSid,
      callText("set_agent_model", {
        agent_id: orch,
        provider: "fake",
        model: "big",
        effort: "high",
      }),
    );
    expect(textOf(r)).toContain("Orch now uses fake/big (effort high) in its next conversations");
    expect(textOf(r)).toContain("its open conversations (1) use it from their next message");
    // An ordinary request of the person's, in plain words.
    const asked = seen.find((i) => i.tool === "set_agent_model");
    expect(asked?.danger).toContain("agent-model");
    expect(requestSentence("it", "set_agent_model", asked?.input, asked?.names)).toBe(
      "Passa l'agente «Orch» al modello «fake/big» (effort high)",
    );
    expect(s.core.registry.get(orch)?.model).toEqual({
      provider: "fake",
      model: "big",
      effort: "high",
    });

    const changed = (await events(s, orchSid)).filter((e) => e.type === "session.model_changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]?.payload).toEqual({
      model: { provider: "fake", model: "big", effort: "high" },
      by: { agentId: god, name: "God" },
    });

    // The same conversation, its history kept, now with the new model; the prefix is the same.
    const next = await say(s, orchSid, "go on");
    expect(next).toMatchObject({ model: "big", effort: "high" });
    expect(next.system).toBe(first.system);
    expect(next.messages.length).toBeGreaterThan(first.messages.length);

    // Resumed from the log (as after a restart) and a new conversation: the new model.
    s.core.agentModelChanged(orch);
    expect((await say(s, orchSid, "again")).model).toBe("big");
    expect((await say(s, await session(orch), "new")).model).toBe("big");
  });

  it("changes nothing when the person says no", async () => {
    s = await startServer(script, { models: ["m", "big"] });
    const { orch, godSid, orchSid } = await setup(s);
    person(s, "deny");
    await say(s, orchSid, "hi");
    const r = await say(
      s,
      godSid,
      callText("set_agent_model", { agent_id: orch, provider: "fake", model: "big" }),
    );
    expect(textOf(r)).toContain("Permission denied");
    expect(s.core.registry.get(orch)?.model).toBeUndefined();
    expect((await events(s, orchSid)).some((e) => e.type === "session.model_changed")).toBe(false);
    expect((await say(s, orchSid, "go on")).model).toBe("m");
  });

  it("asks the person, never the parent agent, when an orchestrator changes its agent's model", async () => {
    let parentsAsked = 0;
    s = await startServer(
      script,
      { models: ["m", "big"] },
      {
        askAgent: async () => {
          parentsAsked++;
          return "allow";
        },
      },
    );
    const { orch, orchSid } = await setup(s);
    const coder = (
      await s.api<{ id: string }>("POST", "/api/agents", {
        kind: "agent",
        parentId: orch,
        name: "Coder",
      })
    ).body.id;
    const seen = person(s, "allow");
    await say(
      s,
      orchSid,
      callText("set_agent_model", { agent_id: coder, provider: "fake", model: "big" }),
    );
    expect(parentsAsked).toBe(0);
    expect(seen.map((i) => i.tool)).toEqual(["set_agent_model"]);
    expect(s.core.registry.get(coder)?.model).toEqual({ provider: "fake", model: "big" });
  });

  it("refuses, before asking anyone, an agent outside its hierarchy and a model not the person's", async () => {
    s = await startServer(script, { models: ["m", "big"] });
    const { god, orch, godSid, orchSid } = await setup(s);
    const seen = person(s, "allow");
    await s.api("POST", "/api/projects", { name: "Other" });
    const otherOrch = (
      await s.api<{ id: string }>("POST", "/api/agents", {
        kind: "orchestrator",
        parentId: god,
        projectId: "other",
        name: "Other orchestrator",
      })
    ).body.id;
    const other = (
      await s.api<{ id: string }>("POST", "/api/agents", {
        kind: "agent",
        parentId: otherOrch,
        name: "Other",
      })
    ).body.id;
    expect(other).toBeTruthy();
    for (const target of [god, orch, otherOrch, other]) {
      const r = await say(
        s,
        orchSid,
        callText("set_agent_model", { agent_id: target, provider: "fake", model: "big" }),
      );
      expect(textOf(r)).toContain("You cannot change");
    }
    // God cannot change its own model either: only the person does, from the composer.
    expect(
      textOf(
        await say(
          s,
          godSid,
          callText("set_agent_model", { agent_id: god, provider: "fake", model: "big" }),
        ),
      ),
    ).toContain("You cannot change God's model");
    expect(seen).toHaveLength(0);
    // A model that is not the person's: nothing changes (the person was asked, then refused).
    const wrong = await say(
      s,
      godSid,
      callText("set_agent_model", { agent_id: orch, provider: "fake", model: "giant" }),
    );
    expect(textOf(wrong)).toContain("Available: fake/m, fake/big. Nothing changed.");
    expect(s.core.registry.get(orch)?.model).toBeUndefined();
  });

  it("waits for a working conversation's turn to end, then records the change and rebuilds it", async () => {
    let release: () => void = () => {};
    let hold: Promise<void> | undefined;
    s = await startServer(script, {
      models: ["m", "big"],
      tick: () => hold ?? Promise.resolve(),
    });
    const { god, orch, orchSid } = await setup(s);
    hold = new Promise((r) => {
      release = r;
    });
    const { done } = await s.core.send("me", orchSid, "work");
    while (!s.core.isRunning(orchSid)) await new Promise((r) => setTimeout(r, 5));
    const by = s.core.registry.get(god);
    if (!by) throw new Error("no God");
    const r = await s.core.setAgentModel("me", orch, { provider: "fake", model: "big" }, by);
    expect(r).toEqual({ now: 0, afterTurn: 1, ownModel: 0 });
    // Nothing inside the running turn.
    expect((await events(s, orchSid)).some((e) => e.type === "session.model_changed")).toBe(false);
    hold = undefined;
    release();
    await done;
    await new Promise((r) => setTimeout(r, 50));
    const log = await events(s, orchSid);
    const at = log.findIndex((e) => e.type === "session.model_changed");
    const answered = log.findLastIndex((e) => e.type === "message.assistant");
    expect(at).toBeGreaterThan(answered);
    expect((await say(s, orchSid, "next")).model).toBe("big");
  });

  it("leaves a conversation whose model the person chose in the composer", async () => {
    s = await startServer(script, { models: ["m", "big", "small"] });
    const { god, orch, orchSid } = await setup(s);
    await s.core.setSessionModel("me", orchSid, { provider: "fake", model: "small" });
    await say(s, orchSid, "hi");
    const by = s.core.registry.get(god);
    if (!by) throw new Error("no God");
    const r = await s.core.setAgentModel("me", orch, { provider: "fake", model: "big" }, by);
    expect(r).toEqual({ now: 0, afterTurn: 0, ownModel: 1 });
    expect((await say(s, orchSid, "go on")).model).toBe("small");
  });
});
