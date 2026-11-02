import type { Automation, AutomationRun } from "@redgiant/protocol";
import { useEffect, useState } from "preact/hooks";
import { t } from "../i18n.js";
import { IconClock, IconPlay, IconPlus } from "../icons.js";
import { renderMarkdown } from "../markdown.js";
import { agents, attempt, automationsVersion, getApi, openTab, projects } from "../state.js";
import { explain } from "./Brain.js";
import { Advanced, Choice, Field, Toggle } from "./ui.js";

const STATUSES: AutomationRun["status"][] = ["running", "ok", "failed", "timeout", "skipped"];
const TRIGGERS: AutomationRun["trigger"][] = ["cron", "webhook", "manual", "missed"];
const statusLabel = (s: AutomationRun["status"]) =>
  t("runStatus").split(",")[STATUSES.indexOf(s)] ?? s;
const triggerLabel = (s: AutomationRun["trigger"]) =>
  t("runTriggers").split(",")[TRIGGERS.indexOf(s)] ?? s;
const chipClass = (s: AutomationRun["status"]) =>
  s === "ok" ? "resolved" : s === "running" || s === "skipped" ? "" : "blocked";
const when = (iso: string) => new Date(iso).toLocaleString();

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

function Runs({ a }: { a: Automation }) {
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const version = automationsVersion.value;
  useEffect(() => {
    void attempt(() => getApi().automationRuns(a.id)).then((r) => r && setRuns(r));
  }, [a.id, version]);
  if (runs.length === 0) return <div class="empty">{t("noRuns")}</div>;
  return (
    <div class="posts">
      {runs.map((r) => (
        <article
          key={r.id}
          class={`post ${r.status === "ok" ? "result" : r.status === "running" || r.status === "skipped" ? "" : "blocker"}`}
        >
          <div class="post-head">
            <span class={`status-chip ${chipClass(r.status)}`}>{statusLabel(r.status)}</span>
            <span class="kind-badge">{triggerLabel(r.trigger)}</span>
            <span class="dim">
              {when(r.startedAt)}
              {r.finishedAt &&
                ` · ${Math.max(1, Math.round((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000))} s`}
            </span>
            <div class="spacer" />
            {r.sessionId && (
              <button
                type="button"
                class="tiny"
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
          </div>
          {r.summary && (
            <div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(r.summary) }} />
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

/** Making or changing an automation: when, who, what; the YAML under "Advanced". */
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
    }
  };
  return (
    <div class="ui-step auto-editor">
      {!current && (
        <>
          <h4>{t("autoStart")}</h4>
          <Choice<Template>
            value={[tpl]}
            onChange={([x]) => x && pickTemplate(x)}
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
          <input value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
        </Field>
        <Field label={t("autoWho")} help={t("autoWhoHelp")}>
          <select value={whoKey} onChange={(e) => setWhoKey((e.target as HTMLSelectElement).value)}>
            {who.map((x) => (
              <option key={x.key} value={x.key}>
                {x.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <h4>{t("autoWhen")}</h4>
      <WhenPicker when={when} onChange={setWhen} />
      <p class="notice ok">{whenWords(when)}</p>
      <Field label={t("autoWhat")} help={t("autoWhatHelp")}>
        <textarea
          rows={4}
          value={instructions}
          onInput={(e) => setInstructions((e.target as HTMLTextAreaElement).value)}
        />
      </Field>
      <Advanced label={t("autoYaml")}>
        <p class="ui-help">{t("autoYamlHint")}</p>
        <textarea
          class="code recipe"
          spellcheck={false}
          rows={12}
          value={yaml ?? generated}
          onInput={(e) => setYaml((e.target as HTMLTextAreaElement).value)}
        />
      </Advanced>
      <div class="row">
        <button
          type="button"
          class="primary"
          disabled={yaml === null && (!title.trim() || !instructions.trim())}
          onClick={() => void save()}
        >
          {current ? t("save") : t("create")}
        </button>
      </div>
      {error && <p class="notice error">{error}</p>}
    </div>
  );
}

function WhenPicker({ when, onChange }: { when: When; onChange: (w: When) => void }) {
  const time = "time" in when ? when.time : "08:00";
  const kinds = [
    "daily",
    "weekdays",
    "weekly",
    "monthly",
    "hours",
    "repo",
    "email",
    "webhook",
  ] as const;
  const set = (kind: (typeof kinds)[number]) => {
    if (kind === "repo")
      onChange({ kind, project: projects.value[0]?.id ?? "", events: ["pull_request"] });
    else if (kind === "email") onChange({ kind, from: "", subject: "" });
    else if (kind === "weekly") onChange({ kind, time, days: [5] });
    else if (kind === "monthly") onChange({ kind, time, day: 1 });
    else if (kind === "hours") onChange({ kind, every: 3 });
    else if (kind === "webhook") onChange({ kind });
    else onChange({ kind, time });
  };
  return (
    <div class="when-picker">
      <div class="choice">
        {kinds.map((k) => (
          <button
            key={k}
            type="button"
            class={when.kind === k ? "active" : ""}
            onClick={() => set(k)}
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
        {when.kind === "weekly" &&
          DAYS.map((d) => (
            <label key={d} class="row day">
              <input
                type="checkbox"
                checked={when.days.includes(d)}
                onChange={(e) =>
                  onChange({
                    ...when,
                    days: (e.target as HTMLInputElement).checked
                      ? [...when.days, d]
                      : when.days.filter((x) => x !== d),
                  })
                }
              />
              {dayName(d)}
            </label>
          ))}
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
          {REPO_EVENTS.map((ev) => (
            <label key={ev} class="row day">
              <input
                type="checkbox"
                checked={when.events.includes(ev)}
                onChange={(e) =>
                  onChange({
                    ...when,
                    events: (e.target as HTMLInputElement).checked
                      ? [...when.events, ev]
                      : when.events.filter((x) => x !== ev),
                  })
                }
              />
              {t(`repoEvent_${ev}`)}
            </label>
          ))}
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

/** A reminder: what, which day, what time; sent as written, no agent. */
function ReminderForm({ onSaved }: { onSaved: (a: Automation) => void }) {
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
    <div class="ui-step">
      <p class="ui-purpose">{t("reminderPurpose")}</p>
      <Field label={t("reminderWhat")}>
        <textarea
          rows={3}
          value={text}
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        />
      </Field>
      <div class="form">
        <Field label={t("reminderDay")}>
          <input
            type="date"
            value={day}
            onInput={(e) => setDay((e.target as HTMLInputElement).value)}
          />
        </Field>
        <Field label={t("whenAtTime")}>
          <input
            type="time"
            value={time}
            onInput={(e) => setTime((e.target as HTMLInputElement).value)}
          />
        </Field>
      </div>
      <div class="row">
        <button type="button" class="primary" disabled={!text.trim()} onClick={() => void save()}>
          {t("reminderSave")}
        </button>
      </div>
      {error && <p class="notice error">{error}</p>}
    </div>
  );
}

/** Automations (G24.8): a clean list, made and changed with words; the YAML for experts. */
export function Automations() {
  const [list, setList] = useState<Automation[]>([]);
  const [open, setOpen] = useState<string | "new" | "reminder" | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const version = automationsVersion.value;
  const current = list.find((a) => a.id === open);

  const reload = () => void attempt(() => getApi().automations()).then((l) => l && setList(l));
  useEffect(reload, [version]);
  useEffect(() => setSecret(null), [open]);
  const saved = (a: Automation, s?: string) => {
    reload();
    setOpen(a.id);
    setTimeout(() => setSecret(s ?? null), 0);
  };
  const hookUrl = current ? `${location.origin}/api/automations/${current.id}/hook` : "";

  return (
    <div class="board automations">
      <aside class="board-list">
        <button type="button" class="primary" onClick={() => setOpen("new")}>
          <IconPlus /> {t("newAutomation")}
        </button>
        <button type="button" onClick={() => setOpen("reminder")}>
          <IconClock /> {t("newReminder")}
        </button>
        {list.length === 0 ? (
          <div class="empty">{t("noAutomations")}</div>
        ) : (
          list.map((a) => (
            <button
              type="button"
              key={a.id}
              class={`thread-item${open === a.id ? " selected" : ""}`}
              onClick={() => setOpen(a.id)}
            >
              <span class="row">
                <span class={`status-chip ${a.enabled ? "resolved" : ""}`}>
                  {a.enabled ? t("enabled") : t("disabled")}
                </span>
                {a.lastRun && (
                  <span class={`status-chip ${chipClass(a.lastRun.status)}`}>
                    {statusLabel(a.lastRun.status)}
                  </span>
                )}
              </span>
              <strong>{a.recipe.description || a.name}</strong>
              <span class="dim">{recipeWhen(a)}</span>
              {a.nextRunAt && (
                <span class="dim">
                  {t("nextRun")} {when(a.nextRunAt)}
                </span>
              )}
            </button>
          ))
        )}
      </aside>
      <section class="board-thread">
        {open === null ? (
          <div class="empty logo-empty">{t("autoEmpty")}</div>
        ) : open === "reminder" ? (
          <ReminderForm onSaved={(a) => saved(a)} />
        ) : (
          <>
            <header class="row">
              <h3>{current ? current.recipe.description || current.name : t("newAutomation")}</h3>
              <div class="spacer" />
              {current && (
                <>
                  <button
                    type="button"
                    onClick={() => void attempt(() => getApi().runAutomation(current.id))}
                  >
                    <IconPlay /> {t("runNow")}
                  </button>
                  <button
                    type="button"
                    class="danger"
                    onClick={() => {
                      if (!confirm(t("deleteAutomationConfirm"))) return;
                      void attempt(() => getApi().deleteAutomation(current.id)).then(() => {
                        setOpen(null);
                        reload();
                      });
                    }}
                  >
                    {t("delete")}
                  </button>
                </>
              )}
            </header>
            {current && (
              <Toggle
                label={t("autoOn")}
                description={current.enabled ? recipeWhen(current) : t("autoOff")}
                checked={current.enabled}
                onChange={(on) =>
                  void attempt(() => getApi().enableAutomation(current.id, on)).then(reload)
                }
              />
            )}
            {current?.recipe.reminder ? (
              <p class="notice">{current.recipe.reminder}</p>
            ) : (
              // The form starts once the automation it shows is known (after a save, the list
              // arrives a moment later).
              (open === "new" || current) && (
                <Editor key={current?.id ?? "new"} current={current} onSaved={saved} />
              )
            )}
            {current?.recipe.on.webhook && (
              <div class="notice">
                {t("webhookUrl")}: <code>POST {hookUrl}</code>{" "}
                <button
                  type="button"
                  class="tiny"
                  onClick={() =>
                    void attempt(() => getApi().rotateAutomationSecret(current.id)).then(
                      (r) => r && setSecret(r.webhookSecret),
                    )
                  }
                >
                  {t("newSecret")}
                </button>
                {secret && (
                  <div>
                    {t("webhookSecretOnce")} <code>{secret}</code>
                  </div>
                )}
              </div>
            )}
            {current && (
              <>
                <h4>{t("runs")}</h4>
                <Runs a={current} />
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
