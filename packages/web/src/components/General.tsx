// Settings > General, drawn as the wizard (2026-11-06, the person: «tutte le pagine delle
// impostazioni con lo stesso stile del wizard»): a big heading, the look and the notifications on
// rows with segments and a switch (the interface's language and the agents', apart: G33.5),
// then the wizard's squares, lit when something is set (never a check mark), each opening a
// window (a sheet from below on phones) with its real panel: instructions for every agent, the
// backup model, web search, voice messages, pictures, updates and the debug log. The account at the bottom. The mailbox serves automations only and lives
// in Settings > Automations (2026-11-07).
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { SetupState } from "../api.js";
import { bytes, localModelName } from "../format.js";
import { lang, setLang, t } from "../i18n.js";
import {
  IconBook,
  IconBox,
  IconCrown,
  IconDownload,
  IconGlobe,
  IconLogout,
  IconMic,
  IconMonitor,
  IconMoon,
  IconRefresh,
  IconSun,
  IconTool,
  IconTrash,
} from "../icons.js";
import { attempt, getApi, signOut } from "../state.js";
import { setTheme, theme } from "../theme.js";
import { explain } from "./Brain.js";
import { AgentLanguagePicker } from "./LanguagePicker.js";
import { ModelSelect, type Spec, useModels } from "./ModelSelect.js";
import { ServicePanel } from "./Services.js";
import {
  Acts,
  Box,
  Done,
  Head,
  Row,
  Seg,
  Sub,
  Switch,
  Tile,
  Tiles,
  WzPage,
} from "./SettingsKit.js";
import { Modal } from "./ui.js";

type DebugState = { enabled: boolean; forced: boolean; bytes: number; files: number };
type Open = "instructions" | "backup" | "search" | "voice" | "images" | "updates" | "debug";

/** The browser's notifications (2026-11-05): when the page is not in view and an agent needs you. */
function BrowserNotifications() {
  const supported = typeof Notification !== "undefined";
  const [state, setState] = useState(supported ? Notification.permission : "denied");
  if (!supported) return null;
  return (
    <Row title={t("notifyTitle")} help={t("notifyHint")}>
      {state === "granted" ? (
        <span class="st-on">{t("notifyOn")}</span>
      ) : state === "denied" ? (
        <span class="dim st-small">{t("notifyBlocked")}</span>
      ) : (
        <button
          type="button"
          class="wz-btn small"
          onClick={() => void Notification.requestPermission().then(setState)}
        >
          {t("notifyEnable")}
        </button>
      )}
    </Row>
  );
}

/**
 * Instructions for every agent (2026-11-05): the person's general system prompt, added to each
 * agent's own. Each agent's own instructions stay in its card under Agents.
 */
function Instructions({ initial, onSaved }: { initial: string; onSaved: () => void }) {
  const [text, setText] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string>();
  const save = async () => {
    setState("saving");
    setError(undefined);
    try {
      await getApi().setupInstructions(text);
      setSaved(text.trim());
      setState("saved");
      onSaved();
    } catch (e) {
      setError(explain(e));
      setState("idle");
    }
  };
  return (
    <>
      <p class="wz-lead2">{t("instructionsHint")}</p>
      <textarea
        class="wz-field st-instructions"
        rows={9}
        value={text}
        aria-label={t("instructionsTitle")}
        placeholder={t("instructionsPlaceholder")}
        onInput={(e) => {
          setText((e.target as HTMLTextAreaElement).value);
          setState("idle");
        }}
      />
      {state === "saved" && <p class="notice ok">{t("instructionsSaved")}</p>}
      {error && <p class="notice error">{error}</p>}
      <Acts>
        <button
          type="button"
          class="wz-btn primary"
          disabled={state === "saving" || text.trim() === saved}
          onClick={() => void save()}
        >
          {t("save")}
        </button>
      </Acts>
    </>
  );
}

/**
 * The backup model for tasks (2026-11-05): a task an agent gives up on is tried once more by
 * this model, in a new conversation; best from another provider.
 */
function BackupModel({ initial, onSaved }: { initial: Spec | null; onSaved: () => void }) {
  const models = useModels();
  const [value, setValue] = useState<Spec | null>(initial);
  const [error, setError] = useState<string>();
  if (!models) return <p class="dim">{t("loading")}</p>;
  const choose = (m: Spec | null) => {
    const before = value;
    setValue(m);
    setError(undefined);
    getApi()
      .setupBackupModel(m)
      .then(onSaved, (e: unknown) => {
        setValue(before);
        setError(explain(e));
      });
  };
  return (
    <>
      <p class="wz-lead2">{t("backupModelHint")}</p>
      <ModelSelect
        models={models}
        value={value}
        onChange={choose}
        empty={t("backupModelNone")}
        label={t("backupModelTitle")}
      />
      {error && <p class="notice error">{error}</p>}
    </>
  );
}

/**
 * Debug mode (2026-11-04, the person's request): everything RedGiant does left in a log, to
 * download as one archive and send, or to delete.
 */
function Diagnostics({ st, setSt }: { st: DebugState; setSt: (x: DebugState) => void }) {
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
    <>
      <p class="wz-lead2">{t("dbgHelp")}</p>
      <Row
        title={t("dbgSwitch")}
        help={
          st.forced
            ? t("dbgForced")
            : t("dbgSize", { size: bytes(st.bytes), files: String(st.files) })
        }
      >
        <Switch
          on={st.enabled}
          disabled={st.forced}
          label={t("dbgSwitch")}
          onChange={(v) => void attempt(() => getApi().setDebug(v)).then((x) => x && setSt(x))}
        />
      </Row>
      {st.forced && (
        <p class="ui-help">{t("dbgSize", { size: bytes(st.bytes), files: String(st.files) })}</p>
      )}
      <Acts>
        <button
          type="button"
          class="wz-btn quiet"
          disabled={st.files === 0}
          onClick={() => {
            if (!confirm(t("dbgClearConfirm"))) return;
            void attempt(() => getApi().clearDebugLogs()).then((x) => x && setSt(x));
          }}
        >
          <IconTrash size={18} /> {t("dbgClear")}
        </button>
        <button
          type="button"
          class="wz-btn primary"
          disabled={st.files === 0}
          onClick={() => void save()}
        >
          <IconDownload size={18} /> {t("dbgDownload")}
        </button>
      </Acts>
    </>
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
    <>
      <p class="wz-lead2">{t("updHelp")}</p>
      {answer && <p class={`notice ${answer.ok ? "ok" : "error"}`}>{answer.text}</p>}
      <Acts>
        <button type="button" class="wz-btn primary" disabled={busy} onClick={() => void look()}>
          <IconRefresh size={18} /> {busy ? t("updLooking") : t("updLook")}
        </button>
      </Acts>
    </>
  );
}

export function General() {
  const [s, setS] = useState<SetupState | null>(null);
  const [dbg, setDbg] = useState<DebugState>();
  const [open, setOpen] = useState<Open | null>(null);
  const load = () => {
    void getApi()
      .setup()
      .then(setS, () => {});
  };
  useEffect(() => {
    load();
    void attempt(() => getApi().debugState()).then((x) => x && setDbg(x));
  }, []);
  const close = () => {
    setOpen(null);
    load();
  };
  if (!s) return null;
  const c = s.config;
  const instructions = (c.instructions ?? "").trim();
  const backup = c.backupModel ?? null;
  const search = c.searchProvider ?? (c.searxngUrl ? "searxng" : undefined);
  const voice = c.transcription;
  const images = !!s.secretsSet.images;
  const titles: Record<Open, string> = {
    instructions: t("instructionsTitle"),
    backup: t("backupModelTitle"),
    search: t("servicesSearch"),
    voice: t("servicesVoice"),
    images: t("servicesImages"),
    updates: t("updTitle"),
    debug: t("dbgTitle"),
  };
  const tile = (id: Open, on: boolean, icon: JSX.Element, text: string, state?: string) => (
    <Tile
      key={id}
      on={on}
      icon={icon}
      title={titles[id]}
      text={text}
      state={state}
      onClick={() => setOpen(id)}
    />
  );
  return (
    <WzPage
      class="st-general"
      after={
        <>
          {open && (
            <Modal title={titles[open]} onClose={close}>
              <div class="wz-panel-in">
                {open === "instructions" && (
                  <Instructions initial={c.instructions ?? ""} onSaved={load} />
                )}
                {open === "backup" && <BackupModel initial={backup} onSaved={load} />}
                {(open === "search" || open === "voice" || open === "images") && (
                  <ServicePanel s={s} part={open} onSaved={load} />
                )}
                {open === "updates" && <Updates />}
                {open === "debug" && dbg && <Diagnostics st={dbg} setSt={setDbg} />}
              </div>
              {(open === "backup" || open === "search") && <Done onClick={close} />}
            </Modal>
          )}
        </>
      }
    >
      <Head eyebrow={t("general")} q={t("stGenQ")} lead={t("stGenLead")} />

      <Box>
        <Row title={t("theme")}>
          <Seg
            label={t("theme")}
            value={theme.value}
            onChange={setTheme}
            options={[
              ["system", [<IconMonitor key="i" size={18} />, " ", t("themeSystem")]],
              ["light", [<IconSun key="i" size={18} />, " ", t("themeLight")]],
              ["dark", [<IconMoon key="i" size={18} />, " ", t("themeDark")]],
            ]}
          />
        </Row>
        <Row title={t("uiLangTitle")} help={t("uiLangHelp")}>
          <Seg
            label={t("uiLangTitle")}
            value={lang.value}
            onChange={(l) => {
              setLang(l);
              // The server writes its own pages and, failing the agents' language, Telegram in it.
              void attempt(() => getApi().setupLanguages({ language: l })).then(load);
            }}
            options={[
              ["it", "Italiano"],
              ["en", "English"],
            ]}
          />
        </Row>
        <Row title={t("agentLangTitle")} help={t("agentLangHelp")}>
          <AgentLanguagePicker
            value={c.agentLanguage ?? c.language ?? lang.value}
            onChange={(code) =>
              void attempt(() => getApi().setupLanguages({ agentLanguage: code })).then(load)
            }
          />
        </Row>
        <BrowserNotifications />
      </Box>

      <Sub title={t("stGenAgents")} lead={t("stGenAgentsLead")} />
      <Tiles>
        {tile(
          "instructions",
          !!instructions,
          <IconBook />,
          instructions
            ? instructions.slice(0, 90) + (instructions.length > 90 ? "…" : "")
            : t("stGenInstrText"),
          instructions ? t("stGenWritten") : undefined,
        )}
        {tile(
          "backup",
          !!backup,
          <IconCrown />,
          t("stGenBackupText"),
          backup ? localModelName(backup.model.split("/").pop() ?? backup.model) : undefined,
        )}
      </Tiles>

      <Sub title={t("servicesTitle")} lead={t("servicesHint")} />
      <Tiles>
        {tile(
          "search",
          !!search,
          <IconGlobe />,
          t("stGenSearchText"),
          search ? t("searchInUse") : undefined,
        )}
        {tile(
          "voice",
          !!voice,
          <IconMic size={22} />,
          t("servicesVoiceHelp"),
          voice ? t("stGenOn") : undefined,
        )}
        {tile(
          "images",
          images,
          <IconBox />,
          t("servicesImagesHelp"),
          images ? (c.imagesModel ?? t("stGenOn")) : undefined,
        )}
      </Tiles>

      <Sub title={t("stGenCare")} lead={t("stGenCareLead")} />
      <Tiles>
        {tile("updates", false, <IconRefresh size={22} />, t("updHelp"))}
        {dbg &&
          tile(
            "debug",
            dbg.enabled,
            <IconTool />,
            t("stGenDebugText"),
            dbg.enabled ? t("stGenOn") : undefined,
          )}
      </Tiles>

      <Sub title={t("account")} />
      <p class="st-center">
        <button type="button" class="wz-btn" onClick={signOut}>
          <IconLogout size={18} /> {t("logout")}
        </button>
      </p>
    </WzPage>
  );
}
