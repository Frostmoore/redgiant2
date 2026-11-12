// The artifacts' bridge (3.6, G38.7, study_artifacts.md §4.3-4.4): what an artifact may ask RedGiant
// besides «send to chat». Three capabilities, each declared in the artifact's header (`wants`) and
// granted by the person, never by the file: `ask` (a question answered by the agent that made it,
// in a conversation of its own with no tools, within a spending cap the person chose), `storage`
// (text the artifact keeps on the server, per artifact, at most 5 MB) and `files:<folder>/` (read
// only, inside that folder of the artifact's project). One channel: the frame posts to the page,
// the page checks who sent it (`event.source`) and the shape here, then forwards it to the server
// over its WebSocket with the artifact the frame shows; the answer goes back to that frame only.
import { z } from "zod";

/** The most text an artifact keeps (`storage`), all its keys and values together. */
export const ARTIFACT_STORAGE_MAX = 5 * 1024 * 1024;
/** The most keys it keeps. */
export const ARTIFACT_STORAGE_KEYS = 10_000;
/** The longest key. */
export const ARTIFACT_STORAGE_KEY_MAX = 200;
/** The biggest file `files.read` gives (text or binary). */
export const ARTIFACT_FILE_MAX = 10 * 1024 * 1024;
/** The most entries `files.list` gives. */
export const ARTIFACT_LIST_MAX = 1000;
/** The longest question `ask` takes. */
export const ARTIFACT_ASK_MAX = 20_000;
/** Questions one artifact may ask in a minute. */
export const ARTIFACT_ASK_PER_MINUTE = 6;
/** Other bridge calls one artifact may make in a second (storage, files). */
export const ARTIFACT_CALLS_PER_SECOND = 20;
/** Calls one frame may have waiting at once (the page refuses more). */
export const ARTIFACT_PENDING_MAX = 16;
/** The spending caps the person picks from when granting `ask` (USD). */
export const ARTIFACT_ASK_CAPS = [0.1, 0.5, 2, 5] as const;
/** The cap preselected on the card. */
export const ARTIFACT_ASK_CAP_DEFAULT = 0.5;
/** The pseudo tool of a grant request (the person's card, every channel). */
export const ARTIFACT_GRANT_TOOL = "artifact_capability";
/** The pseudo tool `criticalOf` reads for a bridge read (G36.17b: secrets never go out). */
export const ARTIFACT_READ_TOOL = "artifact_read";

/** A capability an artifact may ask for. */
export type ArtifactCapability =
  | { kind: "ask" }
  | { kind: "storage" }
  /** A folder of the artifact's project, relative, ending in "/". */
  | { kind: "files"; dir: string };

/** One folder name: no separators, no dots alone, nothing hidden, no control characters. */
const SEGMENT =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses.
  /^(?!\.)[^\\/:*?"<>|\u0000-\u001f\u007f]{1,120}$/;

/** A capability from the header's words ("ask", "storage", "files:dati/"), or undefined. */
export function parseCapability(word: string): ArtifactCapability | undefined {
  const w = word.trim();
  if (w === "ask") return { kind: "ask" };
  if (w === "storage") return { kind: "storage" };
  const m = /^files:(.+)$/.exec(w);
  if (!m?.[1] || m[1].length > 200) return undefined;
  const parts = m[1].replace(/\/+$/, "").split("/");
  if (!parts.length || !parts.every((p) => SEGMENT.test(p) && p.trim() === p)) return undefined;
  return { kind: "files", dir: `${parts.join("/")}/` };
}

/** The canonical word of a capability ("files:dati/"). */
export const capabilityWord = (c: ArtifactCapability): string =>
  c.kind === "files" ? `files:${c.dir}` : c.kind;

/** The capabilities a header asks for, canonical and once each (unknown words are dropped). */
export function wantedCapabilities(wants: readonly string[]): ArtifactCapability[] {
  const out = new Map<string, ArtifactCapability>();
  for (const w of wants) {
    const c = parseCapability(w);
    if (c) out.set(capabilityWord(c), c);
  }
  return [...out.values()];
}

const StorageKey = z.string().min(1).max(ARTIFACT_STORAGE_KEY_MAX);

/** What an artifact asks through the bridge. */
export const BridgeCall = z.discriminatedUnion("op", [
  z.object({ op: z.literal("ask"), prompt: z.string().min(1).max(ARTIFACT_ASK_MAX) }),
  z.object({ op: z.literal("storage.get"), key: StorageKey }),
  z.object({
    op: z.literal("storage.set"),
    key: StorageKey,
    value: z.string().max(ARTIFACT_STORAGE_MAX),
  }),
  z.object({ op: z.literal("storage.delete"), key: StorageKey }),
  z.object({ op: z.literal("storage.list"), prefix: z.string().max(200).optional() }),
  z.object({
    op: z.literal("files.read"),
    path: z.string().min(1).max(1000),
    /** "text" (UTF-8) or "binary" (base64 on the wire; an ArrayBuffer in the artifact). */
    as: z.enum(["text", "binary"]).default("text"),
  }),
  z.object({ op: z.literal("files.list"), dir: z.string().max(1000) }),
]);
export type BridgeCall = z.infer<typeof BridgeCall>;

/** The capability a call needs: `files.*` names the path, the folder comes from the header. */
export const callNeeds = (c: BridgeCall): "ask" | "storage" | "files" =>
  c.op === "ask" ? "ask" : c.op.startsWith("storage.") ? "storage" : "files";

/** Why a bridge call failed, as the artifact's code sees it (`err.code`). */
export const BRIDGE_ERRORS = [
  /** The header does not ask for it. */
  "not_declared",
  /** The person said no (or nobody could: their requests are off). */
  "denied",
  /** Too many calls, or too many questions in a minute. */
  "rate_limited",
  /** The artifact's spending cap, or a budget above it, is used up. */
  "budget",
  /** The agent that made it is gone or stopped. */
  "no_agent",
  /** No such file or folder. */
  "not_found",
  /** Too big (a file, the storage). */
  "too_big",
  /** Outside the granted folder, a secret, a link that leaves: never. */
  "forbidden",
  /** Not here: a widget, an artifact not run yet, a place without a project. */
  "unavailable",
  "bad_request",
  "failed",
] as const;
export type BridgeErrorCode = (typeof BRIDGE_ERRORS)[number];
export const BridgeError = z.object({
  code: z.enum(BRIDGE_ERRORS),
  message: z.string().max(2000),
});
export type BridgeError = z.infer<typeof BridgeError>;

/** What the artifact gets back, by call. */
export type BridgeResult =
  | { text: string }
  | { value: string | null }
  | { ok: true }
  | { keys: string[] }
  | { path: string; size: number; text: string }
  | { path: string; size: number; base64: string; mime: string }
  | { entries: { name: string; dir: boolean; size: number }[] };

/** The frame's message for a bridge call (JSON-RPC 2.0 shape, our own method name). */
export const BridgeFrameMessage = z.object({
  method: z.literal("redgiant/bridge"),
  id: z.number().int().nonnegative().max(1e9),
  params: BridgeCall,
});
export type BridgeFrameMessage = z.infer<typeof BridgeFrameMessage>;

/** One grant, as Settings › Artifacts shows it. */
export const ArtifactGrant = z.object({
  capability: z.string(),
  /** `ask`: the agent it was granted for, and the cap the person chose (USD). */
  agentId: z.string().optional(),
  capUsd: z.number().positive().optional(),
  /** `ask`: spent so far (USD). */
  spentUsd: z.number().nonnegative().optional(),
  at: z.string(),
});
export type ArtifactGrant = z.infer<typeof ArtifactGrant>;

/**
 * A capability in the person's words, for the grant card and Settings: «leggere i file della
 * cartella dati/ (solo lettura)». `agent`: the name of the agent that answers `ask`.
 */
export function capabilitySentence(lang: string, capability: string, agent?: string): string {
  const it = lang === "it";
  const c = parseCapability(capability);
  if (!c) return capability;
  if (c.kind === "files")
    return it
      ? `leggere i file della cartella ${c.dir} del progetto (solo lettura)`
      : `read the files in the project's folder ${c.dir} (read only)`;
  if (c.kind === "storage")
    return it
      ? "tenere dati suoi su RedGiant (solo testo, fino a 5 MB)"
      : "keep data of its own on RedGiant (text only, up to 5 MB)";
  const who = agent
    ? it
      ? `«${agent}»`
      : `“${agent}”`
    : it
      ? "l'agente che l'ha fatto"
      : "the agent that made it";
  return it
    ? `fare domande a ${who}, che risponde senza strumenti e spende dal tuo budget fino al tetto che scegli`
    : `ask ${who} questions, answered with no tools and paid from your budget up to the cap you choose`;
}

/** The grant request's sentence: «L'artefatto «Budget» chiede di …». */
export function grantSentence(
  lang: string,
  input: { artifact?: unknown; capability?: unknown; agent?: unknown },
): string {
  const it = lang === "it";
  const name = typeof input.artifact === "string" && input.artifact ? input.artifact : "?";
  const cap = typeof input.capability === "string" ? input.capability : "";
  const agent = typeof input.agent === "string" && input.agent ? input.agent : undefined;
  const what = capabilitySentence(lang, cap, agent);
  return it ? `L'artefatto «${name}» chiede di ${what}` : `The artifact “${name}” asks to ${what}`;
}
