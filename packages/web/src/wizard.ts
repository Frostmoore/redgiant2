// The setup wizard's logic without the page (2026-11-06, the person's prototype «una cosa alla
// volta»): which steps there are, which can be skipped, the ready choices of the approvals, the
// first models to suggest for each role, the disks for the models and the closing summary.
import { DANGER_IDS } from "@redgiant/protocol";
import type { ModelChoice, SetupState } from "./api.js";
import { localModelName } from "./format.js";
import { lang, t } from "./i18n.js";

/** The wizard's steps; the advanced installation adds where the code lives (G24.5). */
export type StepKey =
  | "wzWelcome"
  /** A complete RedGiant or a node of another one (G39.3). */
  | "wzRole"
  /** The password: from another device it is how one signs in afterwards (G39.3). */
  | "wzAccount"
  /** What the machine is, and what it can run (G39.3). */
  | "wzMachine"
  | "wzMode"
  | "wzBrain"
  | "wzLocal"
  | "wzNames"
  | "wzAssign"
  /** Coming from another agent? (G36.7, optional) */
  | "wzImport"
  | "wzTelegram"
  /** Where the data lives and where backups go (G39.3). */
  | "wzStorage"
  | "wzCode"
  | "wzRemote"
  | "wzSafety"
  | "wzDone";

/** The step only the advanced installation has, after where backups go. */
export const ADVANCED_STEPS: readonly StepKey[] = ["wzCode"];

/** What changes the list besides the mode: the role, and whether local models fit (G39.3). */
export interface StepContext {
  role?: "full" | "node" | undefined;
  /** false: no local model fits this machine, the step is not offered. */
  local?: boolean | undefined;
  /**
   * The password existed when the wizard opened (G39.7: the page that created the access chose
   * it a moment ago): its step is not offered again.
   */
  password?: boolean | undefined;
}

export const stepsFor = (
  mode: "standard" | "advanced" | undefined,
  o: StepContext = {},
): StepKey[] =>
  o.password
    ? stepsFor(mode, { ...o, password: false }).filter((k) => k !== "wzAccount")
    : // A node gets its agents, models and chats from the main RedGiant (pairing, G39.4).
      o.role === "node"
      ? ["wzWelcome", "wzRole", "wzAccount", "wzMachine", "wzDone"]
      : [
          "wzWelcome",
          "wzRole",
          "wzAccount",
          "wzMachine",
          "wzMode",
          "wzBrain",
          ...(o.local === false ? [] : (["wzLocal"] as const)),
          "wzNames",
          "wzAssign",
          "wzImport",
          "wzTelegram",
          "wzStorage",
          ...(mode === "advanced" ? ADVANCED_STEPS : []),
          // Access from outside: offered to everyone, never needed (LAN only is a choice).
          "wzRemote",
          "wzSafety",
          "wzDone",
        ];

/** The steps of a wizard's state. */
export const stepsOf = (
  s: {
    config: { mode?: "standard" | "advanced"; role?: "full" | "node" };
    offer?: { local: boolean };
  },
  o: { password?: boolean } = {},
) => stepsFor(s.config.mode, { role: s.config.role, local: s.offer?.local, password: o.password });

/** Steps that may be left for later: everything works without them. */
const SKIPPABLE: readonly StepKey[] = [
  "wzBrain",
  "wzLocal",
  "wzImport",
  "wzTelegram",
  "wzStorage",
  "wzCode",
  "wzRemote",
];
/**
 * The password step is skipped only by who can sign in otherwise: signed in with the setup
 * code of a first start and without a password yet, the page would be locked out later.
 */
export const skippable = (k: StepKey, o: { mustSetPassword?: boolean } = {}) =>
  SKIPPABLE.includes(k) || (k === "wzAccount" && !o.mustSetPassword);

/** The step after `from` in a (possibly changed) list: choosing "advanced" adds two. */
export function stepAfter(list: StepKey[], from: StepKey): StepKey {
  const i = list.indexOf(from);
  return list[Math.min(i + 1, list.length - 1)] ?? "wzDone";
}

/** The dangers only the human approves, for each ready choice. */
export const PRESETS = {
  careful: [...DANGER_IDS],
  balanced: [
    "git-push",
    "git-history",
    "privilege",
    "disk",
    "deploy",
    "database-drop",
    "secrets-files",
    "platform",
  ],
  free: ["platform", "secrets-files"],
} as const;
export type Preset = keyof typeof PRESETS;

/** The ready choice a set of human-only dangers is, if it is one. */
export function presetOf(humanOnly: readonly string[]): Preset | undefined {
  return (Object.keys(PRESETS) as Preset[]).find(
    (p) =>
      PRESETS[p].length === humanOnly.length &&
      (PRESETS[p] as readonly string[]).every((x) => humanOnly.includes(x)),
  );
}

/** Paid per use: a key of a provider (subscriptions and local models cost nothing more). */
export const paysPerUse = (s: SetupState) => s.secretsSet.keys.length > 0 || s.locked.anthropic;

/** The ways of thinking connected now. */
export type Way = "claude" | "chatgpt" | "keys" | "local" | "server";
export function waysInUse(s: SetupState): Way[] {
  const ways: Way[] = [];
  if (s.config.subscriptions?.claude) ways.push("claude");
  if (s.config.subscriptions?.chatgpt) ways.push("chatgpt");
  if (s.secretsSet.keys.length > 0 || s.locked.anthropic) ways.push("keys");
  if (s.config.engine) ways.push("local");
  if (s.config.server || s.locked.server) ways.push("server");
  return ways;
}

/** A model as the API takes it. */
export type Spec = { provider: string; model: string; effort?: string };

/** Who should come first when the strongest model is wanted. */
const RANK = ["claude-subscription", "anthropic", "chatgpt-subscription", "openai"];
const rank = (p: string) => (RANK.includes(p) ? RANK.indexOf(p) : p === "local" ? 99 : RANK.length);
const STRONG = /opus|gpt-5(?!.*(mini|nano))|\bpro\b|large|max/i;
const FAST = /haiku|mini|nano|flash|small|lite|fast/i;

const spec = (m: ModelChoice, effort: string): Spec => ({
  provider: m.provider,
  model: m.model,
  ...(m.effort && { effort }),
});

/**
 * A first suggestion for a role (the person changes it with one click): "strong" for who
 * decides, the strongest of the best provider; "fast" for who answers, a model on this computer,
 * else a small one, else the strong one. `except` leaves out a provider (the backup model is
 * best from another one).
 */
export function suggestModel(
  models: ModelChoice[],
  want: "strong" | "fast",
  except?: string,
): Spec | null {
  const pool = models.filter((m) => m.provider !== except);
  if (pool.length === 0) return null;
  const sorted = [...pool].sort((a, b) => rank(a.provider) - rank(b.provider));
  const top = sorted[0] as ModelChoice;
  const strong =
    sorted.find((m) => m.provider === top.provider && STRONG.test(m.model)) ??
    sorted.find((m) => m.provider === top.provider && !FAST.test(m.model)) ??
    top;
  if (want === "strong") return spec(strong, "high");
  const fast = pool.find((m) => m.provider === "local") ?? sorted.find((m) => FAST.test(m.model));
  return spec(fast ?? strong, "low");
}

export const sameModel = (a: Spec | null | undefined, b: Spec | null | undefined) =>
  (a?.provider ?? "") === (b?.provider ?? "") &&
  (a?.model ?? "") === (b?.model ?? "") &&
  (a?.effort ?? "") === (b?.effort ?? "");

/** A number in the page's language: 1.188,5 in Italian, 1,188.5 in English. */
export const num = (n: number, digits = 1) =>
  n.toLocaleString(lang.value === "it" ? "it-IT" : "en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
export const gbText = (n: number) => `${num(n)} GB`;

/** One disk the models can stay on, as a tile shows it. */
export interface DiskTile {
  name: string;
  /** "C:", or "this disk" when the computer does not list its disks. */
  label: string;
  kind: string;
  freeGb: number | null;
  totalGb: number | null;
  /** How full it is, 0-100 (unknown: null). */
  usedPct: number | null;
  /** The models are here now. */
  here: boolean;
  /** The models may move here: RedGiant's Windows installation, a disk that is not spinning. */
  canMove: boolean;
  hdd: boolean;
}

/**
 * The disks for the models (2026-11-03): on Windows the computer's disks, the one the engine
 * uses marked; elsewhere the one disk of RedGiant's data, where the models stay.
 */
export function diskTiles(hw: SetupState["hardware"], variant: string): DiskTile[] {
  const disks = hw.disks ?? [];
  const here = variant === "windows" ? hw.modelDisk?.windows : hw.modelDisk?.docker;
  const movable = (hw.onWindows ?? hw.windowsEngine) === true;
  if (disks.length === 0)
    return [
      {
        name: "",
        label: t("wzDiskThis"),
        kind: t("wzDiskData"),
        freeGb: hw.diskFreeGb,
        totalGb: null,
        usedPct: null,
        here: true,
        canMove: false,
        hdd: false,
      },
    ];
  return disks.map((d) => {
    const kind = d.ssd === true ? "SSD" : d.ssd === false ? t("lmDiskHdd") : t("lmDiskUnknown");
    return {
      name: d.name,
      label: d.name === "/" ? t("lmStreamThisDisk") : `${d.name}:`,
      kind: `${kind}${d.bus !== "other" ? ` ${d.bus.toUpperCase()}` : ""}`,
      freeGb: d.freeGb,
      totalGb: d.totalGb,
      usedPct: d.totalGb > 0 ? Math.round(((d.totalGb - d.freeGb) / d.totalGb) * 100) : null,
      here: d.name === here || (!here && disks.length === 1),
      canMove: movable && d.ssd !== false,
      hdd: d.ssd === false,
    };
  });
}

/** The usual folder for the models on a disk. */
/**
 * Whether the bigger reading passes' switch makes sense (G32.1): SSD stream on, and an engine for
 * a card of its own (a card sharing the computer's memory, or none, gains nothing from them).
 */
export function bigChunksShown(
  hw: SetupState["hardware"],
  variant: string,
  streaming: boolean,
): boolean {
  return streaming && variant !== "cpu" && hw.suggestion.kind !== "igpu";
}

/** The patched engine's download (G32.2), as the release's zip measured. */
export const MOE_PREFETCH_SIZE = "700 MB";

/**
 * The «next layer ahead» switch (G32.2): with SSD stream on and an NVIDIA card of its own, either
 * RedGiant's engine on Windows (the server saying whether this version has the patched binaries)
 * or the `cuda` engine in Docker on Linux (whether the patched image is there). "missing": shown,
 * saying so, and off. null: not shown (never on a Mac, never with Vulkan or the CPU).
 */
export function moePrefetchSwitch(
  s: Pick<SetupState, "hardware" | "moePrefetch" | "moePrefetchImage">,
  variant: string,
  streaming: boolean,
): "available" | "missing" | null {
  const hw = s.hardware;
  if (!streaming || hw.os === "darwin") return null;
  if (!hw.gpus.some((g) => g.vendor === "nvidia" && !g.integrated)) return null;
  if (variant === "windows") {
    if (!s.moePrefetch || !(hw.onWindows ?? hw.windowsEngine)) return null;
    return s.moePrefetch;
  }
  if (variant === "cuda") return (hw.dockerGpu && s.moePrefetchImage) || null;
  return null;
}

/** The patched image for Docker (Linux), as the registry measured it. */
export const MOE_PREFETCH_IMAGE_SIZE = "2.5 GB";

/** The switch's help and its «missing» notice for the engine chosen (G32.2). */
export function moePrefetchTexts(variant: string): { help: string; missing: string } {
  return variant === "cuda"
    ? {
        help: t("lmMoePrefetchHelpDocker", { size: MOE_PREFETCH_IMAGE_SIZE }),
        missing: t("lmMoePrefetchMissingDocker"),
      }
    : {
        help: t("lmMoePrefetchHelp", { size: MOE_PREFETCH_SIZE }),
        missing: t("lmMoePrefetchMissing"),
      };
}

/**
 * Whether the advice on NVIDIA's «CUDA Sysmem Fallback» is due (G32.1): Windows with an NVIDIA
 * card and SSD stream on. The driver's setting cannot be read reliably without privileges (it is
 * in the driver's profiles, not in the registry nor in nvidia-smi), so it is explained once.
 */
export function sysmemAdviceDue(
  hw: SetupState["hardware"],
  variant: string,
  streaming: boolean,
  closed: boolean,
): boolean {
  if (closed || !streaming || variant === "cpu") return false;
  if (!(hw.onWindows ?? hw.windowsEngine)) return false;
  return hw.gpus.some((g) => g.vendor === "nvidia" && !g.integrated);
}

export const defaultModelsFolder = (drive: string) => `${drive}:\\RedGiant\\models`;

/** One square of the closing summary: what was set up, and the step that changes it. */
export interface RecapItem {
  step: StepKey;
  icon: "spark" | "monitor" | "crown" | "send" | "shield" | "wallet";
  label: string;
  value: string;
  sub: string;
  /** Set up (off: shown dimmer, still clickable). */
  on: boolean;
}

/** What the summary needs besides the settings: asked to the server by the page. */
export interface RecapExtra {
  models: number;
  godModel: string | null;
  telegramUser: string | null;
}

/** The ways connected, in words: "Claude, Anthropic, a model on this computer". */
export function waysWords(s: SetupState, providerName: (id: string) => string): string[] {
  const out: string[] = [];
  const ways = waysInUse(s);
  if (ways.includes("claude")) out.push("Claude");
  if (ways.includes("chatgpt")) out.push("ChatGPT");
  for (const k of s.secretsSet.keys) out.push(providerName(k));
  if (s.locked.anthropic && !s.secretsSet.keys.includes("anthropic")) out.push("Anthropic");
  if (ways.includes("server")) out.push(t("wzRecapServer"));
  if (ways.includes("local")) out.push(t("wzRecapLocal"));
  return out;
}

/** The closing summary (2026-11-06): six squares, each opening the step it comes from. */
export function recap(
  s: SetupState,
  extra: RecapExtra,
  providerName: (id: string) => string,
): RecapItem[] {
  const ways = waysWords(s, providerName);
  const god = s.names.god ?? "God";
  const demigod = s.names.demigod ?? "Demi-God";
  const engine = s.config.engine;
  const preset = presetOf(s.policy.humanOnly);
  const paid = paysPerUse(s) === true;
  const disk = engine
    ? engine.variant === "windows"
      ? s.hardware.modelDisk?.windows
      : s.hardware.modelDisk?.docker
    : undefined;
  return [
    {
      step: "wzBrain",
      icon: "spark",
      label: t("wzRecapThinks"),
      value: ways.length ? ways.join(", ") : t("wzRecapNothing"),
      sub: ways.length ? t("wzRecapModels", { n: String(extra.models) }) : t("wzRecapNothingSub"),
      on: ways.length > 0,
    },
    {
      step: "wzLocal",
      icon: "monitor",
      label: t("wzRecapComputer"),
      value: engine ? localModelName(engine.model) : t("wzRecapNoLocal"),
      sub: engine
        ? engine.off
          ? t("lmOff")
          : disk
            ? t("wzRecapOnDisk", { disk: `${disk}:` })
            : t("lmInUse")
        : t("wzRecapNoLocalSub"),
      on: !!engine,
    },
    {
      step: "wzNames",
      icon: "crown",
      label: t("wzRecapNames"),
      value: t("wzRecapNamesValue", { god, demigod }),
      sub: extra.godModel
        ? t("wzRecapGodThinks", { god, model: extra.godModel })
        : s.names.godPrompt
          ? t("wzRecapOwnPrompt")
          : t("wzRecapDefaultPrompt"),
      on: true,
    },
    {
      step: "wzTelegram",
      icon: "send",
      label: "Telegram",
      value: extra.telegramUser ? t("wzRecapLinked") : t("wzRecapNotYet"),
      sub: extra.telegramUser
        ? t("wzRecapTelegramSub", { who: extra.telegramUser, demigod })
        : t("wzRecapTelegramLater"),
      on: extra.telegramUser !== null,
    },
    {
      step: "wzSafety",
      icon: "shield",
      label: t("wzRecapApprovals"),
      value: preset ? t(`wzPreset_${preset}`) : t("wzRecapCustom"),
      sub: s.policy.guardian === "auto" ? t("wzRecapGuardAuto") : t("wzRecapGuardAsk"),
      on: true,
    },
    {
      step: "wzSafety",
      icon: "wallet",
      label: t("wzRecapSpending"),
      value: paid
        ? s.budgetUsd !== null
          ? t("wzRecapAtMost", { usd: num(s.budgetUsd, 2) })
          : t("wzRecapNoLimit")
        : t("wzRecapNothingPaid"),
      sub: paid ? t("wzRecapSpendingSub") : t("wzRecapNothingPaidSub"),
      on: true,
    },
  ];
}

/**
 * A processor's name as a person says it (2026-11-06): "AMD Ryzen 9 9900X 12-Core Processor"
 * becomes "Ryzen 9 9900X", made by AMD.
 */
export function cpuShort(cpu: string): { name: string; maker: string | null } {
  const maker = /\bAMD\b/i.test(cpu)
    ? "AMD"
    : /\bIntel\b/i.test(cpu)
      ? "Intel"
      : /\bApple\b/i.test(cpu)
        ? "Apple"
        : null;
  const name = cpu
    .replace(/\((R|TM|C)\)/gi, "")
    .replace(/\b(AMD|Intel|Apple)\b/gi, "")
    .replace(/\bwith Radeon.*$/i, "")
    .replace(/\b\d+-Core\b/i, "")
    .replace(/\b(CPU|Processor)\b/gi, "")
    .replace(/@.*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return { name: name || cpu, maker };
}

/** A graphics card's name without the brand words: "NVIDIA GeForce RTX 4080 SUPER" → "RTX 4080 SUPER". */
export function gpuShort(gpu: string): { name: string; brand: string | null } {
  const m = gpu.match(
    /^(NVIDIA GeForce|NVIDIA|AMD Radeon|AMD|Intel(?:\(R\))? Arc|Intel(?:\(R\))?)\s+(.+)$/i,
  );
  return m
    ? { name: m[2] ?? gpu, brand: (m[1] ?? "").replace(/\(R\)/i, "") }
    : { name: gpu, brand: null };
}

/** The free room to show on the welcome page: the data disk's, else the models' disk. */
export function freeDiskGb(hw: SetupState["hardware"]): number | null {
  if (hw.diskFreeGb !== null) return hw.diskFreeGb;
  const here = hw.modelDisk?.windows ?? hw.modelDisk?.docker;
  return hw.disks?.find((d) => d.name === here)?.freeGb ?? hw.disks?.[0]?.freeGb ?? null;
}
