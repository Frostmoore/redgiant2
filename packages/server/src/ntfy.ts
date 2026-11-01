// Push notifications through ntfy (G20.4): what waits for the human, long or failed turns,
// budgets near their limit, proposals and automations reach the phone even with RedGiant closed.
// ntfy.sh or a self-hosted server; the topic is the last part of the URL.

export interface NtfyConfig {
  /** The topic's URL, e.g. https://ntfy.sh/my-secret-topic */
  url: string;
  /** An access token for protected topics. */
  token?: string;
}

export type NotificationKind =
  | "approval"
  | "question"
  | "turn"
  | "failed"
  | "budget"
  | "proposal"
  | "automation"
  | "message"
  | "test";

export interface Notification {
  kind: NotificationKind;
  title: string;
  message: string;
  /** Opens this address when the notification is tapped. */
  click?: string;
}

/** ntfy priorities: 4 (high) for what blocks an agent, 3 (default) for the rest. */
const PRIORITY: Record<NotificationKind, number> = {
  approval: 4,
  question: 4,
  failed: 4,
  budget: 4,
  turn: 3,
  proposal: 3,
  automation: 3,
  message: 3,
  test: 3,
};

/** Tags are shown as small labels (ntfy turns some into emoji: we use plain words). */
const TAG: Record<NotificationKind, string> = {
  approval: "approval",
  question: "question",
  failed: "failed",
  budget: "budget",
  turn: "done",
  proposal: "proposal",
  automation: "automation",
  message: "redgiant",
  test: "test",
};

export class NtfyError extends Error {}

/** Publishes one notification as JSON (UTF-8 safe, unlike headers). */
export async function publishNtfy(
  cfg: NtfyConfig,
  n: Notification,
  f: typeof fetch = fetch,
): Promise<void> {
  const url = new URL(cfg.url);
  const topic = url.pathname.split("/").filter(Boolean).pop();
  if (!topic) throw new NtfyError("The ntfy URL needs a topic: https://ntfy.sh/<topic>");
  const base = `${url.origin}${url.pathname.slice(0, url.pathname.lastIndexOf("/")) || ""}/`;
  let r: Response;
  try {
    r = await f(base, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cfg.token && { authorization: `Bearer ${cfg.token}` }),
      },
      body: JSON.stringify({
        topic,
        title: n.title.slice(0, 200),
        message: n.message.slice(0, 3500) || n.title,
        priority: PRIORITY[n.kind],
        tags: [TAG[n.kind]],
        ...(n.click && { click: n.click }),
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new NtfyError(`ntfy is unreachable: ${(err as Error).message}`);
  }
  if (!r.ok)
    throw new NtfyError(
      r.status === 401 || r.status === 403
        ? "ntfy refused the token"
        : `ntfy answered ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`,
    );
}

const TEXTS = {
  en: {
    approval: "Approval needed",
    approvalBody: "{agent} wants to use {tool}",
    question: "{agent} asks",
    plan: "{agent} proposes a plan",
    turn: "{agent} finished",
    turnBody: "After {minutes} min: {text}",
    failed: "{agent} stopped",
    budget: "Budget {name}: {pct}%",
    budgetBody: "${used} of ${limit}",
    proposal: "New extension to review",
    proposalBody: "{kind} {name}, proposed by {author}",
    test: "RedGiant",
    testBody: "Notifications work.",
  },
  it: {
    approval: "Serve un'approvazione",
    approvalBody: "{agent} vuole usare {tool}",
    question: "{agent} chiede",
    plan: "{agent} propone un piano",
    turn: "{agent} ha finito",
    turnBody: "Dopo {minutes} min: {text}",
    failed: "{agent} si è fermato",
    budget: "Budget {name}: {pct}%",
    budgetBody: "${used} su ${limit}",
    proposal: "Nuova estensione da valutare",
    proposalBody: "{kind} {name}, proposta da {author}",
    test: "RedGiant",
    testBody: "Le notifiche funzionano.",
  },
} as const;

export type NtfyText = keyof (typeof TEXTS)["en"];

export function ntfyText(
  lang: "it" | "en",
  key: NtfyText,
  vars: Record<string, string | number> = {},
): string {
  return TEXTS[lang][key].replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));
}
