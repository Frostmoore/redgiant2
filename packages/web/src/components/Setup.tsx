import { useEffect, useState } from "preact/hooks";
import type { GgufFile, ModelDownload, SetupState } from "../api.js";
import { lang, setLang, t } from "../i18n.js";
import { IconDownload, IconPlay } from "../icons.js";
import { attempt, getApi, platformInfo, refresh } from "../state.js";

const STEPS = [
  "wzWelcome",
  "wzModels",
  "wzLocal",
  "wzNames",
  "wzTelegram",
  "wzSafety",
  "wzDone",
] as const;
const CLOUD_MODELS = [
  "anthropic/claude-opus-5-5",
  "anthropic/claude-sonnet-5-5",
  "anthropic/claude-haiku-5-5",
];

const gb = (n: number) => `${n.toFixed(1)} GB`;

function Field({ label, children }: { label: string; children: preact.ComponentChildren }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control comes in as children.
    <label>
      {label}
      {children}
    </label>
  );
}

function Locked({ on }: { on: boolean | undefined }) {
  return on ? <span class="chip muted">{t("wzLocked")}</span> : null;
}

/** Models: cloud keys, an OpenAI-compatible server, web search, the default model. */
function Models({ s, next }: { s: SetupState; next: () => void }) {
  const [anthropicKey, setKey] = useState("");
  const [openaiUrl, setOpenaiUrl] = useState(s.config.openaiBaseUrl ?? "");
  const [openaiKey, setOpenaiKey] = useState("");
  const [searx, setSearx] = useState(s.config.searxngUrl ?? "");
  const [voiceApi, setVoiceApi] = useState(s.config.transcription?.api ?? "whisper-asr");
  const [voiceUrl, setVoiceUrl] = useState(s.config.transcription?.url ?? "");
  const [voiceModel, setVoiceModel] = useState(s.config.transcription?.model ?? "");
  const [voiceKey, setVoiceKey] = useState("");
  const [imagesKey, setImagesKey] = useState("");
  const [imagesModel, setImagesModel] = useState(s.config.imagesModel ?? "");
  const current = s.config.defaultModel;
  const [model, setModel] = useState(
    current ? `${current.provider}/${current.model}` : (CLOUD_MODELS[0] ?? ""),
  );
  const [effort, setEffort] = useState(current?.effort ?? "medium");
  const [found, setFound] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const save = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    const [provider = "", ...rest] = model.trim().split("/");
    const r = await attempt(() =>
      getApi().setupModels({
        ...(anthropicKey && { anthropicKey }),
        ...(openaiUrl.trim() &&
          openaiUrl !== s.config.openaiBaseUrl && {
            openai: { baseUrl: openaiUrl.trim(), ...(openaiKey && { key: openaiKey }) },
          }),
        ...(searx.trim() && searx !== s.config.searxngUrl && { searxngUrl: searx.trim() }),
        ...(!s.locked.images &&
          (imagesKey || imagesModel !== (s.config.imagesModel ?? "")) && {
            images: {
              ...(imagesKey && { key: imagesKey }),
              ...(imagesModel.trim() && { model: imagesModel.trim() }),
            },
          }),
        ...(!s.locked.voice &&
          (voiceUrl.trim()
            ? {
                transcription: {
                  api: voiceApi,
                  url: voiceUrl.trim(),
                  ...(voiceModel.trim() && { model: voiceModel.trim() }),
                  ...(voiceKey && { key: voiceKey }),
                },
              }
            : s.config.transcription && { transcription: null })),
        ...(!s.locked.defaultModel && {
          defaultModel: { provider, model: rest.join("/"), ...(effort && { effort }) },
        }),
      }),
    );
    setBusy(false);
    if (r) {
      setFound(r.openaiModels);
      next();
    }
  };
  return (
    <form class="form" onSubmit={(e) => void save(e)}>
      <p class="wide dim">{t("wzModelsHint")}</p>
      <Field label={`Anthropic API key${s.secretsSet.anthropic ? ` (${t("wzAlreadySet")})` : ""}`}>
        <input
          type="password"
          autocomplete="off"
          disabled={s.locked.anthropic}
          placeholder="sk-ant-…"
          value={anthropicKey}
          onInput={(e) => setKey((e.target as HTMLInputElement).value)}
        />
        <Locked on={s.locked.anthropic} />
      </Field>
      <Field label={t("wzOpenai")}>
        <input
          placeholder="http://localhost:11434/v1"
          disabled={s.locked.openai}
          value={openaiUrl}
          onInput={(e) => setOpenaiUrl((e.target as HTMLInputElement).value)}
        />
        <Locked on={s.locked.openai} />
      </Field>
      <Field label={`${t("wzOpenaiKey")}${s.secretsSet.openai ? ` (${t("wzAlreadySet")})` : ""}`}>
        <input
          type="password"
          autocomplete="off"
          disabled={s.locked.openai}
          value={openaiKey}
          onInput={(e) => setOpenaiKey((e.target as HTMLInputElement).value)}
        />
      </Field>
      <Field label={t("wzSearch")}>
        <input
          placeholder="http://searxng:8080"
          disabled={s.locked.search}
          value={searx}
          onInput={(e) => setSearx((e.target as HTMLInputElement).value)}
        />
        <Locked on={s.locked.search} />
      </Field>
      <Field label={t("wzVoice")}>
        <div class="row">
          <select
            disabled={s.locked.voice}
            value={voiceApi}
            onChange={(e) =>
              setVoiceApi((e.target as HTMLSelectElement).value as "whisper-asr" | "openai")
            }
          >
            <option value="whisper-asr">whisper-asr-webservice</option>
            <option value="openai">{t("wzVoiceOpenai")}</option>
          </select>
          <input
            placeholder={
              voiceApi === "openai" ? "https://api.openai.com/v1" : "http://whisper-asr:9000"
            }
            disabled={s.locked.voice}
            value={voiceUrl}
            onInput={(e) => setVoiceUrl((e.target as HTMLInputElement).value)}
          />
        </div>
        <Locked on={s.locked.voice} />
      </Field>
      {voiceApi === "openai" && (
        <>
          <Field label={t("wzVoiceModel")}>
            <input
              placeholder="whisper-1"
              disabled={s.locked.voice}
              value={voiceModel}
              onInput={(e) => setVoiceModel((e.target as HTMLInputElement).value)}
            />
          </Field>
          <Field
            label={`${t("wzVoiceKey")}${s.secretsSet.transcription ? ` (${t("wzAlreadySet")})` : ""}`}
          >
            <input
              type="password"
              autocomplete="off"
              disabled={s.locked.voice}
              value={voiceKey}
              onInput={(e) => setVoiceKey((e.target as HTMLInputElement).value)}
            />
          </Field>
        </>
      )}
      <Field label={`${t("wzImagesKey")}${s.secretsSet.images ? ` (${t("wzAlreadySet")})` : ""}`}>
        <input
          type="password"
          autocomplete="off"
          placeholder="sk-…"
          disabled={s.locked.images}
          value={imagesKey}
          onInput={(e) => setImagesKey((e.target as HTMLInputElement).value)}
        />
        <Locked on={s.locked.images} />
      </Field>
      <Field label={t("wzImagesModel")}>
        <input
          placeholder="gpt-image-2.5-flare"
          disabled={s.locked.images}
          value={imagesModel}
          onInput={(e) => setImagesModel((e.target as HTMLInputElement).value)}
        />
      </Field>
      <Field label={t("wzDefaultModel")}>
        <input
          list="wz-models"
          disabled={s.locked.defaultModel}
          value={model}
          onInput={(e) => setModel((e.target as HTMLInputElement).value)}
        />
        <datalist id="wz-models">
          {[
            ...CLOUD_MODELS,
            ...found.map((m) => `openai/${m}`),
            ...(s.config.engine ? [`local/${s.config.engine.model}`] : []),
          ].map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <Locked on={s.locked.defaultModel} />
      </Field>
      <Field label={t("effort")}>
        <select value={effort} onChange={(e) => setEffort((e.target as HTMLSelectElement).value)}>
          {["low", "medium", "high", "max"].map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
      </Field>
      <div class="row wide">
        <button type="submit" class="primary" disabled={busy}>
          {busy ? t("wzTrying") : t("wzSaveNext")}
        </button>
      </div>
    </form>
  );
}

/** A local model from Hugging Face, sized for this machine, and the engine that runs it. */
function Local({ s, next, reload }: { s: SetupState; next: () => void; reload: () => void }) {
  const [q, setQ] = useState("gemma 4 gguf");
  const [repos, setRepos] = useState<{ id: string; downloads: number }[]>([]);
  const [repo, setRepo] = useState("");
  const [files, setFiles] = useState<GgufFile[]>([]);
  const [downloads, setDownloads] = useState<ModelDownload[]>([]);
  const budget = s.hardware.suggestion.maxModelGb;
  const [variant, setVariant] = useState<"cpu" | "cuda">(s.hardware.suggestion.engine);
  useEffect(() => {
    const tick = () =>
      void getApi()
        .hfDownloads()
        .then(setDownloads, () => {});
    tick();
    const timer = setInterval(tick, 1500);
    return () => clearInterval(timer);
  }, []);
  const best = (() => {
    const fitting = files.filter((f) => f.sizeGb <= budget);
    const order = [
      "Q8_0",
      "Q6_K",
      "Q5_K_M",
      "Q5_K_S",
      "Q4_K_M",
      "Q4_K_S",
      "IQ4_XS",
      "Q4_0",
      "Q3_K_M",
      "Q2_K",
    ];
    for (const o of order) {
      const f = fitting.find((x) => x.quant === o);
      if (f) return f.file;
    }
    return fitting.at(-1)?.file;
  })();
  const ready = downloads.filter((d) => d.state === "done");
  return (
    <div class="form">
      <p class="wide dim">{t("wzLocalHint", { gb: gb(budget) })}</p>
      {s.locked.engine && <p class="wide notice">{t("wzLocked")}</p>}
      <form
        class="row wide"
        onSubmit={(e) => {
          e.preventDefault();
          void attempt(() => getApi().hfSearch(q)).then((r) => r && setRepos(r));
        }}
      >
        <input value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        <button type="submit">{t("search")}</button>
      </form>
      {repos.length > 0 && (
        <select
          class="wide"
          value={repo}
          onChange={(e) => {
            const r = (e.target as HTMLSelectElement).value;
            setRepo(r);
            void attempt(() => getApi().hfFiles(r)).then((f) => f && setFiles(f));
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
      {files.length > 0 && (
        <div class="wide wz-files">
          {files.map((f) => (
            <div key={f.file} class={`row ${f.file === best ? "wz-best" : ""}`}>
              <code>{f.file}</code>
              <span class="dim">{gb(f.sizeGb)}</span>
              {f.file === best && <span class="chip">{t("wzSuggested")}</span>}
              {f.sizeGb > budget && <span class="chip danger">{t("wzTooBig")}</span>}
              <div class="spacer" />
              <button
                type="button"
                class="tiny"
                onClick={() => void attempt(() => getApi().hfDownload(repo, f.file))}
              >
                <IconDownload /> {t("wzDownload")}
              </button>
            </div>
          ))}
        </div>
      )}
      {downloads.map((d) => (
        <div key={d.target} class="wide row">
          <code>{d.target}</code>
          <span class="dim">
            {d.state === "running"
              ? d.total
                ? `${Math.round((d.bytes / d.total) * 100)} %`
                : gb(d.bytes / 1024 ** 3)
              : d.state === "done"
                ? t("downloaded")
                : `${t("failed")}: ${d.error ?? ""}`}
          </span>
        </div>
      ))}
      {ready.length > 0 && !s.locked.engine && (
        <div class="row wide">
          <select
            value={variant}
            onChange={(e) => setVariant((e.target as HTMLSelectElement).value as "cpu" | "cuda")}
          >
            <option value="cpu">CPU</option>
            <option value="cuda">NVIDIA (CUDA)</option>
          </select>
          {ready.map((d) => (
            <button
              key={d.target}
              type="button"
              class="primary"
              onClick={() =>
                void attempt(() => getApi().setupEngine({ variant, model: d.target })).then((r) => {
                  if (r !== undefined) reload();
                })
              }
            >
              <IconPlay /> {t("wzStartEngine", { model: d.target })}
            </button>
          ))}
        </div>
      )}
      {s.config.engine && (
        <p class="wide notice ok">{t("wzEngineOn", { model: s.config.engine.model })}</p>
      )}
      <div class="row wide">
        <button type="button" class="primary" onClick={next}>
          {s.config.engine ? t("wzNext") : t("wzSkip")}
        </button>
      </div>
    </div>
  );
}

function Names({ s, next }: { s: SetupState; next: () => void }) {
  const [god, setGod] = useState(s.names.god ?? "God");
  const [demigod, setDemigod] = useState(s.names.demigod ?? "Demi-God");
  const [prompt, setPrompt] = useState(s.names.godPrompt ?? "");
  const save = async (e: Event) => {
    e.preventDefault();
    const r = await attempt(() =>
      getApi().setupNames({
        god,
        demigod,
        language: lang.value,
        ...(prompt.trim() && { godPrompt: prompt.trim() }),
      }),
    );
    if (r !== undefined) next();
  };
  return (
    <form class="form" onSubmit={(e) => void save(e)}>
      <p class="wide dim">{t("wzNamesHint")}</p>
      <Field label={t("wzGodName")}>
        <input
          required
          maxLength={40}
          value={god}
          onInput={(e) => setGod((e.target as HTMLInputElement).value)}
        />
      </Field>
      <Field label={t("wzDemigodName")}>
        <input
          required
          maxLength={40}
          value={demigod}
          onInput={(e) => setDemigod((e.target as HTMLInputElement).value)}
        />
      </Field>
      <label class="wide">
        {t("wzGodPrompt")}
        <textarea
          rows={5}
          value={prompt}
          onInput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)}
        />
      </label>
      <div class="row wide">
        <button type="submit" class="primary">
          {t("wzSaveNext")}
        </button>
      </div>
    </form>
  );
}

function Telegram({ s, next }: { s: SetupState; next: () => void }) {
  const [token, setToken] = useState("");
  const [bot, setBot] = useState<string | null>(null);
  const [code, setCode] = useState<{ code: string; link: string } | null>(null);
  const connect = async (e: Event) => {
    e.preventDefault();
    const r = await attempt(() => getApi().setupTelegram(token.trim()));
    if (r) {
      setBot(r.username);
      const p = await attempt(() => getApi().telegramPair());
      if (p) setCode({ code: p.code, link: p.link });
    }
  };
  return (
    <div class="form">
      <p class="wide dim">{t("wzTelegramHint")}</p>
      {s.locked.telegram ? (
        <p class="wide notice">{t("wzLocked")}</p>
      ) : (
        <form class="row wide" onSubmit={(e) => void connect(e)}>
          <input
            type="password"
            autocomplete="off"
            placeholder={s.secretsSet.telegram ? t("wzAlreadySet") : "123456:ABC…"}
            value={token}
            onInput={(e) => setToken((e.target as HTMLInputElement).value)}
          />
          <button type="submit">{t("wzConnect")}</button>
        </form>
      )}
      {bot && code && (
        <div class="wide notice ok">
          {t("wzPairNow", { bot })}{" "}
          <a href={code.link} target="_blank" rel="noreferrer">
            {code.link}
          </a>
          <pre>/start {code.code}</pre>
        </div>
      )}
      <div class="row wide">
        <button type="button" class="primary" onClick={next}>
          {bot || s.secretsSet.telegram ? t("wzNext") : t("wzSkip")}
        </button>
      </div>
    </div>
  );
}

function Safety({ s, next }: { s: SetupState; next: () => void }) {
  const [humanOnly, setHumanOnly] = useState<string[]>(s.policy.humanOnly);
  const [budget, setBudget] = useState(s.budgetUsd?.toString() ?? "");
  const [retention, setRetention] = useState(s.config.retentionDays?.toString() ?? "");
  const [ack, setAck] = useState(s.config.subscriptionAck ?? false);
  const save = async (e: Event) => {
    e.preventDefault();
    const r = await attempt(() =>
      getApi().setupSafety({
        humanOnly,
        budgetUsd: budget.trim() ? Number(budget) : null,
        retentionDays: retention.trim() ? Number(retention) : null,
        subscriptionAck: ack,
      }),
    );
    if (r !== undefined) next();
  };
  return (
    <form class="form" onSubmit={(e) => void save(e)}>
      <p class="wide dim">{t("wzSafetyHint")}</p>
      <div class="wide wz-checks">
        {s.policy.dangers.map((d) => (
          <label key={d.id} class="row">
            <input
              type="checkbox"
              checked={humanOnly.includes(d.id)}
              onChange={(e) =>
                setHumanOnly(
                  (e.target as HTMLInputElement).checked
                    ? [...humanOnly, d.id]
                    : humanOnly.filter((x) => x !== d.id),
                )
              }
            />
            {d.label}
          </label>
        ))}
      </div>
      <Field label={t("wzBudget")}>
        <input
          type="number"
          min="1"
          step="1"
          value={budget}
          onInput={(e) => setBudget((e.target as HTMLInputElement).value)}
        />
      </Field>
      <Field label={t("wzRetention")}>
        <input
          type="number"
          min="1"
          step="1"
          placeholder={t("wzForever")}
          value={retention}
          onInput={(e) => setRetention((e.target as HTMLInputElement).value)}
        />
      </Field>
      <p class="wide dim">{t("wzSandbox", { kind: platformInfo.value?.sandbox ?? "?" })}</p>
      <label class="wide row">
        <input
          type="checkbox"
          checked={ack}
          onChange={(e) => setAck((e.target as HTMLInputElement).checked)}
        />
        {t("wzSubscription")}
      </label>
      <div class="row wide">
        <button type="submit" class="primary">
          {t("wzSaveNext")}
        </button>
      </div>
    </form>
  );
}

/** The first-run wizard (G17): each step is applied and saved at once; it can be run again. */
export function Setup({ onDone }: { onDone?: () => void }) {
  const [s, setS] = useState<SetupState | null>(null);
  const [step, setStep] = useState(0);
  const reload = () => void attempt(() => getApi().setup()).then((x) => x && setS(x));
  useEffect(reload, []);
  if (!s) return <div class="empty">…</div>;
  const next = () => {
    reload();
    setStep((n) => Math.min(n + 1, STEPS.length - 1));
  };
  const h = s.hardware;
  return (
    <div class="setup">
      <ol class="wz-steps">
        {STEPS.map((k, i) => (
          <li key={k} class={i === step ? "on" : i < step ? "done" : ""}>
            <button type="button" class="tiny" onClick={() => setStep(i)}>
              {t(k)}
            </button>
          </li>
        ))}
      </ol>
      <section class="wz-body">
        <h2>{t(STEPS[step] ?? "wzWelcome")}</h2>
        {step === 0 && (
          <div class="form">
            <p class="wide">{t("wzWelcomeText")}</p>
            <Field label={t("wzLanguage")}>
              <select
                value={lang.value}
                onChange={(e) => setLang((e.target as HTMLSelectElement).value as "it" | "en")}
              >
                <option value="it">Italiano</option>
                <option value="en">English</option>
              </select>
            </Field>
            <div class="wide notice">
              <strong>{t("wzHardware")}</strong>
              <div>
                {h.cpu} · {h.cores} core · RAM {gb(h.ramGb)}
                {h.diskFreeGb !== null && ` · ${t("wzDiskFree")} ${gb(h.diskFreeGb)}`}
              </div>
              {h.gpus.map((g) => (
                <div key={g.name}>
                  GPU {g.name} · {gb(g.vramGb)}
                </div>
              ))}
              {h.dockerGpu && <div>{t("wzDockerGpu")}</div>}
              <div class="dim">
                {t(`hw_${h.suggestion.kind}` as never, {
                  vram: String(h.suggestion.vramGb),
                  max: String(h.suggestion.maxModelGb),
                })}
              </div>
            </div>
            <div class="row wide">
              <button type="button" class="primary" onClick={next}>
                {t("wzStart")}
              </button>
            </div>
          </div>
        )}
        {step === 1 && <Models s={s} next={next} />}
        {step === 2 && <Local s={s} next={next} reload={reload} />}
        {step === 3 && <Names s={s} next={next} />}
        {step === 4 && <Telegram s={s} next={next} />}
        {step === 5 && <Safety s={s} next={next} />}
        {step === 6 && (
          <div class="form">
            <ul class="wide">
              <li>
                {t("wzDefaultModel")}:{" "}
                {s.config.defaultModel
                  ? `${s.config.defaultModel.provider}/${s.config.defaultModel.model}`
                  : "—"}
              </li>
              <li>
                {t("wzLocalModel")}: {s.config.engine?.model ?? "—"}
              </li>
              <li>
                {t("wzNames")}: {s.names.god ?? "—"} · {s.names.demigod ?? "—"}
              </li>
              <li>Telegram: {s.secretsSet.telegram || s.locked.telegram ? t("yes") : "—"}</li>
              <li>
                {t("wzBudget")}: {s.budgetUsd !== null ? `$${s.budgetUsd}` : "—"}
              </li>
            </ul>
            <p class="wide dim">{t("wzRunAgain")}</p>
            <div class="row wide">
              <button
                type="button"
                class="primary"
                onClick={() =>
                  void attempt(() => getApi().setupComplete()).then(async () => {
                    await attempt(refresh);
                    onDone?.();
                  })
                }
              >
                {t("wzFinish")}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
