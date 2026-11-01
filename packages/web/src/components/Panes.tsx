import { t } from "../i18n.js";
import {
  activateTab,
  closeTab,
  focusedPane,
  type Pane,
  panes,
  splitRight,
  type Tab,
} from "../state.js";
import { Approvals } from "./Approvals.js";
import { Automations } from "./Automations.js";
import { Board } from "./Board.js";
import { Budgets } from "./Budgets.js";
import { Chat } from "./Chat.js";
import { DailyChat } from "./DailyChat.js";
import { Editor } from "./Editor.js";
import { Extensions } from "./Extensions.js";
import { Files } from "./Files.js";
import { Hierarchy } from "./Hierarchy.js";
import { Platform } from "./Platform.js";
import { Telegram } from "./Telegram.js";
import { TerminalView } from "./TerminalView.js";

function Content({ tab }: { tab: Tab }) {
  switch (tab.type) {
    case "chat":
      return <Chat sessionId={tab.sessionId} />;
    case "files":
      return <Files scope={tab.scope} />;
    case "editor":
      return <Editor scope={tab.scope} path={tab.path} />;
    case "terminal":
      return <TerminalView scope={tab.scope} />;
    case "hierarchy":
      return <Hierarchy />;
    case "approvals":
      return <Approvals />;
    case "budgets":
      return <Budgets />;
    case "board":
      return <Board projectId={tab.projectId} />;
    case "extensions":
      return <Extensions />;
    case "telegram":
      return <Telegram />;
    case "automations":
      return <Automations />;
    case "platform":
      return <Platform />;
    case "dailychat":
      return <DailyChat />;
  }
}

function PaneView({ pane }: { pane: Pane }) {
  return (
    <section
      class={`pane${focusedPane.value === pane.id ? " focused" : ""}`}
      onFocusCapture={() => {
        focusedPane.value = pane.id;
      }}
    >
      <div class="tabs" role="tablist">
        {pane.tabs.map((tab) => (
          <div
            key={tab.id}
            role="tab"
            tabIndex={0}
            aria-selected={pane.active === tab.id}
            class={`tab${pane.active === tab.id ? " active" : ""}`}
            onClick={() => activateTab(pane.id, tab.id)}
            onKeyDown={(k) => {
              if (k.key === "Enter" || k.key === " ") {
                k.preventDefault();
                activateTab(pane.id, tab.id);
              }
            }}
            title={tab.title}
          >
            <span class="tab-title">{tab.title}</span>
            {panes.value.length < 3 && pane.tabs.length > 1 && (
              <button
                type="button"
                class="tiny"
                title={t("splitRight")}
                onClick={(e) => {
                  e.stopPropagation();
                  splitRight(pane.id, tab.id);
                }}
              >
                ⇥
              </button>
            )}
            <button
              type="button"
              class="tiny"
              title={t("closeTab")}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(pane.id, tab.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div class="pane-body">
        {/* Tabs stay mounted (terminals and chats keep their state); only the active one shows. */}
        {pane.tabs.map((tab) => (
          <div key={tab.id} class="tab-body" hidden={pane.active !== tab.id}>
            <Content tab={tab} />
          </div>
        ))}
        {pane.tabs.length === 0 && <div class="empty logo-empty">RedGiant</div>}
      </div>
    </section>
  );
}

/** Up to three panes side by side, each with its own tabs. */
export function Panes() {
  return (
    <main class="panes">
      {panes.value.map((p) => (
        <PaneView key={p.id} pane={p} />
      ))}
    </main>
  );
}
