// G33.5: the interface's language and the agents' are chosen apart. The agents' goes into every
// new conversation's instructions (open ones keep theirs), into the shared memory's learning and
// into the automatic texts when they are translated in it.
import { join } from "node:path";
import {
  AGENT_LANGUAGES,
  agentLanguage,
  replyLanguageLine,
  textLanguage,
} from "@redgiant/protocol";
import type { CompletionRequest } from "@redgiant/providers";
import { afterEach, describe, expect, it } from "vitest";
import { learnPrompt, type SetupHooks, SetupService, type SetupState } from "../src/index.js";
import { startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const hooks: SetupHooks = {
  key: async () => [],
  server: async () => [],
  telegram: async () => null,
  search: async () => {},
  engine: async () => undefined,
} as unknown as SetupHooks;

/** A server with the wizard; `before` is the setup saved by an older version, if any. */
async function withSetup(seen: CompletionRequest[], before?: Record<string, unknown>) {
  let service: SetupService | undefined;
  s = await startServer(
    (req) => {
      seen.push(req);
      return { text: "ok" };
    },
    {},
    {},
    undefined,
    undefined,
    async (core, dir) => {
      if (before)
        await core.db.query(
          `INSERT INTO rg_settings (owner_id, key, value) VALUES ('me', 'setup', $1)`,
          [JSON.stringify(before)],
        );
      service = new SetupService({
        db: core.db,
        core,
        dataDir: join(dir, "data"),
        ownerId: "me",
        hooks,
      });
      await service.applyAtStartup();
      return { setup: service };
    },
  );
  return { server: s, service: service as SetupService };
}

describe("the languages the agents speak (G33.5)", () => {
  it("lists the most spoken languages once, each with its own name and two translations", () => {
    expect(AGENT_LANGUAGES.length).toBeGreaterThanOrEqual(40);
    const codes = AGENT_LANGUAGES.map((l) => l.code.toLowerCase());
    expect(new Set(codes).size).toBe(codes.length);
    for (const l of AGENT_LANGUAGES) {
      expect(l.native && l.en && l.it).toBeTruthy();
      expect(l.code).toMatch(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/);
    }
    for (const c of ["it", "en", "es", "pt-BR", "pt-PT", "zh-Hans", "zh-Hant", "ar", "hi", "sw"])
      expect(agentLanguage(c)?.code).toBe(c);
    expect(agentLanguage("PT-br")?.native).toBe("Português (Brasil)");
    expect(AGENT_LANGUAGES.filter((l) => l.common)[0]?.code).toBe("it");
    expect(agentLanguage("xx")).toBeUndefined();
  });

  it("writes automatic texts in the agents' language when translated, else the interface's", () => {
    expect(textLanguage("es", "it")).toBe("it");
    expect(textLanguage("en", "it")).toBe("en");
    expect(textLanguage("it", "en")).toBe("it");
    expect(textLanguage(undefined, "it")).toBe("it");
    expect(replyLanguageLine("ja")).toMatch(/Reply to the person in Japanese \(日本語\)/);
    expect(replyLanguageLine("xx")).toBe("");
    expect(learnPrompt("Spanish")).toContain("in Spanish, the language the person chose");
    expect(learnPrompt()).toContain("in the language the person uses");
  });

  it("keeps them apart, and puts the agents' one in new conversations only", async () => {
    const seen: CompletionRequest[] = [];
    const { server } = await withSetup(seen);
    const api = server.api;
    await api("PUT", "/api/setup/names", { god: "Zeus", demigod: "Hermes" });
    expect(
      (await api("PUT", "/api/setup/languages", { language: "it", agentLanguage: "es" })).status,
    ).toBe(200);
    const st = (await api<SetupState>("GET", "/api/setup")).body;
    expect(st.config).toMatchObject({ language: "it", agentLanguage: "es" });
    // Telegram has no Spanish: its texts stay in the interface's language.
    expect(server.core.language("me")).toBe("it");
    expect(server.core.uiLanguageOf("me")).toBe("it");

    const god = server.core.registry.list({ ownerId: "me" }).find((a) => a.kind === "god");
    const open = async () =>
      (await api<{ sessionId: string }>("POST", "/api/sessions", { agentId: god?.id })).body
        .sessionId;
    const sid = await open();
    await (await server.core.send("me", sid, "Hola")).done;
    const before = seen.at(-1)?.system ?? "";
    expect(before).toContain("Reply to the person in Spanish (Español)");
    expect(before).toMatch(/^You are Zeus/);

    // Another language: the open conversation keeps its instructions, a new one speaks it.
    await api("PUT", "/api/setup/languages", { agentLanguage: "en" });
    expect(server.core.language("me")).toBe("en");
    await (await server.core.send("me", sid, "Otra vez")).done;
    expect(seen.at(-1)?.system).toBe(before);
    const next = await open();
    await (await server.core.send("me", next, "Hi")).done;
    expect(seen.at(-1)?.system).toContain("Reply to the person in English (English)");
    expect(seen.at(-1)?.system).not.toContain("Spanish");

    // Only the interface's language changes: the agents keep theirs.
    await api("PUT", "/api/setup/languages", { language: "en" });
    expect((await api<SetupState>("GET", "/api/setup")).body.config).toMatchObject({
      language: "en",
      agentLanguage: "en",
    });

    const bad = await api<{ code: string }>("PUT", "/api/setup/languages", {
      agentLanguage: "klingon",
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("unknown_language");
    expect(server.core.agentLanguageOf("me")).toBe("en");
  });

  it("gives the everyday chat and the assistants the same line", async () => {
    const seen: CompletionRequest[] = [];
    const { server } = await withSetup(seen);
    await server.api("PUT", "/api/setup/names", { god: "God", demigod: "Demi-God" });
    await server.api("PUT", "/api/setup/languages", { agentLanguage: "ja" });
    const chat = (await server.api<{ id: string }>("GET", "/api/chat/agent")).body;
    const sid = (
      await server.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: chat.id })
    ).body.sessionId;
    await (await server.core.send("me", sid, "こんにちは")).done;
    expect(seen.at(-1)?.system).toContain("Reply to the person in Japanese (日本語)");
  });

  it("lets an older installation's agents keep the language they spoke", async () => {
    const seen: CompletionRequest[] = [];
    const { server, service } = await withSetup(seen, { completed: true, language: "it" });
    expect(server.core.agentLanguageOf("me")).toBe("it");
    expect((await service.state()).config.agentLanguage).toBe("it");
    const [row] = await server.core.db.query<{ value: unknown }>(
      "SELECT value FROM rg_settings WHERE owner_id = 'me' AND key = 'setup'",
    );
    const saved = (typeof row?.value === "string" ? JSON.parse(row.value) : row?.value) as {
      agentLanguage?: string;
    };
    expect(saved.agentLanguage).toBe("it");
  });
});
