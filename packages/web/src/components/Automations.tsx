// Automations (G24.8), drawn as the wizard (2026-11-06): two big squares to make one (an
// automation or a reminder), the automations as squares lit when switched on, each opening a
// window (a sheet from below on phones) with its switch, its webhook, its runs and the buttons to
// run it, change it or delete it; making and changing happen in a window too, in words, with the
// YAML for experts.
import type { Automation, AutomationRun } from "@redgiant/protocol";
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { t } from "../i18n.js";
import {
  IconBell,
  IconClock,
  IconGit,
  IconGlobe,
  IconPencil,
  IconPlay,
  IconPlus,
  IconRefresh,
  IconSend,
} from "../icons.js";
import { renderMarkdown } from "../markdown.js";
import { agents, attempt, automationsVersion, getApi, openTab, projects } from "../state.js";
import { explain } from "./Brain.js";
import { Chips, Facts, Sub, SwitchRow } from "./SettingsKit-automazioni.js";
import { Acts, Head, Tile } from "./SetupKit.js";
import { Advanced, Choice, Field, Modal, Pick } from "./ui.js";

const STATUSES: AutomationRun["status"][] = ["running", "ok", "failed", "timeout", "skipped"];
const TRIGGERS: AutomationRun["trigger"][] = ["cron", "webhook", "manual", "missed"];
const statusLabel = (s: AutomationRun["status"]) =>
  t("runStatus").split(",")[STATUSES.indexOf(s)] ?? s;
const triggerLabel = (s: AutomationRun["trigger"]) =>
  t("runTriggers").split(",")[TRIGGERS.indexOf(s)] ?? s;
const runClass = (s: AutomationRun["status"]) =>
  s === "ok" ? "ok" : s === "running" || s === "skipped" ? "" : "bad";
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

// --- When it runs, in words (G24.8): the choices people make, and the cron they become -------

type When =
  | { kind: "daily" | "weekdays"; time: string }
  | { kind: "weekly"; time: string; days: number[] }
  | { kind: "hours"; every: number }
  | { kind: "monthly"; time: string; day: number }
  | { kind: "webhook" }
  /** On events of a project's repository (G24.14c): its webhook is added by RedGiant. */
  | { kind: "repo"; project: string; events: string[] }
  /** On new email in the person's mailbox that matches (G24.14c). */
  | { kind: "email"; from: string; subject: string }
  | { kind: "custom"; cron: string };

const pad = (n: number) => String(n).padStart(2, "0");
const hm = (time: string) => {
  const [h = "8", m = "0"] = time.split(":");
  return { h: Number(h), m: Number(m) };
};

/** The cron expression of a choice (null: no schedule, only the webhook). */
export function toCron(w: When): string | null {
  if (w.kind === "webhook" || w.kind === "repo" || w.kind === "email") return null;
  if (w.kind === "custom") return w.cron;
  if (w.kind === "hours") return `0 */${Math.max(1, Math.min(23, w.every))} * * *`;
  const { h, m } = hm(w.time);
  if (w.kind === "daily") return `${m} ${h} * * *`;
  if (w.kind === "weekdays") return `${m} ${h} * * 1-5`;
  if (w.kind === "monthly") return `${m} ${h} ${w.day} * *`;
  if (w.kind === "weekly") return `${m} ${h} * * ${[...w.days].sort().join(",") || "1"}`;
  return `${m} ${h} * * *`;
}

/** The choice a recipe's `on` came from: repository events and email first, then the cron. */
export function fromOn(on: Automation["recipe"]["on"], project: string | null): When {
  if (on.email)
    return { kind: "email", from: on.email.from ?? "", subject: on.email.subject ?? "" };
  if (on.events && !on.cron) return { kind: "repo", project: project ?? "", events: on.events };
  return fromCron(on.cron, on.webhook);
}

/** The choice a cron expression came from, when it is one of ours; otherwise "custom". */
export function fromCron(cron: string | undefined, webhook: boolean): When {
  if (!cron) return webhook ? { kind: "webhook" } : { kind: "daily", time: "08:00" };
  const f = cron.trim().split(/\s+/);
  const [m, h, dom, mon, dow] = f;
  const num = (x: string | undefined) => (x !== undefined && /^\d+$/.test(x) ? Number(x) : null);
  const every = h?.match(/^\*\/(\d+)$/);
  if (f.length === 5 && m === "0" && every && dom === "*" && mon === "*" && dow === "*")
    return { kind: "hours", every: Number(every[1]) };
  const mm = num(m);
  const hh = num(h);
  if (f.length !== 5 || mm === null || hh === null || mon !== "*") return { kind: "custom", cron };
  const time = `${pad(hh)}:${pad(mm)}`;
  if (dom === "*" && dow === "*") return { kind: "daily", time };
  if (dom === "*" && dow === "1-5") return { kind: "weekdays", time };
  if (dom === "*" && dow && /^[0-6](,[0-6])*$/.test(dow))
    return { kind: "weekly", time, days: dow.split(",").map(Number) };
  if (num(dom) !== null && dow === "*") return { kind: "monthly", time, day: Number(dom) };
  return { kind: "custom", cron };
}

const DAYS = [1, 2, 3, 4, 5, 6, 0];
const dayName = (d: number) => t(`day_${d}` as never);

/** A sentence for people: "Every weekday at 08:00". */
export function whenWords(w: When): string {
  switch (w.kind) {
    case "daily":
      return t("whenDaily", { time: w.time });
    case "weekdays":
      return t("whenWeekdays", { time: w.time });
    case "weekly":
      return t("whenWeekly", { days: w.days.map(dayName).join(", "), time: w.time });
    case "hours":
      return t("whenHours", { n: String(w.every) });
    case "monthly":
      return t("whenMonthly", { day: String(w.day), time: w.time });
    case "webhook":
      return t("whenWebhook");
    case "repo":
      return t("whenRepo", { events: w.events.join(", ") });
    case "email":
      return t("whenEmail", {
        filter:
          [w.from && `${t("emailFrom")} ${w.from}`, w.subject && `«${w.subject}»`]
            .filter(Boolean)
            .join(" · ") || t("emailAny"),
      });
    default:
      return t("whenCustom", { cron: w.cron });
  }
}

/** When an automation runs, in words (a date for reminders). */
export function recipeWhen(a: Automation): string {
  const on = a.recipe.on;
  if (on.at) return t("whenAt", { at: new Date(on.at).toLocaleString() });
  const words = whenWords(fromOn(on, a.recipe.project));
  return on.cron && on.webhook ? `${words} ${t("whenAlsoWebhook")}` : words;
}

const quote = (s: string) => JSON.stringify(s);
const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "automation";

/** The recipe as YAML (strings quoted as JSON, which YAML reads too). */
function recipeYaml(o: {
  name: string;
  title: string;
  when: When;
  agent: { agent: string; project: string | null };
  instructions: string;
}): string {
  const cron = toCron(o.when);
  return [
    `name: ${o.name}`,
    `description: ${quote(o.title)}`,
    "on:",
    ...(cron ? [`  cron: ${quote(cron)}`, `  timezone: ${tz()}`] : []),
    `  webhook: ${o.when.kind === "webhook" || o.when.kind === "repo"}`,
    ...(o.when.kind === "repo" ? [`  events: ${JSON.stringify(o.when.events)}`] : []),
    ...(o.when.kind === "email"
      ? [
          "  email:",
          ...(o.when.from ? [`    from: ${quote(o.when.from)}`] : []),
          ...(o.when.subject ? [`    subject: ${quote(o.when.subject)}`] : []),
          ...(!o.when.from && !o.when.subject ? ["    {}"] : []),
        ]
      : []),
    `agent: ${quote(o.agent.agent)}`,
    ...(o.agent.project ? [`project: ${quote(o.agent.project)}`] : []),
    `instructions: ${quote(o.instructions)}`,
    "",
  ].join("\n");
}

/** Who can be asked: God, each project's lead, the project agents. */
function whoOptions(): { key: string; label: string; agent: string; project: string | null }[] {
  const out: { key: string; label: string; agent: string; project: string | null }[] = [];
  const god = agents.value.find((a) => a.kind === "god");
  if (god) out.push({ key: "god", label: god.name, agent: "god", project: null });
  // Personal assistants (G24.11): a routine belongs to one of them.
  for (const a of agents.value)
    if (a.kind === "assistant" && a.status === "active")
      out.push({ key: `p:${a.id}`, label: a.name, agent: a.id, project: null });
  for (const a of agents.value) {
    if (a.status !== "active" || !a.projectId) continue;
    if (a.kind === "orchestrator")
      out.push({
        key: `o:${a.projectId}`,
        label: t("whoLead", { project: a.projectId }),
        agent: "orchestrator",
        project: a.projectId,
      });
    else if (a.kind === "agent")
      out.push({
        key: `a:${a.id}`,
        label: `${a.name} (${a.projectId})`,
        agent: a.name,
        project: a.projectId,
      });
  }
  return out;
}

const TEMPLATES = ["morning", "weekly", "spending"] as const;
type Template = (typeof TEMPLATES)[number] | "blank";
const templateWhen: Record<(typeof TEMPLATES)[number], When> = {
  morning: { kind: "weekdays", time: "08:00" },
  weekly: { kind: "weekly", time: "17:00", days: [5] },
  spending: { kind: "monthly", time: "09:00", day: 1 },
};

/** What making or changing an automation keeps while the person writes, and its saving. */
function useDraft(
  current: Automation | undefined,
  preset: string | undefined,
  onSaved: (a: Automation, secret?: string) => void,
) {
  const r = current?.recipe;
  const who = whoOptions();
  const [tpl, setTpl] = useState<Template>(current ? "blank" : "morning");
  const [title, setTitle] = useState(
    r?.description || (current ? current.name : t("tplTitle_morning")),
  );
  const [when, setWhen] = useState<When>(r ? fromOn(r.on, r.project) : templateWhen.morning);
  const [whoKey, setWhoKey] = useState(() => {
    if (!r) return preset ?? "god";
    if (r.agent === "god") return "god";
    if (r.agent === "orchestrator") return `o:${r.project}`;
    return who.find((x) => x.agent === r.agent && x.project === r.project)?.key ?? "god";
  });
  const [instructions, setInstructions] = useState(r?.instructions ?? t("tplText_morning"));
  const [yaml, setYaml] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const pickTemplate = (x: Template) => {
    setTpl(x);
    if (x === "blank") {
      setTitle("");
      setInstructions("");
      setWhen({ kind: "daily", time: "09:00" });
      return;
    }
    setTitle(t(`tplTitle_${x}`));
    setInstructions(t(`tplText_${x}`));
    setWhen(templateWhen[x]);
  };
  const agent = who.find((x) => x.key === whoKey) ?? who[0];
  const generated = recipeYaml({
    name: current?.name ?? `${slug(title)}-${Date.now().toString(36).slice(-4)}`,
    title: title.trim(),
    when,
    agent: agent ?? { agent: "god", project: null },
    instructions: instructions.trim(),
  });
  const save = async () => {
    setError(undefined);
    setBusy(true);
    try {
      const text = yaml ?? generated;
      const res = current
        ? await getApi().updateAutomation(current.id, text)
        : await getApi().createAutomation(text);
      // A routine on repository events: its webhook goes on Gitea or GitHub now, with the
      // secret that is shown only this once (G24.14c).
      if (when.kind === "repo" && res.webhookSecret)
        await getApi().repoHook(res.automation.id, res.webhookSecret, when.project);
      onSaved(res.automation, res.webhookSecret);
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusy(false);
    }
  };
  const ready = yaml !== null || (title.trim() !== "" && instructions.trim() !== "");
  return {
    who,
    tpl,
    pickTemplate,
    title,
    setTitle,
    when,
    setWhen,
    whoKey,
    setWhoKey,
    instructions,
    setInstructions,
    yaml,
    setYaml,
    generated,
    error,
    busy,
    ready,
    save,
  };
}

/**
 * Making or changing an automation: when, who, what; the YAML under "Advanced". The plain form,
 * used where the page is not drawn as the wizard (an assistant's routines).
 */
export function Editor({
  current,
  onSaved,
  who: preset,
}: {
  current: Automation | undefined;
  onSaved: (a: Automation, secret?: string) => void;
  /** Who does it, chosen beforehand (an assistant's own routine). */
  who?: string;
}) {
  const d = useDraft(current, preset, onSaved);
  return (
    <div class="ui-step auto-editor">
      {!current && (
        <>
          <h4>{t("autoStart")}</h4>
          <Choice<Template>
            value={[d.tpl]}
            onChange={([x]) => x && d.pickTemplate(x)}
            options={[...TEMPLATES, "blank" as const].map((x) => ({
              id: x,
              title: t(`tplTitle_${x}`),
              description: t(`tplDesc_${x}`),
            }))}
          />
        </>
      )}
      <div class="form">
        <Field label={t("autoTitle")} help={t("autoTitleHelp")}>
          <input
            value={d.title}
            onInput={(e) => d.setTitle((e.target as HTMLInputElement).value)}
          />
        </Field>
        <Field label={t("autoWho")} help={t("autoWhoHelp")}>
          <select
            value={d.whoKey}
            onChange={(e) => d.setWhoKey((e.target as HTMLSelectElement).value)}
          >
            {d.who.map((x) => (
              <option key={x.key} value={x.key}>
                {x.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <h4>{t("autoWhen")}</h4>
      <WhenPicker when={d.when} onChange={d.setWhen} />
      <p class="notice ok">{whenWords(d.when)}</p>
      <Field label={t("autoWhat")} help={t("autoWhatHelp")}>
        <textarea
          rows={4}
          value={d.instructions}
          onInput={(e) => d.setInstructions((e.target as HTMLTextAreaElement).value)}
        />
      </Field>
      <Advanced label={t("autoYaml")}>
        <p class="ui-help">{t("autoYamlHint")}</p>
        <textarea
          class="code recipe"
          spellcheck={false}
          rows={12}
          value={d.yaml ?? d.generated}
          onInput={(e) => d.setYaml((e.target as HTMLTextAreaElement).value)}
        />
      </Advanced>
      <div class="row">
        <button type="button" class="primary" disabled={!d.ready} onClick={() => void d.save()}>
          {current ? t("save") : t("create")}
        </button>
      </div>
      {d.error && <p class="notice error">{d.error}</p>}
    </div>
  );
}

const WHEN_KINDS = [
  "daily",
  "weekdays",
  "weekly",
  "monthly",
  "hours",
  "repo",
  "email",
  "webhook",
] as const;
type WhenKind = (typeof WHEN_KINDS)[number];

/** The choice of a kind, keeping the time already written. */
function whenOf(kind: WhenKind, current: When): When {
  const time = "time" in current ? current.time : "08:00";
  if (kind === "repo")
    return { kind, project: projects.value[0]?.id ?? "", events: ["pull_request"] };
  if (kind === "email") return { kind, from: "", subject: "" };
  if (kind === "weekly") return { kind, time, days: [5] };
  if (kind === "monthly") return { kind, time, day: 1 };
  if (kind === "hours") return { kind, every: 3 };
  if (kind === "webhook") return { kind };
  return { kind, time };
}

function WhenPicker({ when, onChange }: { when: When; onChange: (w: When) => void }) {
  return (
    <div class="when-picker">
      <div class="choice">
        {WHEN_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            class={when.kind === k ? "active" : ""}
            onClick={() => onChange(whenOf(k, when))}
          >
            {t(`whenKind_${k}`)}
          </button>
        ))}
      </div>
      <div class="row wrap">
        {"time" in when && (
          <label class="row">
            {t("whenAtTime")}
            <input
              type="time"
              value={when.time}
              onInput={(e) => onChange({ ...when, time: (e.target as HTMLInputElement).value })}
            />
          </label>
        )}
        {when.kind === "weekly" && (
          <div class="pick-row">
            {DAYS.map((d) => (
              <Pick
                key={d}
                small
                on={when.days.includes(d)}
                onChange={(v) =>
                  onChange({
                    ...when,
                    days: v ? [...when.days, d] : when.days.filter((x) => x !== d),
                  })
                }
              >
                {dayName(d)}
              </Pick>
            ))}
          </div>
        )}
        {when.kind === "monthly" && (
          <label class="row">
            {t("whenDayOfMonth")}
            <input
              type="number"
              min={1}
              max={28}
              value={when.day}
              onInput={(e) =>
                onChange({ ...when, day: Number((e.target as HTMLInputElement).value) || 1 })
              }
            />
          </label>
        )}
        {when.kind === "hours" && (
          <label class="row">
            {t("whenEveryHours")}
            <input
              type="number"
              min={1}
              max={23}
              value={when.every}
              onInput={(e) =>
                onChange({ ...when, every: Number((e.target as HTMLInputElement).value) || 1 })
              }
            />
          </label>
        )}
        {when.kind === "custom" && <code>{when.cron}</code>}
      </div>
      {when.kind === "webhook" && <p class="ui-help">{t("whenWebhookHelp")}</p>}
      {when.kind === "repo" && (
        <div class="row wrap">
          <select
            aria-label={t("projects")}
            value={when.project}
            onChange={(e) => onChange({ ...when, project: (e.target as HTMLSelectElement).value })}
          >
            {projects.value.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <div class="pick-row">
            {REPO_EVENTS.map((ev) => (
              <Pick
                key={ev}
                small
                on={when.events.includes(ev)}
                onChange={(v) =>
                  onChange({
                    ...when,
                    events: v ? [...when.events, ev] : when.events.filter((x) => x !== ev),
                  })
                }
              >
                {t(`repoEvent_${ev}`)}
              </Pick>
            ))}
          </div>
          <p class="ui-help">{t("whenRepoHelp")}</p>
        </div>
      )}
      {when.kind === "email" && (
        <div class="row wrap">
          <input
            aria-label={t("emailFrom")}
            placeholder={t("emailFromPlaceholder")}
            value={when.from}
            onInput={(e) => onChange({ ...when, from: (e.target as HTMLInputElement).value })}
          />
          <input
            aria-label={t("emailSubject")}
            placeholder={t("emailSubjectPlaceholder")}
            value={when.subject}
            onInput={(e) => onChange({ ...when, subject: (e.target as HTMLInputElement).value })}
          />
          <p class="ui-help">{t("whenEmailHelp")}</p>
        </div>
      )}
    </div>
  );
}

const REPO_EVENTS = ["push", "pull_request", "issues", "issue_comment", "release"] as const;

const value = (e: Event) => (e.target as HTMLInputElement).value;

/** When it runs, as the wizard asks it: chips for the kind, then only what that kind needs. */
function WzWhen({ when, onChange }: { when: When; onChange: (w: When) => void }) {
  return (
    <div class="aw-when">
      <Chips<WhenKind | "custom">
        options={[
          ...WHEN_KINDS.map((k) => ({ id: k, label: t(`whenKind_${k}`) })),
          // A schedule written by hand stays visible as what it is.
          ...(when.kind === "custom" ? [{ id: "custom" as const, label: when.cron }] : []),
        ]}
        value={[when.kind]}
        onChange={([k]) => k && k !== "custom" && onChange(whenOf(k, when))}
      />
      {(when.kind === "monthly" || when.kind === "hours" || "time" in when) && (
        <div class="aw-when-row">
          {"time" in when && (
            <Field label={t("whenAtTime")}>
              <input
                class="wz-field"
                type="time"
                value={when.time}
                onInput={(e) => onChange({ ...when, time: value(e) })}
              />
            </Field>
          )}
          {when.kind === "monthly" && (
            <Field label={t("whenDayOfMonth")}>
              <input
                class="wz-field"
                type="number"
                min={1}
                max={28}
                value={when.day}
                onInput={(e) => onChange({ ...when, day: Number(value(e)) || 1 })}
              />
            </Field>
          )}
          {when.kind === "hours" && (
            <Field label={t("whenEveryHours")}>
              <input
                class="wz-field"
                type="number"
                min={1}
                max={23}
                value={when.every}
                onInput={(e) => onChange({ ...when, every: Number(value(e)) || 1 })}
              />
            </Field>
          )}
        </div>
      )}
      {when.kind === "weekly" && (
        <Chips<number>
          multiple
          options={DAYS.map((d) => ({ id: d, label: dayName(d) }))}
          value={when.days}
          onChange={(days) => onChange({ ...when, days })}
        />
      )}
      {when.kind === "webhook" && <p class="ui-help">{t("whenWebhookHelp")}</p>}
      {when.kind === "repo" && (
        <>
          <Field label={t("projects")}>
            <select
              class="wz-field"
              value={when.project}
              onChange={(e) => onChange({ ...when, project: value(e) })}
            >
              {projects.value.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Chips<string>
            multiple
            options={REPO_EVENTS.map((ev) => ({ id: ev, label: t(`repoEvent_${ev}`) }))}
            value={when.events}
            onChange={(events) => onChange({ ...when, events })}
          />
          <p class="ui-help">{t("whenRepoHelp")}</p>
        </>
      )}
      {when.kind === "email" && (
        <>
          <div class="aw-when-row">
            <Field label={t("emailFrom")}>
              <input
                class="wz-field"
                placeholder={t("emailFromPlaceholder")}
                value={when.from}
                onInput={(e) => onChange({ ...when, from: value(e) })}
              />
            </Field>
            <Field label={t("emailSubject")}>
              <input
                class="wz-field"
                placeholder={t("emailSubjectPlaceholder")}
                value={when.subject}
                onInput={(e) => onChange({ ...when, subject: value(e) })}
              />
            </Field>
          </div>
          <p class="ui-help">{t("whenEmailHelp")}</p>
        </>
      )}
    </div>
  );
}

/** Making or changing an automation in a window: where to start, who, when, what; the YAML. */
function WzEditor({
  current,
  onSaved,
  onCancel,
}: {
  current: Automation | undefined;
  onSaved: (a: Automation, secret?: string) => void;
  onCancel: () => void;
}) {
  const d = useDraft(current, undefined, onSaved);
  return (
    <form
      class="aw-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void d.save();
      }}
    >
      {!current && (
        <>
          <span class="wz-lb">{t("autoStart")}</span>
          <div class="wz-opt aw-tpl">
            {[...TEMPLATES, "blank" as const].map((x) => (
              <button
                key={x}
                type="button"
                class={d.tpl === x ? "on" : ""}
                aria-pressed={d.tpl === x}
                onClick={() => d.pickTemplate(x)}
              >
                <b>{t(`tplTitle_${x}`)}</b>
                <small>{t(`tplDesc_${x}`)}</small>
              </button>
            ))}
          </div>
        </>
      )}
      <Field label={t("autoTitle")} help={t("autoTitleHelp")}>
        <input class="wz-field" value={d.title} onInput={(e) => d.setTitle(value(e))} />
      </Field>
      <Field label={t("autoWho")} help={t("autoWhoHelp")}>
        <select class="wz-field" value={d.whoKey} onChange={(e) => d.setWhoKey(value(e))}>
          {d.who.map((x) => (
            <option key={x.key} value={x.key}>
              {x.label}
            </option>
          ))}
        </select>
      </Field>
      <span class="wz-lb">{t("autoWhen")}</span>
      <WzWhen when={d.when} onChange={d.setWhen} />
      <p class="aw-says">
        <IconClock size={18} /> {whenWords(d.when)}
      </p>
      <Field label={t("autoWhat")} help={t("autoWhatHelp")}>
        <textarea
          class="wz-field"
          rows={5}
          value={d.instructions}
          onInput={(e) => d.setInstructions(value(e))}
        />
      </Field>
      <Advanced label={t("autoYaml")}>
        <p class="ui-help">{t("autoYamlHint")}</p>
        <textarea
          class="wz-field mono aw-yaml"
          spellcheck={false}
          rows={12}
          value={d.yaml ?? d.generated}
          onInput={(e) => d.setYaml(value(e))}
        />
      </Advanced>
      {d.error && <p class="notice error">{d.error}</p>}
      <Acts>
        <button type="button" class="wz-btn quiet" onClick={onCancel}>
          {t("cancel")}
        </button>
        <button type="submit" class="wz-btn primary" disabled={d.busy || !d.ready}>
          {current ? t("save") : t("create")}
        </button>
      </Acts>
    </form>
  );
}

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
          onClick={() => {
            if (!confirm(t("deleteAutomationConfirm"))) return;
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

/** What is open: a new automation, a new reminder, one automation, or one being changed. */
type Open = "new" | "reminder" | { id: string; edit?: boolean };

/** Automations (G24.8): squares made and changed with words; the YAML for experts. */
export function Automations() {
  const [list, setList] = useState<Automation[]>([]);
  const [open, setOpen] = useState<Open | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const version = automationsVersion.value;
  const openId = typeof open === "object" && open ? open.id : undefined;
  const current = list.find((a) => a.id === openId);

  const reload = () => void attempt(() => getApi().automations()).then((l) => l && setList(l));
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

  return (
    <div class="settings-section wz-look aw-page">
      <section class="wz-inner">
        <Head eyebrow={t("automations")} q={t("awQ")} lead={t("awLead")} />
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
      </section>

      {open === "new" && (
        <Modal wide title={t("newAutomation")} onClose={close}>
          <WzEditor current={undefined} onSaved={saved} onCancel={close} />
        </Modal>
      )}
      {open === "reminder" && (
        <Modal title={t("newReminder")} onClose={close}>
          <ReminderForm onSaved={(a) => saved(a)} onCancel={close} />
        </Modal>
      )}
      {/* The window starts once the automation it shows is known (after a save, the list
          arrives a moment later). */}
      {current && typeof open === "object" && open?.edit && (
        <Modal wide title={current.recipe.description || current.name} onClose={close}>
          <WzEditor
            key={current.id}
            current={current}
            onSaved={saved}
            onCancel={() => setOpen({ id: current.id })}
          />
        </Modal>
      )}
      {current && typeof open === "object" && !open?.edit && (
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
    </div>
  );
}
