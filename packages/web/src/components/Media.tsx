// Settings, Generation (G25.3): who makes pictures, videos, speech, music and sound effects, with
// which model and key. The agents' three tools (image_generation, video_generation,
// audio_generation) use what is chosen here.
import { MEDIA_KINDS, MEDIA_PROVIDERS, type MediaKind, mediaProvider } from "@redgiant/protocol";
import { useEffect, useState } from "preact/hooks";
import type { SetupState } from "../api.js";
import { t } from "../i18n.js";
import { IconCheck } from "../icons.js";
import { getApi } from "../state.js";
import { explain } from "./Brain.js";
import { Choice, Field } from "./ui.js";

type Pick = { provider: string; model: string; voice?: string };

/** A provider's key: linked (its own, or the chat key it shares), or a field to paste it. */
function KeyField({
  provider,
  linked,
  onSaved,
}: {
  provider: string;
  linked: boolean;
  onSaved: () => void;
}) {
  const p = mediaProvider(provider);
  const [key, setKey] = useState("");
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string>();
  if (!p) return null;
  if (linked && !changing)
    return (
      <div class="row media-key">
        <span class="notice ok">
          <IconCheck size={14} /> {t("mediaKeyLinked", { name: p.name })}
        </span>
        <button type="button" class="link" onClick={() => setChanging(true)}>
          {t("remotePasswordChange")}
        </button>
      </div>
    );
  return (
    <form
      class="row media-key"
      onSubmit={(e) => {
        e.preventDefault();
        setError(undefined);
        void getApi()
          .setupMediaKey(provider, key.trim())
          .then(
            () => {
              setKey("");
              setChanging(false);
              onSaved();
            },
            (err: unknown) => setError(explain(err)),
          );
      }}
    >
      <input
        type="password"
        autocomplete="off"
        aria-label={t("mediaKey", { name: p.name })}
        placeholder={p.keyExample}
        value={key}
        onInput={(e) => setKey((e.target as HTMLInputElement).value)}
      />
      <button type="submit" class="primary" disabled={key.trim().length < 8}>
        {t("save")}
      </button>
      <a class="button" href={p.keyUrl} target="_blank" rel="noreferrer">
        {t("mediaGetKey")}
      </a>
      {error && <span class="notice error">{error}</span>}
    </form>
  );
}

function KindRow({ kind, s, onChange }: { kind: MediaKind; s: SetupState; onChange: () => void }) {
  const saved = s.config.media?.[kind];
  const able = MEDIA_PROVIDERS.filter((p) => p.models[kind]?.length);
  const [voices, setVoices] = useState<{ id: string; label: string }[]>();
  const [error, setError] = useState<string>();
  const [changing, setChanging] = useState(false);
  const linked = (id: string) => s.secretsSet.media?.includes(id) ?? false;
  const save = (c: Pick | null) => {
    setError(undefined);
    void getApi()
      .setupMedia(kind, c)
      .then(
        () => {
          setChanging(false);
          onChange();
        },
        (err: unknown) => setError(explain(err)),
      );
  };
  const pick = (id: string) => {
    const p = mediaProvider(id);
    const first = p?.models[kind]?.[0];
    if (p && first)
      save({ provider: id, model: first.id, ...(p.voices?.[0] && { voice: p.voices[0].id }) });
  };
  useEffect(() => {
    if (kind !== "speech" || !saved || !linked(saved.provider)) return setVoices(undefined);
    void getApi()
      .mediaVoices(saved.provider)
      .then(setVoices, () => setVoices([]));
  }, [kind, saved?.provider, linked(saved?.provider ?? "")]);
  const provider = saved ? mediaProvider(saved.provider) : undefined;
  const models = saved ? (provider?.models[kind] ?? []) : [];
  const ready = saved !== undefined && linked(saved.provider);
  // Step 1: who makes it; step 2: its key, with where to get it; then the model (and voice).
  const step = !saved || changing ? 1 : !ready ? 2 : 3;
  return (
    <div class="brain-panel media-kind">
      <div class="row media-kind-head">
        <h3>{t(`media_${kind}`)}</h3>
        <span class={`chip ${ready ? "ok" : "muted"}`}>
          {ready
            ? `${provider?.name} · ${models.find((m) => m.id === saved?.model)?.label ?? saved?.model}`
            : saved
              ? t("mediaNeedsKey")
              : t("mediaOff")}
        </span>
      </div>
      <p class="ui-help">{t(`media_${kind}_help`)}</p>
      {step === 1 && (
        <>
          <p class="media-step">{t("mediaStep1")}</p>
          <Choice<string>
            value={saved ? [saved.provider] : []}
            onChange={([id]) => id && pick(id)}
            options={able.map((p) => ({
              id: p.id,
              title: p.name,
              description: (p.models[kind] ?? []).map((m) => m.label).join(" · "),
              ...(linked(p.id) && { badge: t("mediaHasKey") }),
            }))}
          />
          {saved && (
            <button type="button" class="link" onClick={() => setChanging(false)}>
              {t("cancel")}
            </button>
          )}
        </>
      )}
      {step === 2 && provider && (
        <>
          <p class="media-step">{t("mediaStep2", { name: provider.name })}</p>
          <ol class="brain-steps">
            <li>
              {t("mediaKeyStep1", { name: provider.name })}{" "}
              <a class="button" href={provider.keyUrl} target="_blank" rel="noreferrer">
                {t("mediaGetKey")}
              </a>
            </li>
            <li>{t("mediaKeyStep2")}</li>
            <li>
              {t("mediaKeyStep3")}
              <KeyField provider={provider.id} linked={false} onSaved={onChange} />
            </li>
          </ol>
          <div class="row">
            <button type="button" class="link" onClick={() => setChanging(true)}>
              {t("mediaOtherProvider")}
            </button>
          </div>
        </>
      )}
      {step === 3 && saved && (
        <>
          <div class="form">
            <Field label={t("model")}>
              <select
                value={saved.model}
                onChange={(e) => save({ ...saved, model: (e.target as HTMLSelectElement).value })}
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </Field>
            {kind === "speech" && voices && voices.length > 0 && (
              <Field label={t("mediaVoice")}>
                <select
                  value={saved.voice ?? ""}
                  onChange={(e) => save({ ...saved, voice: (e.target as HTMLSelectElement).value })}
                >
                  {!saved.voice && <option value="">{t("mediaVoiceFirst")}</option>}
                  {voices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </div>
          <KeyField provider={saved.provider} linked onSaved={onChange} />
          <div class="row">
            <button type="button" class="link" onClick={() => setChanging(true)}>
              {t("mediaOtherProvider")}
            </button>
            <button type="button" class="link" onClick={() => save(null)}>
              {t("mediaTurnOff")}
            </button>
          </div>
        </>
      )}
      {error && <p class="notice error">{error}</p>}
    </div>
  );
}

/** Settings, Extensions: the default extensions, the agents' three tools (G25.3). */
export function DefaultExtensions() {
  const [s, setS] = useState<SetupState | null>(null);
  const load = () =>
    void getApi()
      .setup()
      .then(setS, () => {});
  useEffect(load, []);
  if (!s) return null;
  return (
    <section class="default-extensions">
      <h3>{t("mediaTitle")}</h3>
      <p class="ui-help">{t("mediaPurpose")}</p>
      <div class="brain">
        {MEDIA_KINDS.map((k) => (
          <KindRow key={k} kind={k} s={s} onChange={load} />
        ))}
      </div>
    </section>
  );
}

export function MediaSettings() {
  const [s, setS] = useState<SetupState | null>(null);
  const load = () =>
    void getApi()
      .setup()
      .then(setS, () => {});
  useEffect(load, []);
  if (!s) return null;
  return (
    <div class="settings-section brain-settings">
      <h2>{t("mediaTitle")}</h2>
      <p class="ui-purpose">{t("mediaPurpose")}</p>
      <div class="brain">
        {MEDIA_KINDS.map((k) => (
          <KindRow key={k} kind={k} s={s} onChange={load} />
        ))}
      </div>
    </div>
  );
}
