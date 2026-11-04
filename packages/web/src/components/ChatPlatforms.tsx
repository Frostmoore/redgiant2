// Demi-God on Discord, Slack, Signal and WhatsApp (G29.5): one card per platform with what it
// needs, then a pairing code to send from the chat. The conversation is the same everywhere:
// begun on Telegram, it goes on here, and on the web.
import { useEffect, useState } from "preact/hooks";
import type { ChatPlatform, SetupState } from "../api.js";
import { type Key, t } from "../i18n.js";
import { IconCheck } from "../icons.js";
import { getApi } from "../state.js";
import { explain } from "./Brain.js";
import { Field } from "./ui.js";

type Link = { userId: string; username: string | null; linkedAt: string };

const FIELDS: Record<ChatPlatform, { id: string; label: Key; secret?: boolean }[]> = {
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
};

const NAMES: Record<ChatPlatform, string> = {
  discord: "Discord",
  slack: "Slack",
  signal: "Signal",
  whatsapp: "WhatsApp",
};

const HOW: Record<ChatPlatform, Key> = {
  discord: "chatDiscordHow",
  slack: "chatSlackHow",
  signal: "chatSignalHow",
  whatsapp: "chatWaHow",
};

function Platform({ p, set, onChange }: { p: ChatPlatform; set: boolean; onChange: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [code, setCode] = useState<string>();
  const [links, setLinks] = useState<Link[]>([]);
  const [changing, setChanging] = useState(false);
  const loadLinks = () =>
    void getApi()
      .chatLinks(p)
      .then(setLinks, () => {});
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
  const complete = FIELDS[p].every((f) => (values[f.id] ?? "").trim().length > 0);
  return (
    <div class="brain-panel chat-platform">
      <h3>{NAMES[p]}</h3>
      {set && !changing ? (
        <>
          {links.map((l) => (
            <div class="row" key={l.userId}>
              <span class="notice ok">
                <IconCheck size={14} /> {t("chatLinked", { who: l.username ?? l.userId })}
              </span>
              <div class="spacer" />
              <button
                type="button"
                class="link"
                onClick={() => void getApi().chatUnlink(p, l.userId).then(loadLinks)}
              >
                {t("unlink")}
              </button>
            </div>
          ))}
          {code && (
            <p>
              {t("chatSendCode")} <code>/start {code}</code>
            </p>
          )}
          {p === "whatsapp" && (
            <p class="ui-help">
              {t("chatWaWebhook", { url: `${location.origin}/api/chats/whatsapp/webhook` })}
            </p>
          )}
          <div class="row">
            <button type="button" class="link" onClick={() => setChanging(true)}>
              {t("chatChange")}
            </button>
            <button type="button" class="link" disabled={busy} onClick={() => void save(null)}>
              {t("chatTurnOff")}
            </button>
          </div>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save(
              Object.fromEntries(FIELDS[p].map((f) => [f.id, (values[f.id] ?? "").trim()])),
            );
          }}
        >
          <p class="ui-help">{t(HOW[p])}</p>
          {FIELDS[p].map((f) => (
            <Field key={f.id} label={t(f.label)}>
              {f.secret ? (
                <input
                  type="password"
                  autocomplete="off"
                  value={values[f.id] ?? ""}
                  onInput={(e) =>
                    setValues({ ...values, [f.id]: (e.target as HTMLInputElement).value })
                  }
                />
              ) : (
                <input
                  type="text"
                  autocomplete="off"
                  value={values[f.id] ?? ""}
                  onInput={(e) =>
                    setValues({ ...values, [f.id]: (e.target as HTMLInputElement).value })
                  }
                />
              )}
            </Field>
          ))}
          <button type="submit" class="primary" disabled={busy || !complete}>
            {busy ? t("wzTrying") : t("wzConnect")}
          </button>
        </form>
      )}
      {error && <p class="notice error">{error}</p>}
    </div>
  );
}

export function ChatPlatforms() {
  const [s, setS] = useState<SetupState>();
  const load = () =>
    void getApi()
      .setup()
      .then(setS, () => {});
  useEffect(load, []);
  if (!s) return null;
  return (
    <div class="settings-section">
      <h2>{t("chats")}</h2>
      <p class="ui-help">{t("chatsHint")}</p>
      <div class="chat-platforms">
        {(Object.keys(NAMES) as ChatPlatform[]).map((p) => (
          <Platform key={p} p={p} set={s.secretsSet.chats?.includes(p) ?? false} onChange={load} />
        ))}
      </div>
    </div>
  );
}
