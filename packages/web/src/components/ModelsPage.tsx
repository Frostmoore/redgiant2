// Settings > Models (2026-11-04, the person's choice: a gallery with a panel). The kinds of
// brains as chips on top; each kind is cards side by side; touching one opens its details and
// actions in the panel (a window with an X on phones).
import { KEY_PROVIDERS, OWN_SERVER_ID, SEARCH_PROVIDERS } from "@redgiant/protocol";
import { useState } from "preact/hooks";
import type { SetupState } from "../api.js";
import { t, tOptional } from "../i18n.js";
import { IconCard, IconCheck, IconChevron, IconMonitor, IconSearch } from "../icons.js";
import { getApi } from "../state.js";
import {
  ChatgptCard,
  ClaudeCard,
  DefaultModel,
  KeyRow,
  providerName,
  ServerPanel,
} from "./Brain.js";
import { Gallery, GalleryCard, type GalleryPanel } from "./Gallery.js";
import { LocalModels } from "./LocalModels.js";
import { SearchSettings } from "./SearchSettings.js";
import { OwnSearch } from "./Services.js";

type Kind = "local" | "subs" | "keys" | "server" | "search" | "default";
const KINDS: Kind[] = ["local", "subs", "keys", "server", "search", "default"];

/** A card's foot: connected or not, and the arrow that says it opens. */
function Foot({ on, text }: { on: boolean; text: string }) {
  return (
    <span class="gcard-foot">
      <span class={on ? "chip ok" : "gcard-note"}>
        {on && <IconCheck size={12} />} {text}
      </span>
      <IconChevron open={false} size={14} />
    </span>
  );
}

/** The two letters drawn for a provider: no logos of others, no symbols. */
const initials = (name: string) =>
  name
    .split(/[\s(]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");

export function ModelsPage({ s, reload }: { s: SetupState; reload: () => void }) {
  const [kind, setKind] = useState<Kind>("local");
  const [open, setOpen] = useState<string | null>(null);
  const [ack, setAckState] = useState(s.config.subscriptionAck === true);
  const setAck = (v: boolean) => {
    setAckState(v);
    void getApi()
      .setupSubscriptions({ ack: v })
      .catch(() => {});
  };
  const pickKind = (k: Kind) => {
    setKind(k);
    setOpen(null);
  };
  const searchNow = s.config.searchProvider ?? (s.config.searxngUrl ? "searxng" : undefined);
  const card = (id: string, on: boolean, body: preact.ComponentChildren) => (
    <GalleryCard
      key={id}
      selected={open === id}
      tone={on ? "ok" : undefined}
      onOpen={() => setOpen(id)}
    >
      {body}
    </GalleryCard>
  );
  let cards: preact.ComponentChildren = null;
  let panel: GalleryPanel | null = null;
  if (kind === "subs") {
    const subs = [
      {
        id: "claude",
        title: t("brainClaude"),
        help: t("brainClaudeCard"),
        on: !!s.config.subscriptions?.claude,
      },
      {
        id: "chatgpt",
        title: t("brainChatgpt"),
        help: t("brainChatgptCard"),
        on: !!s.config.subscriptions?.chatgpt,
      },
    ];
    cards = subs.map((x) =>
      card(
        x.id,
        x.on,
        <>
          <span class="gcard-head">
            <strong>{x.title}</strong>
            <IconCard size={16} />
          </span>
          <span class="gcard-note">{x.help}</span>
          <Foot on={x.on} text={x.on ? t("brainConnected") : t("modelsNotConnected")} />
        </>,
      ),
    );
    if (open === "claude")
      panel = {
        title: t("brainClaude"),
        body: <ClaudeCard ack={ack} setAck={setAck} onChange={reload} />,
      };
    if (open === "chatgpt")
      panel = {
        title: t("brainChatgpt"),
        body: <ChatgptCard ack={ack} setAck={setAck} onChange={reload} />,
      };
  } else if (kind === "keys") {
    cards = KEY_PROVIDERS.map((p) => {
      const on =
        s.secretsSet.keys.includes(p.id) || (p.id === "anthropic" && s.locked.anthropic === true);
      return card(
        p.id,
        on,
        <>
          <span class="gcard-head">
            <strong>{p.name}</strong>
            <span class="gmark" aria-hidden="true">
              {initials(p.name)}
            </span>
          </span>
          <Foot on={on} text={on ? t("brainConnected") : t("modelsNotConnected")} />
        </>,
      );
    });
    const p = KEY_PROVIDERS.find((x) => x.id === open);
    if (p)
      panel = {
        title: p.name,
        body: (
          <ul class="brain-key-list">
            <KeyRow
              key={p.id}
              p={p}
              startOpen
              connected={s.secretsSet.keys.includes(p.id)}
              locked={p.id === "anthropic" && s.locked.anthropic === true}
              onChange={reload}
            />
          </ul>
        ),
      };
  } else if (kind === "server") {
    const on = !!s.config.server || s.locked.server === true;
    cards = card(
      OWN_SERVER_ID,
      on,
      <>
        <span class="gcard-head">
          <strong>{t("brainServer")}</strong>
          <IconMonitor size={16} />
        </span>
        <span class="gcard-note">{s.config.server?.baseUrl ?? t("brainServerCard")}</span>
        <Foot on={on} text={on ? t("brainConnected") : t("modelsNotConnected")} />
      </>,
    );
    if (open === OWN_SERVER_ID)
      panel = { title: t("brainServer"), body: <ServerPanel s={s} onChange={reload} /> };
  } else if (kind === "search") {
    cards = SEARCH_PROVIDERS.map((p) =>
      card(
        p.id,
        searchNow === p.id,
        <>
          <span class="gcard-head">
            <strong>{p.name}</strong>
            <IconSearch size={16} />
          </span>
          <span class="gcard-note">{t(`searchCard_${p.id}`)}</span>
          <Foot
            on={searchNow === p.id}
            text={searchNow === p.id ? t("searchInUse") : t("modelsOff")}
          />
        </>,
      ),
    );
    const p = SEARCH_PROVIDERS.find((x) => x.id === open);
    if (p)
      panel = {
        title: p.name,
        body: (
          <>
            {p.id === "searxng" && <OwnSearch s={s} onChange={reload} />}
            <SearchSettings key={p.id} s={s} only={p.id} onSaved={reload} />
          </>
        ),
      };
  } else if (kind === "default") {
    const d = s.config.defaultModel;
    cards = card(
      "default",
      !!d,
      <>
        <span class="gcard-head">
          <strong>{t("brainDefault")}</strong>
        </span>
        <span class="gcard-big">{d ? d.model.split("/").pop() : "–"}</span>
        <span class="gcard-note">{d ? providerName(d.provider) : t("brainNoModel")}</span>
        <Foot
          on={!!d}
          text={d ? (tOptional(`effort_${d.effort ?? "medium"}`) ?? "") : t("modelsOff")}
        />
      </>,
    );
    if (open === "default")
      panel = { title: t("brainDefault"), body: <DefaultModel s={s} onSaved={reload} /> };
  }
  return (
    <div class="models-page">
      <div class="gallery-kinds" role="tablist">
        {KINDS.map((k) => (
          <button
            type="button"
            role="tab"
            key={k}
            aria-selected={kind === k}
            class={kind === k ? "on" : ""}
            onClick={() => pickKind(k)}
          >
            {t(`modelsKind_${k}`)}
          </button>
        ))}
      </div>
      {kind === "local" ? (
        <LocalModels s={s} reload={reload} />
      ) : (
        <Gallery panel={panel} onClose={() => setOpen(null)}>
          {cards}
        </Gallery>
      )}
    </div>
  );
}
