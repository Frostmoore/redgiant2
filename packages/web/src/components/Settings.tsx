// Settings (2026-11-06, drawn as the wizard after the person's request «tutte le pagine delle
// impostazioni con lo stesso stile del wizard»): the sections on the left in groups, as the
// wizard's list of steps (big rows, the current one lit by border and background); on a phone a
// bar at the top names the section shown and opens the same list in a sheet from below.
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { t } from "../i18n.js";
import {
  IconArchive,
  IconBell,
  IconBook,
  IconBox,
  IconCard,
  IconChat,
  IconChevronDown,
  IconClock,
  IconCode,
  IconCompass,
  IconCpu,
  IconDatabase,
  IconDollar,
  IconFolder,
  IconKey,
  IconLayers,
  IconMic,
  IconNodes,
  IconPuzzle,
  IconServer,
  IconSettings,
  IconShield,
  IconTelegram,
  IconTerminal,
  IconTool,
  IconTree,
  IconUpload,
} from "../icons.js";
import { openTab, type SettingsSection } from "../state.js";
import { Artifacts } from "./Artifacts.js";
import { Automations } from "./Automations.js";
import { Backup } from "./Backup.js";
import { Budgets } from "./Budgets.js";
import { ChatPlatforms } from "./ChatPlatforms.js";
import { CodeSettings } from "./CodeSettings.js";
import { CommandLimits } from "./CommandLimits.js";
import { Extensions } from "./Extensions.js";
import { ExternalAgents } from "./ExternalAgents.js";
import { SystemSettings } from "./FirstBoot.js";
import { General } from "./General.js";
import { Hierarchy } from "./Hierarchy.js";
import { ImportFrom } from "./ImportFrom.js";
import { Keychain } from "./Keychain.js";
import { Knowledge } from "./Knowledge.js";
import { Machines } from "./Machines.js";
import { Platform } from "./Platform.js";
import { ProjectsPage } from "./ProjectArchive.js";
import { RemoteSettings } from "./RemoteSettings.js";
import { RequestsPage } from "./RequestsPage.js";
import { Setup } from "./Setup.js";
import { SharedMemoryPage } from "./SharedMemory.js";
import { Subscriptions } from "./Subscriptions.js";
import { Telegram } from "./Telegram.js";
import { ToolsPage } from "./ToolsPage.js";
import { Modal } from "./ui.js";
import { VoiceSettingsPage } from "./VoiceSettings.js";

type Section = { id: SettingsSection; label: () => string; icon: ComponentChildren };

/** The sections in groups, as the wizard groups its steps. */
const GROUPS: { title: () => string; sections: Section[] }[] = [
  {
    title: () => t("stGrpBasics"),
    sections: [
      { id: "general", label: () => t("general"), icon: <IconSettings size={20} /> },
      { id: "setup", label: () => t("setupWizard"), icon: <IconCompass size={20} /> },
      { id: "import", label: () => t("impSection"), icon: <IconUpload size={20} /> },
      { id: "voice", label: () => t("voiceTitle"), icon: <IconMic size={20} /> },
    ],
  },
  {
    title: () => t("stGrpWho"),
    sections: [
      { id: "agents", label: () => t("agents"), icon: <IconTree size={20} /> },
      { id: "projects", label: () => t("paPageQ"), icon: <IconBox size={20} /> },
      { id: "artifacts", label: () => t("arSection"), icon: <IconCode size={20} /> },
      { id: "memory", label: () => t("memSection"), icon: <IconBook size={20} /> },
      { id: "knowledge", label: () => t("kbSection"), icon: <IconDatabase size={20} /> },
      { id: "automations", label: () => t("automations"), icon: <IconClock size={20} /> },
      { id: "extensions", label: () => t("extensions"), icon: <IconPuzzle size={20} /> },
      { id: "acp", label: () => t("acpSection"), icon: <IconNodes size={20} /> },
      { id: "tools", label: () => t("toolsSection"), icon: <IconTool size={20} /> },
      { id: "commands", label: () => t("cmdSection"), icon: <IconTerminal size={20} /> },
      { id: "requests", label: () => t("rqSection"), icon: <IconBell size={20} /> },
      { id: "keychain", label: () => t("kcSection"), icon: <IconKey size={20} /> },
    ],
  },
  {
    title: () => t("stGrpWhere"),
    sections: [
      { id: "telegram", label: () => t("telegram"), icon: <IconTelegram size={20} /> },
      { id: "chats", label: () => t("chats"), icon: <IconChat size={20} /> },
    ],
  },
  {
    title: () => t("stGrpModels"),
    sections: [
      { id: "subscriptions", label: () => t("subscriptions"), icon: <IconCard size={20} /> },
      { id: "budgets", label: () => t("budgets"), icon: <IconDollar size={20} /> },
    ],
  },
  {
    title: () => t("stGrpHome"),
    sections: [
      { id: "code", label: () => t("wzCode"), icon: <IconFolder size={20} /> },
      { id: "remote", label: () => t("wzRemote"), icon: <IconShield size={20} /> },
      { id: "system", label: () => t("fbSystemSection"), icon: <IconCpu size={20} /> },
      { id: "machines", label: () => t("mcSection"), icon: <IconServer size={20} /> },
      { id: "backup", label: () => t("backup"), icon: <IconArchive size={20} /> },
      { id: "platform", label: () => t("platformView"), icon: <IconLayers size={20} /> },
    ],
  },
];

/** The list of sections: beside the page on a computer, in a sheet on a phone. */
function SectionList({
  current,
  go,
}: {
  current: SettingsSection;
  go: (s: SettingsSection) => void;
}) {
  return (
    <>
      {GROUPS.map((g) => (
        <div class="st-group" key={g.title()}>
          <p class="wz-grp">{g.title()}</p>
          {g.sections.map((s) => (
            <button
              type="button"
              key={s.id}
              class={`st-nav-item${current === s.id ? " cur" : ""}`}
              aria-current={current === s.id ? "page" : undefined}
              onClick={() => go(s.id)}
            >
              <span class="st-nav-ico">{s.icon}</span>
              <span class="st-nav-name">{s.label()}</span>
            </button>
          ))}
        </div>
      ))}
    </>
  );
}

/** Everything that is not a conversation: one page, its sections on the left. */
export function Settings({ section = "general" }: { section?: SettingsSection | undefined }) {
  const [list, setList] = useState(false);
  const go = (s: SettingsSection) => {
    setList(false);
    openTab({ id: "settings", type: "settings", title: t("settings"), section: s });
  };
  const shown = GROUPS.flatMap((g) => g.sections).find((s) => s.id === section);
  return (
    <div class="settings">
      <nav class="settings-nav wz-look" aria-label={t("settings")}>
        <SectionList current={section} go={go} />
      </nav>
      {/* On a phone: the section shown, and the list in a sheet from below. */}
      <div class="st-bar wz-look">
        <button
          type="button"
          class="st-pick"
          aria-haspopup="dialog"
          aria-expanded={list}
          onClick={() => setList(true)}
        >
          <span class="st-nav-ico">{shown?.icon}</span>
          <span class="st-pick-text">
            <small>{t("settings")}</small>
            <b>{shown?.label()}</b>
          </span>
          <IconChevronDown size={20} />
        </button>
        {list && (
          <Modal title={t("settings")} onClose={() => setList(false)}>
            <div class="st-sheet-list">
              <SectionList current={section} go={go} />
            </div>
          </Modal>
        )}
      </div>
      <div class="settings-body">
        {section === "general" && <General />}
        {section === "setup" && <Setup />}
        {section === "import" && <ImportFrom />}
        {section === "voice" && <VoiceSettingsPage />}
        {section === "agents" && <Hierarchy />}
        {section === "projects" && <ProjectsPage />}
        {section === "artifacts" && <Artifacts />}
        {section === "memory" && <SharedMemoryPage />}
        {section === "knowledge" && <Knowledge />}
        {section === "automations" && <Automations />}
        {section === "extensions" && <Extensions />}
        {section === "acp" && <ExternalAgents />}
        {section === "tools" && <ToolsPage />}
        {section === "commands" && <CommandLimits />}
        {section === "requests" && <RequestsPage />}
        {section === "keychain" && <Keychain />}
        {section === "telegram" && <Telegram />}
        {section === "chats" && <ChatPlatforms />}
        {section === "subscriptions" && <Subscriptions />}
        {section === "code" && <CodeSettings />}
        {section === "remote" && <RemoteSettings />}
        {section === "system" && <SystemSettings />}
        {section === "machines" && <Machines />}
        {section === "budgets" && <Budgets />}
        {section === "backup" && <Backup />}
        {section === "platform" && <Platform />}
      </div>
    </div>
  );
}
