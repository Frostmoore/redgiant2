import { useState } from "preact/hooks";
import type { Agent } from "../api.js";
import { t } from "../i18n.js";
import { agents, attempt, getApi, openAgent, openTab, projects, refresh } from "../state.js";

function AgentLink({ a }: { a: Agent }) {
  return (
    <button
      type="button"
      class={`side-item agent ${a.status}`}
      onClick={() => void attempt(() => openAgent(a))}
      title={a.role ?? a.kind}
    >
      <span class={`kind ${a.kind}`}>{a.kind.slice(0, 3)}</span> {a.name}
    </button>
  );
}

/** Platform (God), projects with their agents, files and terminal. */
export function Sidebar({ onNavigate }: { onNavigate: () => void }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const god = agents.value.find((a) => a.kind === "god");
  const open = (f: () => void) => () => {
    f();
    onNavigate();
  };
  const create = async (e: Event) => {
    e.preventDefault();
    if (await attempt(() => getApi().createProject(name))) {
      setName("");
      setAdding(false);
      await refresh();
    }
  };
  return (
    <nav class="sidebar">
      <div class="side-section">
        <div class="side-title">{t("platform")}</div>
        {god ? <AgentLink a={god} /> : null}
        {agents.value
          .filter((a) => a.kind === "demigod")
          .map((a) => (
            <AgentLink key={a.id} a={a} />
          ))}
        <button
          type="button"
          class="side-item"
          onClick={open(() =>
            openTab({
              id: "files:platform",
              type: "files",
              title: `${t("files")} · ${t("platform")}`,
              scope: "platform",
            }),
          )}
        >
          📁 {t("files")}
        </button>
        <button
          type="button"
          class="side-item"
          onClick={open(() =>
            openTab({
              id: "board:global",
              type: "board",
              title: `${t("board")} · ${t("platform")}`,
              projectId: null,
            }),
          )}
        >
          📌 {t("board")}
        </button>
        <button
          type="button"
          class="side-item"
          onClick={open(() =>
            openTab({
              id: `term:platform:${Date.now()}`,
              type: "terminal",
              title: `${t("terminal")} · ${t("platform")}`,
              scope: "platform",
            }),
          )}
        >
          ⌨ {t("terminal")}
        </button>
        <button
          type="button"
          class="side-item"
          onClick={open(() =>
            openTab({ id: "hierarchy", type: "hierarchy", title: t("hierarchy") }),
          )}
        >
          🜲 {t("hierarchy")}
        </button>
        <button
          type="button"
          class="side-item"
          onClick={open(() => openTab({ id: "budgets", type: "budgets", title: t("budgets") }))}
        >
          $ {t("budgets")}
        </button>
        <button
          type="button"
          class="side-item"
          onClick={open(() =>
            openTab({ id: "extensions", type: "extensions", title: t("extensions") }),
          )}
        >
          🧩 {t("extensions")}
        </button>
        <button
          type="button"
          class="side-item"
          onClick={open(() => openTab({ id: "telegram", type: "telegram", title: t("telegram") }))}
        >
          ✈ {t("telegram")}
        </button>
      </div>
      <div class="side-section">
        <div class="side-title">
          {t("projects")}
          <button
            type="button"
            class="tiny"
            onClick={() => setAdding(!adding)}
            title={t("newProject")}
          >
            +
          </button>
        </div>
        {adding && (
          <form class="inline-form" onSubmit={(e) => void create(e)}>
            <input
              required
              placeholder={t("projectName")}
              value={name}
              onInput={(e) => setName((e.target as HTMLInputElement).value)}
            />
          </form>
        )}
        {projects.value.map((p) => {
          const scope = `project:${p.id}`;
          const team = agents.value.filter((a) => a.projectId === p.id && a.kind !== "subagent");
          return (
            <details class="project" key={p.id} open>
              <summary>{p.name}</summary>
              {team.map((a) => (
                <AgentLink key={a.id} a={a} />
              ))}
              <button
                type="button"
                class="side-item"
                onClick={open(() =>
                  openTab({
                    id: `files:${scope}`,
                    type: "files",
                    title: `${t("files")} · ${p.name}`,
                    scope,
                  }),
                )}
              >
                📁 {t("files")}
              </button>
              <button
                type="button"
                class="side-item"
                onClick={open(() =>
                  openTab({
                    id: `board:${p.id}`,
                    type: "board",
                    title: `${t("board")} · ${p.name}`,
                    projectId: p.id,
                  }),
                )}
              >
                📌 {t("board")}
              </button>
              <button
                type="button"
                class="side-item"
                onClick={open(() =>
                  openTab({
                    id: `term:${scope}:${Date.now()}`,
                    type: "terminal",
                    title: `${t("terminal")} · ${p.name}`,
                    scope,
                  }),
                )}
              >
                ⌨ {t("terminal")}
              </button>
            </details>
          );
        })}
      </div>
    </nav>
  );
}
