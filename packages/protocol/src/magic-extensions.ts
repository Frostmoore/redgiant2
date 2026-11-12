// Magic integrations and magic extensions (G38.3, the roadmap: «stesso tasto e stesso flusso
// dell'Automazione magica nella pagina Estensioni: descrivi cosa vuoi, God fa domande, crea
// skill/strumenti/connettori, li prova in sandbox, "Approva e installa" spento finché manca
// qualcosa»). The person describes; God asks and proposes one package (a manifest, the tools'
// code and their tests, the skills); every part is tested by the extension builder in a throwaway
// sandbox and waits; only the person's «Approve and install» installs it.
// What the page and the server share, and the pure rule that says what is still missing.
import { z } from "zod";
import { VAULT_NAME_RE } from "./vault.js";

/** A magic integration reaches a service (its API); a magic extension is any tool or skill. */
export const MagicExtKind = z.enum(["integration", "extension"]);
export type MagicExtKind = z.infer<typeof MagicExtKind>;

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const HOST = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** A credential the package needs: kept in the keychain, reached only through the egress proxy. */
export const MagicCredential = z.object({
  /** Its name in the keychain; the tools read `REDGIANT_VAULT_<NAME>` (the proxy's address). */
  name: z.string().regex(VAULT_NAME_RE),
  service: z.string().min(1).max(80),
  /** Where its value may go; a subset of the package's hosts (default: all of them). */
  hosts: z.array(z.string().regex(HOST)).max(20).default([]),
  /** How the proxy puts it on a request when the code does not write `{{vault:<name>}}`. */
  header: z.string().max(80).default("Authorization"),
  format: z.string().max(200).default("Bearer {value}"),
  why: z.string().max(400).default(""),
  /** Where the person gets it (the service's page for API keys), shown beside the field. */
  help: z.string().max(400).optional(),
});
export type MagicCredential = z.infer<typeof MagicCredential>;

/** One tool of the package, in the extensions' tool format (`tool.json` plus files). */
export const MagicToolInput = z.object({
  name: z.string().regex(NAME).max(64),
  description: z.string().min(10).max(2000),
  input_schema: z.record(z.string(), z.unknown()).default({ type: "object" }),
  command: z.string().min(1).max(500),
  files: z.record(z.string(), z.string()).default({}),
  tests: z
    .array(
      z.object({
        input: z.record(z.string(), z.unknown()).default({}),
        expectExitCode: z.number().int().default(0),
        expectStdoutContains: z.string().optional(),
      }),
    )
    .min(1, "A tool needs at least one test"),
});
export type MagicToolInput = z.input<typeof MagicToolInput>;

/** One skill of the package (instructions; scripts in it wait for the person like any code). */
export const MagicSkillInput = z.object({
  name: z.string().regex(NAME).max(64),
  description: z.string().min(10).max(1024),
  body: z.string().min(20),
  files: z.record(z.string(), z.string()).default({}),
  tests: z.array(z.object({ command: z.string().min(1) })).default([]),
  untestable_reason: z.string().min(20).optional(),
});
export type MagicSkillInput = z.input<typeof MagicSkillInput>;

/** What God proposes with `propose_magic_extension`: the manifest and every part's code. */
export const MagicManifest = z.object({
  /** The package's name (lowercase-with-dashes): the tools usually start with it. */
  name: z.string().regex(NAME).max(48),
  /** Its title for the person, in their language. */
  title: z.string().min(1).max(120),
  /** Two or three lines: what it does and how, in the person's language. */
  summary: z.string().min(1).max(2000),
  /** Every host the code reaches; nothing else is reachable. */
  hosts: z.array(z.string().regex(HOST)).max(20).default([]),
  credentials: z.array(MagicCredential).max(10).default([]),
  tools: z.array(MagicToolInput).max(20).default([]),
  skills: z.array(MagicSkillInput).max(10).default([]),
});
export type MagicManifest = z.output<typeof MagicManifest>;

/** One test of a part, as the builder ran it in the throwaway sandbox. */
export interface MagicTestResult {
  name: string;
  passed: boolean;
  detail: string;
}

/** One part of the proposal (a tool or a skill) and its test in the sandbox. */
export interface MagicPart {
  kind: "tool" | "skill";
  name: string;
  description: string;
  /** A tool's arguments (its JSON schema); none for a skill. */
  inputSchema?: Record<string, unknown> | undefined;
  command?: string | undefined;
  /** The part's files, to read before approving. */
  files: Record<string, string>;
  /** The builder's proposal (rg_proposals) that holds it. */
  proposalId: string;
  /** `pending`: tested and waiting; `failed`: a test failed; `installed`, `rejected`. */
  status: "pending" | "failed" | "installed" | "rejected";
  tests: MagicTestResult[];
}

/** What the page shows of one thing that must hold before «Approve and install». */
export interface MagicCheck {
  /** A credential missing or not given to these tools, a failing test, a host not declared. */
  kind: "credential" | "test" | "host";
  what: string;
  ok: boolean;
  detail?: string | undefined;
  /** A credential: its service, its hosts, and whether an entry of that name is already there. */
  service?: string | undefined;
  hosts?: string[] | undefined;
  exists?: boolean | undefined;
}

export interface MagicExtension {
  id: string;
  kind: MagicExtKind;
  title: string;
  /** What the person asked, in their words. */
  request: string;
  sessionId: string;
  agentId: string;
  /**
   * `building`: talking; `testing`: the parts run in the sandbox again; `ready`: a proposal
   * waits; `done`: installed; `dismissed`: put away or uninstalled.
   */
  status: "building" | "testing" | "ready" | "done" | "dismissed";
  proposal: {
    name: string;
    title: string;
    summary: string;
    hosts: string[];
    credentials: MagicCredential[];
    parts: MagicPart[];
    at: string;
  } | null;
  checks: MagicCheck[];
  /** True only when nothing is missing: the button «Approve and install» lights up. */
  canApprove: boolean;
  /** The tools and skills installed by its last approval. */
  installed: string[];
  createdAt: string;
  updatedAt: string;
}

const IGNORED_HOSTS = new Set(["www.w3.org", "w3.org", "json-schema.org", "schema.org"]);

/**
 * The hosts a package's code reaches: every `http(s)://host` and every host after a keychain
 * address (`$REDGIANT_VAULT_X/<host>/…`). Pure, tested as a table. A best effort read of the code:
 * what really holds is the proxy, which takes a credential only to its own hosts.
 */
export function hostsInCode(texts: readonly string[]): string[] {
  const out = new Set<string>();
  const url = /\bhttps?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::\d+)?/gi;
  const vault = /REDGIANT_VAULT_[A-Z0-9_]+[^/\n]{0,10}\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/g;
  for (const text of texts) {
    for (const m of text.matchAll(url)) out.add((m[1] as string).toLowerCase());
    for (const m of text.matchAll(vault)) out.add((m[1] as string).toLowerCase());
  }
  for (const h of IGNORED_HOSTS) out.delete(h);
  return [...out].sort();
}

/** The keychain names a package's code reads (`REDGIANT_VAULT_<NAME>`), in their env form. */
export function vaultEnvsInCode(texts: readonly string[]): string[] {
  const out = new Set<string>();
  for (const text of texts)
    for (const m of text.matchAll(/REDGIANT_VAULT_([A-Z0-9_]+)/g)) out.add(m[1] as string);
  return [...out].sort();
}

/** `notion-api` → `NOTION_API`, as `REDGIANT_VAULT_<NAME>` writes it. */
export const vaultEnvName = (name: string) => name.toUpperCase().replace(/-/g, "_");

/** Whether `host` is one of `patterns` (`*.example.com` for the subdomains). */
export function hostIn(host: string, patterns: readonly string[]): boolean {
  const h = host.toLowerCase();
  return patterns.some((p) => {
    const q = p.toLowerCase();
    return q.startsWith("*.") ? h.endsWith(q.slice(1)) : h === q;
  });
}

/** What the server knows of one credential the package needs. */
export interface MagicCredentialState {
  /** An entry of that name is in the keychain. */
  exists: boolean;
  /** It is given to every tool of the package. */
  bound: boolean;
  /** Its allowed hosts. */
  hosts: string[];
}

/**
 * What must still hold before «Approve and install» (G38.3): every credential in the keychain and
 * given to the package's tools, every part tested and passing (and still waiting), every host the
 * code reaches declared, every credential's host among the declared ones and every keychain name
 * the code reads declared. Pure, tested as a table: change the table first.
 */
export function magicChecks(
  p: Pick<NonNullable<MagicExtension["proposal"]>, "hosts" | "credentials" | "parts">,
  credentials: (name: string) => MagicCredentialState,
): { checks: MagicCheck[]; canApprove: boolean } {
  const checks: MagicCheck[] = [];
  for (const c of p.credentials) {
    const s = credentials(c.name);
    const want = c.hosts.length ? c.hosts : p.hosts;
    const missingHosts = want.filter((h) => !s.hosts.includes(h));
    checks.push({
      kind: "credential",
      what: c.name,
      ok: s.exists && s.bound && missingHosts.length === 0,
      service: c.service,
      hosts: want,
      exists: s.exists,
      ...(!s.exists
        ? { detail: "missing" }
        : !s.bound || missingHosts.length
          ? { detail: "not-bound" }
          : {}),
    });
  }
  for (const part of p.parts) {
    const failed = part.tests.filter((t) => !t.passed);
    const ok = part.status === "pending" && failed.length === 0;
    checks.push({
      kind: "test",
      what: part.name,
      ok,
      ...(!ok && {
        detail:
          part.status === "failed" || failed.length
            ? (failed[0]?.name ?? "failed")
            : `proposal ${part.status}`,
      }),
    });
  }
  const code = p.parts.flatMap((part) => [part.command ?? "", ...Object.values(part.files)]);
  for (const h of hostsInCode(code))
    if (!hostIn(h, p.hosts))
      checks.push({ kind: "host", what: h, ok: false, detail: "undeclared" });
  for (const c of p.credentials)
    for (const h of c.hosts)
      if (!hostIn(h, p.hosts))
        checks.push({ kind: "host", what: h, ok: false, detail: `credential ${c.name}` });
  const declared = new Set(p.credentials.map((c) => vaultEnvName(c.name)));
  for (const env of vaultEnvsInCode(code))
    if (!declared.has(env))
      checks.push({
        kind: "credential",
        what: env.toLowerCase(),
        ok: false,
        detail: "undeclared",
      });
  const canApprove = p.parts.length > 0 && checks.every((c) => c.ok);
  return { checks, canApprove };
}
