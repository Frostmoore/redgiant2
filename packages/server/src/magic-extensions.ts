// Magic integrations and magic extensions (G38.3). The same flow as the magic automations
// (magic.ts): the person writes what they want, a conversation with God starts with the task in its
// system prompt, God asks and proposes one package with `propose_magic_extension` (a manifest, the
// tools' code and tests, the skills). Every part goes through the one extension builder: tested in
// a throwaway sandbox whose only way out is the keychain's routes (each credential to its own
// hosts), then waiting. The page shows the tests and what is missing (a credential, a failing
// test, a host not declared) and keeps «Approve and install» off until nothing is; the person adds
// the credentials there (keychain entries used by this package, given only to its tools). Only the
// person's yes installs, through `ExtensionBuilder.decide`; updates come back through the same
// conversation; uninstalling removes the tools, skills and the keys added for them.
import { randomUUID } from "node:crypto";
import type { Tool } from "@redgiant/agent";
import type { SqlClient } from "@redgiant/events";
import type { ExtensionBuilder, Proposal } from "@redgiant/extensions";
import {
  type MagicCheck,
  type MagicCredential,
  type MagicExtension,
  type MagicExtKind,
  MagicManifest,
  type MagicPart,
  magicChecks,
} from "@redgiant/protocol";
import type { z } from "zod";
import { magicTitle } from "./magic.js";
import type { Vault } from "./vault.js";
import { blankPastedSecrets } from "./vault.js";

export class MagicExtNotFoundError extends Error {}
export class MagicExtStateError extends Error {}

/** What the magic extensions need from the core. */
export interface MagicExtHost {
  /** The person's God, if there is one. */
  god(ownerId: string): { id: string } | undefined;
  /** A new conversation of an agent; `before` runs once its id exists, before it is built. */
  startSession(
    ownerId: string,
    agentId: string,
    before: (sessionId: string) => Promise<void>,
  ): Promise<string>;
  /** Gives the conversation a message from the person (not waiting for the answer). */
  send(ownerId: string, sessionId: string, text: string): Promise<void>;
  /** The keychain's proxy addresses a tool's tests get (only credentials given to it). */
  toolEnv(
    ownerId: string,
    agentId: string,
    sessionId: string,
    tool: string,
  ): Promise<Record<string, string>>;
  /** The tools and skills installed for every project, by name. */
  installed(ownerId: string): Promise<Set<string>>;
  /** The page is told something changed. */
  changed(ownerId: string, id: string): void;
}

type Manifest = z.output<typeof MagicManifest>;
type InstalledPart = { kind: "tool" | "skill"; name: string };

interface Row {
  id: string;
  owner_id: string;
  kind: MagicExtKind;
  title: string;
  request: string;
  session_id: string;
  agent_id: string;
  status: MagicExtension["status"];
  manifest: Manifest | string | null;
  proposal_ids: string[] | string;
  installed: InstalledPart[] | string;
  proposed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const json = <T>(v: T | string): T => (typeof v === "string" ? (JSON.parse(v) as T) : v);
const iso = (d: Date | string) => new Date(d).toISOString();

/** The keychain key of a credential added for a package (`usedBy`, G36.20). */
const keyOf = (id: string, name: string) => `magic:${id}:${name}`;

export async function migrateMagicExtensions(db: SqlClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS rg_magic_extensions (
      id            text PRIMARY KEY,
      owner_id      text NOT NULL,
      kind          text NOT NULL,
      title         text NOT NULL,
      request       text NOT NULL,
      session_id    text NOT NULL UNIQUE,
      agent_id      text NOT NULL,
      status        text NOT NULL DEFAULT 'building',
      manifest      jsonb,
      proposal_ids  jsonb NOT NULL DEFAULT '[]',
      installed     jsonb NOT NULL DEFAULT '[]',
      proposed_at   timestamptz,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now()
    )`);
}

/** What God reads, in the system prompt of a magic integration's or extension's conversation. */
export const MAGIC_EXT_PROMPT = `## This conversation builds an integration or an extension (magic)
The person pressed "Magic integration" or "Magic extension" in the Extensions page and wrote what they want: a connection to a service (its API) or new abilities for the agents. Your job is one working package of RedGiant: tools (and skills when they help), tested, that the person installs with one button.
1. Understand what they want. Ask short, simple questions (ask_user) only for what you cannot sensibly choose yourself (which account, which operations they need). Write to them in their language, in plain words.
2. Find out how the service's API works (web_search, fetch of its documentation) when you do not know it.
3. Propose the whole package with propose_magic_extension: name, title and summary for the person, hosts (every host the code reaches, nothing else is reachable), credentials (name in lower case with dashes or underscores such as notion_api, service, hosts, the header and format the API wants such as Authorization "Bearer {value}", why, and help: where the person gets the key), tools and skills. Do not use propose_extension here.
4. A tool is a command run in its folder with the path of a JSON file of arguments as last argument; it prints the result, exits non-zero on an error. Prefer node (.mjs, fetch built in) or python3 with the standard library; no packages to install. Name tools <package>-<operation> (notion-search, notion-create-page), each with a clear description and input_schema, and at least one test {input, expectExitCode, expectStdoutContains}.
5. Secrets never go in this chat, in a file, in a test or in an environment. A tool reaches the API only through the keychain: it reads REDGIANT_VAULT_<NAME> (the proxy's address for the credential, e.g. REDGIANT_VAULT_NOTION_API) and calls $REDGIANT_VAULT_<NAME>/<host>/<path>; the proxy adds the key (or puts it where a header says {{vault:<name>}}) and takes it only to the credential's hosts. Tests run in a throwaway sandbox whose only way out is that proxy, with the credentials the person has added: until then the tests that need one fail, and the page asks the person to add it ("Add to the keychain" there; never here).
6. The page shows the person every test, what is missing and the button "Approve and install", off until nothing is missing. When a test fails, read why, fix the code and propose again (the same names). When the person rejects, ask what to change and propose again. Nothing is installed before their yes; you never install anything yourself.
7. Later the person may ask for changes here: propose the changed package again with the same names; it replaces the installed one only when they approve.`;

const toText = (p: Proposal) =>
  p.input.kind === "tool"
    ? { description: p.input.spec.description, command: p.input.spec.command }
    : { description: p.input.description, command: undefined };

export class MagicExtensions {
  /** Packages whose tests run again now (one run each at a time). */
  private readonly testing = new Map<string, Promise<void>>();

  constructor(
    private readonly o: {
      db: SqlClient;
      builder: ExtensionBuilder;
      vault: Vault;
      host: MagicExtHost;
    },
  ) {}

  private async row(ownerId: string, id: string): Promise<Row> {
    const [r] = await this.o.db.query<Row>(
      "SELECT * FROM rg_magic_extensions WHERE id = $1 AND owner_id = $2",
      [id, ownerId],
    );
    if (!r) throw new MagicExtNotFoundError(`Magic extension "${id}" not found`);
    return r;
  }

  /** The tool names of a manifest (the credentials are given to them). */
  private static toolNames(m: Manifest): string[] {
    return m.tools.map((t) => t.name);
  }

  /** A credential as the package wants it: its hosts default to the package's. */
  private static credential(m: Manifest, c: MagicCredential): MagicCredential {
    return { ...c, hosts: c.hosts.length ? c.hosts : m.hosts };
  }

  private async view(r: Row): Promise<MagicExtension> {
    const manifest = r.manifest ? json<Manifest>(r.manifest) : null;
    const ids = json<string[]>(r.proposal_ids);
    const installed = json<InstalledPart[]>(r.installed);
    let proposal: MagicExtension["proposal"] = null;
    let checks: MagicCheck[] = [];
    let canApprove = false;
    if (manifest && (r.status === "ready" || r.status === "testing" || r.status === "done")) {
      const parts: MagicPart[] = [];
      for (const pid of ids) {
        const p = await this.o.builder.get(r.owner_id, pid);
        if (!p) continue;
        const { description, command } = toText(p);
        parts.push({
          kind: p.kind,
          name: p.name,
          description,
          ...(p.input.kind === "tool" && { inputSchema: p.input.spec.inputSchema }),
          ...(command && { command }),
          files: p.input.files,
          proposalId: p.id,
          status: p.status,
          tests: p.report,
        });
      }
      proposal = {
        name: manifest.name,
        title: manifest.title,
        summary: manifest.summary,
        hosts: manifest.hosts,
        credentials: manifest.credentials.map((c) => MagicExtensions.credential(manifest, c)),
        parts,
        at: r.proposed_at ? iso(r.proposed_at) : iso(r.updated_at),
      };
      const tools = MagicExtensions.toolNames(manifest);
      const state = (name: string) => {
        const e = this.o.vault.entryState(r.owner_id, name);
        return {
          exists: e !== undefined,
          bound: e !== undefined && tools.every((t) => e.tools.includes(t)),
          hosts: e?.hosts ?? [],
        };
      };
      if (r.status !== "done") {
        const c = magicChecks(proposal, state);
        checks = c.checks;
        canApprove = r.status === "ready" && c.canApprove;
      }
    }
    return {
      id: r.id,
      kind: r.kind,
      title: r.title,
      request: r.request,
      sessionId: r.session_id,
      agentId: r.agent_id,
      status: r.status,
      proposal,
      checks,
      canApprove,
      installed: installed.map((x) => x.name),
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
    };
  }

  async list(ownerId: string): Promise<MagicExtension[]> {
    const rows = await this.o.db.query<Row>(
      "SELECT * FROM rg_magic_extensions WHERE owner_id = $1 AND status <> 'dismissed' ORDER BY created_at DESC",
      [ownerId],
    );
    return Promise.all(rows.map((r) => this.view(r)));
  }

  async get(ownerId: string, id: string): Promise<MagicExtension> {
    return this.view(await this.row(ownerId, id));
  }

  /** The package a conversation builds, if it is one. */
  async forSession(sessionId: string): Promise<{ id: string; agentId: string } | undefined> {
    const [r] = await this.o.db.query<Row>(
      "SELECT * FROM rg_magic_extensions WHERE session_id = $1",
      [sessionId],
    );
    return r ? { id: r.id, agentId: r.agent_id } : undefined;
  }

  /** A new magic integration or extension: God's conversation starts with what the person asked. */
  async create(ownerId: string, kind: MagicExtKind, request: string): Promise<MagicExtension> {
    // A pasted secret never reaches God nor the list (G33.4).
    const text = blankPastedSecrets(request.trim());
    if (!text) throw new MagicExtStateError("Write what you want");
    const god = this.o.host.god(ownerId);
    if (!god) throw new MagicExtStateError("There is no God yet: finish the setup first");
    const id = `magicx_${randomUUID().slice(0, 12)}`;
    const sessionId = await this.o.host.startSession(ownerId, god.id, async (sid) => {
      await this.o.db.query(
        `INSERT INTO rg_magic_extensions (id, owner_id, kind, title, request, session_id, agent_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, ownerId, kind, magicTitle(text), text, sid, god.id],
      );
    });
    await this.o.host.send(
      ownerId,
      sessionId,
      kind === "integration" ? `Magic integration: ${text}` : `Magic extension: ${text}`,
    );
    this.o.host.changed(ownerId, id);
    return this.get(ownerId, id);
  }

  /** Every part through the builder: tested in a throwaway sandbox, then waiting. */
  private async build(r: Row, m: Manifest): Promise<{ ids: string[]; errors: string[] }> {
    const ids: string[] = [];
    const errors: string[] = [];
    const env = (tool: string) =>
      this.o.host.toolEnv(r.owner_id, r.agent_id, r.session_id, tool).catch(() => ({}));
    const add = async (input: unknown, name: string) => {
      try {
        const p = await this.o.builder.propose({
          ownerId: r.owner_id,
          projectId: null,
          author: r.agent_id,
          input: input as never,
          // Never by itself: the whole package waits for the person's one yes.
          autoInstall: false,
          testEnv: env,
          routesOnly: true,
        });
        ids.push(p.id);
      } catch (err) {
        const issues = (err as { issues?: { path: (string | number)[]; message: string }[] })
          .issues;
        errors.push(
          `${name}: ${issues ? issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ") : (err as Error).message}`,
        );
      }
    };
    for (const t of m.tools)
      await add(
        {
          kind: "tool",
          spec: {
            name: t.name,
            description: t.description,
            inputSchema: t.input_schema,
            command: t.command,
          },
          files: t.files,
          tests: t.tests,
        },
        t.name,
      );
    for (const k of m.skills)
      await add(
        {
          kind: "skill",
          name: k.name,
          description: k.description,
          body: k.body,
          files: k.files,
          tests: k.tests,
          ...(k.untestable_reason && { untestableReason: k.untestable_reason }),
        },
        k.name,
      );
    return { ids, errors };
  }

  /** The proposals still waiting of a package are put aside (a newer one takes their place). */
  private async putAside(r: Row, by: string): Promise<void> {
    for (const pid of json<string[]>(r.proposal_ids)) {
      const p = await this.o.builder.get(r.owner_id, pid);
      if (p?.status === "pending")
        await this.o.builder.decide(r.owner_id, pid, "reject", by).catch(() => {});
    }
  }

  /**
   * God's proposal (`propose_magic_extension`): checked, every part tested, kept for the person's
   * preview. Nothing is installed here.
   */
  async propose(ownerId: string, sessionId: string, raw: unknown): Promise<MagicExtension> {
    const m = MagicManifest.parse(raw);
    if (m.tools.length + m.skills.length === 0)
      throw new MagicExtStateError("The package has no tool and no skill");
    const [r] = await this.o.db.query<Row>(
      "SELECT * FROM rg_magic_extensions WHERE session_id = $1 AND owner_id = $2",
      [sessionId, ownerId],
    );
    if (!r || r.status === "dismissed")
      throw new MagicExtStateError(
        "This conversation is not a magic integration: use propose_extension",
      );
    if (r.status === "testing")
      throw new MagicExtStateError("The tests are running again: wait for them, then propose");
    const names = [...m.tools.map((t) => t.name), ...m.skills.map((k) => k.name)];
    const twice = names.filter((n, i) => names.indexOf(n) !== i);
    if (twice.length) throw new MagicExtStateError(`Two parts are called ${twice[0]}`);
    // Its own names may be replaced (an update); anything else installed keeps its name.
    const mine = new Set(json<InstalledPart[]>(r.installed).map((x) => x.name));
    const taken = [...(await this.o.host.installed(ownerId))].filter(
      (n) => names.includes(n) && !mine.has(n),
    );
    if (taken.length)
      throw new MagicExtStateError(
        `Already installed: ${taken.join(", ")}. Choose other names (start them with the package's name).`,
      );
    for (const c of m.credentials)
      if (m.credentials.filter((x) => x.name === c.name).length > 1)
        throw new MagicExtStateError(`The credential ${c.name} is listed twice`);
    const { ids, errors } = await this.build(r, m);
    if (errors.length) {
      // Nothing half-proposed: the parts that passed wait no longer either.
      await this.putAside({ ...r, proposal_ids: ids }, `superseded:${r.id}`);
      throw new MagicExtStateError(`Not proposed: ${errors.join(" | ")}`);
    }
    // The earlier proposal stops waiting only once this one stands.
    await this.putAside(r, `superseded:${r.id}`);
    await this.o.db.query(
      `UPDATE rg_magic_extensions SET status = 'ready', manifest = $2::jsonb, proposal_ids = $3::jsonb,
         title = $4, proposed_at = now(), updated_at = now() WHERE id = $1`,
      [r.id, JSON.stringify(m), JSON.stringify(ids), m.title],
    );
    this.o.host.changed(ownerId, r.id);
    return this.get(ownerId, r.id);
  }

  /**
   * The tests again with what the person added meanwhile (a credential): the same parts, new
   * proposals, in the background (the page follows `testing`).
   */
  async retest(ownerId: string, id: string): Promise<MagicExtension> {
    const r = await this.row(ownerId, id);
    if (r.status !== "ready" || !r.manifest)
      throw new MagicExtStateError("There is no proposal to test again");
    if (this.testing.has(id)) return this.get(ownerId, id);
    await this.o.db.query(
      "UPDATE rg_magic_extensions SET status = 'testing', updated_at = now() WHERE id = $1",
      [id],
    );
    this.o.host.changed(ownerId, id);
    const run = (async () => {
      const m = json<Manifest>(r.manifest as Manifest | string);
      await this.putAside(r, `superseded:${r.id}`);
      const { ids } = await this.build(r, m);
      await this.o.db.query(
        "UPDATE rg_magic_extensions SET status = 'ready', proposal_ids = $2::jsonb, updated_at = now() WHERE id = $1 AND status = 'testing'",
        [id, JSON.stringify(ids)],
      );
    })()
      .catch(async () => {
        await this.o.db
          .query(
            "UPDATE rg_magic_extensions SET status = 'ready', updated_at = now() WHERE id = $1 AND status = 'testing'",
            [id],
          )
          .catch(() => {});
      })
      .finally(() => {
        this.testing.delete(id);
        this.o.host.changed(ownerId, id);
      });
    this.testing.set(id, run);
    return this.get(ownerId, id);
  }

  /** For tests and the server's stop: the background tests, finished. */
  async settled(id: string): Promise<void> {
    await this.testing.get(id);
  }

  private async manifestOf(ownerId: string, id: string) {
    const r = await this.row(ownerId, id);
    if (!r.manifest || (r.status !== "ready" && r.status !== "testing"))
      throw new MagicExtStateError("There is no proposal yet");
    return { r, m: json<Manifest>(r.manifest) };
  }

  /**
   * The person adds a credential the package needs, from its page (G36.20): a keychain entry used
   * by this package, given only to its tools and only towards its hosts. Then the tests run again.
   */
  async addCredential(
    ownerId: string,
    id: string,
    name: string,
    value: string,
  ): Promise<MagicExtension> {
    const { r, m } = await this.manifestOf(ownerId, id);
    const c = m.credentials.find((x) => x.name === name);
    if (!c) throw new MagicExtStateError(`The package does not need a credential "${name}"`);
    if (!value.trim()) throw new MagicExtStateError("The credential needs its value");
    if (this.o.vault.has(ownerId, name))
      throw new MagicExtStateError(
        `"${name}" is already in the keychain: give it to these tools instead`,
      );
    const cred = MagicExtensions.credential(m, c);
    await this.o.vault.setSystem(ownerId, keyOf(r.id, name), value.trim(), {
      name,
      service: c.service,
      category: "api",
      hosts: cred.hosts,
      inject: { header: c.header, format: c.format },
      section: "extensions",
      kind: "other",
      what: `Used by ${m.title} (${MagicExtensions.toolNames(m).join(", ")})`,
      allowTools: MagicExtensions.toolNames(m),
      // Only its tools, only its hosts, chosen by the person here: no question at every run.
      ask: "never",
    });
    return this.retest(ownerId, id);
  }

  /** The person gives a credential already in the keychain to the package's tools. */
  async bindCredential(ownerId: string, id: string, name: string): Promise<MagicExtension> {
    const { m } = await this.manifestOf(ownerId, id);
    const c = m.credentials.find((x) => x.name === name);
    if (!c) throw new MagicExtStateError(`The package does not need a credential "${name}"`);
    if (!this.o.vault.has(ownerId, name))
      throw new MagicExtStateError(`There is no "${name}" in the keychain yet`);
    await this.o.vault.bindTools(
      ownerId,
      name,
      MagicExtensions.toolNames(m),
      MagicExtensions.credential(m, c).hosts,
    );
    return this.retest(ownerId, id);
  }

  /**
   * The person's yes (only here, only by the person): every part installed through the builder's
   * decision. Parts of an earlier version that are gone are removed.
   */
  async approve(ownerId: string, id: string): Promise<MagicExtension> {
    const v = await this.get(ownerId, id);
    if (v.status !== "ready" || !v.proposal)
      throw new MagicExtStateError("There is no proposal to approve");
    if (!v.canApprove) {
      const missing = v.checks.filter((c) => !c.ok);
      throw new MagicExtStateError(
        `Still missing: ${missing.map((c) => `${c.kind} ${c.what}`).join(", ") || "a part"}`,
      );
    }
    const r = await this.row(ownerId, id);
    const now: InstalledPart[] = v.proposal.parts.map((p) => ({ kind: p.kind, name: p.name }));
    for (const p of v.proposal.parts)
      await this.o.builder.decide(ownerId, p.proposalId, "approve", "human");
    const gone = json<InstalledPart[]>(r.installed).filter(
      (x) => !now.some((y) => y.kind === x.kind && y.name === x.name),
    );
    for (const x of gone)
      await this.o.builder.uninstall(ownerId, null, x.kind, x.name, "human").catch(() => false);
    await this.o.vault.unbindTools(
      ownerId,
      gone.filter((x) => x.kind === "tool").map((x) => x.name),
    );
    await this.o.db.query(
      "UPDATE rg_magic_extensions SET status = 'done', installed = $2::jsonb, updated_at = now() WHERE id = $1",
      [id, JSON.stringify(now)],
    );
    this.o.host.changed(ownerId, id);
    return this.get(ownerId, id);
  }

  /** The person's no: nothing installed; God hears why and tries again. */
  async reject(ownerId: string, id: string, reason?: string): Promise<MagicExtension> {
    const r = await this.row(ownerId, id);
    if (r.status !== "ready") throw new MagicExtStateError("There is no proposal to reject");
    await this.putAside(r, "human");
    await this.o.db.query(
      `UPDATE rg_magic_extensions SET status = $2, proposal_ids = '[]'::jsonb, updated_at = now()
       WHERE id = $1`,
      [id, json<InstalledPart[]>(r.installed).length ? "done" : "building"],
    );
    const words = reason?.trim();
    await this.o.host.send(
      ownerId,
      r.session_id,
      words
        ? `I did not approve the proposal. ${words}`
        : "I did not approve the proposal. Ask me what to change.",
    );
    this.o.host.changed(ownerId, id);
    return this.get(ownerId, id);
  }

  /** A change to an installed package: back to the same conversation, the same flow. */
  async update(ownerId: string, id: string, request: string): Promise<MagicExtension> {
    const r = await this.row(ownerId, id);
    if (r.status !== "done") throw new MagicExtStateError("Only an installed package changes");
    const text = blankPastedSecrets(request.trim());
    if (!text) throw new MagicExtStateError("Write what should change");
    await this.o.db.query(
      "UPDATE rg_magic_extensions SET status = 'building', updated_at = now() WHERE id = $1",
      [id],
    );
    await this.o.host.send(
      ownerId,
      r.session_id,
      `I want to change the installed package: ${text}\nPropose it again with propose_magic_extension (the same names where they stay); it replaces the installed one only when I approve.`,
    );
    this.o.host.changed(ownerId, id);
    return this.get(ownerId, id);
  }

  /** Uninstall: its tools and skills removed, their credentials taken back (the keys added here go). */
  async uninstall(ownerId: string, id: string): Promise<void> {
    const r = await this.row(ownerId, id);
    const parts = json<InstalledPart[]>(r.installed);
    if (parts.length === 0) throw new MagicExtStateError("Nothing of it is installed");
    await this.putAside(r, "human");
    for (const x of parts) await this.o.builder.uninstall(ownerId, null, x.kind, x.name, "human");
    await this.o.vault.unbindTools(
      ownerId,
      parts.filter((x) => x.kind === "tool").map((x) => x.name),
    );
    if (this.o.vault.ready) await this.o.vault.syncSystem(ownerId, keyOf(id, ""), new Map());
    await this.o.db.query(
      "UPDATE rg_magic_extensions SET status = 'dismissed', installed = '[]'::jsonb, updated_at = now() WHERE id = $1",
      [id],
    );
    this.o.host.changed(ownerId, id);
  }

  /** Put away before installing (the conversation stays among the chats). */
  async dismiss(ownerId: string, id: string): Promise<void> {
    const r = await this.row(ownerId, id);
    if (json<InstalledPart[]>(r.installed).length)
      throw new MagicExtStateError("It is installed: uninstall it instead");
    await this.putAside(r, "human");
    if (this.o.vault.ready) await this.o.vault.syncSystem(ownerId, keyOf(id, ""), new Map());
    await this.o.db.query(
      "UPDATE rg_magic_extensions SET status = 'dismissed', updated_at = now() WHERE id = $1",
      [id],
    );
    this.o.host.changed(ownerId, id);
  }
}

/** The tests and what is missing, in words for God. */
export function magicExtReport(v: MagicExtension): string {
  const lines = (v.proposal?.parts ?? []).flatMap((p) => [
    `${p.kind} ${p.name}: ${p.status === "pending" ? "passed its tests" : p.status}`,
    ...p.tests.map(
      (t) => `  ${t.passed ? "passed" : "FAILED"} ${t.name}: ${t.detail.slice(0, 600)}`,
    ),
  ]);
  const missing = v.checks.filter((c) => !c.ok);
  return [
    "Proposed. The person sees the package with its tests and approves, changes or rejects it; nothing is installed before their yes.",
    ...lines,
    missing.length
      ? `Still missing (the button stays off): ${missing
          .map((c) =>
            c.kind === "credential"
              ? `credential ${c.what} (${c.detail === "undeclared" ? "the code reads it but the manifest does not declare it" : c.exists ? "not given to these tools yet: the person does it on the page" : "not in the keychain yet: the person adds it on the page"})`
              : c.kind === "host"
                ? `host ${c.what} (${c.detail === "undeclared" ? "reached by the code but not declared" : `${c.detail} goes there but it is not declared`})`
                : `test of ${c.what} (${c.detail})`,
          )
          .join("; ")}. Tell the person what to add; fix what is yours and propose again.`
      : "Nothing is missing: the person can approve and install.",
  ].join("\n");
}

const PROPOSE_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "lowercase-with-dashes" },
    title: { type: "string" },
    summary: { type: "string" },
    hosts: { type: "array", items: { type: "string" } },
    credentials: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          service: { type: "string" },
          hosts: { type: "array", items: { type: "string" } },
          header: { type: "string" },
          format: { type: "string" },
          why: { type: "string" },
          help: { type: "string" },
        },
        required: ["name", "service"],
      },
    },
    tools: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          input_schema: { type: "object" },
          command: { type: "string" },
          files: { type: "object", additionalProperties: { type: "string" } },
          tests: { type: "array", items: { type: "object" } },
        },
        required: ["name", "description", "command", "tests"],
      },
    },
    skills: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          body: { type: "string" },
          files: { type: "object", additionalProperties: { type: "string" } },
          tests: { type: "array", items: { type: "object" } },
          untestable_reason: { type: "string" },
        },
        required: ["name", "description", "body"],
      },
    },
  },
  required: ["name", "title", "summary"],
};

/** The tool of a magic integration's conversation: only there, only its agent. */
export function magicExtTools(
  self: { id: string; ownerId: string },
  session: { agentId: string } | undefined,
  magic: MagicExtensions,
): Tool[] {
  if (!session || session.agentId !== self.id) return [];
  return [
    {
      def: {
        name: "propose_magic_extension",
        description:
          "Magic integration or extension: propose the whole package (manifest, tools with their code and tests, skills). Every part is tested in a throwaway sandbox that reaches only the keychain's routes; the person sees the tests and what is missing, and installs it with one button. Proposing again replaces the proposal.",
        inputSchema: PROPOSE_SCHEMA,
      },
      async run(i: unknown, ctx: { sessionId?: string }) {
        try {
          return magicExtReport(await magic.propose(self.ownerId, ctx.sessionId ?? "", i));
        } catch (err) {
          const issues = (err as { issues?: { path: (string | number)[]; message: string }[] })
            .issues;
          return {
            content: issues
              ? `Not proposed: ${issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`
              : (err as Error).message,
            isError: true,
          };
        }
      },
    } as Tool,
  ];
}
