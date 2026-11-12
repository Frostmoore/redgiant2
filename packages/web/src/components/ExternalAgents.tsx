// Settings › External agents (G38.6): agents that speak the Agent Client Protocol (Claude Code
// through its adapter, Codex, Gemini CLI…) as workers of a project, and how to use RedGiant from
// an editor that speaks it (Zed, JetBrains). A worker is an agent of the project: its orchestrator
// and God hand it tasks like to any other; its program runs in the agent's own folder, and every
// file, command and permission it asks for goes through RedGiant. Its variables never hold a key.
import type { AcpWorkerConfig, AcpWorkerInfo } from "@redgiant/protocol";
import { acpEnvIssue } from "@redgiant/protocol";
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Project } from "../api.js";
import { t } from "../i18n.js";
import { IconCopy, IconMinus, IconNodes, IconPlay, IconPlus } from "../icons.js";
import { getApi } from "../state.js";
import { explain } from "./Brain.js";
import { askConfirm } from "./dialogs.js";
import { Acts, Box, Chips, Head, Row, Sub, WzPage } from "./SettingsKit.js";
import { Field, Modal } from "./ui.js";

type Preset = { id: string; name: string; command: string; args: string[] };

/** A labelled group of several controls (chips, rows): not a <label>, which would click the first. */
function Group({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: ComponentChildren;
}) {
  return (
    <div class="ui-field" role="group" aria-label={label}>
      <span class="ui-label">{label}</span>
      {children}
      {help && <span class="ui-help">{help}</span>}
    </div>
  );
}
const OTHER = "other";

/** The settings snippet for Zed (`agent_servers`, verified 2026-11-12). */
export function zedSnippet(agent?: string): string {
  return JSON.stringify(
    {
      agent_servers: {
        RedGiant: {
          type: "custom",
          command: "redgiant-acp",
          args: agent ? ["--agent", agent] : [],
          env: {},
        },
      },
    },
    null,
    2,
  );
}

/** The same for JetBrains IDEs (`~/.jetbrains/acp.json`). */
export function jetbrainsSnippet(): string {
  return JSON.stringify(
    { agent_servers: { RedGiant: { command: "redgiant-acp", args: [], env: {} } } },
    null,
    2,
  );
}

const line = (c: Pick<AcpWorkerConfig, "command" | "args">) =>
  [c.command, ...c.args.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(" ");

interface Draft {
  agentId?: string;
  preset: string;
  name: string;
  projectId: string;
  command: string;
  args: string;
  env: { name: string; value: string }[];
}

const draftOf = (w: AcpWorkerInfo): Draft => ({
  agentId: w.agentId,
  preset: OTHER,
  name: w.name,
  projectId: w.projectId ?? "",
  command: w.command,
  args: w.args.join("\n"),
  env: Object.entries(w.env).map(([name, value]) => ({ name, value })),
});

const configOf = (d: Draft): AcpWorkerConfig => ({
  command: d.command.trim(),
  args: d.args
    .split("\n")
    .map((a) => a.trim())
    .filter(Boolean),
  env: Object.fromEntries(d.env.filter((v) => v.name.trim()).map((v) => [v.name.trim(), v.value])),
});

export function ExternalAgents() {
  const [workers, setWorkers] = useState<AcpWorkerInfo[]>();
  const [presets, setPresets] = useState<Preset[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState<Draft>();
  const [copied, setCopied] = useState<string>();
  const load = () =>
    Promise.all([getApi().acpWorkers(), getApi().projects()])
      .then(([r, ps]) => {
        setWorkers(r.workers);
        setPresets(r.presets);
        setProjects(ps.filter((p) => !p.archivedAt));
      })
      .catch((err) => setError(explain(err)));
  useEffect(() => void load(), []);
  const projectName = (id: string | null) => projects.find((p) => p.id === id)?.name ?? id ?? "-";
  const copy = (id: string, text: string) =>
    void navigator.clipboard?.writeText(text).then(
      () => setCopied(id),
      () => {},
    );
  const remove = async (w: AcpWorkerInfo) => {
    if (
      !(await askConfirm(t("acpRemoveQ", { name: w.name }), {
        text: t("acpRemoveText"),
        yes: t("remove"),
        danger: true,
      }))
    )
      return;
    try {
      await getApi().removeAcpWorker(w.agentId);
      await load();
    } catch (err) {
      setError(explain(err));
    }
  };
  const fresh = (): Draft => {
    const p = presets[0];
    return {
      preset: p?.id ?? OTHER,
      name: p?.name ?? "",
      projectId: projects[0]?.id ?? "",
      command: p?.command ?? "",
      args: (p?.args ?? []).join("\n"),
      env: [],
    };
  };
  return (
    <WzPage
      class="acp-page"
      after={
        draft && (
          <WorkerWindow
            draft={draft}
            presets={presets}
            projects={projects}
            onClose={() => setDraft(undefined)}
            onSaved={() => {
              setDraft(undefined);
              void load();
            }}
          />
        )
      }
    >
      <Head q={t("acpPageQ")} lead={t("acpPageLead")} />
      <Sub title={t("acpWorkersTitle")} lead={t("acpWorkersLead")} />
      <Box>
        {!workers && !error && <p class="dim">{t("loading")}</p>}
        {workers?.length === 0 && <p class="dim acp-none">{t("acpNone")}</p>}
        {workers?.map((w) => (
          <Row
            key={w.agentId}
            title={
              <span class="acp-name">
                <IconNodes size={16} /> {w.name}
                {w.status === "stopped" && <span class="wz-badge">{t("acpStopped")}</span>}
              </span>
            }
            help={
              <>
                {t("acpInProject", { project: projectName(w.projectId) })}
                <code class="acp-line">{line(w)}</code>
              </>
            }
          >
            <div class="acp-acts">
              <button type="button" class="wz-btn quiet" onClick={() => setDraft(draftOf(w))}>
                {t("acpEdit")}
              </button>
              <button type="button" class="wz-btn quiet" onClick={() => void remove(w)}>
                {t("remove")}
              </button>
            </div>
          </Row>
        ))}
      </Box>
      {error && <p class="notice error">{error}</p>}
      <Acts>
        <button
          type="button"
          class="wz-btn primary"
          disabled={projects.length === 0}
          onClick={() => setDraft(fresh())}
        >
          <IconPlus size={16} /> {t("acpAdd")}
        </button>
        {projects.length === 0 && <span class="dim">{t("acpNeedProject")}</span>}
      </Acts>
      <p class="wz-subl acp-keys">{t("acpKeysNote")}</p>

      <Sub title={t("acpEditorTitle")} lead={t("acpEditorLead")} />
      <Box class="acp-editor">
        <Row title="Zed" help={t("acpZedHelp")}>
          <button type="button" class="wz-btn quiet" onClick={() => copy("zed", zedSnippet())}>
            <IconCopy size={16} /> {copied === "zed" ? t("copied") : t("copy")}
          </button>
        </Row>
        <pre class="acp-snippet">{zedSnippet()}</pre>
        <Row title="JetBrains" help={t("acpJetbrainsHelp")}>
          <button type="button" class="wz-btn quiet" onClick={() => copy("jb", jetbrainsSnippet())}>
            <IconCopy size={16} /> {copied === "jb" ? t("copied") : t("copy")}
          </button>
        </Row>
        <pre class="acp-snippet">{jetbrainsSnippet()}</pre>
        <p class="wz-subl">{t("acpEditorWho")}</p>
      </Box>
    </WzPage>
  );
}

function WorkerWindow({
  draft: start,
  presets,
  projects,
  onClose,
  onSaved,
}: {
  draft: Draft;
  presets: Preset[];
  projects: Project[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [d, setD] = useState<Draft>(start);
  const [error, setError] = useState<string>();
  const [tried, setTried] = useState<string>();
  const [busy, setBusy] = useState<"try" | "save">();
  const set = (x: Partial<Draft>) => {
    setTried(undefined);
    setD({ ...d, ...x });
  };
  const editing = d.agentId !== undefined;
  const envProblem = d.env
    .filter((v) => v.name.trim())
    .map((v) => {
      const issue = acpEnvIssue(v.name.trim(), v.value);
      return issue && t(`acpEnv_${issue}`, { name: v.name.trim() });
    })
    .find(Boolean);
  const pick = (id: string) => {
    const p = presets.find((x) => x.id === id);
    if (!p) return set({ preset: OTHER });
    set({
      preset: id,
      command: p.command,
      args: p.args.join("\n"),
      ...((!d.name || presets.some((x) => x.name === d.name)) && { name: p.name }),
    });
  };
  const tryIt = async () => {
    setBusy("try");
    setError(undefined);
    try {
      const r = await getApi().tryAcpWorker(configOf(d));
      setTried(
        t("acpTried", { name: `${r.name}${r.version ? ` ${r.version}` : ""}` }) +
          (r.signIn.length ? ` ${t("acpSignIn", { how: r.signIn.join(", ") })}` : ""),
      );
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusy(undefined);
    }
  };
  const save = async () => {
    setBusy("save");
    setError(undefined);
    try {
      if (d.agentId) await getApi().updateAcpWorker(d.agentId, configOf(d));
      else
        await getApi().createAcpWorker({
          name: d.name.trim(),
          projectId: d.projectId,
          ...configOf(d),
        });
      onSaved();
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <Modal
      title={editing ? t("acpEditTitle", { name: d.name }) : t("acpAddTitle")}
      onClose={onClose}
      wide
      class="acp-window"
      foot={
        <>
          <button
            type="button"
            class="wz-btn quiet"
            disabled={!d.command.trim() || busy !== undefined}
            onClick={() => void tryIt()}
          >
            <IconPlay size={16} /> {busy === "try" ? t("acpTrying") : t("acpTry")}
          </button>
          <button
            type="button"
            class="wz-btn primary"
            disabled={
              !d.command.trim() ||
              !d.name.trim() ||
              !d.projectId ||
              !!envProblem ||
              busy !== undefined
            }
            onClick={() => void save()}
          >
            {t("save")}
          </button>
        </>
      }
    >
      {!editing && (
        <Group label={t("acpWhich")}>
          <Chips
            options={[
              ...presets.map((p) => ({ id: p.id, label: p.name })),
              { id: OTHER, label: t("acpOther") },
            ]}
            value={[d.preset]}
            onChange={([v]) => pick(v ?? OTHER)}
          />
        </Group>
      )}
      {!editing && (
        <Field label={t("acpName")}>
          <input
            value={d.name}
            onInput={(e) => set({ name: (e.target as HTMLInputElement).value })}
          />
        </Field>
      )}
      {!editing && (
        <Group label={t("acpProject")} help={t("acpProjectHelp")}>
          <Chips
            options={projects.map((p) => ({ id: p.id, label: p.name }))}
            value={[d.projectId]}
            onChange={([v]) => set({ projectId: v ?? "" })}
          />
        </Group>
      )}
      <Field label={t("acpCommand")} help={t("acpCommandHelp")}>
        <input
          class="acp-mono"
          value={d.command}
          spellcheck={false}
          onInput={(e) => set({ command: (e.target as HTMLInputElement).value, preset: OTHER })}
        />
      </Field>
      <Field label={t("acpArgs")} help={t("acpArgsHelp")}>
        <textarea
          class="acp-mono"
          rows={3}
          spellcheck={false}
          value={d.args}
          onInput={(e) => set({ args: (e.target as HTMLTextAreaElement).value, preset: OTHER })}
        />
      </Field>
      <Group label={t("acpEnv")} help={t("acpEnvHelp")}>
        <div class="acp-env">
          {d.env.map((v, i) => (
            <div class="acp-env-row" key={i}>
              <input
                class="acp-mono"
                placeholder={t("acpEnvName")}
                value={v.name}
                onInput={(e) =>
                  set({
                    env: d.env.map((x, j) =>
                      j === i ? { ...x, name: (e.target as HTMLInputElement).value } : x,
                    ),
                  })
                }
              />
              <input
                class="acp-mono"
                placeholder={t("acpEnvValue")}
                value={v.value}
                onInput={(e) =>
                  set({
                    env: d.env.map((x, j) =>
                      j === i ? { ...x, value: (e.target as HTMLInputElement).value } : x,
                    ),
                  })
                }
              />
              <button
                type="button"
                class="icon-btn"
                aria-label={t("remove")}
                onClick={() => set({ env: d.env.filter((_x, j) => j !== i) })}
              >
                <IconMinus size={16} />
              </button>
            </div>
          ))}
          <button
            type="button"
            class="wz-btn quiet acp-env-add"
            onClick={() => set({ env: [...d.env, { name: "", value: "" }] })}
          >
            <IconPlus size={14} /> {t("acpEnvAdd")}
          </button>
        </div>
      </Group>
      {envProblem && <p class="notice error">{envProblem}</p>}
      {tried && <p class="notice ok">{tried}</p>}
      {error && <p class="notice error">{error}</p>}
      <p class="wz-subl">{t("acpHowItWorks")}</p>
    </Modal>
  );
}
