// Web search (2026-11-03): which service the models that cannot search by themselves use.
// RedGiant's own engine (SearXNG) with one button, or a service with a key: for each one what
// it is good at, how to get its key step by step, a try before saving.
import { SEARCH_PROVIDERS, type SearchProviderId } from "@redgiant/protocol";
import { useState } from "preact/hooks";
import type { SetupState } from "../api.js";
import { t } from "../i18n.js";
import { getApi } from "../state.js";
import { explain } from "./Brain.js";
import { Choice, Field } from "./ui.js";

export function SearchSettings({
  s,
  onSaved,
  only,
}: {
  s: SetupState;
  onSaved: () => void;
  /** One service only, in its own panel (2026-11-04): no list to choose from. */
  only?: SearchProviderId;
}) {
  const current: SearchProviderId | undefined =
    s.config.searchProvider ?? (s.config.searxngUrl ? "searxng" : undefined);
  const [pick, setPick] = useState<SearchProviderId>(only ?? current ?? "searxng");
  const [url, setUrl] = useState(s.config.searxngUrl ?? "");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<"try" | "save" | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string }>();
  const info = SEARCH_PROVIDERS.find((p) => p.id === pick);
  const hasKey = s.secretsSet.search?.includes(pick) ?? false;
  const choice = () => ({
    provider: pick,
    ...(pick === "searxng" ? url.trim() && { url: url.trim() } : key.trim() && { key: key.trim() }),
  });
  const ready = pick === "searxng" ? !!url.trim() : !!key.trim() || hasKey;
  const run = async (what: "try" | "save") => {
    setBusy(what);
    setResult(undefined);
    try {
      if (what === "try") {
        const r = await getApi().trySearch(choice());
        setResult({
          ok: true,
          text: r.results
            ? t("searchTried", { n: String(r.results), first: r.first ?? "" })
            : t("searchTriedEmpty"),
        });
      } else {
        await getApi().setupModels({ search: choice() });
        setKey("");
        setResult({ ok: true, text: t("searchSaved", { name: info?.name ?? pick }) });
        onSaved();
      }
    } catch (err) {
      setResult({ ok: false, text: explain(err) });
    }
    setBusy(null);
  };
  if (s.locked.search) return <p class="ui-help">{t("wzLocked")}</p>;
  return (
    <div class="search-settings">
      {!only && <p class="ui-help">{t("searchWho")}</p>}
      {!only && (
        <Choice<SearchProviderId>
          value={[pick]}
          onChange={(v) => {
            if (v[0]) setPick(v[0]);
            setResult(undefined);
          }}
          options={SEARCH_PROVIDERS.map((p) => ({
            id: p.id,
            title: p.id === current ? `${p.name} · ${t("searchInUse")}` : p.name,
            description: t(`searchCard_${p.id}`),
          }))}
        />
      )}
      {info && (
        <div class="search-how">
          <strong>{t("searchHowTitle", { name: info.name })}</strong>
          <ol>
            {/* RedGiant's own SearXNG has its button only where it can run (2026-11-07). */}
            {t(
              info.id === "searxng" && !s.canRunSearch
                ? "searchHow_searxng_own"
                : `searchHow_${info.id}`,
            )
              .split("\n")
              .map((step) => (
                <li key={step}>{step}</li>
              ))}
          </ol>
          <a href={info.keyUrl} target="_blank" rel="noreferrer">
            {info.needs === "key" ? t("searchKeyPage", { name: info.name }) : t("searchDocs")}
          </a>
          {info.needs === "url" ? (
            <Field label={t("servicesSearchUrl")} help={t("searchUrlHelp")}>
              <input
                placeholder="http://searxng:8080"
                value={url}
                onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
              />
            </Field>
          ) : (
            <Field label={t("searchKey")} help={hasKey ? t("searchKeyKept") : undefined}>
              <input
                type="password"
                autoComplete="off"
                placeholder={hasKey ? "••••••••" : (info.keyExample ?? "")}
                value={key}
                onInput={(e) => setKey((e.target as HTMLInputElement).value)}
              />
            </Field>
          )}
          <div class="row">
            <button
              type="button"
              disabled={!ready || busy !== null}
              onClick={() => void run("try")}
            >
              {busy === "try" ? t("wzTrying") : t("searchTry")}
            </button>
            <button
              type="button"
              class="primary row"
              disabled={!ready || busy !== null}
              onClick={() => void run("save")}
            >
              {t("searchUse")}
            </button>
          </div>
          {result && <p class={`notice ${result.ok ? "ok" : "error"}`}>{result.text}</p>}
        </div>
      )}
    </div>
  );
}
