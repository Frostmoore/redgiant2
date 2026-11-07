// Chat exports (G36.7), pure: ChatGPT's data export (conversations.json, or conversations-000.json…
// in big exports: a list of conversations, each a tree of messages in `mapping`) and Claude's
// (conversations.json with `chat_messages`, memories.json, projects.json). Neither company
// publishes a schema; the shapes below follow the files themselves (checked 2026-11-07).
//   ChatGPT: {title, create_time, update_time (epoch s), current_node, conversation_id|id,
//            mapping: {id: {parent, children, message: {author: {role}, content: {content_type,
//            parts|text…}, create_time, recipient, metadata}}}}. The branch shown is current_node up
//            to the root; tool calls (recipient ≠ all), hidden nodes and thoughts are left out.
//            `user_editable_context` carries the custom instructions, `model_editable_context`
//            the memory as it was.
//   Claude:  [{uuid, name, created_at, updated_at, chat_messages: [{sender human|assistant,
//            text, content: [{type text|thinking|tool_use|tool_result}], created_at,
//            attachments, files}]}]; memories.json [{conversations_memory, project_memories}];
//            projects.json [{name, prompt_template, docs}].

import type { ImportNote } from "@redgiant/protocol";
import {
  type Candidate,
  type FoundFile,
  type ImportedConversation,
  previewOf,
} from "./import-readers.js";

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const epoch = (v: unknown): string | undefined =>
  typeof v === "number" && Number.isFinite(v) ? new Date(v * 1000).toISOString() : str(v);

/** The words of one ChatGPT message, or undefined when it is not part of the conversation shown. */
function chatgptText(content: Record<string, unknown>): string | undefined {
  switch (content.content_type) {
    case "text":
    case "multimodal_text": {
      const parts = Array.isArray(content.parts) ? content.parts : [];
      const words = parts.flatMap((p) => {
        if (typeof p === "string") return [p];
        const o = record(p);
        if (o.content_type === "image_asset_pointer") return ["[picture]"];
        if (typeof o.text === "string") return [o.text];
        return [];
      });
      return words.join("\n").trim() || undefined;
    }
    case "code": {
      const text = str(content.text);
      return text ? `\`\`\`${str(content.language) ?? ""}\n${text}\n\`\`\`` : undefined;
    }
    default:
      // thoughts, reasoning_recap, execution_output, tether_*, *_editable_context…
      return undefined;
  }
}

export interface ChatRead {
  conversations: ImportedConversation[];
  /** ChatGPT's custom instructions (as found in the conversations), Claude's project prompts. */
  instructions: { from: string; name: string; text: string }[];
  memories: { from: string; text: string }[];
  notes: ImportNote[];
}

/** One ChatGPT conversation: the branch the person last saw, in order. */
export function chatgptConversation(
  c: Record<string, unknown>,
  into: ChatRead,
): ImportedConversation | undefined {
  const mapping = record(c.mapping);
  let at = str(c.current_node);
  if (!at) {
    // No current node: the deepest leaf.
    at = Object.keys(mapping).find(
      (k) => (record(mapping[k]).children as unknown[] | undefined)?.length === 0,
    );
  }
  const chain: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  while (at && !seen.has(at)) {
    seen.add(at);
    const node = record(mapping[at]);
    chain.push(node);
    at = str(node.parent);
  }
  chain.reverse();
  let branched = false;
  const messages: ImportedConversation["messages"] = [];
  let model: string | undefined;
  for (const node of chain) {
    if ((node.children as unknown[] | undefined)?.length && (node.children as unknown[]).length > 1)
      branched = true;
    const m = record(node.message);
    if (!node.message) continue;
    const meta = record(m.metadata);
    const content = record(m.content);
    const role = str(record(m.author).role);
    if (content.content_type === "user_editable_context") {
      const text = [str(content.user_profile), str(content.user_instructions)]
        .filter(Boolean)
        .join("\n\n")
        .trim();
      if (text)
        into.instructions.push({
          from: "conversations.json",
          name: "ChatGPT custom instructions",
          text,
        });
      continue;
    }
    if (content.content_type === "model_editable_context") {
      const text = str(content.model_set_context);
      if (text)
        for (const line of text.split("\n")) {
          const l = line
            .replace(/^\s*(\d+\.|[-*])\s*/, "")
            .replace(/^\[[^\]]*\]\s*[.:-]?\s*/, "")
            .trim();
          if (l) into.memories.push({ from: "conversations.json", text: l });
        }
      continue;
    }
    if (meta.is_visually_hidden_from_conversation === true) continue;
    if (role !== "user" && role !== "assistant") continue;
    if (m.recipient !== undefined && m.recipient !== "all") continue;
    const text = chatgptText(content);
    if (!text) continue;
    if (role === "assistant" && typeof meta.model_slug === "string") model = meta.model_slug;
    const time = epoch(m.create_time);
    const last = messages.at(-1);
    // Two pieces of one answer (a search, then the text) read as one message.
    if (last && last.role === role) last.text = `${last.text}\n\n${text}`;
    else messages.push({ role, text, ...(time && { at: time }) });
  }
  if (messages.length === 0) return undefined;
  if (branched && !into.notes.some((n) => n.code === "branch")) into.notes.push({ code: "branch" });
  const id = str(c.conversation_id) ?? str(c.id);
  const created = epoch(c.create_time);
  const updated = epoch(c.update_time);
  return {
    title: (str(c.title) ?? "").trim() || titleFrom(messages[0]?.text, "ChatGPT"),
    ...(id && { originalId: `chatgpt:${id}` }),
    ...(created && { createdAt: created }),
    ...(updated && { updatedAt: updated }),
    ...(model && { model }),
    messages,
  };
}

/** One Claude conversation: its messages are already a line. */
export function claudeConversation(c: Record<string, unknown>): ImportedConversation | undefined {
  const list = Array.isArray(c.chat_messages) ? c.chat_messages : [];
  const messages: ImportedConversation["messages"] = [];
  for (const raw of list) {
    const m = record(raw);
    const role = m.sender === "human" ? "user" : m.sender === "assistant" ? "assistant" : undefined;
    if (!role) continue;
    const blocks = Array.isArray(m.content) ? m.content.map(record) : [];
    let text = blocks
      .filter((b) => b.type === "text")
      .map((b) => str(b.text) ?? "")
      .join("\n")
      .trim();
    // Artifacts the assistant wrote are part of what the person saw.
    for (const b of blocks)
      if (b.type === "tool_use" && b.name === "artifacts") {
        const input = record(b.input);
        const body = str(input.content);
        if (body)
          text += `\n\n**${str(input.title) ?? "Artifact"}**\n\n\`\`\`${str(input.language) ?? ""}\n${body}\n\`\`\``;
      }
    if (!text) text = (str(m.text) ?? "").trim();
    const attached = (Array.isArray(m.attachments) ? m.attachments : [])
      .map(record)
      .flatMap((a) => {
        const name = str(a.file_name);
        const inner = str(a.extracted_content);
        return name ? [inner ? `[file ${name}]\n${inner.slice(0, 20_000)}` : `[file ${name}]`] : [];
      });
    if (attached.length) text = [text, ...attached].filter(Boolean).join("\n\n");
    if (!text) continue;
    const at = str(m.created_at);
    const last = messages.at(-1);
    if (last && last.role === role) last.text = `${last.text}\n\n${text}`;
    else messages.push({ role, text, ...(at && { at }) });
  }
  if (messages.length === 0) return undefined;
  const id = str(c.uuid);
  const created = str(c.created_at);
  const updated = str(c.updated_at);
  return {
    title: (str(c.name) ?? "").trim() || titleFrom(messages[0]?.text, "Claude"),
    ...(id && { originalId: `claude:${id}` }),
    ...(created && { createdAt: created }),
    ...(updated && { updatedAt: updated }),
    messages,
  };
}

const MAX_CONVERSATIONS = 10_000;

/** A title from the first message's words (no picture marks, one line). */
function titleFrom(text: string | undefined, fallback: string): string {
  const words = (text ?? "")
    .replace(/\[picture\]|\[file [^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return words ? previewOf(words, 60) : fallback;
}

/** The chat exports among `files` (any depth: the export's own folders vary). */
export async function readChatExports(found: FoundFile[]): Promise<{
  candidates: Candidate[];
  unreadable: { from: string; why: string }[];
  /** The paths read here (the agents' readers skip them). */
  used: Set<string>;
}> {
  const candidates: Candidate[] = [];
  const unreadable: { from: string; why: string }[] = [];
  const used = new Set<string>();
  const chatgpt: ChatRead = { conversations: [], instructions: [], memories: [], notes: [] };
  const claude: ChatRead = { conversations: [], instructions: [], memories: [], notes: [] };
  for (const f of found) {
    const name = f.path.split("/").pop() ?? "";
    if (!/^(conversations(-\d+)?|memories|projects)\.json$/.test(name)) continue;
    let doc: unknown;
    try {
      doc = JSON.parse((await f.read()).toString("utf8"));
    } catch (err) {
      unreadable.push({ from: f.path, why: (err as Error).message.slice(0, 200) });
      continue;
    }
    if (!Array.isArray(doc)) continue;
    const first = record(doc[0]);
    if (name.startsWith("conversations")) {
      if ("mapping" in first) {
        used.add(f.path);
        for (const c of doc) {
          if (chatgpt.conversations.length >= MAX_CONVERSATIONS) break;
          const conv = chatgptConversation(record(c), chatgpt);
          if (conv) chatgpt.conversations.push(conv);
        }
      } else if ("chat_messages" in first) {
        used.add(f.path);
        for (const c of doc) {
          if (claude.conversations.length >= MAX_CONVERSATIONS) break;
          const conv = claudeConversation(record(c));
          if (conv) claude.conversations.push(conv);
        }
      }
    } else if (name === "memories.json") {
      used.add(f.path);
      for (const m of doc.map(record)) {
        for (const text of [
          str(m.conversations_memory),
          ...Object.values(record(m.project_memories)).map(str),
        ])
          if (text)
            for (const para of text.split(/\n+/)) {
              const t = para.replace(/^\s*(\*\*[^*]+\*\*\s*)?[-*]?\s*/, "").trim();
              if (t && !/^#/.test(t)) claude.memories.push({ from: f.path, text: t });
            }
      }
    } else if (name === "projects.json" && ("prompt_template" in first || "docs" in first)) {
      used.add(f.path);
      for (const p of doc.map(record)) {
        const text = str(p.prompt_template)?.trim();
        if (text && p.is_starter_project !== true)
          claude.instructions.push({
            from: f.path,
            name: `${str(p.name) ?? "Project"} (Claude project)`,
            text,
          });
      }
    }
  }
  const push = (source: "chatgpt" | "claude", r: ChatRead) => {
    for (const c of r.conversations)
      candidates.push({
        kind: "conversation",
        source,
        from: "conversations.json",
        name: c.title,
        preview: previewOf(c.messages[0]?.text ?? "", 300),
        conversation: {
          messages: c.messages.length,
          ...(c.createdAt && { createdAt: c.createdAt }),
          ...(c.updatedAt && { updatedAt: c.updatedAt }),
          ...(c.model && { model: c.model }),
        },
        notes: [
          { code: "no-attachments" },
          ...(source === "chatgpt" && r.notes.some((n) => n.code === "branch")
            ? [{ code: "branch" as const }]
            : []),
        ],
        data: c,
      });
    const texts = new Set<string>();
    for (const i of r.instructions) {
      if (texts.has(i.text)) continue;
      texts.add(i.text);
      candidates.push({
        kind: "instructions",
        source,
        from: i.from,
        name: i.name,
        preview: previewOf(i.text),
        text: i.text,
        target: "everyone",
        notes: [],
        data: { text: i.text },
      });
    }
    const facts = new Set<string>();
    for (const m of r.memories) {
      const t = m.text.replace(/\s+/g, " ").trim();
      if (t.length < 3 || facts.has(t)) continue;
      facts.add(t);
      const text = t.length > 400 ? `${t.slice(0, 399).trimEnd()}…` : t;
      candidates.push({
        kind: "memory",
        source,
        from: m.from,
        name: previewOf(text, 80),
        preview: text,
        text,
        notes: t.length > 400 ? [{ code: "shortened", arg: "400" }] : [],
        data: { text },
      });
    }
  };
  push("chatgpt", chatgpt);
  push("claude", claude);
  return { candidates, unreadable, used };
}
