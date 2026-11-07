import type { RefineEstimate, RefineResult } from "@redgiant/protocol";
import type { CompletionRequest } from "@redgiant/providers";
import { afterEach, describe, expect, it } from "vitest";
import { type PromptView, parseRefined, REFINER_SYSTEM, requiredParts } from "../src/index.js";
import { OTHER, startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const textOf = (r: CompletionRequest) =>
  r.messages
    .at(-1)
    ?.parts.flatMap((p) => (p.type === "text" ? [p.text] : []))
    .join("") ?? "";
const answer = (prompt: string, changes = "- Shorter.") =>
  `<prompt>\n${prompt}\n</prompt>\n<changes>\n${changes}\n</changes>`;

async function family(srv: Server) {
  const god = (
    await srv.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "Zeus",
    })
  ).body;
  const demi = (
    await srv.api<{ id: string }>("POST", "/api/agents", {
      kind: "demigod",
      parentId: god.id,
      name: "Hermes",
    })
  ).body;
  return { god, demi };
}

describe("the pure parts", () => {
  it("reads the agreed form and knows what must come back", () => {
    expect(parseRefined(answer("You are {name}.", "- a\n- b"))).toEqual({
      text: "You are {name}.",
      changes: "- a\n- b",
    });
    expect(parseRefined("no tags here")).toBeNull();
    expect(parseRefined("<prompt>X</prompt>")).toEqual({ text: "X", changes: "" });
    expect(
      requiredParts("Ask {god} with ask_god, then {god} again.", "uses delegate too", true),
    ).toEqual(["ask_god", "{god}"]);
    expect(requiredParts("Use snake_case names; ask {god}.", undefined, false)).toEqual(["{god}"]);
  });
});

describe("the instructions' refiner (G36.13)", () => {
  it("sends the text with placeholders, gives it back with the names, saves nothing", async () => {
    const seen: CompletionRequest[] = [];
    s = await startServer((req) => {
      seen.push(req);
      return {
        text: answer(
          "You are {name}, the user's spokesperson on Telegram. Pass every request to {god} with ask_god and report back briefly.",
        ),
        usage: { inputTokens: 900, outputTokens: 120 },
      };
    });
    const { demi } = await family(s);
    const before = (await s.api<PromptView>("GET", `/api/agents/${demi.id}/prompt`)).body;
    const r = await s.api<RefineResult>("POST", "/api/prompts/refine", {
      target: { agentId: demi.id },
      text: before.text,
      request: "più conciso",
      model: { provider: "fake", model: "m", effort: "high" },
      lang: "it",
    });
    expect(r.status).toBe(200);
    expect(r.body.text).toMatch(/^You are Hermes, .*to Zeus with ask_god/);
    expect(r.body.changes).toBe("- Shorter.");
    expect(r.body).toMatchObject({ inputTokens: 900, outputTokens: 120, usd: null });

    expect(seen).toHaveLength(1);
    const req = seen[0] as CompletionRequest;
    expect(req.system).toBe(REFINER_SYSTEM);
    expect(req.effort).toBe("high");
    expect(req.tools).toEqual([]);
    const msg = textOf(req);
    expect(msg).not.toContain("Zeus");
    expect(msg).not.toContain("Hermes");
    expect(msg).toContain("{god}");
    expect(msg).toContain("<request>\npiù conciso\n</request>");
    expect(msg).toContain("<built_in>");
    expect(msg).toContain("Write the instructions in English");
    expect(msg).toContain("explanation in Italian");

    // Nothing saved: the agent keeps the built-in text; the spend is on the global budget.
    expect(s.core.registry.get(demi.id)?.systemPrompt).toBeUndefined();
    expect((await s.api<PromptView>("GET", `/api/agents/${demi.id}/prompt`)).body.isDefault).toBe(
      true,
    );
    expect((await s.core.budget.used({ scope: "global", id: "me" })).tokens).toBe(1020);
  });

  it("asks once more when a placeholder or a tool is lost, then gives up and changes nothing", async () => {
    const seen: CompletionRequest[] = [];
    let fixed = true;
    s = await startServer((req, i) => {
      seen.push(req);
      if (i % 2 === 0) return { text: answer("You are Hermes. Pass requests on.") };
      return {
        text: fixed
          ? answer("You are {name}. Pass every request to {god} with ask_god.")
          : answer("You are Hermes."),
      };
    });
    const { demi } = await family(s);
    const text = (await s.api<PromptView>("GET", `/api/agents/${demi.id}/prompt`)).body.text;
    const body = { target: { agentId: demi.id }, text, model: { provider: "fake", model: "m" } };
    const ok = await s.api<RefineResult>("POST", "/api/prompts/refine", body);
    expect(ok.status).toBe(200);
    expect(ok.body.text).toBe("You are Hermes. Pass every request to Zeus with ask_god.");
    expect(seen).toHaveLength(2);
    const fix = textOf(seen[1] as CompletionRequest);
    expect(fix).toContain("ask_god");
    expect(fix).toContain("{god}");
    expect(fix).toContain("{name}");
    expect(seen[1]?.messages).toHaveLength(3);

    fixed = false;
    const bad = await s.api<{ code: string }>("POST", "/api/prompts/refine", body);
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("removed_parts");
    expect(s.core.registry.get(demi.id)?.systemPrompt).toBeUndefined();
  });

  it("estimates without asking the model, and keeps to owners, tokens and budgets", async () => {
    const seen: CompletionRequest[] = [];
    s = await startServer((req) => {
      seen.push(req);
      return { text: answer("x") };
    });
    const { god } = await family(s);
    const est = await s.api<RefineEstimate>("POST", "/api/prompts/refine/estimate", {
      target: { agentId: god.id },
      text: "You are Zeus. Be kind.",
    });
    expect(est.status).toBe(200);
    expect(est.body.inputTokens).toBeGreaterThan(500);
    expect(est.body.outputTokens).toBeGreaterThan(0);
    expect(est.body).toMatchObject({ usd: null, model: { provider: "fake", model: "m" } });
    expect(seen).toHaveLength(0);

    const body = {
      target: { agentId: god.id },
      text: "Hi",
      model: { provider: "fake", model: "m" },
    };
    expect((await s.api("POST", "/api/prompts/refine", body, OTHER)).status).toBe(404);
    expect((await s.api("POST", "/api/prompts/refine/estimate", body, OTHER)).status).toBe(404);
    expect((await s.api("POST", "/api/prompts/refine", body, "wrong-token")).status).toBe(401);
    expect((await s.api("POST", "/api/prompts/refine", { text: "no target" })).status).toBe(400);
    expect(
      (
        await s.api("POST", "/api/prompts/refine", {
          ...body,
          model: { provider: "nobody", model: "m" },
        })
      ).status,
    ).toBe(400);

    await s.core.budget.setLimit({ scope: "global", id: "me" }, { tokens: 0 });
    const over = await s.api<{ code: string }>("POST", "/api/prompts/refine", body);
    expect(over.status).toBe(400);
    expect(over.body.code).toBe("budget");
    expect(seen).toHaveLength(0);
  });

  it("revises the Chat's and every agent's instructions too", async () => {
    const seen: CompletionRequest[] = [];
    s = await startServer((req) => {
      seen.push(req);
      return {
        text: answer(
          seen.length === 1
            ? "Rispondi in breve, con elenchi."
            : `Be brief. ${/<current>\n([\s\S]*?)\n<\/current>/.exec(textOf(req))?.[1] ?? ""}`,
        ),
      };
    });
    await family(s);
    const general = await s.api<RefineResult>("POST", "/api/prompts/refine", {
      target: { general: true },
      text: "Rispondi sempre in breve. Rispondi in breve.",
      request: "rispondi sempre con elenchi",
    });
    expect(general.body.text).toBe("Rispondi in breve, con elenchi.");
    expect(textOf(seen[0] as CompletionRequest)).toContain("in the language they are written in");
    expect(textOf(seen[0] as CompletionRequest)).not.toContain("<built_in>");

    const chat = (await s.api<PromptView>("GET", "/api/chat/prompt")).body;
    const r = await s.api<RefineResult>("POST", "/api/prompts/refine", {
      target: { chat: true },
      text: chat.text,
    });
    expect(r.status).toBe(200);
    expect(r.body.text).toBe(`Be brief. ${chat.text}`);
    expect(r.body.text).toContain("Zeus");
    expect(textOf(seen[1] as CompletionRequest)).toContain("general improvement");
  });
});

describe("God's instructions for an agent made by hand (G36.14)", () => {
  it("starts from the built-in text with the job and the settings, with God's model", async () => {
    const seen: CompletionRequest[] = [];
    s = await startServer((req) => {
      seen.push(req);
      return {
        text: answer(
          "You are {name}, one of the user's personal assistants. Your job: {role} Hand other work over with ask_assistant or to {god}; ask for missing services with request_connection. Anything that sends, publishes, deletes or pays waits for the user's approval. Save jobs as skills with propose_extension.",
          "- Fitted to invoices.",
        ),
      };
    });
    await family(s);
    const draft = {
      target: {
        draft: { kind: "assistant", name: "Fatture", role: "Keeps my invoices", mode: "manual" },
      },
      goal: "draft",
    };
    const est = await s.api<RefineEstimate>("POST", "/api/prompts/refine/estimate", draft);
    expect(est.body.base).toMatch(/^You are Fatture, .*Your job: Keeps my invoices/);
    const r = await s.api<RefineResult>("POST", "/api/prompts/refine", draft);
    expect(r.status).toBe(200);
    expect(r.body.text).toMatch(/^You are Fatture, .*Your job: Keeps my invoices Hand/);
    expect(r.body.text).toContain("to Zeus");
    const msg = textOf(seen[0] as CompletionRequest);
    expect(msg).toContain(
      "Write the instructions for a personal assistant of the person, named {name}",
    );
    expect(msg).toContain("Its job, as the person describes it: Keeps my invoices");
    expect(msg).toContain("Permission mode: manual");
    expect(msg).not.toContain("<current>");
    expect(msg).not.toContain("Fatture");
    // God's model, as no other was chosen.
    expect(seen[0]?.model).toBe("m");
  });

  it("rewrites an existing agent's instructions for its new job, keeping its own text as the start", async () => {
    const seen: CompletionRequest[] = [];
    s = await startServer((req) => {
      seen.push(req);
      return { text: answer("You are {name}. Your job: {role} Ask {god}.") };
    });
    const { god } = await family(s);
    const a = (
      await s.api<{ id: string }>("POST", "/api/agents", {
        kind: "assistant",
        parentId: god.id,
        name: "Ada",
        role: "Reads my mail",
      })
    ).body;
    await s.api("PUT", `/api/agents/${a.id}/prompt`, { text: "You are Ada. Be polite with Zeus." });
    await s.api("PATCH", `/api/agents/${a.id}`, { role: "Pays my bills" });
    const r = await s.api<RefineResult>("POST", "/api/prompts/refine", {
      target: { agentId: a.id },
      goal: "draft",
    });
    expect(r.body.text).toBe("You are Ada. Your job: Pays my bills Ask Zeus.");
    const msg = textOf(seen[0] as CompletionRequest);
    expect(msg).toContain("<current>\nYou are {name}. Be polite with {god}.\n</current>");
    expect(msg).toContain("Its job, as the person describes it: Pays my bills");
    expect(s.core.registry.get(a.id)?.systemPrompt).toBe("You are {name}. Be polite with {god}.");
  });

  it("proposes the new agent's tools too: off with why, on by default, never an essential one", async () => {
    const seen: CompletionRequest[] = [];
    s = await startServer(
      (req) => {
        seen.push(req);
        return {
          text: `${answer("You are {name}, one of the user's personal assistants. Your job: {role} Use ask_assistant or {god}, request_connection and propose_extension; anything that sends waits for approval.")}\n<tools>\noff blender: emails only\n- off image_generation — no pictures\non fetch: reads links in mails\n</tools>`,
        };
      },
      { contextWindow: 65_536 },
    );
    const { god } = await family(s);
    await s.api("POST", "/api/agents", {
      kind: "assistant",
      parentId: god.id,
      name: "Old",
      role: "x",
    });
    const r = await s.api<RefineResult>("POST", "/api/prompts/refine", {
      target: { draft: { kind: "assistant", name: "Mail", role: "Writes my emails" } },
      goal: "draft",
    });
    expect(r.status).toBe(200);
    const tools = r.body.tools ?? [];
    expect(tools.find((t) => t.id === "blender")).toMatchObject({ on: false, why: "emails only" });
    expect(tools.find((t) => t.id === "image_generation")).toMatchObject({
      on: false,
      why: "no pictures",
    });
    expect(tools.find((t) => t.id === "fetch")).toMatchObject({ on: true });
    expect(tools.find((t) => t.id === "show_file")).toMatchObject({ on: true, why: "" });
    expect(
      tools.some((t) => ["read_file", "bash", "ask_user", "request_tool"].includes(t.id)),
    ).toBe(false);
    expect(tools.every((t) => t.tokens > 0)).toBe(true);
    const msg = textOf(seen[0] as CompletionRequest);
    expect(msg).toContain("<tools_available>");
    expect(msg).toMatch(/\nblender \(blender; \d+ tokens\)/);
    // Nothing is switched off before the person creates the agent.
    expect((await s.core.toolChoices.get("me")).agents).toEqual({});
  });
});
