import { OWN_SERVER_ID } from "@redgiant/protocol";
import { useEffect, useState } from "preact/hooks";
import { usd } from "../format.js";
import { t } from "../i18n.js";
import {
  IconAlert,
  IconBell,
  IconBoard,
  IconCanvas,
  IconChat,
  IconClose,
  IconCrown,
  IconEye,
  IconFolder,
  IconMenu,
  IconSearch,
  IconSettings,
  IconUser,
  IconUsers,
  Logo,
} from "../icons.js";
import {
  activateTab,
  activeChat,
  activeTab,
  agents,
  approvals,
  attempt,
  budgets,
  closeTab,
  drawerOpen,
  explorerOpen,
  firstRun,
  lastError,
  limits,
  openTab,
  platformInfo,
  questions,
  refresh,
  sessionRows,
  sessionView,
  signIn,
  signOut,
  status,
  type Tab,
  tabs,
  toggleExplorer,
  token,
} from "../state.js";
import { AssistantPage } from "./Assistants.js";
import { Bell } from "./Bell.js";
import { Board } from "./Board.js";
import { Chat } from "./Chat.js";
import { DailyChat } from "./DailyChat.js";
import { Downloads } from "./Downloads.js";
import { Explorer } from "./Explorer.js";
import { Login } from "./Login.js";
import { RoomView } from "./Room.js";
import { Search } from "./Search.js";
import { Settings } from "./Settings.js";
import { Setup } from "./Setup.js";
import { SideArea } from "./SideArea.js";
import { Sidebar } from "./Sidebar.js";
import { Variants } from "./Variants.js";

const level = (pct: number) => (pct >= 90 ? "high" : pct >= 70 ? "medium" : "");

/** One bar of the header: a name, how full, the percentage. */
function Bar({ name, pct, title }: { name: string; pct: number | null; title: string }) {
  return (
    <span class={`limit ${pct === null ? "" : level(pct)}`} title={title}>
      <span class="limit-name">{name}</span>
      <span class="limit-bar">
        <span style={{ width: `${Math.min(100, pct ?? 0)}%` }} />
      </span>
      <span class="limit-num">{pct === null ? "–" : `${Math.round(pct)}%`}</span>
    </span>
  );
}

const resetAt = (iso?: string) =>
  iso
    ? new Date(iso).toLocaleString([], {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

/**
 * The header's bars follow how the open conversation is connected (G21): a flat subscription shows
 * its plan's windows (5h, 7d, per-model), a local model how full the context is before automatic
 * compaction, anything paid per token the budgets.
 */
function Limits() {
  const chat = activeChat();
  const provider = chat?.model?.provider;
  const plan = limits.value.find((l) => l.provider === provider);
  if (plan) {
    const has = (id: string) => plan.windows.some((w) => w.id === id);
    const windows = [
      ...(has("5h")
        ? []
        : [{ id: "5h", label: "5h", usedPct: null as number | null, resetsAt: undefined }]),
      ...plan.windows,
    ].sort((a, b) => (a.id === "5h" ? -1 : b.id === "5h" ? 1 : 0));
    return (
      <div class="limits">
        {windows.map((w) => (
          <Bar
            key={w.id}
            name={w.label}
            pct={w.usedPct}
            title={`${w.label}: ${w.usedPct === null ? "–" : `${w.usedPct}%`}${w.resetsAt ? ` · reset ${resetAt(w.resetsAt)}` : ""}`}
          />
        ))}
      </div>
    );
  }
  if (provider === "local" || provider === OWN_SERVER_ID) {
    const events = chat ? sessionView(chat.sessionId).value.events : [];
    const last = [...events].reverse().find((e) => e.type === "message.assistant");
    const m = last?.type === "message.assistant" ? last.payload?.metrics : undefined;
    const threshold = m ? Math.round(m.contextWindow * 0.8) : 0;
    return (
      <div class="limits">
        <Bar
          name={t("contextLeft")}
          pct={m ? (m.contextUsed / threshold) * 100 : 0}
          title={
            m
              ? t("contextHint", {
                  used: String(m.contextUsed),
                  window: String(m.contextWindow),
                  threshold: String(threshold),
                })
              : t("contextLeft")
          }
        />
      </div>
    );
  }
  return <Budgets />;
}

/** Spending against the limits, like Officina's usage bars; the global budget first. */
function Budgets() {
  const limited = budgets.value.filter(
    (b) => b.limit.usd !== undefined || b.limit.tokens !== undefined,
  );
  const global = budgets.value.find((b) => b.scope === "global");
  if (limited.length === 0)
    return (
      <div class="limits">
        {global && (
          <span class="limit" title={t("budgets")}>
            <span class="limit-name">{t("spent")}</span>
            <span class="limit-num">{usd(global.used.usd)}</span>
          </span>
        )}
      </div>
    );
  return (
    <div class="limits">
      {limited.slice(0, 3).map((b) => {
        const pct =
          b.limit.usd !== undefined
            ? (b.used.usd / b.limit.usd) * 100
            : (b.used.tokens / (b.limit.tokens ?? 1)) * 100;
        const level = pct >= 90 ? "high" : pct >= 70 ? "medium" : "";
        const name =
          b.scope === "global"
            ? t("total")
            : b.scope === "project"
              ? b.id
              : (agents.value.find((a) => a.id === b.id)?.name ?? b.id);
        return (
          <span
            key={`${b.scope}:${b.id}`}
            class={`limit ${level}`}
            title={`${name}: ${usd(b.used.usd)}${b.limit.usd !== undefined ? ` / ${usd(b.limit.usd)}` : ""}`}
          >
            <span class="limit-name">{name}</span>
            <span class="limit-bar">
              <span style={{ width: `${Math.min(100, pct)}%` }} />
            </span>
            <span class="limit-num">{Math.round(pct)}%</span>
          </span>
        );
      })}
    </div>
  );
}

const tabIcon = (tab: Tab) =>
  tab.type === "chat" ? (
    agents.value.find((a) => a.id === tab.agentId)?.kind === "god" ? (
      <IconCrown size={13} />
    ) : null
  ) : tab.type === "dailychat" ? (
    <IconChat size={13} />
  ) : tab.type === "board" ? (
    <IconBoard size={13} />
  ) : tab.type === "inspector" ? (
    <IconEye size={13} />
  ) : tab.type === "assistant" ? (
    <IconUser size={13} />
  ) : tab.type === "room" ? (
    <IconUsers size={13} />
  ) : tab.type === "tavola" ? (
    <IconCanvas size={13} />
  ) : (
    <IconSettings size={13} />
  );

/** The tabs in the middle: conversations and the other views, each with its own state. */
function Tabs() {
  if (tabs.value.length === 0) return null;
  return (
    <div class="tabs" role="tablist">
      {tabs.value.map((tab) => {
        const agent =
          tab.type === "chat" ? agents.value.find((a) => a.id === tab.agentId) : undefined;
        const running =
          tab.type === "chat" && sessionRows.value.some((r) => r.id === tab.sessionId && r.running);
        const label =
          tab.type === "settings"
            ? t("settings")
            : tab.type === "chat"
              ? (agent?.name ?? "")
              : tab.title;
        const detail = tab.type === "chat" ? tab.title : "";
        return (
          <div key={tab.id} class={`tab ${activeTab.value === tab.id ? "active" : ""}`}>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab.value === tab.id}
              class="tab-label"
              onClick={() => activateTab(tab.id)}
              title={`${label} ${detail}`}
            >
              {running ? <span class="dot running" /> : tabIcon(tab)}
              <span class="lp">{label}</span>
              {detail && detail !== label && <span class="lt">{detail}</span>}
            </button>
            <button
              type="button"
              class="icon-button"
              title={t("close")}
              onClick={() => closeTab(tab.id)}
            >
              <IconClose size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function View({ tab }: { tab: Tab }) {
  switch (tab.type) {
    case "chat":
      return <Chat sessionId={tab.sessionId} agentId={tab.agentId} />;
    case "dailychat":
      return <DailyChat chatId={tab.chatId} tabId={tab.id} />;
    case "board":
      return <Board projectId={tab.projectId} />;
    case "inspector":
      return <DailyChat projectId={tab.projectId} />;
    case "settings":
      return <Settings section={tab.section} />;
    case "assistant":
      return <AssistantPage key={tab.id} agentId={tab.agentId} />;
    case "room":
      return <RoomView key={tab.id} roomId={tab.roomId} />;
    case "tavola":
      return <Variants key={tab.id} sessionId={tab.sessionId} proposalId={tab.proposalId} />;
  }
}

export function App() {
  const [ready, setReady] = useState(false);
  const [search, setSearch] = useState(false);
  const [bell, setBell] = useState(false);

  useEffect(() => {
    // The installer opens the page with #token=…: signed in at once, then the address is cleaned.
    const hash = new URLSearchParams(location.hash.slice(1));
    const fromLink = hash.get("token");
    if (fromLink) history.replaceState(null, "", location.pathname + location.search);
    if (fromLink) token.value = fromLink;
    if (token.value)
      void signIn(token.value)
        .catch(() => signOut())
        .finally(() => setReady(true));
    else setReady(true);
  }, []);

  useEffect(() => {
    if (!token.value) return;
    const timer = setInterval(() => void attempt(refresh), 15_000);
    return () => clearInterval(timer);
  }, [token.value]);

  const waiting = approvals.value.length + questions.value.length;
  useEffect(() => {
    document.title = waiting ? `(${waiting}) RedGiant` : "RedGiant";
  }, [waiting]);

  if (!ready) return null;
  if (!token.value) return <Login />;
  // First run: the wizard takes the whole page until it is completed.
  if (firstRun.value)
    return (
      <div class="app">
        <Setup
          onDone={() => {
            firstRun.value = false;
          }}
        />
      </div>
    );

  const tab = tabs.value.find((x) => x.id === activeTab.value);
  const info = platformInfo.value;
  return (
    <div class={`app ${drawerOpen.value ? "drawer-open" : ""}`}>
      <header class="top">
        <button
          type="button"
          class="icon-button menu"
          aria-label={t("menu")}
          onClick={() => (drawerOpen.value = !drawerOpen.value)}
        >
          <IconMenu />
        </button>
        <span class="brand">
          <Logo /> <span class="name">RedGiant</span>
        </span>
        <Limits />
        <button
          type="button"
          class={`icon-button ${explorerOpen.value ? "on" : ""}`}
          title={t("projectFiles")}
          aria-label={t("projectFiles")}
          onClick={() => toggleExplorer()}
        >
          <IconFolder size={19} />
        </button>
        <button
          type="button"
          class="icon-button"
          title={t("searchConversations")}
          aria-label={t("searchConversations")}
          onClick={() => setSearch(!search)}
        >
          <IconSearch />
        </button>
        <button
          type="button"
          class={`icon-button bell ${waiting ? "on" : ""}`}
          title={t("waitingForYou")}
          aria-label={t("waitingForYou")}
          onClick={() => setBell(!bell)}
        >
          <IconBell />
          {waiting > 0 && <span class="badge">{waiting}</span>}
        </button>
        <span
          class={`conn ${status.value}`}
          title={t(
            status.value === "online"
              ? "online"
              : status.value === "connecting"
                ? "connecting"
                : "offline",
          )}
        />
      </header>
      {lastError.value && (
        <div class="banner error">
          <IconAlert /> {lastError.value}
          <button
            type="button"
            class="icon-button"
            title={t("close")}
            onClick={() => (lastError.value = null)}
          >
            <IconClose />
          </button>
        </div>
      )}
      {info?.keyProblems?.map((k) => (
        <div key={k.provider} class="banner error">
          <IconAlert />{" "}
          {t("keyRefused", { provider: k.provider, message: k.message.slice(0, 160) })}
          <button
            type="button"
            class="link"
            onClick={() =>
              openTab({ id: "settings", type: "settings", title: t("settings"), section: "setup" })
            }
          >
            {t("openSetup")}
          </button>
        </div>
      ))}
      {info?.metal && (
        <div class="banner error">
          <IconAlert /> {t("metalWarning")}
        </div>
      )}
      {!info?.metal && info?.sandbox === "host" && (
        <div class="banner">
          <IconAlert /> {t("hostWarning")}
        </div>
      )}
      <div class="body">
        {search && <Search close={() => setSearch(false)} />}
        {bell && <Bell close={() => setBell(false)} />}
        <aside class="side">
          <Sidebar />
        </aside>
        <button
          type="button"
          class="veil"
          aria-label={t("close")}
          onClick={() => (drawerOpen.value = false)}
        />
        <main class="main">
          <Tabs />
          {tab ? (
            tabs.value.map((x) => (
              <div key={x.id} class="view" hidden={x.id !== tab.id}>
                <View tab={x} />
              </div>
            ))
          ) : (
            <div class="welcome">
              <Logo size={64} />
              <h1>RedGiant</h1>
              <p>{t("welcomeText")}</p>
            </div>
          )}
        </main>
        {explorerOpen.value && <Explorer />}
        <SideArea />
      </div>
      <Downloads />
    </div>
  );
}
