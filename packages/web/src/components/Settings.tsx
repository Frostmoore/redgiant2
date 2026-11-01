import type { ComponentChildren } from "preact";
import { lang, setLang, t } from "../i18n.js";
import {
  IconBell,
  IconClock,
  IconCompass,
  IconDollar,
  IconLayers,
  IconLogout,
  IconMonitor,
  IconMoon,
  IconPhone,
  IconPuzzle,
  IconSettings,
  IconSun,
  IconTelegram,
  IconTree,
} from "../icons.js";
import { openTab, type SettingsSection, signOut } from "../state.js";
import { setTheme, theme } from "../theme.js";
import { Automations } from "./Automations.js";
import { Budgets } from "./Budgets.js";
import { Devices } from "./Devices.js";
import { Extensions } from "./Extensions.js";
import { Hierarchy } from "./Hierarchy.js";
import { Notifications } from "./Notifications.js";
import { Platform } from "./Platform.js";
import { Setup } from "./Setup.js";
import { Telegram } from "./Telegram.js";

const SECTIONS: { id: SettingsSection; label: () => string; icon: ComponentChildren }[] = [
  { id: "general", label: () => t("general"), icon: <IconSettings size={15} /> },
  { id: "setup", label: () => t("setupWizard"), icon: <IconCompass size={15} /> },
  { id: "agents", label: () => t("agents"), icon: <IconTree size={15} /> },
  { id: "automations", label: () => t("automations"), icon: <IconClock size={15} /> },
  { id: "extensions", label: () => t("extensions"), icon: <IconPuzzle size={15} /> },
  { id: "telegram", label: () => t("telegram"), icon: <IconTelegram size={15} /> },
  { id: "notifications", label: () => t("notifications"), icon: <IconBell size={15} /> },
  { id: "devices", label: () => t("devices"), icon: <IconPhone size={15} /> },
  { id: "budgets", label: () => t("budgets"), icon: <IconDollar size={15} /> },
  { id: "platform", label: () => t("platformView"), icon: <IconLayers size={15} /> },
];

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
      <h2 style={{ marginTop: "24px" }}>{t("account")}</h2>
      <button type="button" onClick={signOut} class="row">
        <IconLogout /> {t("logout")}
      </button>
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
        {section === "notifications" && <Notifications />}
        {section === "devices" && <Devices />}
        {section === "budgets" && <Budgets />}
        {section === "platform" && <Platform />}
      </div>
    </div>
  );
}
