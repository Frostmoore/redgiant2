// Automations (G24.8), drawn as the wizard (2026-11-06): big squares to make one (an automation,
// a reminder, or a magic one built with God, G33.3), the automations as squares lit when switched
// on, each opening a window (a sheet from below on phones) with its switch, its webhook, its runs
// and the buttons to run it, change it or delete it. Making and changing happen in the editor of
// AutomationEditor.tsx; the mailboxes, by category, sit under «Connections».
import type { Automation, AutomationRun, MagicAutomation } from "@redgiant/protocol";
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { t } from "../i18n.js";
import {
  IconBell,
  IconChat,
  IconClock,
  IconFolder,
  IconGit,
  IconGlobe,
  IconLayers,
  IconPencil,
  IconPlay,
  IconPlus,
  IconRefresh,
  IconSend,
  IconSpark,
  IconZap,
} from "../icons.js";
import { renderMarkdown } from "../markdown.js";
import { agents, attempt, automationsVersion, getApi, openTab } from "../state.js";
import { Editor, fromOn, fromRecipe, sentence, whenWords } from "./AutomationEditor.js";
import { explain } from "./Brain.js";
import { Mailboxes } from "./EmailSettings.js";
import { MagicChat, MagicStart } from "./MagicAutomation.js";
import { Acts, Facts, Head, Sub, SwitchRow, Tile, WzPage } from "./SettingsKit.js";
import { Field, Modal } from "./ui.js";

// The editor and its words live in AutomationEditor.tsx; these names stay importable from here.
export {
  type Draft,
  Editor,
  fromCron,
  fromOn,
  fromRecipe,
  sentence,
  toCron,
  toYaml,
  type When,
  whenWords,
} from "./AutomationEditor.js";

import { askConfirm } from "./dialogs.js";

const STATUSES: AutomationRun["status"][] = ["running", "ok", "failed", "timeout", "skipped"];
const TRIGGERS: AutomationRun["trigger"][] = ["cron", "webhook", "manual", "missed"];
/** The triggers added later (G33.3), with their own words. */
const MORE_TRIGGERS: AutomationRun["trigger"][] = [
  "email",
  "message",
  "files",
  "after",
  "task",
  "startup",
  "retry",
];
const statusLabel = (s: AutomationRun["status"]) =>
  s === "queued" ? t("axRunQueued") : (t("runStatus").split(",")[STATUSES.indexOf(s)] ?? s);
const triggerLabel = (s: AutomationRun["trigger"]) =>
  TRIGGERS.includes(s)
    ? (t("runTriggers").split(",")[TRIGGERS.indexOf(s)] ?? s)
    : (t("axRunTriggers").split(",")[MORE_TRIGGERS.indexOf(s)] ?? s);
const runClass = (s: AutomationRun["status"]) =>
  s === "ok" ? "ok" : s === "running" || s === "skipped" || s === "queued" ? "" : "bad";
const when = (iso: string) => new Date(iso).toLocaleString();

/** Whether a run's message reached the person (Telegram, the web…), in words. */
function deliveryText(d: NonNullable<AutomationRun["delivery"]>): string {
  if (d.status === "delivered") {
    const to = d.to.filter((x) => x !== "chats").join(", ");
    return to ? t("deliveryDeliveredTo", { to }) : t("deliveryDelivered");
  }
  if (d.status === "no-chat") return t("deliveryNoChat");
  return t("deliveryFailed", { reason: d.reason ?? "" });
}

/** The agent a recipe talks to, as the server resolves it (for opening its sessions). */
function agentOf(a: Automation): string {
  const r = a.recipe;
  const want = r.agent.toLowerCase();
  const pool = agents.value.filter((x) => r.project === null || x.projectId === r.project);
  const found =
    want === "god" || want === "orchestrator"
      ? pool.find((x) => x.kind === want)
      : pool.find((x) => x.id === r.agent || x.name.toLowerCase() === want);
  return found?.id ?? "";
}

/** The runs of an automation, newest first: how it went, why it started, what it said. */
function Runs({ a }: { a: Automation }) {
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const version = automationsVersion.value;
  useEffect(() => {
    void attempt(() => getApi().automationRuns(a.id)).then((r) => r && setRuns(r));
  }, [a.id, version]);
  if (runs.length === 0) return <p class="dim">{t("noRuns")}</p>;
  return (
    <div class="aw-runs">
      {runs.map((r) => (
        <article key={r.id} class={`aw-run ${runClass(r.status)}`}>
          <div class="aw-run-head">
            <span class="aw-run-st">{statusLabel(r.status)}</span>
            <span class="aw-run-tr">{triggerLabel(r.trigger)}</span>
            <span class="dim">
              {when(r.startedAt)}
              {r.finishedAt &&
                ` · ${Math.max(1, Math.round((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000))} s`}
            </span>
          </div>
          {r.delivery && (
            <p
              class={`aw-run-dl${r.delivery.status === "delivered" ? "" : " bad"}`}
              title={r.delivery.reason}
            >
              {deliveryText(r.delivery)}
            </p>
          )}
          {r.summary && (
            <div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(r.summary) }} />
          )}
          {r.sessionId && (
            <button
              type="button"
              class="wz-link inl aw-run-open"
              onClick={() =>
                openTab({
                  id: `chat:${r.sessionId}`,
                  type: "chat",
                  title: a.name,
                  sessionId: r.sessionId ?? "",
                  agentId: agentOf(a),
                })
              }
            >
              {t("openSession")}
            </button>
          )}
        </article>
      ))}
    </div>
  );
}

/** When an automation runs, in words (a date for reminders). */
export function recipeWhen(a: Automation): string {
  const on = a.recipe.on;
  if (on.at) return t("whenAt", { at: new Date(on.at).toLocaleString() });
  if (a.error) return whenWords(fromOn(on, a.recipe.project));
  return sentence(fromRecipe(a.recipe))[0] ?? "";
}

const quote = (s: string) => JSON.stringify(s);
const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const pad = (n: number) => String(n).padStart(2, "0");
const value = (e: Event) => (e.target as HTMLInputElement).value;

/** A reminder: what, which day, what time; sent as written, no agent. */
function ReminderForm({
  onSaved,
  onCancel,
}: {
  onSaved: (a: Automation) => void;
  onCancel: () => void;
}) {
  const tomorrow = new Date(Date.now() + 86_400_000);
  const [text, setText] = useState("");
  const [day, setDay] = useState(
    `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`,
  );
  const [time, setTime] = useState("09:00");
  const [error, setError] = useState<string>();
  const save = async () => {
    setError(undefined);
    const yaml = [
      `name: reminder-${day}-${time.replace(":", "")}-${Date.now().toString(36).slice(-3)}`,
      `description: ${quote(text.trim().split("\n")[0]?.slice(0, 80) ?? "")}`,
      "on:",
      `  at: ${quote(`${day}T${time}`)}`,
      `  timezone: ${tz()}`,
      `reminder: ${quote(text.trim())}`,
      "",
    ].join("\n");
    try {
      onSaved((await getApi().createAutomation(yaml)).automation);
    } catch (err) {
      setError(explain(err));
    }
  };
  return (
    <form
      class="aw-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <p class="wz-lead2">{t("reminderPurpose")}</p>
      <Field label={t("reminderWhat")}>
        <textarea
          class="wz-field"
          rows={3}
          value={text}
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        />
      </Field>
      <div class="aw-when-row">
        <Field label={t("reminderDay")}>
          <input class="wz-field" type="date" value={day} onInput={(e) => setDay(value(e))} />
        </Field>
        <Field label={t("whenAtTime")}>
          <input class="wz-field" type="time" value={time} onInput={(e) => setTime(value(e))} />
        </Field>
      </div>
      {error && <p class="notice error">{error}</p>}
      <Acts>
        <button type="button" class="wz-btn quiet" onClick={onCancel}>
          {t("cancel")}
        </button>
        <button type="submit" class="wz-btn primary" disabled={!text.trim()}>
          {t("reminderSave")}
        </button>
      </Acts>
    </form>
  );
}

/** The drawn icon of an automation, by what starts it. */
function iconOf(a: Automation): JSX.Element {
  const on = a.recipe.on;
  if (on.at) return <IconBell />;
  if (on.email) return <IconSend />;
  if (on.message) return <IconChat />;
  if (on.files) return <IconFolder />;
  if (on.after) return <IconLayers />;
  if (on.task) return <IconPlay />;
  if (on.startup && !on.cron) return <IconZap />;
  if (on.events && !on.cron) return <IconGit />;
  if (on.webhook && !on.cron) return <IconGlobe />;
  return <IconClock />;
}

/** One automation's window: its switch, its webhook, its runs; run, change or delete it. */
function AutoView({
  a,
  secret,
  setSecret,
  onEdit,
  onClose,
  onDeleted,
  reload,
}: {
  a: Automation;
  secret: string | null;
  setSecret: (s: string | null) => void;
  onEdit: () => void;
  onClose: () => void;
  onDeleted: () => void;
  reload: () => void;
}) {
  const [started, setStarted] = useState(false);
  const hookUrl = `${location.origin}/api/automations/${a.id}/hook`;
  const facts: [string, string][] = [];
  if (a.nextRunAt) facts.push([t("nextRun"), when(a.nextRunAt)]);
  if (a.lastRun) facts.push([t("awLastRun"), statusLabel(a.lastRun.status)]);
  return (
    <Modal wide title={a.recipe.description || a.name} onClose={onClose}>
      <div class="wz-panel-in aw-view">
        <SwitchRow
          title={t("autoOn")}
          help={a.enabled ? recipeWhen(a) : t("autoOff")}
          on={a.enabled}
          onChange={(on) => void attempt(() => getApi().enableAutomation(a.id, on)).then(reload)}
        />
        {a.error && (
          <p class="notice error">
            {t("recipeBroken")}: {a.error}
          </p>
        )}
        {facts.length > 0 && <Facts rows={facts} />}
        {a.recipe.reminder && <p class="aw-reminder">{a.recipe.reminder}</p>}
        {a.recipe.on.webhook && (
          <div class="aw-hook">
            <span class="wz-lb">{t("webhookUrl")}</span>
            <code>POST {hookUrl}</code>
            <button
              type="button"
              class="wz-btn small"
              onClick={() =>
                void attempt(() => getApi().rotateAutomationSecret(a.id)).then(
                  (r) => r && setSecret(r.webhookSecret),
                )
              }
            >
              <IconRefresh size={16} /> {t("newSecret")}
            </button>
            {secret && (
              <p class="notice ok">
                {t("webhookSecretOnce")} <code>{secret}</code>
              </p>
            )}
          </div>
        )}
        {started && <p class="notice ok">{t("awStarted")}</p>}
        <h4>{t("runs")}</h4>
        <Runs a={a} />
      </div>
      <Acts>
        <button
          type="button"
          class="wz-btn quiet aw-del"
          onClick={async () => {
            if (!(await askConfirm(t("deleteAutomationConfirm"), { danger: true }))) return;
            void attempt(() => getApi().deleteAutomation(a.id)).then(onDeleted);
          }}
        >
          {t("delete")}
        </button>
        {!a.recipe.reminder && (
          <button type="button" class="wz-btn" onClick={onEdit}>
            <IconPencil size={18} /> {t("awChange")}
          </button>
        )}
        <button
          type="button"
          class="wz-btn primary"
          onClick={() =>
            void attempt(() => getApi().runAutomation(a.id)).then(() => setStarted(true))
          }
        >
          <IconPlay size={18} /> {t("runNow")}
        </button>
      </Acts>
    </Modal>
  );
}

/** What is open: a new automation, a reminder, a magic one, one automation, or one being changed. */
type Open = "new" | "reminder" | "magic" | { magic: string } | { id: string; edit?: boolean };

/** The words for where a magic automation stands. */
const magicState = (m: MagicAutomation) => t(`axMagicState_${m.status}` as never);

/** Automations (G24.8): squares made and changed with words; the YAML for experts. */
export function Automations() {
  const [list, setList] = useState<Automation[]>([]);
  const [magic, setMagic] = useState<MagicAutomation[]>([]);
  const [open, setOpen] = useState<Open | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const version = automationsVersion.value;
  const openId = typeof open === "object" && open && "id" in open ? open.id : undefined;
  const current = list.find((a) => a.id === openId);
  const openMagic =
    typeof open === "object" && open && "magic" in open
      ? magic.find((m) => m.id === open.magic)
      : undefined;

  const reload = () => {
    void attempt(() => getApi().automations()).then((l) => l && setList(l));
    void getApi()
      .magicAutomations()
      .then(
        (l) => setMagic(Array.isArray(l) ? l : []),
        () => setMagic([]),
      );
  };
  useEffect(reload, [version]);
  useEffect(() => setSecret(null), [openId]);
  const saved = (a: Automation, s?: string) => {
    reload();
    setOpen({ id: a.id });
    setTimeout(() => setSecret(s ?? null), 0);
  };
  const close = () => setOpen(null);
  const stateOf = (a: Automation) =>
    [
      a.enabled ? t("enabled") : t("disabled"),
      a.lastRun && statusLabel(a.lastRun.status),
      a.nextRunAt && `${t("nextRun")} ${when(a.nextRunAt)}`,
    ]
      .filter(Boolean)
      .join(" · ");
  const building = magic.filter((m) => m.status === "building" || m.status === "ready");

  return (
    <WzPage
      class="aw-page"
      after={
        <>
          {open === "new" && (
            <Modal wide title={t("newAutomation")} onClose={close}>
              <Editor current={undefined} onSaved={saved} onCancel={close} />
            </Modal>
          )}
          {open === "reminder" && (
            <Modal title={t("newReminder")} onClose={close}>
              <ReminderForm onSaved={(a) => saved(a)} onCancel={close} />
            </Modal>
          )}
          {open === "magic" && (
            <MagicStart
              onClose={close}
              onStarted={(m) => {
                setMagic((l) => [m, ...l.filter((x) => x.id !== m.id)]);
                setOpen({ magic: m.id });
              }}
            />
          )}
          {openMagic && (
            <MagicChat
              m={openMagic}
              onClose={close}
              onChange={reload}
              onCreated={(a) => saved(a)}
            />
          )}
          {/* The window starts once the automation it shows is known (after a save, the list
          arrives a moment later). */}
          {current && typeof open === "object" && open && "id" in open && open.edit && (
            <Modal wide title={current.recipe.description || current.name} onClose={close}>
              <Editor
                key={current.id}
                current={current}
                onSaved={saved}
                onCancel={() => setOpen({ id: current.id })}
              />
            </Modal>
          )}
          {current && typeof open === "object" && open && "id" in open && !open.edit && (
            <AutoView
              a={current}
              secret={secret}
              setSecret={setSecret}
              onEdit={() => setOpen({ id: current.id, edit: true })}
              onClose={close}
              onDeleted={() => {
                close();
                reload();
              }}
              reload={reload}
            />
          )}
        </>
      }
    >
      <Head eyebrow={t("automations")} q={t("awQ")} lead={t("awLead")} />
      {/* The magic button (G33.3): a look of its own, God builds the automation with you. */}
      <button type="button" class="mg-cta" onClick={() => setOpen("magic")}>
        <span class="mg-orb big">
          <IconSpark size={26} />
        </span>
        <span class="mg-cta-text">
          <b>{t("axMagic")}</b>
          <span>{t("axMagicTile")}</span>
        </span>
      </button>
      <div class="wz-brain aw-make">
        <Tile
          on={open === "new"}
          icon={<IconPlus />}
          title={t("newAutomation")}
          text={t("awNewText")}
          onClick={() => setOpen("new")}
        />
        <Tile
          on={open === "reminder"}
          icon={<IconClock />}
          title={t("newReminder")}
          text={t("awReminderText")}
          onClick={() => setOpen("reminder")}
        />
      </div>

      {building.length > 0 && (
        <>
          <Sub title={t("axMagicListTitle")} lead={t("axMagicListLead")} />
          <div class="wz-brain aw-list mg-list">
            {building.map((m) => (
              <Tile
                key={m.id}
                on={m.status === "ready"}
                icon={<IconSpark />}
                title={`${t("axMagic")}: ${m.title}`}
                badge={m.status === "ready" ? t("axMagicReadyBadge") : undefined}
                text={m.request}
                state={magicState(m)}
                onClick={() => setOpen({ magic: m.id })}
              />
            ))}
          </div>
        </>
      )}

      <Sub title={t("awListTitle")} lead={list.length > 0 ? t("awListLead") : undefined} />
      {list.length === 0 ? (
        <p class="wz-subl">{t("noAutomations")}</p>
      ) : (
        <div class="wz-brain aw-list">
          {list.map((a) => (
            <Tile
              key={a.id}
              on={a.enabled}
              icon={iconOf(a)}
              title={a.recipe.description || a.name}
              badge={a.error ? t("recipeBroken") : undefined}
              text={recipeWhen(a)}
              state={stateOf(a)}
              onClick={() => setOpen({ id: a.id })}
            />
          ))}
        </div>
      )}

      <Sub title={t("awSourcesTitle")} lead={t("awSourcesLead")} />
      <Mailboxes />
    </WzPage>
  );
}
