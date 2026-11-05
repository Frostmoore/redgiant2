import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { bytes } from "../format.js";
import { lang, setLang, t } from "../i18n.js";
import {
  IconArchive,
  IconCard,
  IconChat,
  IconClock,
  IconCompass,
  IconDollar,
  IconDownload,
  IconFolder,
  IconLayers,
  IconLogout,
  IconMonitor,
  IconMoon,
  IconPuzzle,
  IconRefresh,
  IconSettings,
  IconShield,
  IconSun,
  IconTelegram,
  IconTrash,
  IconTree,
} from "../icons.js";
import { attempt, getApi, openTab, type SettingsSection, signOut } from "../state.js";
import { setTheme, theme } from "../theme.js";
import { Automations } from "./Automations.js";
import { Backup } from "./Backup.js";
import { explain } from "./Brain.js";
import { Budgets } from "./Budgets.js";
import { ChatPlatforms } from "./ChatPlatforms.js";
import { CodeSettings } from "./CodeSettings.js";
import { EmailSettings } from "./EmailSettings.js";
import { Extensions } from "./Extensions.js";
import { Hierarchy } from "./Hierarchy.js";
import { Platform } from "./Platform.js";
import { RemoteSettings } from "./RemoteSettings.js";
import { Services } from "./Services.js";
import { Setup } from "./Setup.js";
import { Subscriptions } from "./Subscriptions.js";
import { Telegram } from "./Telegram.js";
import { Pick } from "./ui.js";

const SECTIONS: { id: SettingsSection; label: () => string; icon: ComponentChildren }[] = [
  { id: "general", label: () => t("general"), icon: <IconSettings size={15} /> },
  { id: "setup", label: () => t("setupWizard"), icon: <IconCompass size={15} /> },
  { id: "agents", label: () => t("agents"), icon: <IconTree size={15} /> },
  { id: "automations", label: () => t("automations"), icon: <IconClock size={15} /> },
  { id: "extensions", label: () => t("extensions"), icon: <IconPuzzle size={15} /> },
  { id: "telegram", label: () => t("telegram"), icon: <IconTelegram size={15} /> },
  { id: "chats", label: () => t("chats"), icon: <IconChat size={15} /> },
  { id: "subscriptions", label: () => t("subscriptions"), icon: <IconCard size={15} /> },
  { id: "code", label: () => t("wzCode"), icon: <IconFolder size={15} /> },
  { id: "remote", label: () => t("wzRemote"), icon: <IconShield size={15} /> },
  { id: "budgets", label: () => t("budgets"), icon: <IconDollar size={15} /> },
  { id: "backup", label: () => t("backup"), icon: <IconArchive size={15} /> },
  { id: "platform", label: () => t("platformView"), icon: <IconLayers size={15} /> },
];

/** The browser's notifications (2026-11-05): when the page is not in view and an agent needs you. */
function BrowserNotifications() {
  const supported = typeof Notification !== "undefined";
  const [state, setState] = useState(supported ? Notification.permission : "denied");
  if (!supported) return null;
  return (
    <div class="field">
      {t("notifyTitle")}
      <span class="ui-help">{t("notifyHint")}</span>
      {state === "granted" ? (
        <span class="notice ok">{t("notifyOn")}</span>
      ) : state === "denied" ? (
        <span class="ui-help">{t("notifyBlocked")}</span>
      ) : (
        <button type="button" onClick={() => void Notification.requestPermission().then(setState)}>
          {t("notifyEnable")}
        </button>
      )}
    </div>
  );
}

/**
 * Instructions for every agent (2026-11-05): the person's general system prompt, added to each
 * agent's own. Each agent's own instructions stay in its card under Agents.
 */
function Instructions() {
  const [text, setText] = useState<string>();
  const [saved, setSaved] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string>();
  useEffect(() => {
    void getApi()
      .setup()
      .then(
        (s) => {
          setText(s.config.instructions ?? "");
          setSaved(s.config.instructions ?? "");
        },
        () => setText(""),
      );
  }, []);
  if (text === undefined) return null;
  const save = async () => {
    setState("saving");
    setError(undefined);
    try {
      await getApi().setupInstructions(text);
      setSaved(text.trim());
      setState("saved");
    } catch (e) {
      setError(explain(e));
      setState("idle");
    }
  };
  return (
    <>
      <h2 style={{ marginTop: "24px" }}>{t("instructionsTitle")}</h2>
      <p class="ui-help">{t("instructionsHint")}</p>
      <textarea
        class="instructions"
        rows={8}
        value={text}
        placeholder={t("instructionsPlaceholder")}
        onInput={(e) => {
          setText((e.target as HTMLTextAreaElement).value);
          setState("idle");
        }}
      />
      <div class="row">
        <button
          type="button"
          class="primary"
          disabled={state === "saving" || text.trim() === saved}
          onClick={() => void save()}
        >
          {t("save")}
        </button>
        {state === "saved" && <span class="ui-help">{t("instructionsSaved")}</span>}
      </div>
      {error && <p class="notice error">{error}</p>}
    </>
  );
}

function General() {
  return (
    <div class="settings-section">
      <h2>{t("general")}</h2>
      <div class="form stack">
        <div class="field">
          {t("theme")}
          <span class="choice">
            {(
              [
                ["system", <IconMonitor key="s" />, t("themeSystem")],
                ["light", <IconSun key="l" />, t("themeLight")],
                ["dark", <IconMoon key="d" />, t("themeDark")],
              ] as const
            ).map(([value, icon, label]) => (
              <button
                type="button"
                key={value}
                class={theme.value === value ? "active" : ""}
                onClick={() => setTheme(value)}
              >
                {icon} {label}
              </button>
            ))}
          </span>
        </div>
        <div class="field">
          {t("language")}
          <span class="choice">
            {(["it", "en"] as const).map((l) => (
              <button
                type="button"
                key={l}
                class={lang.value === l ? "active" : ""}
                onClick={() => setLang(l)}
              >
                {l === "it" ? "Italiano" : "English"}
              </button>
            ))}
          </span>
        </div>
      </div>
      <BrowserNotifications />
      <Instructions />
      <Services />
      <EmailSettings />
      <Updates />
      <Diagnostics />
      <h2 style={{ marginTop: "24px" }}>{t("account")}</h2>
      <button type="button" onClick={signOut} class="row">
        <IconLogout /> {t("logout")}
      </button>
    </div>
  );
}

/**
 * Debug mode (2026-11-04, the person's request): everything RedGiant does left in a log, to
 * download as one archive and send, or to delete.
 */
function Diagnostics() {
  const [st, setSt] = useState<{
    enabled: boolean;
    forced: boolean;
    bytes: number;
    files: number;
  }>();
  useEffect(() => {
    void attempt(() => getApi().debugState()).then((x) => x && setSt(x));
  }, []);
  if (!st) return null;
  const save = async () => {
    const r = await attempt(() => getApi().debugLogs());
    if (!r) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(r.blob);
    a.download = r.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  };
  return (
    <div class="diagnostics">
      <h2 style={{ marginTop: "24px" }}>{t("dbgTitle")}</h2>
      <p class="ui-help">{t("dbgHelp")}</p>
      <Pick
        on={st.enabled}
        onChange={(v) => {
          if (st.forced) return;
          void attempt(() => getApi().setDebug(v)).then((x) => x && setSt(x));
        }}
      >
        <strong>{t("dbgSwitch")}</strong>
      </Pick>
      {st.forced && <p class="ui-help">{t("dbgForced")}</p>}
      <p class="ui-help">{t("dbgSize", { size: bytes(st.bytes), files: String(st.files) })}</p>
      <div class="row wrap">
        <button type="button" class="row" disabled={st.files === 0} onClick={() => void save()}>
          <IconDownload size={14} /> {t("dbgDownload")}
        </button>
        <button
          type="button"
          class="link row"
          disabled={st.files === 0}
          onClick={() => {
            if (!confirm(t("dbgClearConfirm"))) return;
            void attempt(() => getApi().clearDebugLogs()).then((x) => x && setSt(x));
          }}
        >
          <IconTrash size={13} /> {t("dbgClear")}
        </button>
      </div>
    </div>
  );
}

/** «Look for updates» (2026-11-04): the answer in words; on Windows the question on the desktop. */
function Updates() {
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<{ ok: boolean; text: string }>();
  const look = async () => {
    setBusy(true);
    setAnswer(undefined);
    const r = await attempt(() => getApi().checkUpdates());
    setBusy(false);
    if (!r) return;
    const v = r.version ?? "";
    setAnswer(
      r.state === "available"
        ? { ok: true, text: t("updAvailable", { version: v }) }
        : r.state === "latest"
          ? { ok: true, text: t("updLatest", { version: v }) }
          : r.state === "manual"
            ? { ok: true, text: t("updManual", { version: v }) }
            : { ok: false, text: t("updUnreachable") },
    );
  };
  return (
    <div class="updates">
      <h2 style={{ marginTop: "24px" }}>{t("updTitle")}</h2>
      <p class="ui-help">{t("updHelp")}</p>
      <button type="button" class="row" disabled={busy} onClick={() => void look()}>
        <IconRefresh size={14} /> {busy ? t("updLooking") : t("updLook")}
      </button>
      {answer && <p class={`notice ${answer.ok ? "ok" : "error"}`}>{answer.text}</p>}
    </div>
  );
}

/** Everything that is not a conversation: one page, its sections on the left. */
export function Settings({ section = "general" }: { section?: SettingsSection | undefined }) {
  const go = (s: SettingsSection) =>
    openTab({ id: "settings", type: "settings", title: t("settings"), section: s });
  return (
    <div class="settings">
      <nav class="settings-nav">
        {SECTIONS.map((s) => (
          <button
            type="button"
            key={s.id}
            class={section === s.id ? "active" : ""}
            onClick={() => go(s.id)}
          >
            {s.icon}
            {s.label()}
          </button>
        ))}
      </nav>
      <div class="settings-body">
        {section === "general" && <General />}
        {section === "setup" && <Setup />}
        {section === "agents" && <Hierarchy />}
        {section === "automations" && <Automations />}
        {section === "extensions" && <Extensions />}
        {section === "telegram" && <Telegram />}
        {section === "chats" && <ChatPlatforms />}
        {section === "subscriptions" && <Subscriptions />}
        {section === "code" && <CodeSettings />}
        {section === "remote" && <RemoteSettings />}
        {section === "budgets" && <Budgets />}
        {section === "backup" && <Backup />}
        {section === "platform" && <Platform />}
      </div>
    </div>
  );
}
