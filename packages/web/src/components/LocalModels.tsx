// "A model on this computer" (G24.3): what this computer can run, the suggested models as
// cards (what each is good at, its size and quality, whether it fits), downloads with a real
// progress bar that can be paused, and starting the engine with its steps and plain errors.
import { estimatedSpeed, type Job } from "@redgiant/protocol";
import { useEffect, useState } from "preact/hooks";
import type { EngineVariant, LocalFile, LocalModelChoice, SetupState } from "../api.js";
import { bytes } from "../format.js";
import { t, tOptional } from "../i18n.js";
import {
  IconAlert,
  IconDisk,
  IconDownload,
  IconFolder,
  IconGpu,
  IconPlay,
  IconRam,
  IconSearch,
  IconTrash,
} from "../icons.js";
import { closeSysmemAdvice, getApi, sysmemAdviceClosed } from "../state.js";
import {
  bigChunksShown,
  type DiskTile,
  defaultModelsFolder,
  diskTiles,
  gbText,
  moePrefetchSwitch,
  moePrefetchTexts,
  num,
  sysmemAdviceDue,
} from "../wizard.js";
import { explain } from "./Brain.js";
import { askConfirm } from "./dialogs.js";
import { Gallery, GalleryCard } from "./Gallery.js";
import { Acts, Sub, Switch } from "./SettingsKit.js";
import { Advanced, Field, JobView, Modal, Pick, Progress, useJob } from "./ui.js";

const gb = (n: number) => `${n.toFixed(1)} GB`;
/** The name a repository's file gets in the models folder (as the server names it). */
const target = (file: string) => (file.split("/").pop() ?? file).replace(/[^\w.-]+/g, "_");

/** What this computer can run, in a sentence. */
export function hardwareText(h: SetupState["hardware"]): string {
  const s = h.suggestion;
  const card = h.gpus.find((g) => !g.integrated) ?? h.gpus[0];
  const max = String(s.maxModelGb);
  if (s.kind === "gpu" && card)
    return t("lmHwGpu", { name: card.name, vram: String(s.vramGb), max });
  if (s.kind === "gpu-unknown") return t("lmHwGpuUnknown");
  if (s.kind === "igpu") return t("lmHwIgpu", { max });
  // A card is there but the engine cannot reach it (AMD and Intel on Windows, for now).
  if (h.gpus.some((g) => !g.integrated)) return t("lmHwUnreachable", { max });
  return t("lmHwCpu", { max });
}

/**
 * The one to suggest: among those that fit at a good quality and are not too slow here, the
 * cleverest (tools and code as tie-breakers); none of them: the largest that fits.
 */
function recommended(models: LocalModelChoice[], hw: SetupState["hardware"]): string | undefined {
  const fitting = models.filter((m) => m.file && !m.beyondMemory);
  const score = (m: LocalModelChoice) => m.scores.smart * 10 + m.scores.tools * 2 + m.scores.code;
  const usable = fitting.filter(
    (m) =>
      m.file?.quality !== "reduced" &&
      estimatedSpeed(m, m.file?.sizeGb ?? 0, hw.suggestion).stars >= 2,
  );
  return ([...usable].sort((a, b) => score(b) - score(a))[0] ?? fitting.at(-1))?.id;
}

/** Five drawn steps: how a model does at one thing, compared with the others (a table cell). */
function Meter({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <span
      role="img"
      class="lm-meter"
      data-label={label}
      aria-label={`${label}: ${value}/5${note ? `, ${note}` : ""}`}
    >
      <span class="lm-meter-bar" aria-hidden="true">
        {[1, 2, 3, 4, 5].map((i) => (
          <span key={i} class={i <= value ? "on" : ""} />
        ))}
      </span>
      {note && <span class="lm-meter-note">{note}</span>}
    </span>
  );
}

/** How much of the room for models the file takes (a table cell). */
/** Where a model's room comes from, in order: the card, then the RAM, then the SSD. */
export interface Tier {
  kind: "card" | "ram" | "memory" | "ssd";
  gb: number;
}

/**
 * The tiers of this computer for local models (2026-11-04): the card's memory, then the RAM free
 * now, then (SSD stream) the models' disk. A card that shares the computer's memory (a GPU in the
 * processor, unified memory) has one tier, the memory.
 */
export function roomTiers(hw: SetupState["hardware"], diskFreeGb?: number): Tier[] {
  const s = hw.suggestion;
  const free = (hw.freeRamGb ?? hw.ramGb * 0.6) * 0.9;
  const tiers: Tier[] =
    s.kind === "gpu" || s.kind === "gpu-unknown"
      ? [
          { kind: "card", gb: s.maxModelGb },
          ...(diskFreeGb !== undefined ? [{ kind: "ram" as const, gb: free }] : []),
        ]
      : [{ kind: "memory", gb: diskFreeGb !== undefined ? free : s.maxModelGb }];
  if (diskFreeGb !== undefined) tiers.push({ kind: "ssd", gb: Math.max(0, diskFreeGb - 10) });
  return tiers.filter((x) => x.gb > 0);
}

/** How a model of `sizeGb` fills the tiers, the first ones first. */
export function placeModel(sizeGb: number, tiers: Tier[]): Tier[] {
  let left = sizeGb;
  const out: Tier[] = [];
  for (const tier of tiers) {
    if (left <= 0) break;
    const take = Math.min(left, tier.gb);
    if (take > 0) out.push({ kind: tier.kind, gb: take });
    left -= take;
  }
  return out;
}

function RoomBar({ sizeGb, tiers }: { sizeGb: number; tiers: Tier[] }) {
  const parts = placeModel(sizeGb, tiers);
  // A big SSD would squash the other tiers: it is drawn at most as wide as card and RAM together.
  const memory = tiers.filter((x) => x.kind !== "ssd").reduce((n, x) => n + x.gb, 0);
  const shown = (tier: Tier) =>
    tier.kind === "ssd" ? Math.min(tier.gb, Math.max(memory, 1)) : tier.gb;
  const total = tiers.reduce((n, x) => n + shown(x), 0);
  const words = parts
    .map((p) => t(`lmTier_${p.kind}`, { gb: gb(Math.round(p.gb * 10) / 10) }))
    .join(" · ");
  return (
    <span class="lm-room" data-label={t("lmRoom")} role="img" aria-label={words}>
      <span class="lm-room-bar" aria-hidden="true">
        {tiers.map((tier) => {
          const used = parts.find((p) => p.kind === tier.kind)?.gb ?? 0;
          return (
            <span
              key={tier.kind}
              class={`lm-tier tier-${tier.kind}`}
              style={{ flexGrow: shown(tier) / Math.max(total, 0.1) }}
            >
              <span
                style={{ width: `${Math.min(100, (used / Math.max(shown(tier), 0.1)) * 100)}%` }}
              />
            </span>
          );
        })}
      </span>
      <span class="lm-meter-note">{words}</span>
    </span>
  );
}

/** The speed measured here for a file, when it ran and was tuned (2026-11-05). */
function measuredTps(s: SetupState, file: string): number | undefined {
  const e = s.config.engine;
  if (!e || e.model !== file) return undefined;
  return e.trials?.find((x) => x.chosen)?.genTps;
}

/**
 * Usable here (2026-11-05, the person: «quelli che possono girare tra gpu e ram, che mi
 * consentano di andare almeno a 10»): the model fits in the card and the computer's whole RAM,
 * nothing from the SSD, and writes at least this many tokens a second there, or measured it.
 * gpt-oss 120B on Rig: about 15, outlined; GLM-4.5 Air: about 5, measured 1-3, not.
 */
export const USABLE_TPS = 10;
function usable(
  m: { totalB: number; activeB: number },
  sizeGb: number,
  hw: Parameters<typeof estimatedSpeed>[2],
  measured: number | undefined,
) {
  if (measured !== undefined) return measured >= USABLE_TPS;
  const all = estimatedSpeed(m, sizeGb, hw);
  return !all.range && all.tokensPerSec >= USABLE_TPS;
}

/** A speed for a card: measured when known, else the estimate (a range when it is uncertain). */
function SpeedText({
  speed,
  measured,
  unit,
}: {
  speed: { tokensPerSec: number; range?: [number, number] };
  measured: number | undefined;
  unit: string;
}) {
  if (measured !== undefined)
    return (
      <>
        {measured} <small>{t("lmSpeedMeasured")}</small>
      </>
    );
  const [low, high] = speed.range ?? [];
  return (
    <>
      {low !== undefined && high !== undefined && low !== high
        ? `${low}–${high}`
        : speed.tokensPerSec}{" "}
      <small>{unit}</small>
    </>
  );
}

const latest = (jobs: Job[], kind: string, model: string) =>
  jobs.filter((j) => j.kind === kind && j.vars.model === model).at(-1);

type Availability = { ok: boolean; reason?: string; warn?: string };

/**
 * SSD stream needs the models on a solid-state disk with room (2026-11-03). The disk is the
 * one the chosen engine keeps its models on: unknown (an older RedGiant.exe) still allows it.
 */
function streamAvailable(s: SetupState, variant: EngineVariant): Availability {
  const hw = s.hardware;
  const name = variant === "windows" ? hw.modelDisk?.windows : hw.modelDisk?.docker;
  const disk =
    hw.disks?.find((d) => d.name === name) ?? (hw.disks?.length === 1 ? hw.disks[0] : undefined);
  if (!disk) return { ok: true, warn: t("lmStreamUnknownDisk") };
  const label = disk.name === "/" ? t("lmStreamThisDisk") : `${disk.name}:`;
  if (disk.ssd === false) return { ok: false, reason: t("lmStreamHdd", { disk: label }) };
  if (disk.freeGb < 20)
    return { ok: false, reason: t("lmStreamNoRoom", { disk: label, free: gb(disk.freeGb) }) };
  if (disk.ssd === null) return { ok: true, warn: t("lmStreamMaybeSsd", { disk: label }) };
  return { ok: true };
}

/**
 * NVIDIA's «CUDA Sysmem Fallback» on Windows (G32.1, Strata's issue #4219): the driver spills to
 * the computer's RAM when the card is full and reading gets 2-3.5 times slower. How to turn it
 * off, until the person closes it; RedGiant never changes the driver's settings itself.
 */
export function SysmemAdvice() {
  return (
    <div class="lm-sysmem" role="note">
      <div class="lm-sysmem-head">
        <IconAlert size={16} />
        <strong>{t("lmSysmemTitle")}</strong>
      </div>
      <p>{t("lmSysmemText")}</p>
      <ol>
        <li>{t("lmSysmemStep1")}</li>
        <li>{t("lmSysmemStep2")}</li>
        <li>{t("lmSysmemStep3")}</li>
        <li>{t("lmSysmemStep4")}</li>
      </ol>
      <button type="button" class="tiny" onClick={closeSysmemAdvice}>
        {t("lmSysmemClose")}
      </button>
    </div>
  );
}

/**
 * The SSD stream's tuning as it happens (2026-11-03): each split of the card tried, the context
 * and the experts' cache it gave, how fast it read and wrote, and the one kept.
 */
type TuneTrial = {
  share: number;
  opOffload?: boolean;
  /** Tokens a pass and the long message read, for the bigger passes' tries (G32.1). */
  batch?: number;
  readTokens?: number;
  ctx: number;
  cacheMib: number;
  state: "running" | "done" | "failed";
  genTps?: number;
  prefillTps?: number;
  /** Seconds of a typical agent's turn: what decides (2026-11-05). */
  turnS?: number;
  chosen?: boolean;
  error?: string;
};

function TuneTrials({
  json,
  onPick,
}: {
  json: string;
  /** Once the tuning is over, another row can be picked: the engine starts again with it. */
  onPick?: (trial: TuneTrial) => void;
}) {
  let trials: TuneTrial[] = [];
  try {
    trials = JSON.parse(json);
  } catch {
    return null;
  }
  return (
    <div class="lm-trials">
      <strong>{t("lmTuneTitle")}</strong>
      <table>
        <thead>
          <tr>
            <th>{t("lmTuneCache")}</th>
            <th>{t("lmTuneCtx")}</th>
            <th>{t("lmTuneRead")}</th>
            <th>{t("lmTuneWrite")}</th>
            <th>{t("lmTuneTurn")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {trials.map((x) => (
            <tr
              key={`${x.share}-${x.opOffload ?? true}-${x.batch ?? 0}`}
              class={x.chosen ? "chosen" : ""}
            >
              <td>
                {gb(x.cacheMib / 1024)} · {Math.round(x.share * 100)}%
                {x.opOffload === false && <span class="sub">{t("lmTuneNoCopy")}</span>}
                {x.batch !== undefined && (
                  <span class="sub">
                    {t("lmTuneBatch", { n: num(x.batch, 0) })}
                    {x.readTokens ? ` · ${t("lmTuneLongRead", { n: num(x.readTokens, 0) })}` : ""}
                  </span>
                )}
              </td>
              <td>{x.ctx ? `${Math.round(x.ctx / 1024)}k` : "–"}</td>
              <td>{x.prefillTps ?? "–"}</td>
              <td>{x.genTps ?? "–"}</td>
              <td>{x.turnS ?? "–"}</td>
              <td>
                {x.state === "running" ? (
                  t("lmTuneRunning")
                ) : x.state === "failed" ? (
                  t("lmTuneFailed")
                ) : x.chosen ? (
                  t("lmTuneChosen")
                ) : onPick ? (
                  <button type="button" class="tiny" onClick={() => onPick(x)}>
                    {t("lmTuneUse")}
                  </button>
                ) : (
                  ""
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p class="ui-help">{t("lmTuneHelp")}</p>
    </div>
  );
}

/**
 * What the activation measured (2026-11-04): how fast the model was read once from the disk,
 * and how fast the warm-up's context was read, the same reading as a first message.
 */
function ActivationSpeeds({ vars }: { vars: Record<string, string> }) {
  if (!vars.preloadGbs && !vars.warmTps) return null;
  return (
    <dl class="gfacts">
      {vars.preloadGbs && (
        <>
          <dt>{t("lmPreloadSpeed")}</dt>
          <dd>{t("lmGbPerSec", { n: vars.preloadGbs })}</dd>
        </>
      )}
      {vars.warmTps && (
        <>
          <dt>{t("lmWarmSpeed")}</dt>
          <dd>{t("lmTokensPerSec", { n: vars.warmTps })}</dd>
        </>
      )}
    </dl>
  );
}

/**
 * Every model file on the disk in one place, with the room it takes and a delete button for each
 * (2026-11-05, the person: «sennò mi trovo con centinaia di giga di monnezza sul pc»). Paused
 * downloads and models no longer suggested are here too.
 */
function DownloadedModels({
  files,
  names,
  jobs,
  active,
  variant,
  onChange,
}: {
  files: LocalFile[];
  /** The suggested models' names by file, for a readable list. */
  names: Map<string, string>;
  jobs: Job[];
  active: string | undefined;
  variant: EngineVariant;
  onChange: () => void;
}) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  if (files.length === 0) return <p class="ui-help">{t("lmDownloadedEmpty")}</p>;
  const remove = async (f: LocalFile) => {
    const name = names.get(f.file) ?? f.file;
    const inUse = active === f.file;
    if (
      !(await askConfirm(
        t(inUse ? "lmDownloadedConfirmActive" : "lmDownloadedConfirm", {
          name,
          size: bytes(f.bytes),
        }),
        { danger: true },
      ))
    )
      return;
    setError(undefined);
    setBusy(f.file);
    void (async () => {
      // The model in use goes too: the engine stops first.
      if (inUse) await getApi().setupEngine(null);
      await getApi().removeModel(f.file, variant);
    })()
      .then(onChange, (e: unknown) => setError(explain(e)))
      .finally(() => setBusy(undefined));
  };
  return (
    <div class="lm-downloaded">
      <p class="ui-help">
        {t("lmDownloadedHelp", { size: bytes(files.reduce((n, f) => n + f.bytes, 0)) })}
      </p>
      {error && <p class="notice error">{error}</p>}
      <table>
        <tbody>
          {[...files]
            .sort((a, b) => b.bytes - a.bytes)
            .map((f) => {
              const downloading = latest(jobs, "model_download", f.file)?.state === "running";
              return (
                <tr key={f.file}>
                  <td>
                    <strong>{names.get(f.file) ?? f.file}</strong>
                    {names.has(f.file) && <div class="ui-help">{f.file}</div>}
                  </td>
                  <td class="num">{bytes(f.bytes)}</td>
                  <td>
                    {active === f.file && <span class="chip ok">{t("lmInUse")}</span>}
                    {downloading ? (
                      <span class="chip">{t("lmDownloadedBusy")}</span>
                    ) : (
                      f.partial && <span class="chip">{t("lmDownloadedPartial")}</span>
                    )}
                  </td>
                  <td>
                    {!downloading && (
                      <button
                        type="button"
                        class="danger tiny"
                        disabled={busy === f.file}
                        onClick={() => remove(f)}
                      >
                        <IconTrash size={13} /> {t("lmDelete")}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
        </tbody>
      </table>
    </div>
  );
}

/** What can be done with one model file: download, pause, go on, start, use, delete. */
function FileActions({
  repo,
  file,
  sizeGb,
  local,
  jobs,
  active,
  variant,
  stream,
  bigChunks,
  moePrefetch,
  speculative,
  off,
  onChange,
}: {
  repo: string | null;
  file: string;
  sizeGb: number | null;
  local: LocalFile | undefined;
  jobs: Job[];
  active: boolean;
  variant: EngineVariant;
  /** Start it with SSD stream (2026-11-03). */
  stream?: boolean;
  /** With SSD stream, bigger reading passes (G32.1, experimental). */
  bigChunks?: boolean;
  /** With SSD stream, the next layer copied ahead (G32.2, experimental). */
  moePrefetch?: boolean;
  /** Start it with speculative decoding (2026-11-04). */
  speculative?: { speculative: "draft" | "ngram"; draftModel?: string } | undefined;
  /** The model in use, turned off by the person (2026-11-04). */
  off?: boolean | undefined;
  onChange: () => void;
}) {
  const name = target(file);
  const dl = latest(jobs, "model_download", name);
  const eng = latest(jobs, "engine", name);
  const [error, setError] = useState<string>();
  const [used, setUsed] = useState(false);
  /** The activation's window closed by the person (it goes on underneath). */
  const [hidden, setHidden] = useState(false);
  const act = (f: () => Promise<unknown>) => {
    setError(undefined);
    void f().then(onChange, (e: unknown) => setError(explain(e)));
  };
  const download = () => repo && act(() => getApi().downloadModel(repo, file, variant));
  let body: preact.JSX.Element;
  if (dl?.state === "running") {
    const p = dl.steps[0]?.progress;
    body = (
      <div class="lm-progress">
        {p ? <Progress progress={p} /> : <span class="ui-help">{t("lmStarting")}</span>}
        <button type="button" class="tiny" onClick={() => act(() => getApi().cancelJob(dl.id))}>
          {t("lmPause")}
        </button>
      </div>
    );
  } else if (local?.partial) {
    body = (
      <div class="row wrap">
        <span class="ui-help">
          {sizeGb
            ? t("lmPaused", { done: bytes(local.bytes), total: gb(sizeGb) })
            : t("lmPausedAt", { done: bytes(local.bytes) })}
        </span>
        {repo && (
          <button type="button" class="primary" onClick={download}>
            {t("lmResume")}
          </button>
        )}
        <button
          type="button"
          class="link"
          onClick={() => act(() => getApi().removeModel(name, variant))}
        >
          {t("lmDiscard")}
        </button>
      </div>
    );
  } else if (local) {
    body = (
      <div class="lm-ready">
        {eng && (eng.state === "running" || eng.state === "failed") && !hidden && (
          <Modal
            title={tOptional(`job_${eng.kind}`, eng.vars) ?? eng.kind}
            onClose={() => setHidden(true)}
          >
            <JobView job={eng} countSteps={["try", "tune"]} />
            {eng.steps.find((x) => x.id === "try")?.state === "running" && (
              <p class="ui-help">{t("lmWarmHelp")}</p>
            )}
            {eng.vars.trials && <TuneTrials json={eng.vars.trials} />}
            <ActivationSpeeds vars={eng.vars} />
          </Modal>
        )}
        {eng?.state === "running" && hidden && (
          <button type="button" class="link" onClick={() => setHidden(false)}>
            {t("lmShowActivation")}
          </button>
        )}
        {eng?.state === "done" && eng.vars.trials && (
          <TuneTrials
            json={eng.vars.trials}
            onPick={(x) =>
              act(() =>
                getApi().setupEngine({
                  variant,
                  model: name,
                  stream,
                  ...(stream && bigChunks && { bigChunks }),
                  ...(stream && moePrefetch && { moePrefetch }),
                  ...speculative,
                  tuning: {
                    moeCacheShare: x.share,
                    opOffload: x.opOffload !== false,
                    ...(x.batch !== undefined && { batch: x.batch }),
                  },
                }),
              )
            }
          />
        )}
        {eng?.state === "done" && <ActivationSpeeds vars={eng.vars} />}
        <div class="row wrap">
          {active && eng?.state !== "running" ? (
            <>
              {/* On or off without deleting it (2026-11-04): off frees its memory and it does
                  not load when RedGiant opens. */}
              {/* A switch, never a check mark (2026-11-07): lit when on, its word beside it. */}
              <span class={`lm-power${off ? "" : " on"}`}>
                <Switch
                  small
                  on={!off}
                  label={off ? t("lmOff") : t("lmOn")}
                  onChange={(v) => act(() => getApi().setEnginePower(v))}
                />
                <span>{off ? t("lmOff") : t("lmOn")}</span>
              </span>
              <button
                type="button"
                class="primary"
                disabled={used}
                onClick={() =>
                  act(async () => {
                    await getApi().setupModels({
                      defaultModel: { provider: "local", model: name },
                    });
                    setUsed(true);
                  })
                }
              >
                {t("lmUseForAgents")}
              </button>
              {used && <span class="notice ok">{t("lmUsedForAgents")}</span>}
            </>
          ) : (
            eng?.state !== "running" && (
              <button
                type="button"
                class="primary"
                onClick={() =>
                  act(() =>
                    getApi().setupEngine({
                      variant,
                      model: name,
                      stream,
                      ...(stream && bigChunks && { bigChunks }),
                      ...(stream && moePrefetch && { moePrefetch }),
                      ...speculative,
                    }),
                  )
                }
              >
                <IconPlay /> {t("lmStart")}
              </button>
            )
          )}
          {eng?.state !== "running" && (
            <button
              type="button"
              class="link"
              onClick={async () => {
                // The model in use goes too (2026-11-04): the engine stops first.
                if (active && !(await askConfirm(t("lmDeleteActiveConfirm"), { danger: true })))
                  return;
                act(async () => {
                  if (active) await getApi().setupEngine(null);
                  await getApi().removeModel(name, variant);
                });
              }}
            >
              <IconTrash size={13} /> {t("lmDelete")}
            </button>
          )}
        </div>
      </div>
    );
  } else {
    body = (
      <div class="row wrap">
        {dl?.state === "failed" && dl.error && (
          <span class="notice error">
            {(dl.error.code && tOptional(`job_error_${dl.error.code}`)) || dl.error.message}
          </span>
        )}
        {repo && (
          <button type="button" class="primary" onClick={download}>
            <IconDownload /> {t("lmDownload", { size: sizeGb ? gb(sizeGb) : "" })}
          </button>
        )}
      </div>
    );
  }
  return (
    <>
      {body}
      {error && <p class="notice error">{error}</p>}
    </>
  );
}

/** Repositories and files of Hugging Face, for those who know what they want. */
function HfSearch({
  jobs,
  files,
  active,
  variant,
  stream,
  bigChunks,
  moePrefetch,
  onChange,
}: {
  jobs: Job[];
  files: LocalFile[];
  active: string | undefined;
  variant: EngineVariant;
  stream: boolean;
  bigChunks?: boolean;
  moePrefetch?: boolean;
  onChange: () => void;
}) {
  const [q, setQ] = useState("");
  const [repos, setRepos] = useState<{ id: string; downloads: number }[]>([]);
  const [repo, setRepo] = useState("");
  const [list, setList] = useState<{ file: string; sizeGb: number }[]>([]);
  const [error, setError] = useState<string>();
  return (
    <div class="lm-search">
      <form
        class="row"
        onSubmit={(e) => {
          e.preventDefault();
          setError(undefined);
          void getApi()
            .hfSearch(q)
            .then(setRepos, (err: unknown) => setError(explain(err)));
        }}
      >
        <input
          aria-label={t("lmSearch")}
          placeholder={t("lmSearchPlaceholder")}
          value={q}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
        />
        <button type="submit">{t("search")}</button>
      </form>
      {repos.length > 0 && (
        <select
          value={repo}
          onChange={(e) => {
            const r = (e.target as HTMLSelectElement).value;
            setRepo(r);
            void getApi()
              .hfFiles(r)
              .then(setList, (err: unknown) => setError(explain(err)));
          }}
        >
          <option value="">{t("wzPickRepo")}</option>
          {repos.map((r) => (
            <option key={r.id} value={r.id}>
              {r.id} · {r.downloads.toLocaleString()} {t("downloads")}
            </option>
          ))}
        </select>
      )}
      {list.length > 0 && (
        <ul class="lm-files">
          {list.map((f) => (
            <li key={f.file}>
              <div class="row">
                <code>{f.file}</code>
                <span class="dim">{gb(f.sizeGb)}</span>
              </div>
              <FileActions
                repo={repo}
                file={f.file}
                sizeGb={f.sizeGb}
                local={files.find((x) => x.file === target(f.file))}
                jobs={jobs}
                active={active === target(f.file)}
                variant={variant}
                stream={stream}
                bigChunks={bigChunks}
                moePrefetch={moePrefetch}
                onChange={onChange}
              />
            </li>
          ))}
        </ul>
      )}
      {error && <p class="notice error">{error}</p>}
    </div>
  );
}

/** What a card says at its foot: in use, ready, downloading, to download, too big. */
function cardState(
  m: LocalModelChoice,
  files: LocalFile[],
  jobs: Job[],
  active: string | undefined,
  off = false,
): string {
  if (!m.file) return m.unavailable ? t("lmUnavailable") : t("lmCardTooBig");
  const name = target(m.file.file);
  const dl = latest(jobs, "model_download", name);
  if (dl?.state === "running") {
    const p = dl.steps[0]?.progress;
    return p?.total
      ? t("lmCardDownloading", { pct: String(Math.round((p.done / p.total) * 100)) })
      : t("lmStarting");
  }
  const local = files.find((f) => f.file === name);
  if (local?.partial) return t("lmCardPaused");
  if (local) return active === name ? (off ? t("lmCardOff") : t("lmInUse")) : t("lmCardReady");
  return t("lmCardGet", { size: gb(m.file.sizeGb) });
}

/**
 * Speculative decoding, an option for those who want it (2026-11-04): what it does, when it
 * helps, and the small model to download when the family has one.
 */
function Speculation({
  m,
  model,
  stream,
  mode,
  setMode,
  files,
  jobs,
  variant,
  onChange,
}: {
  m: LocalModelChoice;
  /** The big model's file in the folder (downloaded), for the speed test. */
  model: string | undefined;
  stream: boolean;
  mode: "none" | "draft" | "ngram";
  setMode: (v: "none" | "draft" | "ngram") => void;
  files: LocalFile[];
  jobs: Job[];
  variant: EngineVariant;
  onChange: () => void;
}) {
  const [error, setError] = useState<string>();
  const [testing, setTesting] = useState(false);
  const draft = m.draftFile;
  const name = draft ? target(draft.file) : "";
  const local = files.find((f) => f.file === name);
  const dl = draft ? latest(jobs, "model_download", name) : undefined;
  const p = dl?.state === "running" ? dl.steps[0]?.progress : undefined;
  return (
    <div class="gspec">
      <span class="ui-label">{t("lmSpecTitle")}</span>
      <p class="ui-help">{t("lmSpecHelp")}</p>
      <div class="gspec-options">
        <Pick small on={mode === "none"} onChange={() => setMode("none")}>
          {t("lmSpecNone")}
        </Pick>
        {draft && (
          <Pick small on={mode === "draft"} onChange={() => setMode("draft")}>
            {t("lmSpecDraft")}
          </Pick>
        )}
        <Pick small on={mode === "ngram"} onChange={() => setMode("ngram")}>
          {t("lmSpecNgram")}
        </Pick>
      </div>
      {mode === "draft" && draft && (
        <>
          <p class="ui-help">{t("lmSpecDraftHelp", { name: name, size: gb(draft.sizeGb) })}</p>
          {local && !local.partial ? (
            <span class="chip ok">{t("lmSpecDraftReady")}</span>
          ) : p ? (
            <Progress progress={p} />
          ) : (
            m.draft && (
              <button
                type="button"
                onClick={() => {
                  setError(undefined);
                  void getApi()
                    .downloadModel(m.draft?.repo ?? "", draft.file, variant)
                    .then(onChange, (e: unknown) => setError(explain(e)));
                }}
              >
                <IconDownload /> {t("lmSpecDraftGet", { size: gb(draft.sizeGb) })}
              </button>
            )
          )}
        </>
      )}
      {mode === "ngram" && <p class="ui-help">{t("lmSpecNgramHelp")}</p>}
      {model && (
        <button type="button" onClick={() => setTesting(true)}>
          {t("lmSpeedTest")}
        </button>
      )}
      {testing && model && (
        <SpeedTest
          variant={variant}
          model={model}
          stream={stream}
          draftModel={local && !local.partial ? name : undefined}
          onClose={() => {
            setTesting(false);
            onChange();
          }}
        />
      )}
      {error && <p class="notice error">{error}</p>}
    </div>
  );
}

/**
 * The speed test of speculative decoding in a window (2026-11-04): first what it will do and
 * what it costs, then each mode as it runs, and the gain over the model alone.
 */
function SpeedTest({
  variant,
  model,
  stream,
  draftModel,
  onClose,
}: {
  variant: EngineVariant;
  model: string;
  stream: boolean;
  draftModel: string | undefined;
  onClose: () => void;
}) {
  const [jobId, setJobId] = useState<string>();
  const [error, setError] = useState<string>();
  const job = useJob(jobId);
  const modes: ("none" | "draft" | "ngram")[] = draftModel
    ? ["none", "draft", "ngram"]
    : ["none", "ngram"];
  let trials: {
    mode: string;
    state: string;
    proseTps?: number;
    codeTps?: number;
    error?: string;
  }[] = [];
  try {
    trials = job?.vars.trials ? JSON.parse(job.vars.trials) : [];
  } catch {
    trials = [];
  }
  const base = trials.find((x) => x.mode === "none");
  const gain = (v: number | undefined, b: number | undefined) =>
    v && b ? ` (×${(v / b).toFixed(1)})` : "";
  return (
    <Modal title={t("lmSpeedTestTitle")} onClose={onClose}>
      {!jobId ? (
        <>
          <p>{t("lmSpeedTestIntro")}</p>
          <p class="notice warn">{t("lmSpeedTestCost")}</p>
          <div class="row">
            <button
              type="button"
              class="primary"
              onClick={() => {
                setError(undefined);
                void getApi()
                  .speedTest({ variant, model, stream, ...(draftModel && { draftModel }) }, modes)
                  .then(
                    (j) => setJobId(j.id),
                    (e: unknown) => setError(explain(e)),
                  );
              }}
            >
              {t("lmSpeedTestStart")}
            </button>
            <button type="button" class="link" onClick={onClose}>
              {t("cancel")}
            </button>
          </div>
        </>
      ) : (
        <>
          {job && <JobView job={job} countSteps={modes} cancellable />}
          {trials.length > 0 && (
            <table class="lm-trials-table">
              <thead>
                <tr>
                  <th>{t("lmSpeedTestMode")}</th>
                  <th>{t("lmSpeedTestProse")}</th>
                  <th>{t("lmSpeedTestCode")}</th>
                </tr>
              </thead>
              <tbody>
                {trials.map((x) => (
                  <tr key={x.mode}>
                    <td>{tOptional(`lmSpeedMode_${x.mode}`) ?? x.mode}</td>
                    <td>
                      {x.proseTps !== undefined
                        ? `${x.proseTps}${x.mode === "none" ? "" : gain(x.proseTps, base?.proseTps)}`
                        : x.state === "running"
                          ? t("lmTuneRunning")
                          : x.state === "skipped"
                            ? t("uiNotNeeded")
                            : x.state === "failed"
                              ? t("lmTuneFailed")
                              : "–"}
                    </td>
                    <td>
                      {x.codeTps !== undefined
                        ? `${x.codeTps}${x.mode === "none" ? "" : gain(x.codeTps, base?.codeTps)}`
                        : "–"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {job?.state === "done" && <p class="ui-help">{t("lmSpeedTestDone")}</p>}
        </>
      )}
      {error && <p class="notice error">{error}</p>}
    </Modal>
  );
}

/** Everything about one suggested model: what it is good at, where it sits, its versions. */
function ModelPanel({
  m,
  s,
  tiers,
  files,
  jobs,
  active,
  variant,
  stream,
  bigChunks,
  moePrefetch,
  onChange,
}: {
  m: LocalModelChoice;
  s: SetupState;
  tiers: Tier[];
  files: LocalFile[];
  jobs: Job[];
  active: string | undefined;
  variant: EngineVariant;
  stream: boolean;
  bigChunks?: boolean;
  moePrefetch?: boolean;
  onChange: () => void;
}) {
  const [pick, setPick] = useState(m.file?.file);
  useEffect(() => setPick(m.file?.file), [m.id, m.file?.file]);
  const file = m.versions?.find((v) => v.file === pick) ?? m.file;
  const hw = { ...s.hardware.suggestion, ramGb: s.hardware.freeRamGb ?? s.hardware.ramGb };
  const speed = file ? estimatedSpeed(m, file.sizeGb, hw) : undefined;
  const name = file ? target(file.file) : "";
  const inUse = !!file && active === name;
  const plan = inUse && s.config.engine?.stream ? s.config.engine.plan : undefined;
  // Speculative decoding (2026-11-04): what runs now for this model, and what the person picks.
  const running = inUse ? (s.config.engine?.speculative ?? "none") : "none";
  const [spec, setSpec] = useState<"none" | "draft" | "ngram">(running);
  const draftName = m.draftFile ? target(m.draftFile.file) : undefined;
  const draftReady = !!draftName && files.some((f) => f.file === draftName && !f.partial);
  const chosenSpec =
    spec === "ngram"
      ? { speculative: "ngram" as const }
      : spec === "draft" && draftReady && draftName
        ? { speculative: "draft" as const, draftModel: draftName }
        : undefined;
  const sameSpec = (chosenSpec?.speculative ?? "none") === running;
  const memory = tiers.filter((x) => x.kind !== "ssd").reduce((n, x) => n + x.gb, 0);
  const room = tiers.reduce((n, x) => n + x.gb, 0);
  return (
    <>
      <p class="ui-help">{tOptional(`lm_${m.id}`) ?? ""}</p>
      {speed && file && (
        <div class="row wrap">
          <span class="gcard-big">
            <SpeedText speed={speed} measured={measuredTps(s, name)} unit={t("lmSpeedEstimate")} />
          </span>
          {plan && (
            <span class="gcard-big">
              {Math.round(plan.ctx / 1024)}k <small>{t("lmContextTokens")}</small>
            </span>
          )}
        </div>
      )}
      <div class="gscores">
        {(["smart", "code", "tools", "languages"] as const).map((k) => (
          <div key={k} class="gscore">
            {t(`lmScore_${k}`)}
            <Meter label={t(`lmScore_${k}`)} value={m.scores[k]} />
          </div>
        ))}
      </div>
      {file ? (
        <>
          <div>
            <span class="ui-label">{t("lmWhere")}</span>
            <RoomBar sizeGb={file.sizeGb} tiers={tiers} />
          </div>
          {file.sizeGb > memory && <p class="notice warn">{t("lmBeyondMemory")}</p>}
          {plan && (
            <dl class="gfacts">
              {plan.moeCacheMib > 0 && (
                <>
                  <dt>{t("lmFactCache")}</dt>
                  <dd>{gb(plan.moeCacheMib / 1024)}</dd>
                </>
              )}
              <dt>{t("lmFactSsd")}</dt>
              <dd>
                {plan.source === "ssd"
                  ? t("lmFactSsdGb", { gb: plan.ssdGbPerWord.toFixed(2) })
                  : t("lmFactSsdNone")}
              </dd>
              {plan.ramGb !== undefined && (
                <>
                  <dt>{t("lmFactRam")}</dt>
                  <dd>{gb(plan.ramGb)}</dd>
                </>
              )}
            </dl>
          )}
          {m.versions && m.versions.length > 1 && (
            <label class="gversions">
              <span class="ui-label">{t("lmVersions")}</span>
              <select value={pick} onChange={(e) => setPick((e.target as HTMLSelectElement).value)}>
                {m.versions
                  .filter((v) => v.file === m.file?.file || v.sizeGb <= room)
                  .map((v) => (
                    <option key={v.file} value={v.file}>
                      {v.quant ?? "GGUF"} · {gb(v.sizeGb)} · {t(`lmQuality_${v.quality}`)}
                      {v.file === m.file?.file ? ` · ${t("lmVersionSuggested")}` : ""}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <Speculation
            m={m}
            model={files.some((f) => f.file === name && !f.partial) ? name : undefined}
            stream={stream}
            mode={spec}
            setMode={setSpec}
            files={files}
            jobs={jobs}
            variant={variant}
            onChange={onChange}
          />
          <FileActions
            repo={m.repo}
            file={file.file}
            sizeGb={file.sizeGb}
            local={files.find((f) => f.file === name)}
            jobs={jobs}
            active={inUse && sameSpec}
            variant={variant}
            stream={stream}
            bigChunks={bigChunks}
            moePrefetch={moePrefetch}
            speculative={chosenSpec}
            off={inUse && s.config.engine?.off === true}
            onChange={onChange}
          />
        </>
      ) : (
        <p class="notice">
          {m.unavailable
            ? t("lmUnavailable")
            : t("lmTooBig", {
                need: m.smallestGb ? gb(m.smallestGb) : "?",
                max: gb(memory),
              })}
        </p>
      )}
    </>
  );
}

/** What the last start with SSD stream decided: context, the experts' cache, the source. */
type StreamPlan = {
  ctx: number;
  moeCacheMib: number;
  source: string;
  ssdGbPerWord: number;
  ramGb?: number;
};

function planText(plan: StreamPlan): string {
  return t("lmStreamPlan", {
    ctx: `${Math.round(plan.ctx / 1024)}k`,
    cache: plan.moeCacheMib > 0 ? t("lmStreamCache", { gb: gb(plan.moeCacheMib / 1024) }) : "",
    source:
      plan.source === "ssd"
        ? t("lmStreamFromSsd", { gb: plan.ssdGbPerWord.toFixed(2) })
        : plan.source === "ram"
          ? t("lmStreamFromRam")
          : t("lmStreamFromCard"),
    ram: plan.ramGb !== undefined ? gb(plan.ramGb) : "?",
  });
}

/** An experimental switch under SSD stream (G32.1, G32.2): its name, the badge, what it does. */
export function ExpSwitch({
  title,
  help,
  on,
  disabled = false,
  note,
  onChange,
}: {
  title: string;
  help: string;
  on: boolean;
  disabled?: boolean;
  /** Why it cannot be turned on, when it cannot. */
  note?: string | undefined;
  onChange: (on: boolean) => void;
}) {
  return (
    <div class="wz-big">
      <div class="wz-tog">
        <h4>
          {title}
          <span class="exp-badge">{t("lmExperimental")}</span>
        </h4>
        <Switch small on={on && !disabled} label={title} disabled={disabled} onChange={onChange} />
      </div>
      <p class="dim">{help}</p>
      {note && <p class="notice">{note}</p>}
    </div>
  );
}

/**
 * «Next layer ahead» (G32.2), next to SSD stream: llama.cpp with RedGiant's patch, experimental and
 * off by default. Where this version has no patched binaries it says so and cannot be turned on.
 */
export function MoePrefetchSwitch({
  state,
  on,
  onChange,
  variant = "windows",
}: {
  state: "available" | "missing";
  on: boolean;
  onChange: (on: boolean) => void;
  /** The engine: the Windows zip or, with `cuda`, the patched image in Docker. */
  variant?: EngineVariant;
}) {
  const missing = state === "missing";
  const texts = moePrefetchTexts(variant);
  return (
    <ExpSwitch
      title={t("lmMoePrefetch")}
      help={texts.help}
      on={on}
      disabled={missing}
      note={missing ? texts.missing : undefined}
      onChange={onChange}
    />
  );
}

/**
 * The wizard's computer (2026-11-06, the person's prototype): the card and the RAM on the left,
 * the SSD stream switch inside the same box on the right.
 */
function WzMachine({
  s,
  variant,
  on,
  available,
  onChange,
  big,
  prefetch,
  room,
  plan,
}: {
  s: SetupState;
  variant: EngineVariant;
  on: boolean;
  available: Availability;
  onChange: (on: boolean) => void;
  /**
   * Settings only (2026-11-06): the bar of where the model in use sits (card, RAM, SSD), the RAM
   * free now and the SSD's room, as the old «This computer» box had them.
   */
  room?: { tiers: Tier[]; activeGb: number; diskFreeGb: number | undefined } | undefined;
  /** Settings only: what the last start with SSD stream decided. */
  plan?: StreamPlan | undefined;
  /** The bigger passes' switch (G32.1), when SSD stream is on with a card. */
  big?: { on: boolean; onChange: (on: boolean) => void } | undefined;
  /** «Next layer ahead» (G32.2): Windows, an NVIDIA card, SSD stream on. */
  prefetch?:
    | { state: "available" | "missing"; on: boolean; onChange: (on: boolean) => void }
    | undefined;
}) {
  const [info, setInfo] = useState(false);
  const hw = s.hardware;
  const card = hw.gpus.find((g) => !g.integrated);
  const shared = hw.suggestion.kind !== "gpu" && hw.suggestion.kind !== "gpu-unknown";
  const name = variant === "windows" ? hw.modelDisk?.windows : hw.modelDisk?.docker;
  const disk = name && name !== "/" ? `${name}:` : t("lmStreamThisDisk");
  return (
    <div class="wz-machine">
      <div class="wz-machine-l">
        <div class="wz-eyebrow">{t("lmThisPc")}</div>
        {!shared && card && (
          <div class="wz-mrow">
            <IconGpu size={22} />
            <span>
              <b>{card.name}</b> · {t("wzVram", { gb: gbText(hw.suggestion.vramGb) })}
            </span>
          </div>
        )}
        <div class="wz-mrow">
          <IconRam size={22} />
          <span>
            <b>{gbText(hw.ramGb)}</b> {t("wzOfRamLong")}
            {room && (
              <small class="wz-msub">
                {t("lmPartRamSub", { free: gb(hw.freeRamGb ?? hw.ramGb * 0.6) })}
              </small>
            )}
          </span>
        </div>
        {room?.diskFreeGb !== undefined && (
          <div class="wz-mrow">
            <IconDisk size={22} />
            <span>
              <b>{t("lmPartSsd")}</b>
              <small class="wz-msub">{t("lmPartSsdSub", { free: gb(room.diskFreeGb) })}</small>
            </span>
          </div>
        )}
        <div class="dim">
          {shared ? hardwareText(hw) : t("wzFitsUpTo", { max: gbText(hw.suggestion.maxModelGb) })}
        </div>
        {room && (
          <div class="wz-room">
            <RoomBar sizeGb={room.activeGb} tiers={room.tiers} />
            <div class="tier-legend">
              {room.tiers.map((x) => (
                <span key={x.kind}>
                  <i class={`tier-${x.kind}`} />
                  {t(`lmLegend_${x.kind}`)}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
      <div class="wz-machine-r">
        <div class="wz-tog">
          <h3>{t("lmStream")}</h3>
          <Switch on={on} label={t("lmStream")} disabled={!available.ok} onChange={onChange} />
        </div>
        <p class="dim">{on ? t("wzStreamOn", { disk }) : t("wzStreamOff")}</p>
        {!available.ok && <p class="notice">{available.reason}</p>}
        {available.ok && available.warn && <p class="ui-help">{available.warn}</p>}
        <button type="button" class="wz-link inl" onClick={() => setInfo(true)}>
          {t("wzHowItWorks")}
        </button>
        {big && (
          <ExpSwitch
            title={t("lmBigChunks")}
            help={t("lmBigChunksHelp")}
            on={big.on}
            onChange={big.onChange}
          />
        )}
        {prefetch && <MoePrefetchSwitch {...prefetch} variant={variant} />}
        {plan && <p class="dim">{planText(plan)}</p>}
      </div>
      {info && (
        <Modal title={t("lmStream")} onClose={() => setInfo(false)}>
          <p class="wz-lead2">{t("wzStreamInfo1")}</p>
          <p>{t("wzStreamInfo2")}</p>
          <p>{t("wzStreamInfo3")}</p>
          <Acts>
            <button type="button" class="wz-btn primary" onClick={() => setInfo(false)}>
              {t("wzUnderstood")}
            </button>
          </Acts>
        </Modal>
      )}
    </div>
  );
}

/**
 * Where the models are (2026-11-06): one square per disk with its free room, the models' one lit;
 * on Windows a click moves them there, and each disk has a button to choose the folder.
 */
function WzDisks({
  s,
  variant,
  onMoved,
}: {
  s: SetupState;
  variant: EngineVariant;
  onMoved: () => void;
}) {
  const [jobId, setJobId] = useState<string>();
  const job = useJob(jobId);
  const [ask, setAsk] = useState<{ tile: DiskTile; folder: boolean } | null>(null);
  const [folder, setFolder] = useState("");
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (job?.state === "done") onMoved();
  }, [job?.state]);
  const tiles = diskTiles(s.hardware, variant);
  const moving = job?.state === "running";
  const start = (drive: string, to?: string) => {
    setError(undefined);
    setAsk(null);
    void getApi()
      .moveModels(drive, "models", to)
      .then(
        (j) => setJobId(j.id),
        (e: unknown) => setError(explain(e)),
      );
  };
  const choose = (d: DiskTile) => {
    if (d.here || !d.canMove || moving) return;
    setAsk({ tile: d, folder: false });
  };
  return (
    <>
      <Sub title={t("wzDisksTitle")} />
      <p class="wz-subl">{t("wzDisksLead")}</p>
      <div class={`wz-disks n${Math.min(tiles.length, 4)}`}>
        {tiles.map((d) => (
          // biome-ignore lint/a11y/useSemanticElements: a square with a button inside it.
          <div
            key={d.label}
            class={`wz-tile wz-disk${d.here ? " on" : ""}${d.canMove && !d.here ? " movable" : ""}`}
            role="button"
            tabIndex={0}
            aria-pressed={d.here}
            onClick={() => choose(d)}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
              e.preventDefault();
              choose(d);
            }}
          >
            <div class="wz-disk-top">
              <span class="wz-letter">{d.label}</span>
              <span class="wz-here">{d.here ? t("wzHereNow") : ""}</span>
            </div>
            <div class="wz-disk-kind">{d.kind}</div>
            {d.usedPct !== null && (
              <div class="wz-bar">
                <i style={{ width: `${d.usedPct}%` }} />
              </div>
            )}
            {d.freeGb !== null && (
              <div class="wz-free">
                <b>{gbText(d.freeGb)}</b>{" "}
                <span class="dim">
                  {d.totalGb ? t("wzFreeOf", { total: num(d.totalGb, 0) }) : t("wzFree")}
                </span>
              </div>
            )}
            {d.hdd && <div class="wz-disk-warn">{t("wzDiskHdd")}</div>}
            {d.name && (
              <button
                type="button"
                class="wz-btn small"
                disabled={!d.canMove || moving}
                onClick={(e) => {
                  e.stopPropagation();
                  setFolder(defaultModelsFolder(d.name));
                  setAsk({ tile: d, folder: true });
                }}
              >
                <IconFolder size={18} />
                {t("wzPickFolder")}
              </button>
            )}
          </div>
        ))}
      </div>
      {!tiles.some((d) => d.canMove) && (
        <p class="ui-help wz-center">{t(tiles[0]?.name ? "wzDisksNoMove" : "wzDisksOne")}</p>
      )}
      {job && <JobView job={job} />}
      {error && <p class="notice error">{error}</p>}
      {ask && !ask.folder && (
        <Modal title={t("wzMoveTitle", { disk: ask.tile.label })} onClose={() => setAsk(null)}>
          <p class="wz-lead2">
            {t("wzMoveLead", {
              kind: ask.tile.kind,
              free: ask.tile.freeGb !== null ? gbText(ask.tile.freeGb) : "?",
              folder: defaultModelsFolder(ask.tile.name),
            })}
          </p>
          <Acts>
            <button type="button" class="wz-btn quiet" onClick={() => setAsk(null)}>
              {t("cancel")}
            </button>
            <button type="button" class="wz-btn primary" onClick={() => start(ask.tile.name)}>
              {t("wzMoveHere")}
            </button>
          </Acts>
        </Modal>
      )}
      {ask?.folder && (
        <Modal title={t("wzFolderTitle", { disk: ask.tile.label })} onClose={() => setAsk(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              start(ask.tile.name, folder.trim());
            }}
          >
            <p class="wz-lead2">{t("wzFolderLead")}</p>
            <Field label={t("wzFolder")} help={t("wzFolderHelp")}>
              <input
                class="wz-field mono"
                autocomplete="off"
                spellcheck={false}
                value={folder}
                onInput={(e) => setFolder((e.target as HTMLInputElement).value)}
              />
            </Field>
            <Acts>
              <button type="button" class="wz-btn quiet" onClick={() => setAsk(null)}>
                {t("cancel")}
              </button>
              <button
                type="submit"
                class="wz-btn primary"
                disabled={!folder.trim().toUpperCase().startsWith(`${ask.tile.name}:`)}
              >
                {t("wzUseFolder")}
              </button>
            </Acts>
          </form>
        </Modal>
      )}
    </>
  );
}

export function LocalModels({
  s,
  reload,
  wizard,
}: {
  s: SetupState;
  reload: () => void;
  /** The wizard's layout (2026-11-06): the computer, the disks, the models in two groups. */
  wizard?: boolean;
}) {
  const [data, setData] = useState<{
    models: LocalModelChoice[];
    files: LocalFile[];
    budgetGb?: number;
    diskFreeGb?: number;
  }>();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [variant, setVariant] = useState<EngineVariant>(
    s.config.engine?.variant ?? s.hardware.suggestion.engine,
  );
  const [error, setError] = useState<string>();
  const [stream, setStream] = useState(s.config.engine?.stream ?? false);
  const [bigChunks, setBigChunks] = useState(s.config.engine?.bigChunks ?? false);
  const [moePrefetch, setMoePrefetch] = useState(s.config.engine?.moePrefetch ?? false);
  /** The card whose panel is open: a model's id, `file:` and a file, or `hf`. */
  const [open, setOpen] = useState<string | null>(null);
  /** On a phone the wizard shows one group at a time. */
  const [tab, setTab] = useState<"fit" | "slow">("fit");
  const canStream = streamAvailable(s, variant);
  const load = (v: EngineVariant = variant, st: boolean = stream) => {
    void getApi()
      .localModels(v, st && canStream.ok)
      .then(setData, (e: unknown) => setError(explain(e)));
    void getApi()
      .jobs()
      .then(setJobs, () => {});
  };
  // Each engine keeps its models in its own folder: changing engine shows that folder.
  useEffect(() => load(variant, stream), [variant, stream]);
  // While something runs, its progress is read every second; when it ends, everything again.
  const running = jobs.some((j) => j.state === "running");
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(
      () =>
        void getApi()
          .jobs()
          .then(
            (next) => {
              setJobs(next);
              if (!next.some((j) => j.state === "running")) {
                load();
                reload();
              }
            },
            () => {},
          ),
      1000,
    );
    return () => clearInterval(timer);
  }, [running]);
  const changed = () => {
    load();
    reload();
  };
  const active = s.config.engine?.model;
  const best = data && recommended(data.models, s.hardware);
  const streaming = stream && canStream.ok;
  // The options next to SSD stream (G32.1): bigger passes and NVIDIA's advice on Windows.
  const showBig = bigChunksShown(s.hardware, variant, streaming);
  const bigOn = showBig && bigChunks;
  // «Next layer ahead» (G32.2): Windows and NVIDIA, only where the patched binaries exist.
  const prefetchState = moePrefetchSwitch(s, variant, streaming);
  const prefetchOn = prefetchState === "available" && moePrefetch;
  const sysmem = sysmemAdviceDue(s.hardware, variant, streaming, sysmemAdviceClosed.value);
  const tiers = roomTiers(s.hardware, streaming ? data?.diskFreeGb : undefined);
  const files = data?.files ?? [];
  // The model in use, drawn on the computer's bar: what is in the card, in RAM, on the SSD.
  const activeModel = data?.models.find((m) => m.file && target(m.file.file) === active);
  const activeGb =
    active && !s.config.engine?.off
      ? (activeModel?.file?.sizeGb ?? (files.find((f) => f.file === active)?.bytes ?? 0) / 1e9)
      : 0;
  const known = new Set(data?.models.flatMap((m) => (m.file ? [target(m.file.file)] : [])) ?? []);
  const others = files.filter((f) => !known.has(f.file) && !f.partial);
  const hw = { ...s.hardware.suggestion, ramGb: s.hardware.freeRamGb ?? s.hardware.ramGb };
  // What can run between the card and all of the RAM (other programs can be closed).
  const wholeRam = { ...s.hardware.suggestion, ramGb: s.hardware.ramGb };
  const openModel = data?.models.find((m) => m.id === open);
  const openFile = open?.startsWith("file:")
    ? others.find((f) => `file:${f.file}` === open)
    : undefined;
  const panel = openModel
    ? {
        title: openModel.name,
        wide: true,
        body: (
          <ModelPanel
            key={openModel.id}
            m={openModel}
            s={s}
            tiers={tiers}
            files={files}
            jobs={jobs}
            active={active}
            variant={variant}
            stream={streaming}
            bigChunks={bigOn}
            moePrefetch={prefetchOn}
            onChange={changed}
          />
        ),
      }
    : openFile
      ? {
          title: openFile.file,
          body: (
            <>
              <p class="ui-help">{t("lmOtherHelp", { size: bytes(openFile.bytes) })}</p>
              <FileActions
                repo={null}
                file={openFile.file}
                sizeGb={null}
                local={openFile}
                jobs={jobs}
                active={active === openFile.file}
                variant={variant}
                stream={streaming}
                bigChunks={bigOn}
                moePrefetch={prefetchOn}
                onChange={changed}
              />
            </>
          ),
        }
      : open === "disk"
        ? {
            title: t("lmDownloadedTitle"),
            body: (
              <DownloadedModels
                files={files}
                names={
                  new Map(
                    data?.models.flatMap((m) => (m.file ? [[target(m.file.file), m.name]] : [])) ??
                      [],
                  )
                }
                jobs={jobs}
                active={active}
                variant={variant}
                onChange={changed}
              />
            ),
          }
        : open === "hf"
          ? {
              title: t("lmSearch"),
              body: (
                <>
                  <p class="ui-help">{t("lmSearchHint")}</p>
                  <HfSearch
                    jobs={jobs}
                    files={files}
                    active={active}
                    variant={variant}
                    stream={streaming}
                    bigChunks={bigOn}
                    moePrefetch={prefetchOn}
                    onChange={changed}
                  />
                </>
              ),
            }
          : null;
  const engineField = (
    <Advanced>
      <Field label={t("lmEngine")} help={t("lmEngineHelp")}>
        <select
          value={variant}
          onChange={(e) => setVariant((e.target as HTMLSelectElement).value as EngineVariant)}
        >
          {(s.hardware.windowsEngine
            ? // On Windows only the engine that runs natively (2026-11-04).
              (["windows"] as const)
            : (["cpu", "cuda", "vulkan"] as const)
          ).map((v) => (
            <option key={v} value={v}>
              {/* A Mac runs the same engine next to RedGiant, with Metal (2026-11-05). */}
              {t(v === "windows" && s.hardware.os === "darwin" ? "lmEngine_mac" : `lmEngine_${v}`)}
              {v === s.hardware.suggestion.engine ? ` (${t("lmRecommended")})` : ""}
            </option>
          ))}
        </select>
      </Field>
    </Advanced>
  );
  const off = s.config.engine?.off === true;
  const works = (m: LocalModelChoice) =>
    !!m.file && usable(m, m.file.sizeGb, wholeRam, measuredTps(s, target(m.file.file)));
  const tagOf = (m: LocalModelChoice) => {
    if (!m.file) return m.unavailable ? t("lmUnavailable") : t("lmCardTooBig");
    const name = target(m.file.file);
    if (active === name) return off ? t("lmOff") : t("lmInUse");
    const busy = latest(jobs, "model_download", name)?.state === "running";
    if (busy || files.some((f) => f.file === name)) return cardState(m, files, jobs, active, off);
    return m.id === best ? t("lmRecommended") : "";
  };
  const card = (m: LocalModelChoice) => {
    const speed = m.file ? estimatedSpeed(m, m.file.sizeGb, hw) : undefined;
    const inUse = !!m.file && active === target(m.file.file);
    return (
      <GalleryCard
        key={m.id}
        selected={open === m.id}
        tone={works(m) ? "usable" : inUse ? "ok" : undefined}
        onOpen={() => setOpen(m.id)}
      >
        <span class="wz-mtag">{tagOf(m) || "\u00a0"}</span>
        <strong class="wz-mname">{m.name}</strong>
        <span class="wz-mkind">
          {t(m.activeB < m.totalB ? "wzMoe" : "wzDense", { b: num(m.totalB, 1) })}
        </span>
        <span class="wz-mmeta">
          <span class="wz-mspd">
            {speed && m.file ? (
              <SpeedText
                speed={speed}
                measured={measuredTps(s, target(m.file.file))}
                unit={t("lmTokensUnit")}
              />
            ) : (
              "–"
            )}
          </span>
          <span class="dim">{m.file ? gbText(m.file.sizeGb) : ""}</span>
        </span>
      </GalleryCard>
    );
  };
  const fit = data?.models.filter(works) ?? [];
  const slow = data?.models.filter((m) => !works(m)) ?? [];
  return (
    <div class="lm wz-lm" data-tab={tab}>
      <WzMachine
        s={s}
        variant={variant}
        on={streaming}
        available={canStream}
        onChange={(v) => setStream(v)}
        room={
          wizard
            ? undefined
            : { tiers, activeGb, diskFreeGb: streaming ? data?.diskFreeGb : undefined }
        }
        plan={!wizard && streaming && s.config.engine?.stream ? s.config.engine.plan : undefined}
        big={showBig ? { on: bigChunks, onChange: setBigChunks } : undefined}
        prefetch={
          prefetchState
            ? { state: prefetchState, on: moePrefetch, onChange: setMoePrefetch }
            : undefined
        }
      />
      {sysmem && <SysmemAdvice />}
      {s.locked.engine && <p class="notice">{t("wzLocked")}</p>}
      {error && <p class="notice error">{error}</p>}
      <WzDisks s={s} variant={variant} onMoved={changed} />
      <Sub title={t("wzPickModel")} />
      <div class="wz-legend">
        <i />
        <span>{t("wzLegend", { n: String(USABLE_TPS) })}</span>
      </div>
      {/* Settings say what the bars and the speeds are (the old page's hints, 2026-11-06). */}
      {!wizard && <p class="wz-subl">{t("lmScoresHint")}</p>}
      {!data && <p class="ui-help">{t("lmLoading")}</p>}
      <div class="wz-mtabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "fit"}
          class={tab === "fit" ? "on" : ""}
          onClick={() => setTab("fit")}
        >
          {t("wzFitTab")} <small>· {fit.length}</small>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "slow"}
          class={tab === "slow" ? "on" : ""}
          onClick={() => setTab("slow")}
        >
          {t("wzSlowTab")} <small>· {slow.length}</small>
        </button>
      </div>
      <div class="wz-group fit">
        <div class="wz-ghead">
          <h3>{t("wzFitTitle")}</h3>
          <span>{t("wzNModels", { n: String(fit.length) })}</span>
        </div>
        {data && fit.length === 0 && <p class="ui-help">{t("wzFitNone")}</p>}
        <Gallery panel={panel} onClose={() => setOpen(null)}>
          {fit.map(card)}
        </Gallery>
      </div>
      <div class="wz-group slow">
        <div class="wz-ghead">
          <h3>{t("wzSlowTitle")}</h3>
          <span>{t("wzNModels", { n: String(slow.length) })}</span>
        </div>
        <Gallery panel={null} onClose={() => setOpen(null)}>
          {slow.map(card)}
        </Gallery>
      </div>
      <div class="wz-group more">
        <div class="wz-ghead">
          <h3>{t("wzMoreModels")}</h3>
        </div>
        <Gallery panel={null} onClose={() => setOpen(null)}>
          {others.map((f) => (
            <GalleryCard
              key={f.file}
              selected={open === `file:${f.file}`}
              tone={active === f.file ? "ok" : undefined}
              onOpen={() => setOpen(`file:${f.file}`)}
            >
              <span class="wz-mtag">{active === f.file ? t("lmInUse") : t("lmOther")}</span>
              <strong class="wz-mname gcard-file">{f.file}</strong>
              <span class="wz-mmeta">
                <span />
                <span class="dim">{bytes(f.bytes)}</span>
              </span>
            </GalleryCard>
          ))}
          <GalleryCard selected={open === "disk"} onOpen={() => setOpen("disk")}>
            <span class="gcard-head">
              <strong>{t("lmDownloadedTitle")}</strong>
              <IconTrash size={16} />
            </span>
            <span class="gcard-note">
              {t("lmDownloadedNote", {
                n: String(files.length),
                size: bytes(files.reduce((n, f) => n + f.bytes, 0)),
              })}
            </span>
          </GalleryCard>
          <GalleryCard selected={open === "hf"} onOpen={() => setOpen("hf")}>
            <span class="gcard-head">
              <strong>{t("lmSearch")}</strong>
              <IconSearch size={16} />
            </span>
            <span class="gcard-note">{t("lmSearchHint")}</span>
          </GalleryCard>
        </Gallery>
      </div>
      {engineField}
    </div>
  );
}
