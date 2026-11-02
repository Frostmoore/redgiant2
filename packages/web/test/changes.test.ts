import { beforeEach, describe, expect, it } from "vitest";
import type { PlatformChange } from "../src/api.js";
import { describeChange } from "../src/changes.js";
import { monthDays } from "../src/format.js";
import { lang } from "../src/i18n.js";

const names = { agent: (id: string) => `A-${id}`, project: (id: string) => `P-${id}` };
const change = (target: string, before: unknown, after: unknown): PlatformChange => ({
  id: "c1",
  kind: "config",
  change: "raw",
  stage: "promoted",
  target,
  before,
  after,
  detail: null,
  by: "human",
  createdAt: "2026-11-02T10:00:00Z",
  updatedAt: "2026-11-02T10:00:00Z",
});
const say = (target: string, before: unknown, after: unknown) =>
  describeChange(change(target, before, after), names);

describe("the history in sentences", () => {
  beforeEach(() => {
    lang.value = "it";
  });

  it("tells budgets: set, raised, lowered, removed", () => {
    expect(say("budget:global:me", {}, { usd: 1000 })).toEqual([
      "Messo il limite di spesa totale: $1000.00",
    ]);
    expect(say("budget:project:p1", { usd: 5 }, { usd: 20 })).toEqual([
      "Alzato il limite di spesa di P-p1 da $5.00 a $20.00",
    ]);
    expect(say("budget:agent:a1", { usd: 20 }, { usd: 5 })).toEqual([
      "Abbassato il limite di spesa di A-a1 da $20.00 a $5.00",
    ]);
    expect(say("budget:global:me", { usd: 5 }, {})).toEqual([
      "Tolto il limite di spesa totale (era $5.00)",
    ]);
  });

  it("tells agents, policies, automations and services", () => {
    expect(
      say("agent:a1", { mode: "auto" }, { mode: "readonly", model: { provider: "x", model: "m" } }),
    ).toEqual([
      "A-a1 ora pensa con x/m (prima quello predefinito)",
      "A-a1 ora lavora in modo «Solo guarda» (prima «Da solo»)",
    ]);
    const policy = say(
      "policy",
      { rules: [], humanOnly: [], disabledDanger: [] },
      {
        rules: [{ tool: "bash", match: "npm", decision: "deny" }],
        humanOnly: ["git-push"],
        disabledDanger: [],
      },
    );
    expect(policy[0]).toMatch(/^Ora solo tu puoi approvare: /);
    expect(policy[1]).toBe("Regola nuova: bash (npm) non è mai permesso");
    expect(say("automation:x", null, { yaml: "name: nightly\non: {}", enabled: true })).toEqual([
      "Nuova automazione «nightly»",
    ]);
    expect(
      say(
        "automation:x",
        { yaml: "name: nightly", enabled: true },
        { yaml: "name: nightly", enabled: false },
      ),
    ).toEqual(["Messa in pausa l'automazione «nightly»"]);
    expect(
      say("mcp:notion", null, { projectId: "p1", transport: { type: "http", url: "https://x" } }),
    ).toEqual(["Aggiunto Notion (Solo in P-p1)"]);
    expect(say("mcp:notion", { projectId: null, transport: { type: "http" } }, null)).toEqual([
      "Tolto Notion",
    ]);
  });

  it("speaks English too, and falls back to the raw text", () => {
    lang.value = "en";
    expect(say("budget:global:me", { usd: 5 }, { usd: 10 })).toEqual([
      "Raised the total spending limit from $5.00 to $10.00",
    ]);
    expect(say("something:else", null, null)).toEqual(["raw"]);
  });

  it("lists this month's days up to today", () => {
    expect(monthDays(new Date(2026, 10, 3))).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
  });
});
