// The background commands of a conversation (p3.3.1, as Officina's strip, but collapsible): the
// running ones always in view, with their start, a running time, «Output» and «Stop» (no
// confirmation); the finished ones in one line «N finished», opened on demand, with «Remove all
// finished». The whole strip shrinks to one line and remembers it. Closed stays closed: the
// log records it, for every device.
import { useComputed } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import { duration } from "../format.js";
import { t } from "../i18n.js";
import { IconChevron, IconClose, IconStop, IconTerminal } from "../icons.js";
import {
  type CommandRow,
  commandRows,
  commandStripMin,
  getApi,
  getLive,
  sessionView,
  setCommandStripMin,
} from "../state.js";
import { Modal } from "./ui.js";

/** 15:03:12, the same on every system (the log's own clock). */
const hm = (iso: string) => {
  const d = new Date(iso);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
};
const short = (c: string) => (c.length > 80 ? `${c.slice(0, 77)}...` : c);

/** Ticks once a second while something runs. */
function useNow(on: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

export function CommandStrip({ sessionId }: { sessionId: string }) {
  const view = sessionView(sessionId);
  const rows = useComputed(() => commandRows(view.value.events).filter((r) => !r.closed));
  const [showDone, setShowDone] = useState(false);
  const [output, setOutput] = useState<CommandRow | null>(null);
  const running = rows.value.filter((r) => r.status === "running");
  const done = rows.value.filter((r) => r.status !== "running");
  const now = useNow(running.length > 0);
  if (rows.value.length === 0) return null;
  const min = commandStripMin.value;
  const stop = (r: CommandRow) => getLive().send({ type: "command.stop", sessionId, id: r.id });
  const close = (r: CommandRow) => getLive().send({ type: "command.close", sessionId, id: r.id });
  const summary = [
    running.length ? t("cmdRunningN", { n: String(running.length) }) : "",
    done.length ? t("cmdDoneN", { n: String(done.length) }) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <section class={`cmd-strip ${min ? "min" : ""}`} aria-label={t("cmdStrip")}>
      <button
        type="button"
        class="cmd-head"
        aria-expanded={!min}
        title={min ? t("cmdOpenStrip") : t("cmdShrinkStrip")}
        onClick={() => setCommandStripMin(!min)}
      >
        <IconTerminal size={13} />
        <span class={`cmd-dot ${running.length ? "running" : "done"}`} />
        <span>{summary}</span>
        <span class="spacer" />
        <IconChevron open={!min} size={13} />
      </button>
      {!min && (
        <>
          {running.map((r) => (
            <div class="cmd-row" key={r.id}>
              <span class="cmd-dot running" />
              <code class="cmd-text" title={r.command}>
                {short(r.command)}
              </code>
              <span class="cmd-time dim" title={`${t("cmdStartedAt", { at: hm(r.startedAt) })}`}>
                {hm(r.startedAt)} · {duration(now - Date.parse(r.startedAt))}
              </span>
              <button type="button" class="link" onClick={() => setOutput(r)}>
                {t("cmdOutput")}
              </button>
              <button type="button" class="cmd-stop" onClick={() => stop(r)}>
                <IconStop size={11} />
                {t("cmdStop")}
              </button>
            </div>
          ))}
          {done.length > 0 && (
            <div class="cmd-done-line">
              <button
                type="button"
                class="link cmd-done-toggle"
                aria-expanded={showDone}
                onClick={() => setShowDone((x) => !x)}
              >
                <IconChevron open={showDone} size={12} />
                {t("cmdFinishedN", { n: String(done.length) })}
              </button>
              <span class="spacer" />
              <button type="button" class="link" onClick={() => done.forEach(close)}>
                {t("cmdRemoveFinished")}
              </button>
            </div>
          )}
          {showDone &&
            done.map((r) => (
              <div class="cmd-row done" key={r.id}>
                <span class={`cmd-dot ${r.status}`} />
                <code class="cmd-text" title={r.command}>
                  {short(r.command)}
                </code>
                <span class="cmd-time dim">
                  {hm(r.startedAt)}
                  {r.endedAt && ` · ${duration(Date.parse(r.endedAt) - Date.parse(r.startedAt))}`}
                  {` · ${t(`cmdStatus_${r.status}`, { code: String(r.exitCode ?? "-") })}`}
                </span>
                <button type="button" class="link" onClick={() => setOutput(r)}>
                  {t("cmdOutput")}
                </button>
                <button
                  type="button"
                  class="cmd-x"
                  title={t("cmdRemove")}
                  aria-label={t("cmdRemove")}
                  onClick={() => close(r)}
                >
                  <IconClose size={11} />
                </button>
              </div>
            ))}
        </>
      )}
      {output && (
        <CommandOutput
          sessionId={sessionId}
          row={rows.value.find((r) => r.id === output.id) ?? output}
          onClose={() => setOutput(null)}
          onStop={() => stop(output)}
        />
      )}
    </section>
  );
}

type Line = { n: number; clock: string; at: number; stream: "out" | "err"; text: string };

/** A command's whole log, live while it runs; every line's time on request. */
function CommandOutput({
  sessionId,
  row,
  onClose,
  onStop,
}: {
  sessionId: string;
  row: CommandRow;
  onClose: () => void;
  onStop: () => void;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [head, setHead] = useState<{ folder?: string; by?: string; started?: string }>({});
  const [times, setTimes] = useState(false);
  const [missing, setMissing] = useState(false);
  const box = useRef<HTMLPreElement>(null);
  const last = useRef(0);
  useEffect(() => {
    let live = true;
    const pull = async () => {
      const r = await getApi()
        .commandOutput(sessionId, row.id, last.current ? last.current + 1 : undefined)
        .catch(() => undefined);
      if (!live) return;
      if (!r) {
        setMissing(true);
        return;
      }
      setHead(r.log);
      if (r.lines.length) {
        last.current = r.lines.at(-1)?.n ?? last.current;
        setLines((l) => [...l, ...r.lines].slice(-5000));
      }
    };
    void pull();
    const timer = row.status === "running" ? setInterval(() => void pull(), 2000) : undefined;
    return () => {
      live = false;
      if (timer) clearInterval(timer);
    };
  }, [row.id, row.status]);
  useEffect(() => {
    const el = box.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  });
  return (
    <Modal title={t("cmdOutputTitle")} onClose={onClose}>
      <div class="cmd-output">
        <code class="cmd-output-cmd">{row.command}</code>
        <dl class="cmd-output-meta">
          <dt>{t("cmdStarted")}</dt>
          <dd>{head.started ?? new Date(row.startedAt).toLocaleString()}</dd>
          {row.endedAt && (
            <>
              <dt>{t("cmdEnded")}</dt>
              <dd>
                {new Date(row.endedAt).toLocaleString()} ·{" "}
                {t(`cmdStatus_${row.status}`, { code: String(row.exitCode ?? "-") })}
              </dd>
            </>
          )}
          <dt>{t("cmdFolder")}</dt>
          <dd>{head.folder ?? row.cwd}</dd>
          <dt>{t("cmdBy")}</dt>
          <dd>{head.by ?? row.by}</dd>
        </dl>
        <div class="cmd-output-bar">
          <button
            type="button"
            class={`cmd-switch ${times ? "on" : ""}`}
            aria-pressed={times}
            onClick={() => setTimes((x) => !x)}
          >
            <span class="cmd-switch-knob" />
            {t("cmdShowTimes")}
          </button>
          <span class="dim">{t("cmdLines", { n: String(lines.length) })}</span>
          <span class="spacer" />
          {row.status === "running" && (
            <button type="button" class="cmd-stop" onClick={onStop}>
              <IconStop size={11} />
              {t("cmdStop")}
            </button>
          )}
        </div>
        <pre class="cmd-output-lines" ref={box}>
          {missing && <span class="dim">{t("cmdNoLog")}</span>}
          {lines.map((l) => (
            <div key={l.n} class={`cmd-line ${l.stream}`}>
              {times && (
                <span class="cmd-line-time">
                  {l.clock} +{l.at.toFixed(1)}s{" "}
                </span>
              )}
              {l.text || " "}
            </div>
          ))}
        </pre>
      </div>
    </Modal>
  );
}
