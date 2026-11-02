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
import { Field } from "./ui.js";

type Choice = { provider: string; model: string; voice?: string };

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
  const linked = (id: string) => s.secretsSet.media?.includes(id) ?? false;
  const save = (c: Choice | null) => {
    setError(undefined);
    void getApi()
      .setupMedia(kind, c)
      .then(onChange, (err: unknown) => setError(explain(err)));
  };
  useEffect(() => {
    if (kind !== "speech" || !saved) return setVoices(undefined);
    void getApi()
      .mediaVoices(saved.provider)
      .then(setVoices, () => setVoices([]));
  }, [kind, saved?.provider, linked(saved?.provider ?? "")]);
  const models = saved ? (mediaProvider(saved.provider)?.models[kind] ?? []) : [];
  return (
    <div class="brain-panel media-kind">
      <h3>{t(`media_${kind}`)}</h3>
      <p class="ui-help">{t(`media_${kind}_help`)}</p>
      <div class="form">
        <Field label={t("mediaProvider")}>
          <select
            value={saved?.provider ?? ""}
            onChange={(e) => {
              const id = (e.target as HTMLSelectElement).value;
              const p = mediaProvider(id);
              const first = p?.models[kind]?.[0];
              save(
                p && first
                  ? {
                      provider: id,
                      model: first.id,
                      ...(p.voices?.[0] && { voice: p.voices[0].id }),
                    }
                  : null,
              );
            }}
          >
            <option value="">{t("mediaNobody")}</option>
            {able.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        {saved && (
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
        )}
        {saved && kind === "speech" && voices && voices.length > 0 && (
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
      {saved && (
        <KeyField provider={saved.provider} linked={linked(saved.provider)} onSaved={onChange} />
      )}
      {error && <p class="notice error">{error}</p>}
    </div>
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
