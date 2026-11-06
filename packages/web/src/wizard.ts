// The setup wizard's logic without the page (2026-11-06, the person's prototype «una cosa alla
// volta»): which steps there are, which can be skipped, the ready choices of the approvals, the
// first models to suggest for each role, the disks for the models and the closing summary.
import { DANGER_IDS } from "@redgiant/protocol";
import type { ModelChoice, SetupState } from "./api.js";
import { lang, t } from "./i18n.js";

/** The wizard's steps; the advanced installation adds where the code lives (G24.5). */
export type StepKey =
  | "wzWelcome"
  | "wzMode"
  | "wzBrain"
  | "wzLocal"
  | "wzNames"
  | "wzAssign"
  | "wzTelegram"
  | "wzCode"
  | "wzRemote"
  | "wzSafety"
  | "wzDone";

/** The two steps only the advanced installation has, right after Telegram. */
export const ADVANCED_STEPS: readonly StepKey[] = ["wzCode", "wzRemote"];

export const stepsFor = (mode: "standard" | "advanced" | undefined): StepKey[] => [
  "wzWelcome",
  "wzMode",
  "wzBrain",
  "wzLocal",
  "wzNames",
  "wzAssign",
  "wzTelegram",
  ...(mode === "advanced" ? ADVANCED_STEPS : []),
  "wzSafety",
  "wzDone",
];

/** Steps that may be left for later: everything works without them. */
const SKIPPABLE: readonly StepKey[] = ["wzBrain", "wzLocal", "wzTelegram", "wzCode", "wzRemote"];
export const skippable = (k: StepKey) => SKIPPABLE.includes(k);

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
      value: engine ? engine.model.replace(/\.gguf$/i, "") : t("wzRecapNoLocal"),
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
