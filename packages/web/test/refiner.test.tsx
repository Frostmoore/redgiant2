// @vitest-environment jsdom
// G36.13-15: «Improve the instructions» under the editor (estimate, before and after with the
// differences lit, Use / Try again / Cancel, nothing saved by itself), God's instructions and tools
// in the creation's last step, the offer after a new job, and the request for a switched-off tool.
import type { PermissionRequestInfo } from "@redgiant/protocol";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lang } from "../src/i18n.js";
import { diffCounts, substantialChange, wordDiff } from "../src/word-diff.js";

const calls: [string, unknown[]][] = [];
const sent: unknown[] = [];
let refined: Record<string, unknown> = {};
let failRefine = false;
// biome-ignore lint/suspicious/noExplicitAny: a stand-in for the whole API
const fakeApi: any = new Proxy(
  {},
  {
    get: (_t, name: string) => {
      if (name === "then") return undefined;
      return (...args: unknown[]) => {
        calls.push([name, args]);
        if (name === "models")
          return Promise.resolve([{ provider: "anthropic", model: "claude-x", effort: true }]);
        if (name === "agentPrompt")
          return Promise.resolve({
            text: "You are Ada. Be kind. Use ask_god.",
            isDefault: false,
            defaultText: "You are Ada.",
          });
        if (name === "refineEstimate")
          return Promise.resolve({
            inputTokens: 1800,
            outputTokens: 400,
            usd: 0.004,
            model: { provider: "fake", model: "m" },
            base: "You are Mail, an assistant. Your job: emails",
          });
        if (name === "refinePrompt")
          return failRefine
            ? Promise.reject(Object.assign(new Error("x"), { code: "removed_parts", status: 400 }))
            : Promise.resolve({
                text: "You are Ada. Be kind and brief. Use ask_god.",
                changes: "- Asked to be brief.\n- Kept the tools.",
                inputTokens: 1900,
                outputTokens: 380,
                usd: 0.02,
                model: { provider: "fake", model: "m" },
                ...refined,
              });
        if (name === "createAgent") return Promise.resolve({ id: "new1", name: "Mail" });
        if (name === "setAgentPrompt")
          return Promise.resolve({ text: args[1], isDefault: false, defaultText: "" });
        if (name.startsWith("set")) return Promise.resolve({});
        return Promise.resolve([]);
      };
    },
  },
);
vi.mock("../src/state.js", async (orig) => {
  const real = await orig<typeof import("../src/state.js")>();
  real.agents.value = [
    { id: "g", kind: "god", name: "Zeus" } as never,
    { id: "a1", kind: "assistant", name: "Ada", role: "mail" } as never,
  ];
  return {
    ...real,
    getApi: () => fakeApi,
    getLive: () => ({ send: (m: unknown) => sent.push(m) }),
    refresh: () => Promise.resolve(),
  };
});

const { PromptEditor } = await import("../src/components/PromptEditor.js");
const { AssistantWizard } = await import("../src/components/Assistants.js");
const { ToolRequestCard } = await import("../src/components/ToolRequestCard.js");
const state = await import("../src/state.js");

const CHECK = 'path[d="M20 6L9 17l-5-5"]';

beforeEach(() => {
  calls.length = 0;
  sent.length = 0;
  refined = {};
  failRefine = false;
  localStorage.clear();
  lang.value = "it";
});
afterEach(cleanup);

describe("the word diff", () => {
  it("lights what goes and what comes, and tells a new job from a typo", () => {
    const parts = wordDiff("Be kind. Use tools.", "Be kind and brief. Use tools.");
    expect(
      parts
        .filter((p) => p.kind !== "add")
        .map((p) => p.text)
        .join(""),
    ).toBe("Be kind. Use tools.");
    expect(
      parts
        .filter((p) => p.kind !== "del")
        .map((p) => p.text)
        .join(""),
    ).toBe("Be kind and brief. Use tools.");
    expect(diffCounts(parts)).toEqual({ del: 0, add: 2 });
    expect(parts.find((p) => p.kind === "add")?.text).toBe(" and brief");
    expect(
      substantialChange("Reads my mail and answers it", "Reads my mail and answers it fast"),
    ).toBe(false);
    expect(substantialChange("Reads my mail", "Pays the bills every month")).toBe(true);
  });
});

describe("«Migliora le istruzioni» (G36.13)", () => {
  it("estimates, shows before and after, fills the editor only on «Usa questa versione»", async () => {
    const r = render(
      <PromptEditor
        load={() => fakeApi.agentPrompt("a1")}
        save={(text) => fakeApi.setAgentPrompt("a1", text)}
        target={{ agentId: "a1" }}
      />,
    );
    await waitFor(() => expect(r.getByText("Migliora le istruzioni")).toBeTruthy());
    fireEvent.click(r.getByText("Migliora le istruzioni"));
    await waitFor(() =>
      expect(r.getByText(/Stima: circa 2200 token, meno di un centesimo/)).toBeTruthy(),
    );
    expect(r.getByRole("combobox", { name: "Il modello che scrive" })).toBeTruthy();
    expect(r.getByText("Il modello di Zeus")).toBeTruthy();
    fireEvent.input(r.getByPlaceholderText(/più conciso/), { target: { value: "più breve" } });
    fireEvent.click(r.getByRole("button", { name: "Migliora" }));
    await waitFor(() => expect(r.getByText("Prima")).toBeTruthy());
    const req = calls.find(([n]) => n === "refinePrompt")?.[1][0] as Record<string, unknown>;
    expect(req).toMatchObject({
      target: { agentId: "a1" },
      goal: "refine",
      text: "You are Ada. Be kind. Use ask_god.",
      request: "più breve",
      lang: "it",
    });
    expect(r.container.querySelector("ins.rf-add")?.textContent).toBe(" and brief");
    expect(r.container.querySelector("del.rf-del")).toBeNull();
    expect(r.getByText("Asked to be brief.")).toBeTruthy();
    expect(r.getByText(/Speso: circa 2280 token, circa \$0.02/)).toBeTruthy();
    // Nothing saved by itself.
    expect(calls.some(([n]) => n === "setAgentPrompt")).toBe(false);
    fireEvent.click(r.getByRole("button", { name: "Usa questa versione" }));
    const field = r.getByRole("textbox", { name: "Le sue istruzioni" }) as HTMLTextAreaElement;
    expect(field.value).toBe("You are Ada. Be kind and brief. Use ask_god.");
    expect(r.getByText(/salva per tenerla/)).toBeTruthy();
    expect(calls.some(([n]) => n === "setAgentPrompt")).toBe(false);
    fireEvent.click(r.getByRole("button", { name: "Salva" }));
    await waitFor(() => expect(calls.some(([n]) => n === "setAgentPrompt")).toBe(true));
    expect(r.container.querySelector(CHECK)).toBeNull();
  });

  it("remembers the model, tries again, cancels, and explains a refusal in words", async () => {
    const r = render(
      <PromptEditor
        load={() => fakeApi.agentPrompt("a1")}
        save={(text) => fakeApi.setAgentPrompt("a1", text)}
        target={{ agentId: "a1" }}
      />,
    );
    await waitFor(() => r.getByText("Migliora le istruzioni"));
    fireEvent.click(r.getByText("Migliora le istruzioni"));
    await waitFor(() => r.getByRole("combobox", { name: "Il modello che scrive" }));
    fireEvent.change(r.getByRole("combobox", { name: "Il modello che scrive" }), {
      target: { value: "anthropic/claude-x" },
    });
    expect(JSON.parse(localStorage.getItem("rg.refiner.model") ?? "null")).toMatchObject({
      provider: "anthropic",
      model: "claude-x",
    });
    fireEvent.click(r.getByRole("button", { name: "Migliora" }));
    await waitFor(() => r.getByText("Riprova"));
    fireEvent.click(r.getByRole("button", { name: "Riprova" }));
    await waitFor(() => expect(calls.filter(([n]) => n === "refinePrompt")).toHaveLength(2));
    const last = calls.at(-1)?.[1][0] as { model: unknown } | undefined;
    expect(last?.model).toMatchObject({ model: "claude-x" });
    await waitFor(() => r.getByRole("button", { name: "Annulla" }));
    fireEvent.click(r.getAllByRole("button", { name: "Annulla" }).at(-1) as HTMLElement);
    expect(r.queryByText("Prima")).toBeNull();
    const field = r.getByRole("textbox", { name: "Le sue istruzioni" }) as HTMLTextAreaElement;
    expect(field.value).toBe("You are Ada. Be kind. Use ask_god.");

    failRefine = true;
    fireEvent.click(r.getByText("Migliora le istruzioni"));
    await waitFor(() => r.getByRole("button", { name: "Migliora" }));
    fireEvent.click(r.getByRole("button", { name: "Migliora" }));
    await waitFor(() =>
      expect(r.getByText(/Il modello ha tolto parti che devono restare/)).toBeTruthy(),
    );
  });

  it("offers God's rewrite after a new job, and only fills the field", async () => {
    state.offerPromptRewrite("a1", true);
    const r = render(
      <PromptEditor
        load={() => fakeApi.agentPrompt("a1")}
        save={(text) => fakeApi.setAgentPrompt("a1", text)}
        target={{ agentId: "a1" }}
      />,
    );
    await waitFor(() => expect(r.getByText(/Hai cambiato cosa fa Ada/)).toBeTruthy());
    fireEvent.click(r.getByRole("button", { name: "Sì, falle riscrivere" }));
    await waitFor(() => r.getByRole("button", { name: "Riscrivi" }));
    fireEvent.click(r.getByRole("button", { name: "Riscrivi" }));
    await waitFor(() => r.getByText("Usa questa versione"));
    expect(calls.find(([n]) => n === "refinePrompt")?.[1][0]).toMatchObject({ goal: "draft" });
    fireEvent.click(r.getByRole("button", { name: "Usa questa versione" }));
    expect(state.promptRewriteOffer.value.a1).toBeUndefined();
    expect(calls.some(([n]) => n === "setAgentPrompt")).toBe(false);
  });
});

describe("God's instructions and tools for a new assistant (G36.14)", () => {
  it("shows the estimate first, then the text and the tools; creates with what was chosen", async () => {
    refined = {
      text: "You are Mail. Your job: emails. Ask Zeus.",
      tools: [
        { id: "blender", on: false, why: "no 3D", tokens: 300 },
        { id: "image_generation", on: false, why: "no pictures", tokens: 120 },
        { id: "fetch", on: true, why: "reads links", tokens: 80 },
      ],
    };
    const r = render(<AssistantWizard onDone={() => {}} />);
    await waitFor(() => expect(r.getByText(/Zeus scriverà le sue istruzioni/)).toBeTruthy());
    await waitFor(() => expect(r.getByText(/Stima: circa 2200 token/)).toBeTruthy());
    expect(calls.some(([n]) => n === "refinePrompt")).toBe(false);
    fireEvent.click(r.getByRole("button", { name: "Avanti: Zeus scrive le sue istruzioni" }));
    await waitFor(() => expect(r.getByText("I suoi strumenti")).toBeTruthy());
    expect(calls.find(([n]) => n === "refinePrompt")?.[1][0]).toMatchObject({
      goal: "draft",
      target: { draft: { kind: "assistant", mode: "auto" } },
    });
    expect(r.getByText(/2 spenti: circa 420 token risparmiati/)).toBeTruthy();
    const blender = r.getByRole("switch", { name: "Blender (3D)" });
    expect(blender.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(blender);
    expect(r.getByText(/1 spenti: circa 120 token/)).toBeTruthy();
    const field = r.getByRole("textbox", { name: "Le sue istruzioni" }) as HTMLTextAreaElement;
    expect(field.value).toBe("You are Mail. Your job: emails. Ask Zeus.");
    fireEvent.input(field, { target: { value: "You are Mail. Short answers." } });
    fireEvent.click(r.getByRole("button", { name: "Crea l'agente" }));
    await waitFor(() => expect(calls.some(([n]) => n === "setAgentTools")).toBe(true));
    expect(calls.find(([n]) => n === "setAgentPrompt")?.[1]).toEqual([
      "new1",
      "You are Mail. Short answers.",
    ]);
    expect(calls.find(([n]) => n === "setAgentTools")?.[1]).toEqual([
      "new1",
      { image_generation: "off" },
    ]);
    expect(r.container.querySelector(CHECK)).toBeNull();
  });

  it("falls back to the built-in text when God cannot write them, and says so", async () => {
    failRefine = true;
    const r = render(<AssistantWizard onDone={() => {}} />);
    await waitFor(() => r.getByRole("button", { name: "Avanti: Zeus scrive le sue istruzioni" }));
    fireEvent.click(r.getByRole("button", { name: "Avanti: Zeus scrive le sue istruzioni" }));
    await waitFor(() => expect(r.getByText(/Zeus non è riuscito a scriverle/)).toBeTruthy());
    const field = r.getByRole("textbox", { name: "Le sue istruzioni" }) as HTMLTextAreaElement;
    expect(field.value).toBe("You are Mail, an assistant. Your job: emails");
    expect(r.queryByText("I suoi strumenti")).toBeNull();
  });
});

describe("an agent asks for a switched-off tool (G36.15)", () => {
  it("says who, which and why; this conversation, always, or no", () => {
    const req: PermissionRequestInfo = {
      requestId: "tool_1",
      agentId: "a1",
      agentName: "Ada",
      projectId: null,
      tool: "request_tool",
      input: { tool: "fetch", why: "to read the page" },
      reasons: [],
      danger: [],
      createdAt: new Date().toISOString(),
      sessionId: "s1",
    };
    const r = render(<ToolRequestCard r={req} />);
    expect(r.getByText(/Ada chiede di accendere/)).toBeTruthy();
    expect(r.getByText("Perché: to read the page")).toBeTruthy();
    fireEvent.click(r.getByRole("button", { name: "Accendi per questa conversazione" }));
    fireEvent.click(r.getByRole("button", { name: "Sempre per Ada" }));
    fireEvent.click(r.getByRole("button", { name: "No" }));
    expect(sent).toEqual([
      {
        type: "permission.resolve",
        requestId: "tool_1",
        decision: "allow",
        remember: false,
        scope: "session",
      },
      {
        type: "permission.resolve",
        requestId: "tool_1",
        decision: "allow",
        remember: false,
        scope: "always",
      },
      {
        type: "permission.resolve",
        requestId: "tool_1",
        decision: "deny",
        remember: false,
        scope: "session",
      },
    ]);
  });
});
