// Alerts on Telegram: long or failed turns, budgets near their limit and extensions to review
// reach the phone even with RedGiant closed. Approvals and questions are not here: the Telegram
// gateway sends them itself, with buttons.

export type AlertKind = "turn" | "failed" | "budget" | "proposal";

export interface Alert {
  kind: AlertKind;
  title: string;
  message: string;
}

const TEXTS = {
  en: {
    turn: "{agent} finished",
    turnBody: "After {minutes} min: {text}",
    failed: "{agent} stopped",
    budget: "Budget {name}: {pct}%",
    budgetBody: "${used} of ${limit}",
    proposal: "New extension to review",
    proposalBody: "{kind} {name}, proposed by {author}",
  },
  it: {
    turn: "{agent} ha finito",
    turnBody: "Dopo {minutes} min: {text}",
    failed: "{agent} si è fermato",
    budget: "Budget {name}: {pct}%",
    budgetBody: "${used} su ${limit}",
    proposal: "Nuova estensione da valutare",
    proposalBody: "{kind} {name}, proposta da {author}",
  },
} as const;

export type AlertText = keyof (typeof TEXTS)["en"];

export function alertText(
  lang: "it" | "en",
  key: AlertText,
  vars: Record<string, string | number> = {},
): string {
  return TEXTS[lang][key].replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));
}
