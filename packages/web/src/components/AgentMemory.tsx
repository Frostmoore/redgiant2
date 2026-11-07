// An agent's Memory tab (G33.2): its own memory first, named so it cannot be mistaken for the
// shared one («Memoria di <nome>: solo per questo agente»), written by the person or noted by the
// agent itself; the project's memory when it works for one; a way to the shared memory (what every
// agent knows about the person); then how its long conversations are summarised.
import { useEffect, useState } from "preact/hooks";
import type { Agent } from "../api.js";
import { t } from "../i18n.js";
import { IconArrowRight, IconUsers } from "../icons.js";
import { getApi, openTab, projects } from "../state.js";
import { CompactionSettings } from "./CompactionSettings.js";
import { memoryError } from "./SharedMemory.js";

/** One memory kept as a short text: the agent's own or its project's. */
function MemoryText({
  title,
  help,
  q,
}: {
  title: string;
  help: string;
  q: { scope: "self" | "project"; agentId: string; projectId?: string };
}) {
  const [text, setText] = useState<string>();
  const [kept, setKept] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void getApi()
      .notes(q)
      .then(
        (r) => {
          setText(r.text);
          setKept(r.text);
        },
        () => {
          setText("");
          setKept("");
        },
      );
  }, [q.scope, q.agentId, q.projectId]);
  if (text === undefined) return null;
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await getApi().setNotes(q, text);
      setKept(text);
    } catch (err) {
      setError(memoryError(err));
    } finally {
      setBusy(false);
    }
  };
  const changed = text !== kept;
  return (
    <div class={`mem-own${q.scope === "self" ? " on" : ""}`}>
      <h3>{title}</h3>
      <p>{help}</p>
      <textarea
        class="wz-field"
        rows={5}
        aria-label={title}
        placeholder={q.scope === "self" ? t("memOwnPlaceholder") : ""}
        value={text}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
      />
      {error && <p class="mem-error">{error}</p>}
      <div class="mem-own-acts">
        {!changed && kept && <span class="mem-pill">{t("memSaved")}</span>}
        <button
          type="button"
          class="wz-btn small primary"
          disabled={busy || !changed}
          onClick={() => void save()}
        >
          {t("save")}
        </button>
      </div>
    </div>
  );
}

export function AgentMemory({ agent }: { agent: Agent }) {
  const [count, setCount] = useState<number>();
  useEffect(() => {
    void getApi()
      .sharedMemory()
      .then(
        (v) => setCount(v.entries.length),
        () => setCount(undefined),
      );
  }, []);
  const remembers = agent.kind !== "demigod" && agent.kind !== "inspector";
  const project = agent.projectId
    ? (projects.value.find((p) => p.id === agent.projectId)?.name ?? agent.projectId)
    : undefined;
  return (
    <div class="st-form wz-look mem-agent">
      {remembers ? (
        <MemoryText
          title={t("memOwnTitle", { name: agent.name })}
          help={t("memOwnHelp", { name: agent.name })}
          q={{ scope: "self", agentId: agent.id }}
        />
      ) : (
        <p class="ui-help">{t("memNoOwn")}</p>
      )}
      {agent.projectId && project && (
        <MemoryText
          title={t("memProjectTitle", { name: project })}
          help={t("memProjectHelp")}
          q={{ scope: "project", agentId: agent.id, projectId: agent.projectId }}
        />
      )}
      <button
        type="button"
        class="mem-go"
        onClick={() =>
          openTab({ id: "settings", type: "settings", title: t("settings"), section: "memory" })
        }
      >
        <span class="wz-scard-av">
          <IconUsers size={22} />
        </span>
        <span class="mem-go-text">
          <b>{t("memGoShared")}</b>
          <span>
            {t("memGoSharedText")}
            {count !== undefined &&
              ` ${count === 1 ? t("memCountOne") : t("memCount", { n: String(count) })}.`}
          </span>
        </span>
        <span class="mem-go-open">
          {t("memGoSharedOpen")}
          <IconArrowRight size={18} />
        </span>
      </button>
      <h3 class="mem-sum-title">{t("memSummaryTitle")}</h3>
      <p class="ui-help">{t("compactExplain")}</p>
      <CompactionSettings agent={agent} />
    </div>
  );
}
