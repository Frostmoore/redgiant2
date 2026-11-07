// The automation editor without limits (G33.3, the person: "mi deve dare ogni tipo di possibilità
// immaginabile, rimanendo con uno stile moderno e gradevole"). Five parts, in the order a person
// thinks: When (one or more things that start it), Only if (conditions, all together), What it
// does (an agent and its instructions, or a plain reminder; a yes first, a spending limit), Where
// it tells you, and Advanced (failures, overlaps, model, the YAML). A sentence in words follows
// every change, and the next times come from the server, which reads the recipe as it will run.
import type { Automation, Recipe } from "@redgiant/protocol";
import type { ComponentChildren } from "preact";
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
  IconPlay,
  IconSend,
  IconShield,
  IconSliders,
  IconZap,
} from "../icons.js";
import { agents, getApi, projects } from "../state.js";
import { explain } from "./Brain.js";
import { MailboxNeed, useMailboxes } from "./EmailSettings.js";
import { Acts, Chips, Seg, SwitchRow } from "./SettingsKit.js";
import { Advanced, Field } from "./ui.js";

// --- When it runs on a schedule, in words (G24.8): the choices people make, and their cron ------

export type When =
  | { kind: "daily" | "weekdays"; time: string }
  | { kind: "weekly"; time: string; days: number[] }
  | { kind: "hours"; every: number }
  | { kind: "monthly"; time: string; day: number }
  | { kind: "webhook" }
  /** On events of a project's repository (G24.14c): its webhook is added by RedGiant. */
  | { kind: "repo"; project: string; events: string[] }
  /** On new email in the person's mailbox that matches (G24.14c). */
  | { kind: "email"; from: string; subject: string }
  | { kind: "custom"; cron: string }
  /** Every few minutes (G33.3). */
  | { kind: "minutes"; every: number }
  /** Once, at a date and time (G33.3). */
  | { kind: "once"; at: string };

const pad = (n: number) => String(n).padStart(2, "0");
const hm = (time: string) => {
  const [h = "8", m = "0"] = time.split(":");
  return { h: Number(h), m: Number(m) };
};

/** The cron expression of a choice (null: no schedule). */
export function toCron(w: When): string | null {
  if (w.kind === "webhook" || w.kind === "repo" || w.kind === "email" || w.kind === "once")
    return null;
  if (w.kind === "custom") return w.cron;
  if (w.kind === "hours") return `0 */${Math.max(1, Math.min(23, w.every))} * * *`;
  if (w.kind === "minutes") return `*/${Math.max(1, Math.min(59, w.every))} * * * *`;
  const { h, m } = hm(w.time);
  if (w.kind === "daily") return `${m} ${h} * * *`;
  if (w.kind === "weekdays") return `${m} ${h} * * 1-5`;
  if (w.kind === "monthly") return `${m} ${h} ${w.day} * *`;
  if (w.kind === "weekly") return `${m} ${h} * * ${[...w.days].sort().join(",") || "1"}`;
  return `${m} ${h} * * *`;
}

/** The choice a recipe's `on` came from: repository events and email first, then the cron. */
export function fromOn(on: Recipe["on"], project: string | null): When {
  if (on.email)
    return { kind: "email", from: on.email.from ?? "", subject: on.email.subject ?? "" };
  if (on.events && !on.cron) return { kind: "repo", project: project ?? "", events: on.events };
  if (on.at) return { kind: "once", at: on.at };
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
  const everyMin = m?.match(/^\*\/(\d+)$/);
  if (f.length === 5 && everyMin && h === "*" && dom === "*" && mon === "*" && dow === "*")
    return { kind: "minutes", every: Number(everyMin[1]) };
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

export const DAYS = [1, 2, 3, 4, 5, 6, 0];
export const dayName = (d: number) => t(`day_${d}` as never);

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
    case "minutes":
      return t("axWhenMinutes", { n: String(w.every) });
    case "monthly":
      return t("whenMonthly", { day: String(w.day), time: w.time });
    case "once":
      return t("whenAt", { at: w.at ? new Date(w.at).toLocaleString() : "" });
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

// --- The draft: everything the person can choose, and the recipe it becomes ---------------------

/** What can start an automation (one or more of them). */
export const STARTS = [
  "time",
  "email",
  "message",
  "files",
  "repo",
  "after",
  "task",
  "startup",
  "webhook",
] as const;
export type Start = (typeof STARTS)[number];

export const PLATFORMS = ["telegram", "whatsapp", "discord", "slack", "signal"] as const;
export const PLATFORM_NAMES: Record<string, string> = {
  telegram: "Telegram",
  whatsapp: "WhatsApp",
  discord: "Discord",
  slack: "Slack",
  signal: "Signal",
};
const REPO_EVENTS = ["push", "pull_request", "issues", "issue_comment", "release"] as const;
const SCHEDULES = ["daily", "weekdays", "weekly", "monthly", "hours", "minutes", "once"] as const;
type Schedule = (typeof SCHEDULES)[number] | "custom";

export interface Draft {
  title: string;
  starts: Start[];
  time: When;
  email: {
    from: string;
    subject: string;
    text: string;
    scope: "all" | "categories" | "boxes";
    categories: string[];
    boxes: string[];
  };
  message: { platforms: string[]; from: string; chat: string; words: string; handle: boolean };
  files: { project: string; path: string; pattern: string; changes: string[] };
  repo: { project: string; events: string[] };
  after: { automation: string; status: string[] };
  task: { project: string; outcome: string[] };
  only: {
    hours: boolean;
    from: string;
    to: string;
    days: number[] | null;
    dates: boolean;
    dateFrom: string;
    dateTo: string;
    senders: string;
    words: string;
    match: "any" | "all";
    without: string;
    maxPerDay: number;
    cooldown: number;
  };
  does: "agent" | "reminder";
  whoKey: string;
  instructions: string;
  reminder: string;
  session: "new" | "continue";
  approve: boolean;
  budget: number;
  timeout: number;
  notifyWhen: "always" | "failure" | "never";
  notifyTo: string[];
  notifyEmail: string;
  notifyBox: string;
  retries: number;
  retryMinutes: number;
  fallback: string;
  overlap: "skip" | "queue";
  missed: "skip" | "run";
  model: string;
  effort: string;
  /** Kept from the recipe as it was. */
  timezone: string | undefined;
}

const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const words = (s: string) =>
  s
    .split(",")
    .map((w) => w.trim())
    .filter(Boolean);
const tomorrowAt = (time: string) => {
  const d = new Date(Date.now() + 86_400_000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${time}`;
};

/** A new draft (or the one a template starts from). */
export function blankDraft(over: Partial<Draft> = {}): Draft {
  return {
    title: "",
    starts: ["time"],
    time: { kind: "daily", time: "09:00" },
    email: { from: "", subject: "", text: "", scope: "all", categories: [], boxes: [] },
    message: { platforms: [], from: "", chat: "", words: "", handle: false },
    files: { project: projects.value[0]?.id ?? "", path: ".", pattern: "", changes: [] },
    repo: { project: projects.value[0]?.id ?? "", events: ["pull_request"] },
    after: { automation: "", status: [] },
    task: { project: "", outcome: [] },
    only: {
      hours: false,
      from: "09:00",
      to: "18:00",
      days: null,
      dates: false,
      dateFrom: "",
      dateTo: "",
      senders: "",
      words: "",
      match: "any",
      without: "",
      maxPerDay: 0,
      cooldown: 0,
    },
    does: "agent",
    whoKey: "god",
    instructions: "",
    reminder: "",
    session: "new",
    approve: false,
    budget: 0,
    timeout: 30,
    notifyWhen: "always",
    notifyTo: [],
    notifyEmail: "",
    notifyBox: "",
    retries: 0,
    retryMinutes: 5,
    fallback: "",
    overlap: "skip",
    missed: "skip",
    model: "",
    effort: "",
    timezone: undefined,
    ...over,
  };
}

/** Who can be asked: God, the personal assistants, each project's lead, the project agents. */
export function whoOptions(): {
  key: string;
  label: string;
  agent: string;
  project: string | null;
}[] {
  const out: { key: string; label: string; agent: string; project: string | null }[] = [];
  const god = agents.value.find((a) => a.kind === "god");
  if (god) out.push({ key: "god", label: god.name, agent: "god", project: null });
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

/** The key of the agent a recipe names, among the options. */
function whoKeyOf(r: Recipe): string {
  if (r.agent === "god") return "god";
  if (r.agent === "orchestrator") return `o:${r.project}`;
  return (
    whoOptions().find((x) => x.agent === r.agent && x.project === r.project)?.key ??
    whoOptions().find((x) => x.agent === r.agent)?.key ??
    "god"
  );
}

/** The draft a saved (or proposed) recipe becomes. Nothing it says is lost. */
export function fromRecipe(r: Recipe): Draft {
  const on = r.on;
  const starts: Start[] = [];
  if (on.cron || on.at) starts.push("time");
  if (on.email) starts.push("email");
  if (on.message) starts.push("message");
  if (on.files) starts.push("files");
  if (on.events) starts.push("repo");
  if (on.after) starts.push("after");
  if (on.task) starts.push("task");
  if (on.startup) starts.push("startup");
  if (on.webhook && !on.events) starts.push("webhook");
  const only = r.only;
  const b = blankDraft();
  return blankDraft({
    title: r.description || r.name,
    starts,
    time: on.at ? { kind: "once", at: on.at } : on.cron ? fromCron(on.cron, false) : b.time,
    email: {
      from: on.email?.from ?? "",
      subject: on.email?.subject ?? "",
      text: on.email?.text ?? "",
      scope: on.email?.boxes ? "boxes" : on.email?.categories ? "categories" : "all",
      categories: on.email?.categories ?? [],
      boxes: on.email?.boxes ?? [],
    },
    message: {
      platforms: on.message?.platforms ?? [],
      from: on.message?.from ?? "",
      chat: on.message?.chat ?? "",
      words: (on.message?.words ?? []).join(", "),
      handle: on.message?.handle ?? false,
    },
    files: {
      project: on.files?.project ?? r.project ?? b.files.project,
      path: on.files?.path ?? ".",
      pattern: on.files?.pattern ?? "",
      changes: on.files?.changes ?? [],
    },
    repo: { project: r.project ?? b.repo.project, events: on.events ?? b.repo.events },
    after: { automation: on.after?.automation ?? "", status: on.after?.status ?? [] },
    task: { project: on.task?.project ?? "", outcome: on.task?.outcome ?? [] },
    only: {
      hours: !!only?.hours,
      from: only?.hours?.from ?? "09:00",
      to: only?.hours?.to ?? "18:00",
      days: only?.days ?? null,
      dates: !!only?.dates,
      dateFrom: only?.dates?.from ?? "",
      dateTo: only?.dates?.to ?? "",
      senders: (only?.from ?? []).join(", "),
      words: (only?.words ?? []).join(", "),
      match: only?.match ?? "any",
      without: (only?.without ?? []).join(", "),
      maxPerDay: only?.maxPerDay ?? 0,
      cooldown: only?.cooldownMinutes ?? 0,
    },
    does: r.reminder !== undefined ? "reminder" : "agent",
    whoKey: whoKeyOf(r),
    instructions: r.instructions ?? "",
    reminder: r.reminder ?? "",
    session: r.session,
    approve: r.approve ?? false,
    budget: r.budgetUsd ?? 0,
    timeout: r.timeoutMinutes,
    notifyWhen: r.notify.when,
    notifyTo: r.notify.to ?? [],
    notifyEmail: r.notify.email ?? "",
    notifyBox: r.notify.box ?? "",
    retries: r.onFailure?.retries ?? 0,
    retryMinutes: r.onFailure?.retryMinutes ?? 5,
    fallback: r.onFailure?.run ?? "",
    overlap: r.overlap ?? "skip",
    missed: r.missed,
    model: r.model ?? "",
    effort: r.effort ?? "",
    timezone: on.timezone,
  });
}

/** A value in YAML: strings quoted as JSON (YAML reads it), lists inline. */
function yamlLines(obj: Record<string, unknown>, indent = 0): string[] {
  const out: string[] = [];
  const sp = "  ".repeat(indent);
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const inner = yamlLines(v as Record<string, unknown>, indent + 1);
      out.push(inner.length ? `${sp}${k}:` : `${sp}${k}: {}`, ...inner);
    } else out.push(`${sp}${k}: ${JSON.stringify(v)}`);
  }
  return out;
}

const some = <T,>(list: T[]) => (list.length > 0 ? list : undefined);
const set = (n: number) => (n > 0 ? n : undefined);

/** The recipe a draft becomes, as YAML. */
export function toYaml(d: Draft, name: string): string {
  const who = whoOptions().find((x) => x.key === d.whoKey) ?? {
    agent: "god",
    project: null,
  };
  const has = (s: Start) => d.starts.includes(s);
  const cron = has("time") ? toCron(d.time) : null;
  const at = has("time") && d.time.kind === "once" ? d.time.at : undefined;
  // The project a recipe needs: its agent's, or the one its repository or files are in.
  const project = who.project ?? (has("repo") ? d.repo.project || null : null);
  const needsZone = cron || at || d.only.hours || d.only.days || d.only.dates || d.only.maxPerDay;
  const on: Record<string, unknown> = {
    ...(cron && { cron }),
    ...(at && { at }),
    ...(needsZone && { timezone: d.timezone ?? tz() }),
    ...((has("webhook") || has("repo")) && { webhook: true }),
    ...(has("repo") && { events: d.repo.events.length ? d.repo.events : ["push"] }),
    ...(has("email") && {
      email: {
        from: d.email.from.trim() || undefined,
        subject: d.email.subject.trim() || undefined,
        text: d.email.text.trim() || undefined,
        boxes: d.email.scope === "boxes" ? some(d.email.boxes) : undefined,
        categories: d.email.scope === "categories" ? some(d.email.categories) : undefined,
      },
    }),
    ...(has("message") && {
      message: {
        platforms: some(d.message.platforms),
        from: d.message.from.trim() || undefined,
        chat: d.message.chat.trim() || undefined,
        words: some(words(d.message.words)),
        handle: d.message.handle || undefined,
      },
    }),
    ...(has("files") && {
      files: {
        project: d.files.project && d.files.project !== project ? d.files.project : undefined,
        path: d.files.path.trim() || ".",
        pattern: d.files.pattern.trim() || undefined,
        changes: some(d.files.changes),
      },
    }),
    ...(has("after") && {
      after: { automation: d.after.automation, status: some(d.after.status) },
    }),
    ...(has("task") && {
      task: { project: d.task.project || undefined, outcome: some(d.task.outcome) },
    }),
    ...(has("startup") && { startup: true }),
  };
  const o = d.only;
  const only = {
    hours: o.hours ? { from: o.from, to: o.to } : undefined,
    days: o.days?.length ? [...o.days].sort() : undefined,
    dates:
      o.dates && (o.dateFrom || o.dateTo)
        ? { from: o.dateFrom || undefined, to: o.dateTo || undefined }
        : undefined,
    from: some(words(o.senders)),
    words: some(words(o.words)),
    match: o.match === "all" && words(o.words).length ? "all" : undefined,
    without: some(words(o.without)),
    maxPerDay: set(o.maxPerDay),
    cooldownMinutes: set(o.cooldown),
  };
  const hasOnly = Object.values(only).some((v) => v !== undefined);
  const notify = {
    when: d.notifyWhen === "always" ? undefined : d.notifyWhen,
    to: some(d.notifyTo),
    email: d.notifyTo.includes("email") && d.notifyEmail.trim() ? d.notifyEmail.trim() : undefined,
    box: d.notifyTo.includes("email") && d.notifyBox ? d.notifyBox : undefined,
  };
  const onFailure = {
    retries: set(d.retries),
    retryMinutes: d.retries > 0 && d.retryMinutes !== 5 ? d.retryMinutes : undefined,
    run: d.fallback || undefined,
  };
  const reminder = d.does === "reminder";
  return `${yamlLines({
    name,
    description: d.title.trim(),
    on,
    only: hasOnly ? only : undefined,
    agent: reminder ? undefined : who.agent,
    project: project ?? undefined,
    model: !reminder && d.model.trim() ? d.model.trim() : undefined,
    effort: !reminder && d.effort ? d.effort : undefined,
    instructions: reminder ? undefined : d.instructions.trim(),
    reminder: reminder ? d.reminder.trim() : undefined,
    session: !reminder && d.session === "continue" ? "continue" : undefined,
    approve: d.approve || undefined,
    budgetUsd: !reminder && d.budget > 0 ? d.budget : undefined,
    timeoutMinutes: d.timeout !== 30 ? d.timeout : undefined,
    overlap: d.overlap === "queue" ? "queue" : undefined,
    missed: d.missed === "run" && !at ? "run" : undefined,
    onFailure: Object.values(onFailure).some((v) => v !== undefined) ? onFailure : undefined,
    notify: Object.values(notify).some((v) => v !== undefined) ? notify : undefined,
  }).join("\n")}\n`;
}

const list = (xs: string[]) => xs.join(", ");
const cut = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** The automation in words, as it stands: what starts it, only if, what it does, where it tells. */
export function sentence(d: Draft, others: Automation[] = []): string[] {
  const out: string[] = [];
  const parts: string[] = [];
  for (const s of d.starts) {
    if (s === "time") parts.push(whenWords(d.time));
    if (s === "email")
      parts.push(
        t("axSayEmail", {
          filter:
            [
              d.email.from && `${t("emailFrom")} ${d.email.from}`,
              d.email.subject && `«${d.email.subject}»`,
            ]
              .filter(Boolean)
              .join(" · ") || t("emailAny"),
        }),
      );
    if (s === "message")
      parts.push(
        t("axSayMessage", {
          where: d.message.platforms.length
            ? list(d.message.platforms.map((p) => PLATFORM_NAMES[p] ?? p))
            : t("axAnyChat"),
        }) + (d.message.words ? ` ${t("axSayWith", { words: d.message.words })}` : ""),
      );
    if (s === "files")
      parts.push(
        !d.files.path || d.files.path === "."
          ? t("axSayFilesAll")
          : t("axSayFiles", { path: d.files.path }),
      );
    if (s === "repo") parts.push(t("whenRepo", { events: d.repo.events.join(", ") }));
    if (s === "after")
      parts.push(
        t("axSayAfter", {
          name:
            others.find((a) => a.name === d.after.automation)?.recipe.description ||
            d.after.automation ||
            "…",
        }),
      );
    if (s === "task") parts.push(t("axSayTask"));
    if (s === "startup") parts.push(t("axSayStartup"));
    if (s === "webhook") parts.push(t("whenWebhook"));
  }
  // "Every day at 8 or when an email arrives": the parts after the first in lower case.
  const lowered = parts.map((x, i) => (i === 0 ? x : x.charAt(0).toLowerCase() + x.slice(1)));
  out.push(lowered.length ? `${lowered.join(` ${t("axOr")} `)}.` : t("axSayNever"));
  const o = d.only;
  const conds: string[] = [];
  if (o.hours) conds.push(t("axSayHours", { from: o.from, to: o.to }));
  if (o.days?.length) conds.push(t("axSayDays", { days: list(o.days.map(dayName)) }));
  if (o.dates && (o.dateFrom || o.dateTo))
    conds.push(t("axSayDates", { from: o.dateFrom || "…", to: o.dateTo || "…" }));
  if (o.senders) conds.push(t("axSayFrom", { from: o.senders }));
  if (o.words)
    conds.push(t(o.match === "all" ? "axSayWordsAll" : "axSayWordsAny", { words: o.words }));
  if (o.without) conds.push(t("axSayWithout", { words: o.without }));
  if (o.maxPerDay > 0) conds.push(t("axSayMax", { n: String(o.maxPerDay) }));
  if (o.cooldown > 0) conds.push(t("axSayCooldown", { n: String(o.cooldown) }));
  if (conds.length) out.push(`${t("axSayOnly")} ${conds.join(", ")}.`);
  const who = whoOptions().find((x) => x.key === d.whoKey)?.label ?? "God";
  if (d.does === "reminder") out.push(t("axSayReminder", { text: cut(d.reminder.trim() || "…") }));
  else out.push(t("axSayDoes", { who, what: cut(d.instructions.trim() || "…") }));
  if (d.approve) out.push(t("axSayApprove"));
  if (d.does === "agent" && d.budget > 0) out.push(t("axSayBudget", { usd: d.budget.toFixed(2) }));
  if (d.notifyWhen === "never") out.push(t("axSayQuiet"));
  else {
    const where = d.notifyTo.length
      ? list(
          d.notifyTo.map((x) =>
            x === "web" ? t("axToWeb") : x === "email" ? t("axToEmail") : (PLATFORM_NAMES[x] ?? x),
          ),
        )
      : t("axToAllChats");
    out.push(t(d.notifyWhen === "failure" ? "axSayTellFailure" : "axSayTell", { where }));
  }
  return out;
}

// --- Templates -------------------------------------------------------------------------------

const TEMPLATES = ["morning", "weekly", "spending"] as const;
type Template = (typeof TEMPLATES)[number] | "blank";
const templateWhen: Record<(typeof TEMPLATES)[number], When> = {
  morning: { kind: "weekdays", time: "08:00" },
  weekly: { kind: "weekly", time: "17:00", days: [5] },
  spending: { kind: "monthly", time: "09:00", day: 1 },
};

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "automation";

const value = (e: Event) => (e.target as HTMLInputElement).value;
const num = (e: Event, min = 0) => Math.max(min, Number(value(e)) || 0);

/** One part of the editor: a numbered head, a line of help, the choices. */
function Part({
  n,
  icon,
  title,
  help,
  children,
}: {
  n: number;
  icon: ComponentChildren;
  title: string;
  help: string;
  children: ComponentChildren;
}) {
  return (
    <section class="ax-part">
      <div class="ax-part-head">
        <span class="ax-part-n">{n}</span>
        <span class="ax-part-ico">{icon}</span>
        <span class="ax-part-t">
          <b>{title}</b>
          <small>{help}</small>
        </span>
      </div>
      <div class="ax-part-body">{children}</div>
    </section>
  );
}

/** A condition that opens its fields when switched on. */
function Cond({
  title,
  help,
  on,
  onChange,
  children,
}: {
  title: string;
  help?: string;
  on: boolean;
  onChange: (on: boolean) => void;
  children?: ComponentChildren;
}) {
  return (
    <div class={`ax-cond${on ? " on" : ""}`}>
      <SwitchRow title={title} help={help} on={on} onChange={onChange} />
      {on && children && <div class="ax-cond-body">{children}</div>}
    </div>
  );
}

/** The kind of schedule, keeping the time already written. */
function scheduleOf(kind: Schedule, current: When): When {
  const time = "time" in current ? current.time : "08:00";
  if (kind === "weekly") return { kind, time, days: [5] };
  if (kind === "monthly") return { kind, time, day: 1 };
  if (kind === "hours") return { kind, every: 3 };
  if (kind === "minutes") return { kind, every: 15 };
  if (kind === "once") return { kind, at: tomorrowAt(time) };
  if (kind === "custom") return { kind, cron: toCron(current) ?? "0 9 * * *" };
  return { kind, time };
}

/** The schedule: how often, then only what that needs. */
function TimeDetail({ when, onChange }: { when: When; onChange: (w: When) => void }) {
  return (
    <div class="aw-when">
      <Chips<Schedule>
        options={[
          ...SCHEDULES.map((k) => ({
            id: k as Schedule,
            label: k === "minutes" || k === "once" ? t(`axKind_${k}`) : t(`whenKind_${k}`),
          })),
          { id: "custom", label: t("axKind_custom") },
        ]}
        value={[when.kind as Schedule]}
        onChange={([k]) => k && onChange(scheduleOf(k, when))}
      />
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
              onInput={(e) => onChange({ ...when, day: Math.min(28, num(e, 1)) })}
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
              onInput={(e) => onChange({ ...when, every: Math.min(23, num(e, 1)) })}
            />
          </Field>
        )}
        {when.kind === "minutes" && (
          <Field label={t("axEveryMinutes")}>
            <input
              class="wz-field"
              type="number"
              min={1}
              max={59}
              value={when.every}
              onInput={(e) => onChange({ ...when, every: Math.min(59, num(e, 1)) })}
            />
          </Field>
        )}
        {when.kind === "once" && (
          <Field label={t("axOnceAt")}>
            <input
              class="wz-field"
              type="datetime-local"
              value={when.at}
              onInput={(e) => onChange({ ...when, at: value(e) })}
            />
          </Field>
        )}
        {when.kind === "custom" && (
          <Field label={t("axCron")} help={t("axCronHelp")}>
            <input
              class="wz-field mono"
              value={when.cron}
              onInput={(e) => onChange({ ...when, cron: value(e) })}
            />
          </Field>
        )}
      </div>
      {when.kind === "weekly" && (
        <Chips<number>
          multiple
          options={DAYS.map((d) => ({ id: d, label: dayName(d) }))}
          value={when.days}
          onChange={(days) => onChange({ ...when, days })}
        />
      )}
    </div>
  );
}

/** Every automation's draft and its saving. */
function useDraft(
  current: Automation | undefined,
  seed: Recipe | undefined,
  preset: string | undefined,
) {
  const start = seed ?? current?.recipe;
  const [tpl, setTpl] = useState<Template>(start ? "blank" : "morning");
  const [d, setD] = useState<Draft>(() =>
    start
      ? fromRecipe(start)
      : blankDraft({
          title: t("tplTitle_morning"),
          time: templateWhen.morning,
          instructions: t("tplText_morning"),
          whoKey: preset ?? "god",
        }),
  );
  const up = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const pickTemplate = (x: Template) => {
    setTpl(x);
    if (x === "blank") {
      up({ title: "", instructions: "", starts: ["time"], time: { kind: "daily", time: "09:00" } });
      return;
    }
    up({
      title: t(`tplTitle_${x}`),
      instructions: t(`tplText_${x}`),
      starts: ["time"],
      time: templateWhen[x],
    });
  };
  const [name] = useState(
    () => current?.name ?? seed?.name ?? `${slug(d.title)}-${Date.now().toString(36).slice(-4)}`,
  );
  return { d, up, setD, tpl, pickTemplate, name };
}

/** The next times and the server's reading of the recipe, a moment after each change. */
function usePreview(yaml: string): { next: string[]; error: string | null } | undefined {
  const [p, setP] = useState<{ next: string[]; error: string | null }>();
  useEffect(() => {
    const timer = setTimeout(() => {
      void getApi()
        .previewAutomation(yaml, 5)
        .then(
          (r) =>
            setP(r && Array.isArray(r.next) ? { next: r.next, error: r.error ?? null } : undefined),
          () => setP(undefined),
        );
    }, 450);
    return () => clearTimeout(timer);
  }, [yaml]);
  return p;
}

/**
 * Making or changing an automation in a window. The Automations page, an assistant's routines
 * (with `who` chosen beforehand) and a magic automation's proposal (`seed`, with `submit` to
 * approve it) all use it.
 */
export function Editor({
  current,
  onSaved,
  onCancel,
  who: preset,
  seed,
  submit,
  submitLabel,
}: {
  current: Automation | undefined;
  onSaved: (a: Automation, secret?: string) => void;
  onCancel: () => void;
  /** Who does it, chosen beforehand (an assistant's own routine). */
  who?: string;
  /** A recipe to start from (a magic automation's proposal). */
  seed?: Recipe;
  /** Instead of saving: what the button does with the YAML (approve a proposal). */
  submit?: (yaml: string) => Promise<{ automation: Automation; webhookSecret?: string }>;
  submitLabel?: string;
}) {
  const { d, up, tpl, pickTemplate, name } = useDraft(current, seed, preset);
  const who = whoOptions();
  const mail = useMailboxes();
  const [others, setOthers] = useState<Automation[]>([]);
  useEffect(() => {
    void getApi()
      .automations()
      .then(
        (l) => setOthers(Array.isArray(l) ? l.filter((a) => a.id !== current?.id) : []),
        () => {},
      );
  }, []);
  const [yaml, setYaml] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const generated = toYaml(d, name);
  const text = yaml ?? generated;
  const preview = usePreview(text);
  const has = (s: Start) => d.starts.includes(s);
  const o = d.only;
  const setOnly = (patch: Partial<Draft["only"]>) => up({ only: { ...o, ...patch } });

  const save = async () => {
    setError(undefined);
    setBusy(true);
    try {
      const res = submit
        ? await submit(text)
        : current
          ? await getApi().updateAutomation(current.id, text)
          : await getApi().createAutomation(text);
      // A routine on repository events: its webhook goes on Gitea or GitHub now, with the
      // secret that is shown only this once (G24.14c).
      if (has("repo") && res.webhookSecret)
        await getApi().repoHook(res.automation.id, res.webhookSecret, d.repo.project);
      onSaved(res.automation, res.webhookSecret);
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusy(false);
    }
  };
  const ready =
    yaml !== null ||
    (d.title.trim() !== "" &&
      d.starts.length > 0 &&
      (d.does === "agent" ? d.instructions.trim() !== "" : d.reminder.trim() !== ""));
  const said = sentence(d, others);

  return (
    <form
      class="aw-editor ax-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {!current && !seed && (
        <>
          <span class="wz-lb">{t("autoStart")}</span>
          <div class="wz-opt aw-tpl">
            {[...TEMPLATES, "blank" as const].map((x) => (
              <button
                key={x}
                type="button"
                class={tpl === x ? "on" : ""}
                aria-pressed={tpl === x}
                onClick={() => pickTemplate(x)}
              >
                <b>{t(`tplTitle_${x}`)}</b>
                <small>{t(`tplDesc_${x}`)}</small>
              </button>
            ))}
          </div>
        </>
      )}
      <Field label={t("autoTitle")} help={t("autoTitleHelp")}>
        <input class="wz-field" value={d.title} onInput={(e) => up({ title: value(e) })} />
      </Field>

      {/* What it says, live: the person reads the automation as a sentence. */}
      <div class="ax-says" aria-live="polite">
        <span class="ax-says-ico">
          <IconZap size={20} />
        </span>
        <div class="ax-says-lines">
          {said.map((line, i) => (
            <p key={String(i)} class={i === 0 ? "first" : ""}>
              {line}
            </p>
          ))}
        </div>
      </div>

      <Part n={1} icon={<IconClock size={18} />} title={t("axWhen")} help={t("axWhenHelp")}>
        <Chips<Start>
          multiple
          options={STARTS.map((s) => ({
            id: s,
            label:
              s === "email"
                ? t("whenKind_email")
                : s === "repo"
                  ? t("whenKind_repo")
                  : s === "webhook"
                    ? t("whenKind_webhook")
                    : t(`axStart_${s}`),
          }))}
          value={d.starts}
          onChange={(starts) => up({ starts })}
        />
        {has("time") && (
          <div class="ax-detail">
            <span class="ax-detail-t">
              <IconClock size={16} /> {t("axStart_time")}
            </span>
            <TimeDetail when={d.time} onChange={(time) => up({ time })} />
          </div>
        )}
        {has("email") && (
          <div class="ax-detail">
            <span class="ax-detail-t">
              <IconSend size={16} /> {t("whenKind_email")}
            </span>
            <div class="aw-when-row">
              <Field label={t("emailFrom")}>
                <input
                  class="wz-field"
                  placeholder={t("emailFromPlaceholder")}
                  value={d.email.from}
                  onInput={(e) => up({ email: { ...d.email, from: value(e) } })}
                />
              </Field>
              <Field label={t("emailSubject")}>
                <input
                  class="wz-field"
                  placeholder={t("emailSubjectPlaceholder")}
                  value={d.email.subject}
                  onInput={(e) => up({ email: { ...d.email, subject: value(e) } })}
                />
              </Field>
              <Field label={t("axEmailText")}>
                <input
                  class="wz-field"
                  placeholder={t("axEmailTextPlaceholder")}
                  value={d.email.text}
                  onInput={(e) => up({ email: { ...d.email, text: value(e) } })}
                />
              </Field>
            </div>
            {mail.boxes.length > 1 && (
              <>
                <span class="wz-lb">{t("axEmailWhich")}</span>
                <Seg<Draft["email"]["scope"]>
                  value={d.email.scope}
                  options={[
                    ["all", t("axEmailAll")],
                    ["categories", t("axEmailByCategory")],
                    ["boxes", t("axEmailByBox")],
                  ]}
                  onChange={(scope) => up({ email: { ...d.email, scope } })}
                />
                {d.email.scope === "categories" && (
                  <Chips<string>
                    multiple
                    options={[...new Set(mail.boxes.map((b) => b.category))].map((c) => ({
                      id: c,
                      label: categoryLabel(c),
                    }))}
                    value={d.email.categories}
                    onChange={(categories) => up({ email: { ...d.email, categories } })}
                  />
                )}
                {d.email.scope === "boxes" && (
                  <Chips<string>
                    multiple
                    options={mail.boxes.map((b) => ({ id: b.id, label: b.name }))}
                    value={d.email.boxes}
                    onChange={(boxes) => up({ email: { ...d.email, boxes } })}
                  />
                )}
              </>
            )}
            <MailboxNeed />
            <p class="ui-help">{t("whenEmailHelp")}</p>
          </div>
        )}
        {has("message") && (
          <div class="ax-detail">
            <span class="ax-detail-t">
              <IconChat size={16} /> {t("axStart_message")}
            </span>
            <span class="wz-lb">{t("axMessageWhere")}</span>
            <Chips<string>
              multiple
              options={PLATFORMS.map((p) => ({ id: p, label: PLATFORM_NAMES[p] ?? p }))}
              value={d.message.platforms}
              onChange={(platforms) => up({ message: { ...d.message, platforms } })}
            />
            <div class="aw-when-row">
              <Field label={t("axMessageFrom")} help={t("axMessageFromHelp")}>
                <input
                  class="wz-field"
                  value={d.message.from}
                  onInput={(e) => up({ message: { ...d.message, from: value(e) } })}
                />
              </Field>
              <Field label={t("axMessageWords")} help={t("axWordsHelp")}>
                <input
                  class="wz-field"
                  placeholder={t("axMessageWordsPlaceholder")}
                  value={d.message.words}
                  onInput={(e) => up({ message: { ...d.message, words: value(e) } })}
                />
              </Field>
              <Field label={t("axMessageChat")} help={t("axMessageChatHelp")}>
                <input
                  class="wz-field"
                  value={d.message.chat}
                  onInput={(e) => up({ message: { ...d.message, chat: value(e) } })}
                />
              </Field>
            </div>
            <SwitchRow
              title={t("axMessageHandle")}
              help={t("axMessageHandleHelp")}
              on={d.message.handle}
              onChange={(handle) => up({ message: { ...d.message, handle } })}
            />
          </div>
        )}
        {has("files") && (
          <div class="ax-detail">
            <span class="ax-detail-t">
              <IconFolder size={16} /> {t("axStart_files")}
            </span>
            <div class="aw-when-row">
              <Field label={t("projects")}>
                <select
                  class="wz-field"
                  value={d.files.project}
                  onChange={(e) => up({ files: { ...d.files, project: value(e) } })}
                >
                  {projects.value.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t("axFilesPath")} help={t("axFilesPathHelp")}>
                <input
                  class="wz-field"
                  value={d.files.path}
                  onInput={(e) => up({ files: { ...d.files, path: value(e) } })}
                />
              </Field>
              <Field label={t("axFilesPattern")} help={t("axFilesPatternHelp")}>
                <input
                  class="wz-field"
                  placeholder="*.pdf"
                  value={d.files.pattern}
                  onInput={(e) => up({ files: { ...d.files, pattern: value(e) } })}
                />
              </Field>
            </div>
            <Chips<string>
              multiple
              options={["added", "changed", "removed"].map((c) => ({
                id: c,
                label: t(`axFiles_${c}` as never),
              }))}
              value={d.files.changes}
              onChange={(changes) => up({ files: { ...d.files, changes } })}
            />
            {projects.value.length === 0 && <p class="ui-help">{t("axFilesProjectHelp")}</p>}
          </div>
        )}
        {has("repo") && (
          <div class="ax-detail">
            <span class="ax-detail-t">
              <IconGit size={16} /> {t("whenKind_repo")}
            </span>
            <Field label={t("projects")}>
              <select
                class="wz-field"
                value={d.repo.project}
                onChange={(e) => up({ repo: { ...d.repo, project: value(e) } })}
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
              value={d.repo.events}
              onChange={(events) => up({ repo: { ...d.repo, events } })}
            />
            <p class="ui-help">{t("whenRepoHelp")}</p>
          </div>
        )}
        {has("after") && (
          <div class="ax-detail">
            <span class="ax-detail-t">
              <IconLayers size={16} /> {t("axStart_after")}
            </span>
            <Field label={t("axAfterWhich")}>
              <select
                class="wz-field"
                value={d.after.automation}
                onChange={(e) => up({ after: { ...d.after, automation: value(e) } })}
              >
                <option value="">{t("axPick")}</option>
                {others.map((a) => (
                  <option key={a.id} value={a.name}>
                    {a.recipe.description || a.name}
                  </option>
                ))}
              </select>
            </Field>
            <Chips<string>
              multiple
              options={["ok", "failed", "timeout"].map((s) => ({
                id: s,
                label: t(`axAfter_${s}` as never),
              }))}
              value={d.after.status}
              onChange={(status) => up({ after: { ...d.after, status } })}
            />
          </div>
        )}
        {has("task") && (
          <div class="ax-detail">
            <span class="ax-detail-t">
              <IconPlay size={16} /> {t("axStart_task")}
            </span>
            <Field label={t("projects")}>
              <select
                class="wz-field"
                value={d.task.project}
                onChange={(e) => up({ task: { ...d.task, project: value(e) } })}
              >
                <option value="">{t("axAnyProject")}</option>
                {projects.value.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Chips<string>
              multiple
              options={["verified", "not_testable", "abandoned"].map((s) => ({
                id: s,
                label: t(`axTask_${s}` as never),
              }))}
              value={d.task.outcome}
              onChange={(outcome) => up({ task: { ...d.task, outcome } })}
            />
          </div>
        )}
        {has("webhook") && <p class="ui-help">{t("whenWebhookHelp")}</p>}
        {has("startup") && <p class="ui-help">{t("axStartupHelp")}</p>}
        {preview &&
          !preview.error &&
          preview.next.length === 0 &&
          has("time") &&
          d.time.kind !== "once" && (
            <div class="ax-next bad">
              <span>{t("axNextNone")}</span>
            </div>
          )}
        {preview && (preview.next.length > 0 || preview.error) && (
          <div class={`ax-next${preview.error ? " bad" : ""}`}>
            {preview.error ? (
              <span>
                {t("axServerSays")} {preview.error}
              </span>
            ) : (
              <>
                <span class="ax-next-t">{t("axNextTimes")}</span>
                <ol>
                  {preview.next.map((n) => (
                    <li key={n}>
                      {new Date(n).toLocaleString(undefined, {
                        weekday: "short",
                        day: "numeric",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </li>
                  ))}
                </ol>
              </>
            )}
          </div>
        )}
      </Part>

      <Part n={2} icon={<IconSliders size={18} />} title={t("axOnly")} help={t("axOnlyHelp")}>
        <div class="ax-conds">
          <Cond title={t("axCondHours")} on={o.hours} onChange={(hours) => setOnly({ hours })}>
            <div class="aw-when-row">
              <Field label={t("axFrom")}>
                <input
                  class="wz-field"
                  type="time"
                  value={o.from}
                  onInput={(e) => setOnly({ from: value(e) })}
                />
              </Field>
              <Field label={t("axTo")}>
                <input
                  class="wz-field"
                  type="time"
                  value={o.to}
                  onInput={(e) => setOnly({ to: value(e) })}
                />
              </Field>
            </div>
            <div class="ax-quick">
              <button
                type="button"
                class="wz-chip"
                onClick={() => setOnly({ from: "09:00", to: "18:00", days: [1, 2, 3, 4, 5] })}
              >
                {t("axWorkHours")}
              </button>
              <button
                type="button"
                class="wz-chip"
                onClick={() => setOnly({ from: "22:00", to: "07:00" })}
              >
                {t("axNightHours")}
              </button>
            </div>
          </Cond>
          <Cond
            title={t("axCondDays")}
            on={o.days !== null}
            onChange={(on) => setOnly({ days: on ? [1, 2, 3, 4, 5] : null })}
          >
            <Chips<number>
              multiple
              options={DAYS.map((x) => ({ id: x, label: dayName(x) }))}
              value={o.days ?? []}
              onChange={(days) => setOnly({ days })}
            />
          </Cond>
          <Cond title={t("axCondDates")} on={o.dates} onChange={(dates) => setOnly({ dates })}>
            <div class="aw-when-row">
              <Field label={t("axFromDay")}>
                <input
                  class="wz-field"
                  type="date"
                  value={o.dateFrom}
                  onInput={(e) => setOnly({ dateFrom: value(e) })}
                />
              </Field>
              <Field label={t("axToDay")}>
                <input
                  class="wz-field"
                  type="date"
                  value={o.dateTo}
                  onInput={(e) => setOnly({ dateTo: value(e) })}
                />
              </Field>
            </div>
          </Cond>
          <Cond
            title={t("axCondFrom")}
            help={t("axCondFromHelp")}
            on={o.senders !== ""}
            onChange={(on) => setOnly({ senders: on ? " " : "" })}
          >
            <Field label={t("axSenders")} help={t("axWordsHelp")}>
              <input
                class="wz-field"
                value={o.senders.trim()}
                placeholder={t("axSendersPlaceholder")}
                onInput={(e) => setOnly({ senders: value(e) || " " })}
              />
            </Field>
          </Cond>
          <Cond
            title={t("axCondWords")}
            on={o.words !== ""}
            onChange={(on) => setOnly({ words: on ? " " : "" })}
          >
            <Field label={t("axWords")} help={t("axWordsHelp")}>
              <input
                class="wz-field"
                value={o.words.trim()}
                placeholder={t("axWordsPlaceholder")}
                onInput={(e) => setOnly({ words: value(e) || " " })}
              />
            </Field>
            <Seg<"any" | "all">
              value={o.match}
              options={[
                ["any", t("axMatchAny")],
                ["all", t("axMatchAll")],
              ]}
              onChange={(match) => setOnly({ match })}
            />
          </Cond>
          <Cond
            title={t("axCondWithout")}
            on={o.without !== ""}
            onChange={(on) => setOnly({ without: on ? " " : "" })}
          >
            <Field label={t("axWithout")} help={t("axWordsHelp")}>
              <input
                class="wz-field"
                value={o.without.trim()}
                placeholder={t("axWithoutPlaceholder")}
                onInput={(e) => setOnly({ without: value(e) || " " })}
              />
            </Field>
          </Cond>
          <Cond
            title={t("axCondMax")}
            on={o.maxPerDay > 0}
            onChange={(on) => setOnly({ maxPerDay: on ? 3 : 0 })}
          >
            <Field label={t("axMaxPerDay")}>
              <input
                class="wz-field"
                type="number"
                min={1}
                value={o.maxPerDay}
                onInput={(e) => setOnly({ maxPerDay: num(e, 1) })}
              />
            </Field>
          </Cond>
          <Cond
            title={t("axCondCooldown")}
            on={o.cooldown > 0}
            onChange={(on) => setOnly({ cooldown: on ? 30 : 0 })}
          >
            <Field label={t("axCooldown")}>
              <input
                class="wz-field"
                type="number"
                min={1}
                value={o.cooldown}
                onInput={(e) => setOnly({ cooldown: num(e, 1) })}
              />
            </Field>
          </Cond>
        </div>
      </Part>

      <Part n={3} icon={<IconZap size={18} />} title={t("axDoes")} help={t("axDoesHelp")}>
        <Seg<Draft["does"]>
          value={d.does}
          options={[
            ["agent", t("axDoesAgent")],
            ["reminder", t("axDoesReminder")],
          ]}
          onChange={(does) => up({ does })}
        />
        {d.does === "agent" ? (
          <>
            <Field label={t("autoWho")} help={t("autoWhoHelp")}>
              <select class="wz-field" value={d.whoKey} onChange={(e) => up({ whoKey: value(e) })}>
                {who.map((x) => (
                  <option key={x.key} value={x.key}>
                    {x.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("autoWhat")} help={t("autoWhatHelp")}>
              <textarea
                class="wz-field"
                rows={5}
                value={d.instructions}
                onInput={(e) => up({ instructions: value(e) })}
              />
            </Field>
            <span class="wz-lb">{t("axSession")}</span>
            <Seg<Draft["session"]>
              value={d.session}
              options={[
                ["new", t("axSessionNew")],
                ["continue", t("axSessionContinue")],
              ]}
              onChange={(session) => up({ session })}
            />
          </>
        ) : (
          <Field label={t("reminderWhat")}>
            <textarea
              class="wz-field"
              rows={3}
              value={d.reminder}
              onInput={(e) => up({ reminder: value(e) })}
            />
          </Field>
        )}
        <div class="ax-conds">
          <Cond
            title={t("axApprove")}
            help={t("axApproveHelp")}
            on={d.approve}
            onChange={(approve) => up({ approve })}
          />
          {d.does === "agent" && (
            <Cond
              title={t("axBudget")}
              help={t("axBudgetHelp")}
              on={d.budget > 0}
              onChange={(on) => up({ budget: on ? 0.5 : 0 })}
            >
              <Field label={t("axBudgetUsd")}>
                <input
                  class="wz-field"
                  type="number"
                  min={0.01}
                  step={0.01}
                  value={d.budget}
                  onInput={(e) => up({ budget: Math.max(0.01, Number(value(e)) || 0.01) })}
                />
              </Field>
            </Cond>
          )}
        </div>
      </Part>

      <Part n={4} icon={<IconBell size={18} />} title={t("axTell")} help={t("axTellHelp")}>
        <Seg<Draft["notifyWhen"]>
          value={d.notifyWhen}
          options={[
            ["always", t("axTellAlways")],
            ["failure", t("axTellFailure")],
            ["never", t("axTellNever")],
          ]}
          onChange={(notifyWhen) => up({ notifyWhen })}
        />
        {d.notifyWhen !== "never" && (
          <>
            <span class="wz-lb">{t("axTellWhere")}</span>
            <Chips<string>
              multiple
              options={[
                ...PLATFORMS.map((p) => ({ id: p, label: PLATFORM_NAMES[p] ?? p })),
                { id: "web", label: t("axToWeb") },
                { id: "email", label: t("axToEmail") },
              ]}
              value={d.notifyTo}
              onChange={(notifyTo) => up({ notifyTo })}
            />
            <p class="ui-help">
              {d.notifyTo.length === 0
                ? t("axTellAllHelp")
                : has("message") &&
                    !d.notifyTo.some((x) => (PLATFORMS as readonly string[]).includes(x))
                  ? t("axTellReplyHelp")
                  : t("axTellSomeHelp")}
            </p>
            {d.notifyTo.includes("email") && (
              <div class="aw-when-row">
                <Field label={t("axTellEmailTo")} help={t("axTellEmailToHelp")}>
                  <input
                    class="wz-field"
                    type="email"
                    value={d.notifyEmail}
                    onInput={(e) => up({ notifyEmail: value(e) })}
                  />
                </Field>
                {mail.boxes.length > 0 && (
                  <Field label={t("axTellEmailFrom")}>
                    <select
                      class="wz-field"
                      value={d.notifyBox}
                      onChange={(e) => up({ notifyBox: value(e) })}
                    >
                      <option value="">{t("axFirstBox")}</option>
                      {mail.boxes.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
              </div>
            )}
          </>
        )}
      </Part>

      <Advanced label={t("axAdvanced")}>
        <div class="ax-adv">
          <span class="ax-detail-t">
            <IconShield size={16} /> {t("axIfFails")}
          </span>
          <div class="aw-when-row">
            <Field label={t("axRetries")}>
              <input
                class="wz-field"
                type="number"
                min={0}
                max={5}
                value={d.retries}
                onInput={(e) => up({ retries: Math.min(5, num(e)) })}
              />
            </Field>
            {d.retries > 0 && (
              <Field label={t("axRetryMinutes")}>
                <input
                  class="wz-field"
                  type="number"
                  min={1}
                  value={d.retryMinutes}
                  onInput={(e) => up({ retryMinutes: num(e, 1) })}
                />
              </Field>
            )}
            <Field label={t("axFallback")}>
              <select
                class="wz-field"
                value={d.fallback}
                onChange={(e) => up({ fallback: value(e) })}
              >
                <option value="">{t("axNone")}</option>
                {others.map((a) => (
                  <option key={a.id} value={a.name}>
                    {a.recipe.description || a.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <span class="wz-lb">{t("axOverlap")}</span>
          <Seg<Draft["overlap"]>
            value={d.overlap}
            options={[
              ["skip", t("axOverlapSkip")],
              ["queue", t("axOverlapQueue")],
            ]}
            onChange={(overlap) => up({ overlap })}
          />
          {has("time") && d.time.kind !== "once" && (
            <>
              <span class="wz-lb">{t("axMissed")}</span>
              <Seg<Draft["missed"]>
                value={d.missed}
                options={[
                  ["skip", t("axMissedSkip")],
                  ["run", t("axMissedRun")],
                ]}
                onChange={(missed) => up({ missed })}
              />
            </>
          )}
          <div class="aw-when-row">
            <Field label={t("axTimeout")}>
              <input
                class="wz-field"
                type="number"
                min={1}
                max={1440}
                value={d.timeout}
                onInput={(e) => up({ timeout: Math.min(1440, num(e, 1)) })}
              />
            </Field>
            {d.does === "agent" && (
              <>
                <Field label={t("axModel")} help={t("axModelHelp")}>
                  <input
                    class="wz-field mono"
                    placeholder="provider/model"
                    value={d.model}
                    onInput={(e) => up({ model: value(e) })}
                  />
                </Field>
                <Field label={t("axEffort")}>
                  <select
                    class="wz-field"
                    value={d.effort}
                    onChange={(e) => up({ effort: value(e) })}
                  >
                    <option value="">{t("axAgentOwn")}</option>
                    {["low", "medium", "high", "xhigh", "max"].map((x) => (
                      <option key={x} value={x}>
                        {x}
                      </option>
                    ))}
                  </select>
                </Field>
              </>
            )}
          </div>
          <span class="ax-detail-t">
            <IconGlobe size={16} /> {t("autoYaml")}
          </span>
          <p class="ui-help">{t("autoYamlHint")}</p>
          <textarea
            class="wz-field mono aw-yaml"
            spellcheck={false}
            rows={12}
            value={text}
            onInput={(e) => setYaml(value(e))}
          />
          {yaml !== null && (
            <button type="button" class="wz-link inl" onClick={() => setYaml(null)}>
              {t("axYamlBack")}
            </button>
          )}
        </div>
      </Advanced>
      {error && <p class="notice error">{error}</p>}
      <Acts>
        <button type="button" class="wz-btn quiet" onClick={onCancel}>
          {t("cancel")}
        </button>
        <button type="submit" class="wz-btn primary" disabled={busy || !ready}>
          {submitLabel ?? (current ? t("save") : t("create"))}
        </button>
      </Acts>
    </form>
  );
}

/** A mailbox category in words (the default ones translated, the person's own as written). */
export function categoryLabel(c: string): string {
  return ["work", "personal", "social", "other"].includes(c) ? t(`axCat_${c}` as never) : c;
}
