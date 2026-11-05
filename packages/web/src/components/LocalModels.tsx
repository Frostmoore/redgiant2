// "A model on this computer" (G24.3): what this computer can run, the suggested models as
// cards (what each is good at, its size and quality, whether it fits), downloads with a real
// progress bar that can be paused, and starting the engine with its steps and plain errors.
import { estimatedSpeed, type Job } from "@redgiant/protocol";
import { useEffect, useState } from "preact/hooks";
import type { EngineVariant, LocalFile, LocalModelChoice, SetupState } from "../api.js";
import { bytes } from "../format.js";
import { t, tOptional } from "../i18n.js";
import {
  IconBox,
  IconChevron,
  IconCpu,
  IconDownload,
  IconLayers,
  IconPlay,
  IconSearch,
  IconTrash,
} from "../icons.js";
import { attempt, getApi } from "../state.js";
import { explain } from "./Brain.js";
import { Gallery, GalleryCard } from "./Gallery.js";
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
 * Where the models are, and the other SSDs they can go to (Windows, 2026-11-03): the Windows
 * engine's folder moves with a bar; for the engines in Docker the whole distribution moves
 * (projects too) and RedGiant starts again.
 */
function ModelsDisk({
  s,
  variant,
  onMoved,
}: {
  s: SetupState;
  variant: EngineVariant;
  onMoved: () => void;
}) {
  const [jobId, setJobId] = useState<string>();
  const [restarting, setRestarting] = useState(false);
  const job = useJob(jobId);
  useEffect(() => {
    if (job?.state === "done") onMoved();
  }, [job?.state]);
  const hw = s.hardware;
  if (!(hw.onWindows ?? hw.windowsEngine) || !hw.disks?.length) return null;
  const kind = variant === "windows" ? "models" : "distro";
  const here = variant === "windows" ? hw.modelDisk?.windows : hw.modelDisk?.docker;
  const current = hw.disks.find((d) => d.name === here);
  const kindOf = (d: { ssd: boolean | null; bus: string }) =>
    `${d.ssd === true ? "SSD" : d.ssd === false ? t("lmDiskHdd") : t("lmDiskUnknown")}${d.bus !== "other" ? ` ${d.bus.toUpperCase()}` : ""}`;
  const move = (drive: string) => {
    if (kind === "distro" && !confirm(t("lmMoveDistroConfirm", { disk: `${drive}:` }))) return;
    void attempt(() => getApi().moveModels(drive, kind)).then((j) => {
      if (!j) return;
      if (kind === "distro") setRestarting(true);
      else setJobId(j.id);
    });
  };
  return (
    <div class="lm-disk">
      <strong>{t("lmDiskTitle")}</strong>
      <p class="ui-help">
        {current
          ? t("lmDiskNow", {
              disk: `${current.name}:`,
              kind: kindOf(current),
              free: gb(current.freeGb),
            })
          : t("lmDiskNowUnknown")}
      </p>
      <ul>
        {hw.disks
          .filter((d) => d.name !== here)
          .map((d) => (
            <li key={d.name} class="row">
              <span>
                <strong>{d.name}:</strong> {kindOf(d)} · {t("lmDiskFree", { free: gb(d.freeGb) })}
              </span>
              <button
                type="button"
                disabled={d.ssd === false || job?.state === "running" || restarting}
                title={d.ssd === false ? t("lmStreamHdd", { disk: `${d.name}:` }) : undefined}
                onClick={() => move(d.name)}
              >
                {t("lmDiskMove")}
              </button>
            </li>
          ))}
      </ul>
      <p class="ui-help">{kind === "models" ? t("lmMoveModelsHelp") : t("lmMoveDistroHelp")}</p>
      {job && <JobView job={job} />}
      {restarting && <p class="notice">{t("lmMoveDistroRunning")}</p>}
    </div>
  );
}

/** The switch with what it does, why it is off when it is, and what the last start decided. */
function StreamSwitch({
  on,
  available,
  plan,
  onChange,
}: {
  on: boolean;
  available: Availability;
  plan:
    | { ctx: number; moeCacheMib: number; source: string; ssdGbPerWord: number; ramGb?: number }
    | undefined;
  onChange: (on: boolean) => void;
}) {
  return (
    <div class={`lm-stream${available.ok ? "" : " off"}`}>
      <Pick on={on} onChange={(v) => available.ok && onChange(v)}>
        <strong>{t("lmStream")}</strong>
      </Pick>
      <p class="ui-help">{t("lmStreamHelp")}</p>
      {!available.ok && <p class="notice">{available.reason}</p>}
      {available.ok && available.warn && <p class="ui-help">{available.warn}</p>}
      {on && plan && (
        <p class="ui-help">
          {t("lmStreamPlan", {
            ctx: `${Math.round(plan.ctx / 1024)}k`,
            cache:
              plan.moeCacheMib > 0 ? t("lmStreamCache", { gb: gb(plan.moeCacheMib / 1024) }) : "",
            source:
              plan.source === "ssd"
                ? t("lmStreamFromSsd", { gb: plan.ssdGbPerWord.toFixed(2) })
                : plan.source === "ram"
                  ? t("lmStreamFromRam")
                  : t("lmStreamFromCard"),
            ram: plan.ramGb !== undefined ? gb(plan.ramGb) : "?",
          })}
        </p>
      )}
    </div>
  );
}

/**
 * The SSD stream's tuning as it happens (2026-11-03): each split of the card tried, the context
 * and the experts' cache it gave, how fast it read and wrote, and the one kept.
 */
function TuneTrials({ json }: { json: string }) {
  let trials: {
    share: number;
    opOffload?: boolean;
    ctx: number;
    cacheMib: number;
    state: "running" | "done" | "failed";
    genTps?: number;
    prefillTps?: number;
    chosen?: boolean;
    error?: string;
  }[] = [];
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
            <th />
          </tr>
        </thead>
        <tbody>
          {trials.map((x) => (
            <tr key={`${x.share}-${x.opOffload ?? true}`} class={x.chosen ? "chosen" : ""}>
              <td>
                {gb(x.cacheMib / 1024)} ({Math.round(x.share * 100)}%)
                {x.opOffload === false && ` · ${t("lmTuneNoCopy")}`}
              </td>
              <td>{x.ctx ? `${Math.round(x.ctx / 1024)}k` : "–"}</td>
              <td>{x.prefillTps ? `${x.prefillTps} tok/s` : "–"}</td>
              <td>{x.genTps ? `${x.genTps} tok/s` : "–"}</td>
              <td>
                {x.state === "running"
                  ? t("lmTuneRunning")
                  : x.state === "failed"
                    ? t("lmTuneFailed")
                    : x.chosen
                      ? t("lmTuneChosen")
                      : ""}
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
        {eng?.state === "done" && eng.vars.trials && <TuneTrials json={eng.vars.trials} />}
        {eng?.state === "done" && <ActivationSpeeds vars={eng.vars} />}
        <div class="row wrap">
          {active && eng?.state !== "running" ? (
            <>
              {/* On or off without deleting it (2026-11-04): off frees its memory and it does
                  not load when RedGiant opens. */}
              <Pick small on={!off} onChange={(v) => act(() => getApi().setEnginePower(v))}>
                {off ? t("lmOff") : t("lmOn")}
              </Pick>
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
                  act(() => getApi().setupEngine({ variant, model: name, stream, ...speculative }))
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
              onClick={() => {
                // The model in use goes too (2026-11-04): the engine stops first.
                if (active && !confirm(t("lmDeleteActiveConfirm"))) return;
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
  onChange,
}: {
  jobs: Job[];
  files: LocalFile[];
  active: string | undefined;
  variant: EngineVariant;
  stream: boolean;
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

/**
 * Models still inside WSL on Windows (2026-11-04, the person's decision: the engine runs
 * natively, no virtualisation where it is not needed): how many, and one button to move them.
 */
function OutOfWsl({ s, onDone }: { s: SetupState; onDone: () => void }) {
  const [jobId, setJobId] = useState<string>();
  const [open, setOpen] = useState(false);
  const job = useJob(jobId);
  useEffect(() => {
    if (job?.state === "done") onDone();
  }, [job?.state]);
  const files = s.wslModels ?? [];
  if (!s.hardware.windowsEngine || (files.length === 0 && !jobId)) return null;
  const total = files.reduce((n, f) => n + f.bytes, 0);
  return (
    <div class="notice warn out-of-wsl">
      <p>{t("lmOutOfWsl", { n: String(files.length), size: bytes(total) })}</p>
      <div class="row wrap">
        <button
          type="button"
          class="primary"
          disabled={job?.state === "running"}
          onClick={() =>
            void attempt(() => getApi().modelsToWindows()).then((j) => {
              if (j) {
                setJobId(j.id);
                setOpen(true);
              }
            })
          }
        >
          {t("lmOutOfWslMove")}
        </button>
        {jobId && !open && (
          <button type="button" class="link" onClick={() => setOpen(true)}>
            {t("lmShowActivation")}
          </button>
        )}
      </div>
      {open && job && (
        <Modal title={t("lmOutOfWslTitle")} onClose={() => setOpen(false)}>
          <p class="ui-help">{t("lmOutOfWslHelp")}</p>
          <JobView job={job} />
        </Modal>
      )}
    </div>
  );
}

/** This computer's places for a model, in order, with the bar of the room each one gives. */
function Machine({
  s,
  tiers,
  diskFreeGb,
  activeGb = 0,
}: {
  s: SetupState;
  tiers: Tier[];
  diskFreeGb: number | undefined;
  /** The model in use, in GB: shown where it sits (2026-11-05). */
  activeGb?: number;
}) {
  const hw = s.hardware;
  const card = hw.gpus.find((g) => !g.integrated);
  const free = hw.freeRamGb ?? hw.ramGb * 0.6;
  const shared = hw.suggestion.kind !== "gpu" && hw.suggestion.kind !== "gpu-unknown";
  return (
    <div class="machine">
      <strong>{t("lmThisPc")}</strong>
      <div class="machine-parts">
        {!shared && (
          <div class="machine-part">
            <IconCpu size={18} />
            <span>
              <b>{t("lmPartCard")}</b> {card?.name ?? ""}
              <small>
                {t("lmPartCardSub", {
                  vram: gb(hw.suggestion.vramGb),
                  use: gb(hw.suggestion.maxModelGb),
                })}
              </small>
            </span>
          </div>
        )}
        <div class="machine-part">
          <IconLayers size={18} />
          <span>
            <b>{shared ? t("lmPartMemory") : t("lmPartRam")}</b> {gb(hw.ramGb)}
            <small>{t("lmPartRamSub", { free: gb(free) })}</small>
          </span>
        </div>
        {diskFreeGb !== undefined && (
          <div class="machine-part">
            <IconBox size={18} />
            <span>
              <b>{t("lmPartSsd")}</b>
              <small>{t("lmPartSsdSub", { free: gb(diskFreeGb) })}</small>
            </span>
          </div>
        )}
      </div>
      <RoomBar sizeGb={activeGb} tiers={tiers} />
      <div class="tier-legend">
        {tiers.map((x) => (
          <span key={x.kind}>
            <i class={`tier-${x.kind}`} />
            {t(`lmLegend_${x.kind}`)}
          </span>
        ))}
      </div>
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
            {speed.tokensPerSec} <small>{t("lmSpeedEstimate")}</small>
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

export function LocalModels({ s, reload }: { s: SetupState; reload: () => void }) {
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
  /** The card whose panel is open: a model's id, `file:` and a file, or `hf`. */
  const [open, setOpen] = useState<string | null>(null);
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
  const openModel = data?.models.find((m) => m.id === open);
  const openFile = open?.startsWith("file:")
    ? others.find((f) => `file:${f.file}` === open)
    : undefined;
  const panel = openModel
    ? {
        title: openModel.name,
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
                onChange={changed}
              />
            </>
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
                  onChange={changed}
                />
              </>
            ),
          }
        : null;
  return (
    <div class="lm">
      <OutOfWsl s={s} onDone={changed} />
      <Machine
        s={s}
        tiers={tiers}
        diskFreeGb={streaming ? data?.diskFreeGb : undefined}
        activeGb={activeGb}
      />
      {s.locked.engine && <p class="notice">{t("wzLocked")}</p>}
      {error && <p class="notice error">{error}</p>}
      <StreamSwitch
        on={streaming}
        available={canStream}
        plan={s.config.engine?.stream ? s.config.engine.plan : undefined}
        onChange={(v) => setStream(v)}
      />
      <ModelsDisk s={s} variant={variant} onMoved={changed} />
      <h3>{t("lmSuggested")}</h3>
      <p class="ui-help">{t("lmScoresHint")}</p>
      {!data && <p class="ui-help">{t("lmLoading")}</p>}
      <Gallery panel={panel} onClose={() => setOpen(null)}>
        {data?.models.map((m) => {
          const speed = m.file ? estimatedSpeed(m, m.file.sizeGb, hw) : undefined;
          const inUse = !!m.file && active === target(m.file.file);
          return (
            <GalleryCard
              key={m.id}
              selected={open === m.id}
              tone={inUse ? "ok" : undefined}
              onOpen={() => setOpen(m.id)}
            >
              <span class="gcard-head">
                <strong>{m.name}</strong>
                {inUse ? (
                  <span class={s.config.engine?.off ? "chip" : "chip ok"}>
                    {s.config.engine?.off ? t("lmOff") : t("lmInUse")}
                  </span>
                ) : (
                  m.id === best && <span class="chip ok">{t("lmRecommended")}</span>
                )}
              </span>
              {speed && m.file ? (
                <span class="row wrap">
                  <span class="gcard-big">
                    {speed.tokensPerSec} <small>{t("lmTokensUnit")}</small>
                  </span>
                  <span class="spacer" />
                  <span class="dim">{gb(m.file.sizeGb)}</span>
                </span>
              ) : (
                <span class="gcard-note">{tOptional(`lm_${m.id}`) ?? ""}</span>
              )}
              {m.file && <RoomBar sizeGb={m.file.sizeGb} tiers={tiers} />}
              <span class="gcard-foot">
                <span class="gcard-note">
                  {cardState(m, files, jobs, active, s.config.engine?.off === true)}
                </span>
                <IconChevron open={false} size={14} />
              </span>
            </GalleryCard>
          );
        })}
        {others.map((f) => (
          <GalleryCard
            key={f.file}
            selected={open === `file:${f.file}`}
            tone={active === f.file ? "ok" : undefined}
            onOpen={() => setOpen(`file:${f.file}`)}
          >
            <span class="gcard-head">
              <strong class="gcard-file">{f.file}</strong>
              {active === f.file && <span class="chip ok">{t("lmInUse")}</span>}
            </span>
            <span class="gcard-note">{t("lmOther")}</span>
            <span class="gcard-foot">
              <span class="gcard-note">{bytes(f.bytes)}</span>
              <IconChevron open={false} size={14} />
            </span>
          </GalleryCard>
        ))}
        <GalleryCard selected={open === "hf"} onOpen={() => setOpen("hf")}>
          <span class="gcard-head">
            <strong>{t("lmSearch")}</strong>
            <IconSearch size={16} />
          </span>
          <span class="gcard-note">{t("lmSearchHint")}</span>
          <span class="gcard-foot">
            <span />
            <IconChevron open={false} size={14} />
          </span>
        </GalleryCard>
      </Gallery>
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
                {t(`lmEngine_${v}`)}
                {v === s.hardware.suggestion.engine ? ` (${t("lmRecommended")})` : ""}
              </option>
            ))}
          </select>
        </Field>
      </Advanced>
    </div>
  );
}
