// Demi-God on Discord, Slack, Signal and WhatsApp (G29.5), Matrix, Microsoft Teams and iMessage
// (G36.9), drawn as the wizard (2026-11-06): one
// big square per platform, lit when it is on (never a check mark), each opening a window (a sheet
// from below on phones) with what it needs, then a pairing code to send from the chat. The
// conversation is the same everywhere: begun on Telegram, it goes on here, and on the web.
import { useEffect, useState } from "preact/hooks";
import type { ChatPlatform, SetupState } from "../api.js";
import { brandOr } from "../brands.js";
import { type Key, t } from "../i18n.js";
import { IconChat, IconDownload, IconGrid, IconPhone, IconUsers } from "../icons.js";
import { getApi } from "../state.js";
import { explain } from "./Brain.js";
import { Acts, Head, SwitchRow, Tile, WzPage } from "./SettingsKit.js";
import { Modal } from "./ui.js";

type Link = { userId: string; username: string | null; linkedAt: string };

type Field = { id: string; label: Key; secret?: boolean; kind?: "switch" };

const FIELDS: Record<ChatPlatform, Field[]> = {
  discord: [{ id: "token", label: "chatDiscordToken", secret: true }],
  slack: [
    { id: "botToken", label: "chatSlackBot", secret: true },
    { id: "appToken", label: "chatSlackApp", secret: true },
  ],
  signal: [
    { id: "url", label: "chatSignalUrl" },
    { id: "number", label: "chatSignalNumber" },
  ],
  whatsapp: [
    { id: "token", label: "chatWaToken", secret: true },
    { id: "phoneNumberId", label: "chatWaPhoneId" },
    { id: "appSecret", label: "chatWaSecret", secret: true },
    { id: "verifyToken", label: "chatWaVerify", secret: true },
  ],
  matrix: [
    { id: "homeserver", label: "chatMatrixHomeserver" },
    { id: "accessToken", label: "chatMatrixToken", secret: true },
  ],
  teams: [
    { id: "appId", label: "chatTeamsAppId" },
    { id: "tenantId", label: "chatTeamsTenant" },
    { id: "appPassword", label: "chatTeamsSecret", secret: true },
  ],
  imessage: [
    { id: "url", label: "chatImUrl" },
    { id: "password", label: "chatImPassword", secret: true },
    { id: "privateApi", label: "chatImPrivate", kind: "switch" },
  ],
};

/** Numbered steps for the platforms that need more than a token (G36.9). */
const STEPS: Partial<Record<ChatPlatform, Key[]>> = {
  matrix: ["chatMatrixStep1", "chatMatrixStep2", "chatMatrixStep3", "chatMatrixStep4"],
  teams: [
    "chatTeamsStep1",
    "chatTeamsStep2",
    "chatTeamsStep3",
    "chatTeamsStep4",
    "chatTeamsStep5",
    "chatTeamsStep6",
  ],
  imessage: ["chatImStep1", "chatImStep2", "chatImStep3", "chatImStep4", "chatImStep5"],
};

/** What to know besides, under the steps and once on. */
const NOTE: Partial<Record<ChatPlatform, Key>> = {
  matrix: "chatMatrixE2ee",
  teams: "chatTeamsFiles",
  imessage: "chatImLimits",
};

const teamsEndpoint = () => `${location.origin}/api/chats/teams/messages`;

async function downloadTeamsApp() {
  const blob = await getApi().teamsApp(location.host);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "redgiant-teams.zip";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

const NAMES: Record<ChatPlatform, string> = {
  discord: "Discord",
  slack: "Slack",
  signal: "Signal",
  whatsapp: "WhatsApp",
  matrix: "Matrix",
  teams: "Microsoft Teams",
  imessage: "iMessage",
};

const HOW: Record<ChatPlatform, Key> = {
  discord: "chatDiscordHow",
  slack: "chatSlackHow",
  signal: "chatSignalHow",
  whatsapp: "chatWaHow",
  matrix: "chatMatrixHow",
  teams: "chatTeamsHow",
  imessage: "chatImHow",
};

const TEXT: Record<ChatPlatform, Key> = {
  discord: "sbChatDiscordText",
  slack: "sbChatSlackText",
  signal: "sbChatSignalText",
  whatsapp: "sbChatWaText",
  matrix: "sbChatMatrixText",
  teams: "sbChatTeamsText",
  imessage: "sbChatImText",
};

// Their own logos where simple-icons has them (2026-11-07); Slack's and Microsoft's were withdrawn
// there.
const ICON = {
  discord: brandOr("discord", <IconChat size={26} />, 26),
  slack: <IconUsers size={26} />,
  signal: brandOr("signal", <IconPhone size={26} />, 26),
  whatsapp: brandOr("whatsapp", <IconPhone size={26} />, 26),
  matrix: brandOr("matrix", <IconChat size={26} />, 26),
  teams: <IconGrid size={26} />,
  imessage: brandOr("imessage", <IconPhone size={26} />, 26),
} satisfies Record<ChatPlatform, preact.JSX.Element>;

const linksOf = (p: ChatPlatform) =>
  getApi()
    .chatLinks(p)
    .then(
      (l) => l as Link[],
      () => [] as Link[],
    );

/** The window of one platform: its settings, or (once on) the accounts and the pairing code. */
function Panel({
  p,
  set,
  onChange,
  onClose,
}: {
  p: ChatPlatform;
  set: boolean;
  onChange: () => void;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [code, setCode] = useState<string>();
  const [links, setLinks] = useState<Link[]>([]);
  const [changing, setChanging] = useState(false);
  const loadLinks = () => void linksOf(p).then(setLinks);
  const pair = () =>
    void getApi()
      .chatPair(p)
      .then(
        (r) => setCode(r.code),
        (e: unknown) => setError(explain(e)),
      );
  useEffect(() => {
    if (!set) return;
    loadLinks();
    pair();
  }, [set]);
  // While the code waits, the account shows up as soon as it is sent from the chat.
  useEffect(() => {
    if (!code || links.length > 0) return;
    const timer = setInterval(loadLinks, 2500);
    return () => clearInterval(timer);
  }, [code, links.length]);
  const save = async (settings: Record<string, string> | null) => {
    setBusy(true);
    setError(undefined);
    try {
      await getApi().setupChat(p, settings);
      setValues({});
      setChanging(false);
      onChange();
    } catch (err) {
      setError(explain(err));
    }
    setBusy(false);
  };
  const complete = FIELDS[p].every(
    (f) => f.kind === "switch" || (values[f.id] ?? "").trim().length > 0,
  );
  if (set && !changing)
    return (
      <div class="wz-panel-in sb-chat">
        <h4>{t("sbChatAccounts")}</h4>
        {links.length === 0 ? (
          <p class="dim">{t("sbChatNoAccount")}</p>
        ) : (
          <div class="sb-accounts">
            {links.map((l) => (
              <div class="sb-account" key={l.userId}>
                <span class="sb-account-av">
                  <IconChat size={18} />
                </span>
                <span class="sb-account-name">{l.username ?? l.userId}</span>
                <button
                  type="button"
                  class="wz-btn small quiet"
                  onClick={() => void getApi().chatUnlink(p, l.userId).then(loadLinks)}
                >
                  {t("unlink")}
                </button>
              </div>
            ))}
          </div>
        )}
        {/* Teams: the app first, then the code is sent from it. */}
        {p === "teams" && (
          <div class="sb-teams">
            <p class="ui-help">{t("chatTeamsEndpoint", { url: teamsEndpoint() })}</p>
            <button
              type="button"
              class="wz-btn"
              onClick={() => void downloadTeamsApp().catch((e: unknown) => setError(explain(e)))}
            >
              <IconDownload size={18} />
              {t("chatTeamsDownload")}
            </button>
            <p class="ui-help">{t("chatTeamsUpload")}</p>
          </div>
        )}
        {code && (
          <div class="sb-pair">
            <p>{t("chatSendCode")}</p>
            <span class="wz-code">/start {code}</span>
            {links.length === 0 && <span class="ui-help">{t("sbChatWaiting")}</span>}
          </div>
        )}
        {p === "whatsapp" && (
          <p class="ui-help">
            {t("chatWaWebhook", { url: `${location.origin}/api/chats/whatsapp/webhook` })}
          </p>
        )}
        {NOTE[p] && <p class="ui-help">{t(NOTE[p] as Key)}</p>}
        {error && <p class="notice error">{error}</p>}
        <Acts>
          <button
            type="button"
            class="wz-btn quiet"
            disabled={busy}
            onClick={() => void save(null)}
          >
            {t("chatTurnOff")}
          </button>
          <button type="button" class="wz-btn" onClick={() => setChanging(true)}>
            {t("chatChange")}
          </button>
          <button type="button" class="wz-btn primary" onClick={onClose}>
            {t("wzDoneBtn")}
          </button>
        </Acts>
      </div>
    );
  return (
    <form
      class="wz-panel-in sb-chat"
      onSubmit={(e) => {
        e.preventDefault();
        void save(
          Object.fromEntries(
            FIELDS[p].map((f) => [
              f.id,
              f.kind === "switch" ? (values[f.id] ?? "off") : (values[f.id] ?? "").trim(),
            ]),
          ),
        );
      }}
    >
      <p class="wz-lead2">{t(HOW[p])}</p>
      {STEPS[p] && (
        <div class="sb-steps">
          <h4>{t("chatSteps")}</h4>
          <ol>
            {STEPS[p]?.map((k) => (
              <li key={k}>{t(k, { url: teamsEndpoint() })}</li>
            ))}
          </ol>
        </div>
      )}
      {FIELDS[p].map((f) =>
        f.kind === "switch" ? (
          <SwitchRow
            key={f.id}
            title={t(f.label)}
            on={values[f.id] === "on"}
            onChange={(v) => setValues({ ...values, [f.id]: v ? "on" : "off" })}
          />
        ) : (
          // biome-ignore lint/a11y/noLabelWithoutControl: the input is inside, in either branch.
          <label key={f.id} class="sb-field">
            <span>{t(f.label)}</span>
            {f.secret ? (
              <input
                class="wz-field mono"
                type="password"
                autocomplete="off"
                spellcheck={false}
                value={values[f.id] ?? ""}
                onInput={(e) =>
                  setValues({ ...values, [f.id]: (e.target as HTMLInputElement).value })
                }
              />
            ) : (
              <input
                class="wz-field"
                type="text"
                autocomplete="off"
                autocapitalize="off"
                spellcheck={false}
                value={values[f.id] ?? ""}
                onInput={(e) =>
                  setValues({ ...values, [f.id]: (e.target as HTMLInputElement).value })
                }
              />
            )}
          </label>
        ),
      )}
      {NOTE[p] && <p class="ui-help">{t(NOTE[p] as Key)}</p>}
      {error && <p class="notice error">{error}</p>}
      <Acts>
        <button
          type="button"
          class="wz-btn quiet"
          onClick={() => (changing ? setChanging(false) : onClose())}
        >
          {t("cancel")}
        </button>
        <button type="submit" class="wz-btn primary" disabled={busy || !complete}>
          {busy ? t("wzTrying") : t("wzConnect")}
        </button>
      </Acts>
    </form>
  );
}

export function ChatPlatforms() {
  const [s, setS] = useState<SetupState>();
  const [open, setOpen] = useState<ChatPlatform | null>(null);
  const [links, setLinks] = useState<Partial<Record<ChatPlatform, Link[]>>>({});
  const load = () =>
    void getApi()
      .setup()
      .then(setS, () => {});
  useEffect(load, []);
  const on = (p: ChatPlatform) => s?.secretsSet.chats?.includes(p) ?? false;
  const onKey = (Object.keys(NAMES) as ChatPlatform[]).filter(on).join();
  // Who is linked, for the squares: asked again whenever a window closes.
  useEffect(() => {
    if (!s || open) return;
    const ps = (Object.keys(NAMES) as ChatPlatform[]).filter(on);
    void Promise.all(ps.map((p) => linksOf(p).then((l) => [p, l] as const))).then((all) =>
      setLinks(Object.fromEntries(all)),
    );
  }, [onKey, open, s]);
  if (!s) return null;
  const stateOf = (p: ChatPlatform) => {
    if (!on(p)) return undefined;
    const l = links[p] ?? [];
    return l.length
      ? t("chatLinked", { who: l.map((x) => x.username ?? x.userId).join(", ") })
      : t("sbChatOnWaiting");
  };
  return (
    <WzPage class="sb-chats">
      <Head eyebrow={t("chats")} q={t("sbChatsQ")} lead={t("chatsHint")} />
      <div class="wz-brain sb-tiles">
        {(Object.keys(NAMES) as ChatPlatform[]).map((p) => (
          <Tile
            key={p}
            on={on(p)}
            icon={ICON[p]}
            title={NAMES[p]}
            text={t(TEXT[p])}
            state={stateOf(p)}
            onClick={() => setOpen(p)}
          />
        ))}
      </div>
      {open && (
        <Modal title={NAMES[open]} onClose={() => setOpen(null)}>
          <Panel key={open} p={open} set={on(open)} onChange={load} onClose={() => setOpen(null)} />
        </Modal>
      )}
    </WzPage>
  );
}
