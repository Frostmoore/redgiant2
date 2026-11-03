// "A model on this computer" (G24.3): what this computer can run, the suggested models as
// cards (what each is good at, its size and quality, whether it fits), downloads with a real
// progress bar that can be paused, and starting the engine with its steps and plain errors.
import { estimatedSpeed, type Job } from "@redgiant/protocol";
import { useEffect, useState } from "preact/hooks";
import type { EngineVariant, LocalFile, LocalModelChoice, SetupState } from "../api.js";
import { bytes } from "../format.js";
import { t, tOptional } from "../i18n.js";
import { IconCpu, IconDownload, IconPlay, IconTrash } from "../icons.js";
import { getApi } from "../state.js";
import { explain } from "./Brain.js";
import { Advanced, Field, JobView, Pick, Progress } from "./ui.js";

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
  const fitting = models.filter((m) => m.file);
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
function RoomBar({ sizeGb, maxGb }: { sizeGb: number; maxGb: number }) {
  const pct = Math.min(100, Math.round((sizeGb / Math.max(maxGb, 0.1)) * 100));
  return (
    <span
      class="lm-room"
      data-label={t("lmRoom")}
      role="img"
      aria-label={t("lmRoomOf", { size: gb(sizeGb), max: gb(maxGb) })}
    >
      <span class={`lm-room-bar${pct > 85 ? " tight" : ""}`} aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </span>
      <span class="lm-meter-note">{t("lmRoomOf", { size: gb(sizeGb), max: gb(maxGb) })}</span>
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

/** The switch with what it does, why it is off when it is, and what the last start decided. */
function StreamSwitch({
  on,
  available,
  plan,
  onChange,
}: {
  on: boolean;
  available: Availability;
  plan: { ctx: number; moeCacheMib: number; source: string; ssdGbPerWord: number } | undefined;
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
            <tr key={x.share} class={x.chosen ? "chosen" : ""}>
              <td>
                {gb(x.cacheMib / 1024)} ({Math.round(x.share * 100)}%)
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
  onChange: () => void;
}) {
  const name = target(file);
  const dl = latest(jobs, "model_download", name);
  const eng = latest(jobs, "engine", name);
  const [error, setError] = useState<string>();
  const [used, setUsed] = useState(false);
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
        {eng && (eng.state === "running" || eng.state === "failed") && <JobView job={eng} />}
        {eng?.vars.trials && <TuneTrials json={eng.vars.trials} />}
        <div class="row wrap">
          {active && eng?.state !== "running" ? (
            <>
              <span class="chip ok">{t("lmInUse")}</span>
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
                onClick={() => act(() => getApi().setupEngine({ variant, model: name, stream }))}
              >
                <IconPlay /> {t("lmStart")}
              </button>
            )
          )}
          {!active && eng?.state !== "running" && (
            <button
              type="button"
              class="link"
              onClick={() => act(() => getApi().removeModel(name, variant))}
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

export function LocalModels({ s, reload }: { s: SetupState; reload: () => void }) {
  const [data, setData] = useState<{ models: LocalModelChoice[]; files: LocalFile[] }>();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [variant, setVariant] = useState<EngineVariant>(
    s.config.engine?.variant ?? s.hardware.suggestion.engine,
  );
  const [error, setError] = useState<string>();
  const [stream, setStream] = useState(s.config.engine?.stream ?? false);
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
  const files = data?.files ?? [];
  const known = new Set(data?.models.flatMap((m) => (m.file ? [target(m.file.file)] : [])) ?? []);
  const others = files.filter((f) => !known.has(f.file) && !f.partial);
  return (
    <div class="lm">
      <div class="lm-pc">
        <IconCpu size={18} />
        <div>
          <strong>{t("lmThisPc")}</strong>
          <p class="ui-help">{hardwareText(s.hardware)}</p>
        </div>
      </div>
      {s.locked.engine && <p class="notice">{t("wzLocked")}</p>}
      {error && <p class="notice error">{error}</p>}
      <StreamSwitch
        on={stream && canStream.ok}
        available={canStream}
        plan={s.config.engine?.stream ? s.config.engine.plan : undefined}
        onChange={(v) => setStream(v)}
      />
      <h3>{t("lmSuggested")}</h3>
      <p class="ui-help">{t("lmScoresHint")}</p>
      {!data && <p class="ui-help">{t("lmLoading")}</p>}
      {/* One row a model, one column a quality: compared at a glance (2026-11-03). */}
      <div class="lm-table">
        <div class="lm-row lm-head">
          <span>{t("lmModel")}</span>
          <span>{t("lmScore_smart")}</span>
          <span>{t("lmScore_code")}</span>
          <span>{t("lmScore_tools")}</span>
          <span>{t("lmScore_languages")}</span>
          <span>{t("lmScore_speed")}</span>
          <span>{t("lmRoom")}</span>
          <span />
        </div>
        {data?.models.map((m) => {
          const speed = m.file
            ? estimatedSpeed(m, m.file.sizeGb, s.hardware.suggestion)
            : undefined;
          const inUse = !!m.file && active === target(m.file.file);
          return (
            <div
              key={m.id}
              class={`lm-row${m.file ? "" : " too-big"}${m.id === best ? " best" : ""}${inUse ? " in-use" : ""}`}
            >
              <span class="lm-name">
                <span class="row wrap">
                  <strong>{m.name}</strong>
                  {m.id === best && <span class="chip ok">{t("lmRecommended")}</span>}
                  {inUse && <span class="chip ok">{t("lmInUse")}</span>}
                </span>
                <span class="ui-help">{tOptional(`lm_${m.id}`) ?? ""}</span>
                {m.file && <span class="lm-meta">{t(`lmQuality_${m.file.quality}`)}</span>}
              </span>
              <Meter label={t("lmScore_smart")} value={m.scores.smart} />
              <Meter label={t("lmScore_code")} value={m.scores.code} />
              <Meter label={t("lmScore_tools")} value={m.scores.tools} />
              <Meter label={t("lmScore_languages")} value={m.scores.languages} />
              {speed ? (
                <Meter
                  label={t("lmScore_speed")}
                  value={speed.stars}
                  note={t("lmWordsShort", { n: String(speed.wordsPerSec) })}
                />
              ) : (
                <span />
              )}
              {m.file ? (
                <RoomBar sizeGb={m.file.sizeGb} maxGb={s.hardware.suggestion.maxModelGb} />
              ) : (
                <span />
              )}
              <span class="lm-actions">
                {m.file ? (
                  <FileActions
                    repo={m.repo}
                    file={m.file.file}
                    sizeGb={m.file.sizeGb}
                    local={files.find((f) => f.file === target(m.file?.file ?? ""))}
                    jobs={jobs}
                    active={inUse}
                    variant={variant}
                    stream={stream}
                    onChange={changed}
                  />
                ) : (
                  <span class="ui-help">
                    {m.unavailable
                      ? t("lmUnavailable")
                      : t("lmTooBig", {
                          need: m.smallestGb ? gb(m.smallestGb) : "?",
                          max: gb(s.hardware.suggestion.maxModelGb),
                        })}
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>
      {others.length > 0 && (
        <>
          <h3>{t("lmOther")}</h3>
          <ul class="lm-files">
            {others.map((f) => (
              <li key={f.file}>
                <div class="row">
                  <code>{f.file}</code>
                  <span class="dim">{bytes(f.bytes)}</span>
                </div>
                <FileActions
                  repo={null}
                  file={f.file}
                  sizeGb={null}
                  local={f}
                  jobs={jobs}
                  active={active === f.file}
                  variant={variant}
                  stream={stream}
                  onChange={changed}
                />
              </li>
            ))}
          </ul>
        </>
      )}
      <Advanced>
        <Field label={t("lmEngine")} help={t("lmEngineHelp")}>
          <select
            value={variant}
            onChange={(e) => setVariant((e.target as HTMLSelectElement).value as EngineVariant)}
          >
            {(s.hardware.windowsEngine
              ? (["windows", "cuda", "cpu"] as const)
              : (["cpu", "cuda", "vulkan"] as const)
            ).map((v) => (
              <option key={v} value={v}>
                {t(`lmEngine_${v}`)}
                {v === s.hardware.suggestion.engine ? ` (${t("lmRecommended")})` : ""}
              </option>
            ))}
          </select>
        </Field>
        <div class="ui-field">
          <span class="ui-label">{t("lmSearch")}</span>
          <span class="ui-help">{t("lmSearchHint")}</span>
          <HfSearch
            jobs={jobs}
            files={files}
            active={active}
            variant={variant}
            stream={stream && canStream.ok}
            onChange={changed}
          />
        </div>
      </Advanced>
    </div>
  );
}
