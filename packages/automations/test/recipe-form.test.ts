import { describe, expect, it } from "vitest";
import { parseRecipe } from "../src/index.js";

describe("recipes written by the web form (G24.8)", () => {
  it("reads strings quoted as JSON, accents, quotes and new lines included", () => {
    const r = parseRecipe(
      [
        "name: il-punto-del-mattino-k3x9",
        'description: "Il punto del mattino"',
        "on:",
        '  cron: "0 8 * * 1-5"',
        "  timezone: Europe/Rome",
        "  webhook: false",
        'agent: "orchestrator"',
        'project: "sito"',
        'instructions: "Dimmi cos\'è successo ieri: \\"lavori finiti\\",\\nproblemi aperti."',
        "",
      ].join("\n"),
    );
    expect(r).toMatchObject({
      name: "il-punto-del-mattino-k3x9",
      description: "Il punto del mattino",
      on: { cron: "0 8 * * 1-5", timezone: "Europe/Rome", webhook: false },
      agent: "orchestrator",
      project: "sito",
      instructions: 'Dimmi cos\'è successo ieri: "lavori finiti",\nproblemi aperti.',
    });
  });

  it("reads a reminder for one date", () => {
    const r = parseRecipe(
      'name: reminder-2026-11-04-0900-a1b\ndescription: "Chiamare il commercialista"\non:\n  at: "2026-11-04T09:00"\n  timezone: Europe/Rome\nreminder: "Chiamare il commercialista"\n',
    );
    expect(r.on.at).toBe("2026-11-04T09:00");
    expect(r.reminder).toBe("Chiamare il commercialista");
  });
});
