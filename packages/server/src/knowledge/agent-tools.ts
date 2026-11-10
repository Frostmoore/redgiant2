// The knowledge made by the agents (3.5.3, decision of 2026-11-09 «Gli agenti possono creare tutto
// da sé»): what the person does on the Knowledge page, an agent with the right scope does with its
// tools. knowledge_create makes a collection, knowledge_add_source gives it a folder, a file, a
// project's files or a web page, knowledge_status says what is there and whether the search goes by
// meaning. Who may do what is `canKnowledge` (hierarchy, a table); a folder outside the agent's own
// folders is the guardian's (the person's yes). Mailboxes and conversations stay the person's: they
// need their own consent on the page.

import { homedir } from "node:os";
import { join } from "node:path";
import type { Tool, ToolContext } from "@redgiant/agent";
import { type AgentNode, canKnowledge, type KnowledgeTarget } from "@redgiant/hierarchy";
import {
  type KnowledgeCollection,
  type KnowledgeScope,
  type KnowledgeSource,
  KnowledgeSourceInput,
  meaningOffLine,
} from "@redgiant/protocol";
import { z } from "zod";
import { KnowledgeError, type KnowledgeService } from "./service.js";

export interface KnowledgeToolsHost {
  knowledge(): KnowledgeService | undefined;
  /** The owner's agents (names for a scope given as an agent). */
  agents(): AgentNode[];
  /** The agent's own workspace scope: `platform`, `assistants` or `project:<id>`. */
  scope: string | undefined;
  /** The projects this agent sees in the knowledge (for knowledge_status). */
  projectIds: string[];
  /** Whether a project is archived (2026-11-09): no agent makes or reads anything there. */
  archived?(projectId: string): boolean;
}

const fail = (content: string) => ({ content, isError: true });

/** What a scope is called in a tool's answer. */
function scopeWords(s: KnowledgeScope, agents: AgentNode[]): string {
  if (s.kind === "all") return "every agent";
  if (s.kind === "agent")
    return `only ${agents.find((a) => a.id === s.agentId)?.name ?? s.agentId}`;
  return `the project ${s.projectId}`;
}

function targetOf(s: KnowledgeScope, agents: AgentNode[]): KnowledgeTarget | undefined {
  if (s.kind === "all") return { kind: "all" };
  if (s.kind === "project") return { kind: "project", projectId: s.projectId };
  const a = agents.find((x) => x.id === s.agentId);
  return a ? { kind: "agent", agent: a } : undefined;
}

/** The default «for» of a new collection: God for every agent, an assistant itself, others their project. */
function defaultFor(agent: AgentNode): string {
  if (agent.kind === "god") return "everyone";
  if (agent.kind === "assistant" || !agent.projectId) return "me";
  return "project";
}

const CreateInput = z.object({
  name: z.string().trim().min(1).max(120),
  for: z.string().trim().max(200).optional(),
  description: z.string().trim().max(500).optional(),
});

const AddInput = z.object({
  collection: z.string().trim().min(1).max(200),
  kind: z.enum(["folder", "file", "project", "url"]),
  path: z.string().trim().max(4000).optional(),
  project: z.string().trim().max(200).optional(),
  url: z.string().trim().max(4000).optional(),
  exclude: z.array(z.string().max(200)).max(200).optional(),
});

const StatusInput = z.object({ collection: z.string().trim().max(200).optional() });

/** knowledge_create, knowledge_add_source and knowledge_status for one agent. */
export function knowledgeTools(agent: AgentNode, host: KnowledgeToolsHost): Tool[] {
  const actor = { type: "agent" as const, agent };
  /** A project target says whether the project is archived (the table refuses it then). */
  const marked = (t: KnowledgeTarget): KnowledgeTarget =>
    t.kind === "project" && host.archived?.(t.projectId) ? { ...t, archived: true } : t;
  const service = () => {
    const k = host.knowledge();
    if (!k) throw new KnowledgeError("no_vector", "The knowledge is not running on this server.");
    return k;
  };
  /** A «for» as written by the model: everyone, me, project, a project, an agent. */
  const scopeFor = async (k: KnowledgeService, raw: string): Promise<KnowledgeScope> => {
    const w = raw.trim();
    const low = w.toLowerCase();
    if (["everyone", "all", "every agent", "everybody"].includes(low)) return { kind: "all" };
    if (["me", "myself", "only me", "self"].includes(low))
      return { kind: "agent", agentId: agent.id };
    if (low === "project" || low === "my project") {
      const own = host.scope?.startsWith("project:") ? host.scope.slice(8) : agent.projectId;
      if (!own) throw new KnowledgeError("bad_choice", "You work in no project: say which one.");
      return { kind: "project", projectId: own };
    }
    const named = w
      .replace(/^agent:/i, "")
      .trim()
      .toLowerCase();
    const a = host
      .agents()
      .find((x) => x.id.toLowerCase() === named || x.name.trim().toLowerCase() === named);
    if (a && !/^project:/i.test(w)) return { kind: "agent", agentId: a.id };
    const scope = await k.resolveScope(agent.ownerId, w);
    if (!scope.startsWith("project:"))
      throw new KnowledgeError(
        "bad_choice",
        `"${w}" is a folder, not someone a collection is for: say "everyone", "me", a project or an agent.`,
      );
    return { kind: "project", projectId: scope.slice(8) };
  };
  /** A collection by its id or name, among the owner's. */
  const collectionOf = async (k: KnowledgeService, raw: string): Promise<KnowledgeCollection> => {
    const all = await k.collections(agent.ownerId);
    const w = raw.trim().toLowerCase();
    const c =
      all.find((x) => x.id.toLowerCase() === w) ??
      all.find((x) => x.name.trim().toLowerCase() === w);
    if (!c)
      throw new KnowledgeError(
        "not_found",
        `No collection "${raw}".${all.length ? ` There are: ${all.map((x) => `${x.name} (${x.id})`).join(", ")}.` : " Make one with knowledge_create."}`,
      );
    return c;
  };
  const mayMake = (c: { scope: KnowledgeScope }) => {
    const t = targetOf(c.scope, host.agents());
    return t !== undefined && canKnowledge(actor, "make", marked(t));
  };
  const wrap =
    <I>(run: (k: KnowledgeService, i: I, ctx: ToolContext) => Promise<string>) =>
    async (i: I, ctx: ToolContext) => {
      try {
        return await run(service(), i, ctx);
      } catch (err) {
        if (err instanceof KnowledgeError) return fail(err.message);
        if (err instanceof z.ZodError)
          return fail(err.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; "));
        throw err;
      }
    };

  const create: Tool = {
    def: {
      name: "knowledge_create",
      description:
        "Make a knowledge collection (documents the agents search with search_knowledge), as the person does in Settings > Knowledge. Then give it sources with knowledge_add_source.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          for: {
            type: "string",
            description: `Who searches it: "everyone", "me", "project" (yours), a project's name or id, or an agent's name. Default: ${defaultFor(agent)}`,
          },
          description: { type: "string", description: "What it holds, in a line" },
        },
        required: ["name"],
      },
    },
    schema: CreateInput,
    run: wrap(async (k, i: z.infer<typeof CreateInput>) => {
      const scope = await scopeFor(k, i.for ?? defaultFor(agent));
      const agents = host.agents();
      const target = targetOf(scope, agents);
      if (!target || !canKnowledge(actor, "make", marked(target)))
        throw new KnowledgeError(
          "forbidden",
          `You cannot make a collection for ${scopeWords(scope, agents)}. ${agent.kind === "god" ? "" : `You can make one for "me"${agent.projectId ? ' or "project"' : ""}.`}`.trim(),
        );
      const same = (await k.collections(agent.ownerId)).find(
        (c) => c.name.trim().toLowerCase() === i.name.trim().toLowerCase(),
      );
      if (same)
        return `A collection «${same.name}» (${same.id}) is there already, for ${scopeWords(same.scope, agents)}, with ${same.documents} documents: add sources to it with knowledge_add_source, or choose another name.`;
      const made = await k.createCollection(
        agent.ownerId,
        { name: i.name, scope, ...(i.description && { description: i.description }) },
        agent.id,
      );
      return `Made the collection «${made.name}» (${made.id}) for ${scopeWords(made.scope, agents)}. Give it sources with knowledge_add_source (a folder, a file, a project's files or a web page); the person sees it in Settings > Knowledge.`;
    }),
  } as Tool;

  const add: Tool = {
    def: {
      name: "knowledge_add_source",
      description:
        'Give a knowledge collection a source to read and keep up to date: kind "project" (a project\'s files, by its name or id; path inside it), "folder" or "file" (a path: relative to your folder, or full; outside your folders the person is asked), or "url" (a web page).',
      inputSchema: {
        type: "object",
        properties: {
          collection: { type: "string", description: "Its name or id" },
          kind: { type: "string", enum: ["project", "folder", "file", "url"] },
          path: { type: "string" },
          project: { type: "string", description: "kind project: its name or id (default yours)" },
          url: { type: "string" },
          exclude: {
            type: "array",
            items: { type: "string" },
            description: ".gitignore-style patterns left out",
          },
        },
        required: ["collection", "kind"],
      },
    },
    schema: AddInput,
    run: wrap(async (k, i: z.infer<typeof AddInput>) => {
      const c = await collectionOf(k, i.collection);
      if (!mayMake(c))
        throw new KnowledgeError(
          "forbidden",
          `«${c.name}» is for ${scopeWords(c.scope, host.agents())}: you cannot add sources to it. Ask the person, or make a collection of your own with knowledge_create.`,
        );
      let spec: Record<string, unknown>;
      if (i.kind === "url") {
        if (!i.url) throw new KnowledgeError("bad_source", 'Give the page\'s address in "url".');
        spec = { kind: "url", url: i.url };
      } else if (i.kind === "project") {
        const raw = i.project ?? (host.scope?.startsWith("project:") ? host.scope : undefined);
        if (!raw)
          throw new KnowledgeError(
            "bad_source",
            'Say which project in "project" (its name or id).',
          );
        spec = {
          kind: "workspace",
          scope: raw,
          path: i.path?.trim() || ".",
          ...(i.exclude && { exclude: i.exclude }),
        };
      } else {
        if (!i.path) throw new KnowledgeError("bad_source", `Give the ${i.kind}'s path in "path".`);
        // ~ is the person's home, as in a shell (the guardian reads it the same way).
        const path = /^~([\\/]|$)/.test(i.path) ? join(homedir(), i.path.slice(1)) : i.path;
        const relative = !/^([a-zA-Z]:[\\/]|[\\/])/.test(path);
        if (relative && !host.scope)
          throw new KnowledgeError(
            "bad_source",
            "You have no folder of your own: give a full path.",
          );
        spec = relative
          ? i.kind === "folder"
            ? {
                kind: "workspace",
                scope: host.scope,
                path,
                ...(i.exclude && { exclude: i.exclude }),
              }
            : { kind: "file", scope: host.scope, path }
          : i.kind === "folder"
            ? { kind: "folder", path, ...(i.exclude && { exclude: i.exclude }) }
            : { kind: "file", path };
      }
      // The place whose files it reads: the table says whose an agent may read.
      const exact = await k.normalizeSource(agent.ownerId, KnowledgeSourceInput.parse(spec));
      const scope = "scope" in exact && typeof exact.scope === "string" ? exact.scope : undefined;
      if (scope) {
        const target: KnowledgeTarget =
          scope === "platform" || scope === "assistants"
            ? { kind: scope }
            : { kind: "project", projectId: scope.slice(8) };
        if (!canKnowledge(actor, "source", marked(target)))
          throw new KnowledgeError(
            "forbidden",
            `You cannot read ${scope === "platform" ? "God's folder" : scope === "assistants" ? "the assistants' desk" : `the project ${scope.slice(8)}`} into the knowledge: only your own ${agent.kind === "assistant" ? "desk" : "project"}'s files.`,
          );
      }
      const source = await k.addSource(agent.ownerId, c.id, exact, agent.id);
      return `Added ${sourceWords(source.spec)} to «${c.name}»: it is being read now. knowledge_status tells when it is ready and what was left out.`;
    }),
  } as Tool;

  const status: Tool = {
    def: {
      name: "knowledge_status",
      description:
        "The knowledge's state: the collections you may search or add to, their sources and documents, and whether the search goes by meaning. With collection: its sources and what was left out.",
      inputSchema: {
        type: "object",
        properties: { collection: { type: "string", description: "A name or id" } },
      },
    },
    schema: StatusInput,
    run: wrap(async (k, i: z.infer<typeof StatusInput>) => {
      const owner = agent.ownerId;
      const st = await k.status(owner);
      const agents = host.agents();
      const visible = new Set(
        (
          await k.visible(owner, {
            kind: "agent",
            agentId: agent.id,
            projectIds: host.projectIds,
            agentKind: agent.kind,
          })
        ).map((c) => c.id),
      );
      const mine = (await k.collections(owner)).filter((c) => visible.has(c.id) || mayMake(c));
      const lines: string[] = [];
      lines.push(st.meaning.on ? "Search: by meaning and words." : meaningOffLine(st.meaning));
      if (st.queue.documents > 0)
        lines.push(
          `Reading now: ${st.queue.documents} documents wait${st.queue.paused ? " (paused by the person)" : ""}.`,
        );
      if (i.collection) {
        const c = await collectionOf(k, i.collection);
        if (!mine.some((x) => x.id === c.id))
          throw new KnowledgeError("forbidden", `«${c.name}» is not one of yours.`);
        lines.push(
          `«${c.name}» (${c.id}), for ${scopeWords(c.scope, agents)}: ${c.documents} documents, ${c.chunks} pieces${visible.has(c.id) ? "" : " (you add to it, but do not search it)"}.`,
        );
        const sources = await k.sources(owner, c.id);
        if (!sources.length) lines.push("No sources yet: add one with knowledge_add_source.");
        for (const s of sources)
          lines.push(
            `- ${sourceWords(s.spec)}: ${s.state}, ${s.documents} documents${s.error ? ` (${s.error})` : ""}`,
          );
        const left = [
          ...(await k.documents(owner, c.id, { state: "failed", limit: 10 })),
          ...(await k.documents(owner, c.id, { state: "skipped", limit: 10 })),
        ];
        if (left.length)
          lines.push(
            `Left out: ${left.map((d) => `${d.path} (${d.state}${d.reason ? `: ${d.reason}` : ""})`).join("; ")}`,
          );
        return lines.join("\n");
      }
      if (!mine.length) lines.push("No collection is yours yet: make one with knowledge_create.");
      for (const c of mine)
        lines.push(
          `- «${c.name}» (${c.id}), for ${scopeWords(c.scope, agents)}: ${c.documents} documents, ${c.chunks} pieces${visible.has(c.id) ? "" : " (you add to it, but do not search it)"}`,
        );
      return lines.join("\n");
    }),
  } as Tool;

  return [create, add, status];
}

/** A source in a line. */
function sourceWords(s: KnowledgeSource["spec"]): string {
  switch (s.kind) {
    case "folder":
      return `the folder ${s.path}`;
    case "file":
      return s.scope ? `the file ${s.path} (${s.scope})` : `the file ${s.path}`;
    case "workspace":
      return `the files of ${s.scope}${s.path && s.path !== "." ? `/${s.path}` : ""}`;
    case "url":
      return `the page ${s.url}`;
    case "mail":
      return `the mailbox ${s.mailbox}`;
    default:
      return "the conversations";
  }
}
