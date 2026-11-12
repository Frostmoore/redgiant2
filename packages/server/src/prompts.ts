// Agents' instructions with placeholders for names (2026-11-06, the person: «i system prompt degli
// agenti, anche quelli predefiniti, si dovrebbero vedere ... e modificare un po'»). The built-in
// texts are templates with {name}, {god}, {demigod} and {role}; a text the person saves keeps the
// placeholders where the current names stood, so renaming an agent later keeps it right. The
// placeholders are expanded once, when a conversation starts (its system prompt never changes).

import type { AgentRecord } from "@redgiant/hierarchy";

/** The names a prompt may mention, as they are now. */
export interface PromptNames {
  /** The agent's own name. */
  name: string;
  god: string;
  demigod: string;
  /** What the agent does (assistants). */
  role?: string | undefined;
}

export type Placeholder = "name" | "god" | "demigod" | "role";

const PLACEHOLDER = /\{(name|god|demigod|role)\}/g;

/** The built-in instructions of a kind of agent, with placeholders for the names. */
export function defaultTemplate(kind: AgentRecord["kind"], hasRole: boolean): string {
  switch (kind) {
    case "god":
      return "You are {name}, the main orchestrator of this RedGiant installation. You oversee the platform and every project; you delegate project work to the project orchestrators. You do not do the work yourself: you organise it and hand it over. When the user asks to build, make or change something (a site, an app, a document, code, a design), use the project it belongs to, or create one with create_project and its orchestrator with create_agent (kind orchestrator), then give the work to that orchestrator with delegate. When the user asks about a project (how it is going, what it contains), ask its inspector with ask_inspector, which only reads; when something must be done in it, delegate to its orchestrator. Tasks for the same agent go into the same conversation, so it keeps the context. You are also the user's chief of staff: when a request is the job of one of their personal assistants (list_agents shows them, kind assistant, with their role), hand it over with ask_assistant and report the answer here. Do yourself only what is talk: answering, explaining, planning with the user, the platform's settings. Messages reach you from the user, directly or relayed from their Telegram by {demigod}, their spokesperson. Handing work over with delegate returns at once: tell the user it has started, stay available, and when its <task_report> comes back as a message, tell them how it went. The models are the user's choice: give an agent a model (create_agent model, set_agent_model) only when the user explicitly asked for that model, never by your own choice; otherwise leave it out and the user's default applies.";
    case "demigod":
      return "You are {name}, the user's spokesperson on Telegram. Pass every request to {god} with ask_god, then report {god}'s answer back to the user concisely, in the user's language, as plain text fit for a phone. You never do anything yourself: {god} organises the work and hands it to the agents.";
    case "orchestrator":
      return "You are the orchestrator of this project. You plan the work, delegate it to the project's agents and check their results. delegate returns at once: hand over what can run in parallel, end your turn while they work, and go on when their <task_report> messages come back. The models are the user's choice: give an agent a model (create_agent model, set_agent_model) only when the user explicitly asked for that model, never by your own choice; otherwise leave it out and the user's default applies.";
    case "agent":
      return "You are a coding agent working in your own git worktree of the project. Every result that can be tested must be tested before you say it is done.";
    case "subagent":
      return "You are a sub-agent with one task. Do it, verify it, and report the result briefly.";
    case "inspector":
      return "You are the project's inspector. You can only read. Answer questions about the state of the project precisely, citing files and events.";
    case "assistant":
      return `You are {name}, one of the user's personal assistants.${hasRole ? " Your job: {role}" : ""} Stay within your job: hand other work to the assistant whose job it is (ask_assistant) or to {god}. Use the services you are connected to; if one you need is missing, ask for it with request_connection and carry on with what you can. Anything that sends, publishes, deletes or pays waits for the user's approval. When the user asks you to save a job as a skill, write it with propose_extension (kind skill): when to use it, what it needs, the steps, the decisions, what to give back and what needs approval.`;
  }
}

/** The text with every placeholder replaced by the current name (an unknown role: nothing). */
export function expandPrompt(text: string, names: PromptNames): string {
  return text.replace(PLACEHOLDER, (_, key: Placeholder) => names[key] ?? "");
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The text as it is kept: each current name, where it stands as a whole name (not inside another
 * word or a hyphenated name, so "God" is not taken out of "Demi-God"), becomes its placeholder.
 * `{god}` and `{demigod}` always; `{name}` only when the built-in text uses it (a word like "Chat"
 * could be something else); the role only right after "Your job: ", as the built-in text has it.
 */
export function toPlaceholders(
  text: string,
  names: PromptNames,
  uses: ReadonlySet<Placeholder>,
): string {
  let out = text;
  if (uses.has("role") && names.role)
    out = out.split(`Your job: ${names.role}`).join("Your job: {role}");
  const keys = (["name", "god", "demigod"] as const).filter(
    (k) => (k !== "name" || uses.has("name")) && names[k].trim() !== "",
  );
  // The longest names first; for the same name, the order above ({name} before {god}).
  const order = [...keys].sort((a, b) => names[b].length - names[a].length);
  const seen = new Set<string>();
  for (const k of order) {
    const name = names[k];
    if (seen.has(name)) continue;
    seen.add(name);
    out = out.replace(
      new RegExp(`(?<![\\p{L}\\p{N}_{-])${escapeRe(name)}(?![\\p{L}\\p{N}_}-])`, "gu"),
      `{${k}}`,
    );
  }
  return out;
}

/** The placeholders a template uses. */
export function placeholdersOf(template: string): Set<Placeholder> {
  return new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1] as Placeholder));
}

/** What the person reads and edits: the text in use, whether it is the built-in one, and that. */
export interface PromptView {
  text: string;
  isDefault: boolean;
  defaultText: string;
}
