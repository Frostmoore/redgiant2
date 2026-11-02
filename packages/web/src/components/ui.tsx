// The pieces every screen is built from (G24.1), so that each one reads the same way:
// a step says what it is for and can be skipped, a field explains itself, a switch has its
// words next to it, a long action shows its steps and progress, and errors say what to do.
import type { Job, JobProgress } from "@redgiant/protocol";
import type { ComponentChildren, JSX } from "preact";
import { useEffect, useId, useState } from "preact/hooks";
import qrcode from "qrcode-generator";
import { bytes } from "../format.js";
import { t, tOptional } from "../i18n.js";
import { IconAlert, IconCheck, IconChevron, IconSpinner, IconX } from "../icons.js";
import { attempt, getApi } from "../state.js";

/** One screen of a guided flow: a title, one sentence on what it is for, an optional skip. */
export function Step({
  title,
  purpose,
  children,
  onSkip,
  skipLabel,
}: {
  title: string;
  purpose: string;
  children: ComponentChildren;
  onSkip?: () => void;
  skipLabel?: string;
}) {
  return (
    <section class="ui-step">
      <h2>{title}</h2>
      <p class="ui-purpose">{purpose}</p>
      <div class="ui-step-body">{children}</div>
      {onSkip && (
        <div class="ui-step-skip">
          <button type="button" class="link" onClick={onSkip}>
            {skipLabel ?? t("uiSkip")}
          </button>
        </div>
      )}
    </section>
  );
}

/** A labelled control with a line of help under it, and the error when there is one. */
export function Field({
  label,
  help,
  error,
  children,
}: {
  label: string;
  help?: string | undefined;
  error?: string | undefined;
  children: ComponentChildren;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control comes in as children.
    <label class={`ui-field${error ? " invalid" : ""}`}>
      <span class="ui-label">{label}</span>
      {children}
      {help && !error && <span class="ui-help">{help}</span>}
      {error && (
        <span class="ui-error" role="alert">
          <IconAlert size={13} /> {error}
        </span>
      )}
    </label>
  );
}

/** An on/off switch with its name and a line of explanation on the same row. */
export function Toggle({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description?: string | undefined;
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean | undefined;
}) {
  const id = useId();
  return (
    <div class={`ui-toggle${disabled ? " disabled" : ""}`}>
      <div class="ui-toggle-text">
        <label for={id} class="ui-toggle-label">
          {label}
        </label>
        {description && <span class="ui-help">{description}</span>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        class={`ui-switch${checked ? " on" : ""}`}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
    </div>
  );
}

export interface ChoiceOption<T extends string> {
  id: T;
  title: string;
  description: string;
  icon?: JSX.Element;
  /** A small word on the card ("Recommended"). */
  badge?: string;
}

/** Big cards to pick from: one, or several when `multiple`. */
export function Choice<T extends string>({
  options,
  value,
  onChange,
  multiple,
}: {
  options: ChoiceOption<T>[];
  value: T[];
  onChange: (value: T[]) => void;
  multiple?: boolean;
}) {
  return (
    <div class="ui-choice" role={multiple ? "group" : "radiogroup"}>
      {options.map((o) => {
        const on = value.includes(o.id);
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={on}
            class={`ui-card${on ? " on" : ""}`}
            onClick={() =>
              onChange(
                multiple ? (on ? value.filter((v) => v !== o.id) : [...value, o.id]) : [o.id],
              )
            }
          >
            <span class="ui-card-head">
              {o.icon}
              <strong>{o.title}</strong>
              {o.badge && <span class="chip ok">{o.badge}</span>}
              <span class="ui-card-mark">{on && <IconCheck size={14} />}</span>
            </span>
            <span class="ui-help">{o.description}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Seconds left, in words: "less than a minute", "about 4 min", "about 1 h 20 min". */
export function timeLeft(seconds: number): string {
  if (seconds < 60) return t("uiLessThanMinute");
  const min = Math.round(seconds / 60);
  if (min < 60) return t("uiAboutMinutes", { min: String(min) });
  return t("uiAboutHours", { h: String(Math.floor(min / 60)), min: String(min % 60) });
}

/** What a progress says in words: amounts, speed and time left (bytes, or plain counts). */
export function progressText(p: JobProgress, unit: "bytes" | "count" = "bytes"): string {
  const amount = (n: number) => (unit === "bytes" ? bytes(n) : String(Math.round(n)));
  const parts = [
    p.total !== null ? t("uiOf", { done: amount(p.done), total: amount(p.total) }) : amount(p.done),
  ];
  if (p.rate !== null)
    parts.push(unit === "bytes" ? `${bytes(p.rate)}/s` : `${p.rate.toFixed(1)}/s`);
  if (p.secondsLeft !== null && p.total !== null && p.done < p.total)
    parts.push(timeLeft(p.secondsLeft));
  return parts.join(" · ");
}

/** A real progress bar with its words; without a total it moves without filling. */
export function Progress({
  progress,
  unit = "bytes",
}: {
  progress: JobProgress;
  unit?: "bytes" | "count";
}) {
  const pct =
    progress.total && progress.total > 0
      ? Math.min(100, Math.round((progress.done / progress.total) * 100))
      : null;
  return (
    <div class="ui-progress">
      <div
        class={`ui-bar${pct === null ? " busy" : ""}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
      >
        <span style={pct === null ? undefined : { width: `${pct}%` }} />
      </div>
      <span class="ui-help">
        {pct !== null && `${pct}% · `}
        {progressText(progress, unit)}
      </span>
    </div>
  );
}

/** Options for experts, closed until opened. */
export function Advanced({ label, children }: { label?: string; children: ComponentChildren }) {
  return (
    <details class="ui-advanced">
      <summary>
        <IconChevron open={false} size={13} /> {label ?? t("uiAdvanced")}
      </summary>
      <div class="ui-advanced-body">{children}</div>
    </details>
  );
}

/** Follows a job until it ends (polls once a second); undefined until the first answer. */
export function useJob(id: string | undefined): Job | undefined {
  const [job, setJob] = useState<Job>();
  useEffect(() => {
    setJob(undefined);
    if (!id) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const j = await getApi()
        .job(id)
        .catch(() => undefined);
      if (stop) return;
      if (j) setJob(j);
      if (!j || j.state === "running") timer = setTimeout(() => void tick(), 1000);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [id]);
  return job;
}

const STEP_ICONS = {
  waiting: <span class="ui-dot" />,
  running: <IconSpinner size={14} />,
  done: <IconCheck size={14} />,
  failed: <IconX size={14} />,
  skipped: <IconCheck size={14} />,
} as const;

/**
 * A long action as people see it: its steps with what is happening now, the progress of the
 * running step, and at the end "done" or the error in plain words with the details below.
 */
export function JobView({ job, cancellable }: { job: Job; cancellable?: boolean }) {
  return (
    <div class={`ui-job ${job.state}`} aria-live="polite">
      <strong>{tOptional(`job_${job.kind}`, job.vars) ?? job.kind}</strong>
      <ol class="ui-job-steps">
        {job.steps.map((s) => (
          <li key={s.id} class={s.state}>
            <span class="ui-job-icon">{STEP_ICONS[s.state]}</span>
            <span>
              {tOptional(`job_step_${s.id}`, job.vars) ?? s.id}
              {s.state === "skipped" && <span class="dim"> · {t("uiNotNeeded")}</span>}
              {s.progress && <Progress progress={s.progress} />}
            </span>
          </li>
        ))}
      </ol>
      {job.state === "done" && (
        <p class="notice ok">
          <IconCheck size={14} /> {t("uiDone")}
        </p>
      )}
      {job.state === "cancelled" && <p class="notice">{t("uiCancelled")}</p>}
      {job.state === "failed" && job.error && (
        <div class="ui-job-error">
          <p class="notice error">
            <IconAlert size={14} />{" "}
            {(job.error.code && tOptional(`job_error_${job.error.code}`, job.vars)) ??
              t("uiFailedGeneric")}
          </p>
          <Advanced label={t("uiDetails")}>
            <pre>{job.error.message}</pre>
          </Advanced>
        </div>
      )}
      {cancellable && job.state === "running" && (
        <button
          type="button"
          class="link"
          onClick={() => void attempt(() => getApi().cancelJob(job.id))}
        >
          {t("cancel")}
        </button>
      )}
    </div>
  );
}

/** The QR code of an address, drawn here as SVG (no service sees the address). */
export function Qr({ text, label }: { text: string; label: string }) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return (
    <div
      class="qr"
      role="img"
      aria-label={label}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: SVG made here from our own address.
      dangerouslySetInnerHTML={{
        __html: qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true }),
      }}
    />
  );
}
