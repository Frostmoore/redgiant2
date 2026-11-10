// Settings > Models and subscriptions, redone as the wizard (2026-11-06, the person: «va rifatta
// come quella del wizard»): big centred headings and a lot of room; the ways of thinking as the
// wizard's squares, lit by border and background when connected (never a check mark), each one
// opening a window (a sheet from below on phones) with the real panels; the model agents use and
// web search as squares too; then the local model as in the wizard's step, with what only
// Settings had (the bar of where the model sits, the last start's plan, the engine).
import { SEARCH_PROVIDERS } from "@redgiant/protocol";
import { useRef, useState } from "preact/hooks";
import type { SetupState } from "../api.js";
import { brandOr } from "../brands.js";
import { localModelName } from "../format.js";
import { t, tOptional } from "../i18n.js";
import { IconCrown, IconSearch, IconServer } from "../icons.js";
import { getApi } from "../state.js";
import { type Way, waysInUse } from "../wizard.js";
import {
  ChatgptCard,
  ClaudeCard,
  DefaultModel,
  KeysForm,
  providerName,
  ServerPanel,
  wayState,
  wayTiles,
} from "./Brain.js";
import { LocalModels } from "./LocalModels.js";
import { ModelsCatalogRow } from "./ModelsCatalogRow.js";
import { SearchSettings } from "./SearchSettings.js";
import { OwnSearch } from "./Services.js";
import { Acts, Head, Sub, Tile } from "./SettingsKit.js";
import { Modal } from "./ui.js";

/** The window open: a way of thinking, the agents' model, a search provider, or the help. */
type Open = Exclude<Way, "local"> | "why" | "default" | `search:${string}`;

export function ModelsPage({ s, reload }: { s: SetupState; reload: () => void }) {
  const [open, setOpen] = useState<Open | null>(null);
  const [ack, setAckState] = useState(s.config.subscriptionAck === true);
  const local = useRef<HTMLElement>(null);
  const setAck = (v: boolean) => {
    setAckState(v);
    void getApi()
      .setupSubscriptions({ ack: v })
      .catch(() => {});
  };
  const close = () => {
    setOpen(null);
    reload();
  };
  const ways = waysInUse(s);
  const tiles = wayTiles();
  const titleOf = (w: Way) => tiles.find((x) => x[0] === w)?.[2] ?? "";
  // As in the wizard: only a lit square says what is connected; the others say nothing.
  const stateOf = (w: Way) => {
    if (!ways.includes(w)) return undefined;
    if (w === "local" && s.config.engine?.off) return `${wayState(s, w)} · ${t("lmOff")}`;
    return wayState(s, w);
  };
  // The local model is not a window: it is the page's last part, as the wizard's step.
  const pick = (w: Way) => {
    if (w === "local") local.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    else setOpen(w);
  };
  const d = s.config.defaultModel;
  const searchNow = s.config.searchProvider ?? (s.config.searxngUrl ? "searxng" : undefined);
  const searchOpen = open?.startsWith("search:")
    ? SEARCH_PROVIDERS.find((p) => `search:${p.id}` === open)
    : undefined;
  const done = (
    <Acts>
      <button type="button" class="wz-btn primary" onClick={close}>
        {t("wzDoneBtn")}
      </button>
    </Acts>
  );
  return (
    <div class="models-wz">
      <section class="wz-inner">
        <Head eyebrow={t("subscriptions")} q={t("wzBrainQ")} lead={t("mpLead")} />
        <div class="wz-brain">
          {tiles.map(([w, icon, title, text]) => (
            <Tile
              key={w}
              on={ways.includes(w)}
              icon={icon}
              title={title}
              text={text}
              state={stateOf(w)}
              onClick={() => pick(w)}
            />
          ))}
        </div>
        <p class="wz-more">
          <button type="button" class="wz-link" onClick={() => setOpen("why")}>
            {t("wzWhich")}
          </button>
        </p>
        <ModelsCatalogRow />

        <Sub title={t("brainDefault")} lead={t("brainDefaultHint")} />
        <div class="wz-brain mp-one">
          <Tile
            on={!!d}
            icon={<IconCrown />}
            title={d ? localModelName(d.model.split("/").pop() ?? d.model) : t("mpNoDefault")}
            text={
              d
                ? [providerName(d.provider), tOptional(`effort_${d.effort ?? "medium"}`)]
                    .filter(Boolean)
                    .join(" · ")
                : t("mpNoDefaultText")
            }
            state={s.locked.defaultModel ? t("wzLocked") : t("mpChange")}
            onClick={() => setOpen("default")}
          />
        </div>

        <Sub title={t("mpSearchTitle")} lead={t("mpSearchLead")} />
        <div class="wz-brain mp-search">
          {SEARCH_PROVIDERS.map((p) => (
            <Tile
              key={p.id}
              on={searchNow === p.id}
              icon={brandOr(p.id, p.id === "searxng" ? <IconServer /> : <IconSearch size={22} />)}
              title={p.name}
              text={t(`searchCard_${p.id}`)}
              state={searchNow === p.id ? t("searchInUse") : undefined}
              onClick={() => setOpen(`search:${p.id}`)}
            />
          ))}
        </div>
      </section>

      <section class="wz-inner wide mp-local" ref={local}>
        <h2 class="wz-q mp-q">{t("wzLocalQ")}</h2>
        <p class="wz-lead">{t("mpLocalLead")}</p>
        <LocalModels s={s} reload={reload} />
      </section>

      {open === "why" && (
        <Modal title={t("wzWhich")} onClose={() => setOpen(null)}>
          <p class="wz-lead2">{t("brainWhyText")}</p>
          <Acts>
            <button type="button" class="wz-btn primary" onClick={() => setOpen(null)}>
              {t("wzUnderstood")}
            </button>
          </Acts>
        </Modal>
      )}
      {(open === "claude" || open === "chatgpt" || open === "server") && (
        <Modal title={titleOf(open)} onClose={close}>
          <div class="wz-panel-in">
            {open === "claude" && <ClaudeCard ack={ack} setAck={setAck} onChange={reload} />}
            {open === "chatgpt" && <ChatgptCard ack={ack} setAck={setAck} onChange={reload} />}
            {open === "server" && <ServerPanel s={s} onChange={reload} />}
          </div>
          {done}
        </Modal>
      )}
      {open === "keys" && (
        <Modal title={titleOf("keys")} onClose={close}>
          <div class="wz-panel-in">
            <KeysForm s={s} onChange={reload} onClose={close} />
          </div>
        </Modal>
      )}
      {open === "default" && (
        <Modal title={t("brainDefault")} onClose={close}>
          <div class="wz-panel-in">
            {s.locked.defaultModel ? (
              <p class="notice">{t("wzLocked")}</p>
            ) : (
              <DefaultModel s={s} onSaved={reload} />
            )}
          </div>
          {done}
        </Modal>
      )}
      {searchOpen && (
        <Modal title={searchOpen.name} onClose={close}>
          <div class="wz-panel-in">
            <p class="wz-lead2">{t(`searchCard_${searchOpen.id}`)}</p>
            {searchOpen.id === "searxng" && <OwnSearch s={s} onChange={reload} />}
            <SearchSettings key={searchOpen.id} s={s} only={searchOpen.id} onSaved={reload} />
          </div>
          {done}
        </Modal>
      )}
    </div>
  );
}
