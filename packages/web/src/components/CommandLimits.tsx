// Settings > Commands (G36.16, the person: «i comandi in background devono poter essere infiniti»):
// how many background commands at once in a conversation, how long one runs, how big its log
// grows, how long an ordinary command may wait, and how many model calls one turn may make
// (G36.15). Each a row of chips; "No limit" is always
// there, with a plain warning (never a block). Saved as configuration: in the history, undoable.
import type { CommandSettings } from "@redgiant/protocol";
import { useEffect, useState } from "preact/hooks";
import type { PlatformChange } from "../api.js";
import { t } from "../i18n.js";
import { getApi } from "../state.js";
import { explain } from "./Brain.js";
import { Box, Chips, Head, Row, Sub, WzPage } from "./SettingsKit.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const MB = 1024 * 1024;
const NONE = "none";

/** A choice's id: the number as text, or "none" for no limit. */
const id = (v: number | null) => (v === null ? NONE : String(v));
const value = (s: string) => (s === NONE ? null : Number(s));

/** A span of time in words ("10 min", "6 h", "7 days"). */
export function spanWords(ms: number): string {
  if (ms % (24 * HOUR) === 0) {
    const d = ms / (24 * HOUR);
    return d === 1 ? t("cmdOneDay") : t("cmdDays", { n: String(d) });
  }
  if (ms === HOUR) return t("cmdOneHour");
  if (ms % HOUR === 0) return t("cmdHours", { n: String(ms / HOUR) });
  return t("cmdMinutes", { n: String(Math.round(ms / MIN)) });
}

/** The ready choices, and the saved value too when it is not one of them. */
function options(ready: (number | null)[], now: number | null, label: (v: number) => string) {
  const all = ready.includes(now) ? ready : [...ready, now];
  return all.map((v) => ({ id: id(v), label: v === null ? t("cmdNoLimit") : label(v) }));
}

export function CommandLimits() {
  const [s, setS] = useState<CommandSettings>();
  const [defaults, setDefaults] = useState<CommandSettings>();
  const [serverTurns, setServerTurns] = useState(50);
  const [saved, setSaved] = useState<PlatformChange | "undone">();
  const [error, setError] = useState<string>();
  const load = () =>
    getApi()
      .commandSettings()
      .then((r) => {
        setS(r.settings);
        setDefaults(r.defaults);
        setServerTurns(r.serverMaxTurns ?? 50);
      })
      .catch((err) => setError(explain(err)));
  useEffect(() => void load(), []);
  if (!s)
    return (
      <WzPage>
        <Head q={t("cmdPageQ")} lead={t("cmdPageLead")} />
        {error ? <p class="notice error">{error}</p> : <p class="dim">{t("loading")}</p>}
      </WzPage>
    );
  const change = (next: Partial<CommandSettings>) => {
    setSaved(undefined);
    setS({ ...s, ...next });
  };
  const save = async (v: CommandSettings) => {
    setError(undefined);
    try {
      setSaved(await getApi().setCommandSettings(v));
      setS(v);
    } catch (err) {
      setError(explain(err));
    }
  };
  const undo = async () => {
    if (!saved || saved === "undone") return;
    try {
      await getApi().undoChange(saved.id);
      setSaved("undone");
      await load();
    } catch (err) {
      setError(explain(err));
    }
  };
  const mb = (v: number) => (v >= 1024 * MB ? "1 GB" : `${Math.round(v / MB)} MB`);
  return (
    <WzPage class="cmd-limits">
      <Head q={t("cmdPageQ")} lead={t("cmdPageLead")} />
      <Sub title={t("cmdBgTitle")} lead={t("cmdBgLead")} />
      <Box>
        <Row title={t("cmdAtOnce")} help={t("cmdAtOnceHelp")}>
          <Chips
            options={options([2, 4, 8, 16, null], s.maxPerSession, String)}
            value={[id(s.maxPerSession)]}
            onChange={([v]) => change({ maxPerSession: value(v ?? "4") })}
          />
        </Row>
        {s.maxPerSession === null && <p class="cl-warn">{t("cmdAtOnceWarn")}</p>}
        <Row title={t("cmdLong")} help={t("cmdLongHelp")}>
          <Chips
            options={options(
              [10 * MIN, HOUR, 6 * HOUR, 24 * HOUR, 7 * 24 * HOUR, null],
              s.maxMs,
              spanWords,
            )}
            value={[id(s.maxMs)]}
            onChange={([v]) => change({ maxMs: value(v ?? String(24 * HOUR)) })}
          />
        </Row>
        {s.maxMs === null && <p class="cl-warn">{t("cmdLongWarn")}</p>}
        <Row title={t("cmdLog")} help={t("cmdLogHelp")}>
          <Chips
            options={options([MB, 8 * MB, 64 * MB, 512 * MB, null], s.maxLogBytes, mb)}
            value={[id(s.maxLogBytes)]}
            onChange={([v]) => change({ maxLogBytes: value(v ?? String(8 * MB)) })}
          />
        </Row>
        {s.maxLogBytes === null && <p class="cl-warn">{t("cmdLogWarn")}</p>}
      </Box>
      <Sub title={t("cmdBashTitle")} lead={t("cmdBashLead")} />
      <Box>
        <Row title={t("cmdBash")} help={t("cmdBashHelp")}>
          <Chips
            options={options([2 * MIN, 10 * MIN, 30 * MIN, HOUR, 2 * HOUR], s.bashMaxMs, spanWords)}
            value={[String(s.bashMaxMs)]}
            onChange={([v]) => change({ bashMaxMs: Number(v ?? 10 * MIN) })}
          />
        </Row>
      </Box>
      <Sub title={t("cmdStepsTitle")} lead={t("cmdStepsLead")} />
      <Box>
        <Row title={t("cmdSteps")} help={t("cmdStepsHelp")}>
          <Chips
            options={[
              { id: "default", label: t("cmdStepsDefault", { n: String(serverTurns) }) },
              ...options(
                [25, 100, 200, 500, null].filter((n) => n !== serverTurns),
                s.maxTurns === undefined || s.maxTurns === serverTurns ? 25 : s.maxTurns,
                String,
              ),
            ]}
            value={[
              s.maxTurns === undefined || s.maxTurns === serverTurns ? "default" : id(s.maxTurns),
            ]}
            onChange={([v]) => {
              const { maxTurns: _old, ...rest } = s;
              setSaved(undefined);
              setS(v === "default" || v === undefined ? rest : { ...rest, maxTurns: value(v) });
            }}
          />
        </Row>
        {s.maxTurns === null && <p class="cl-warn">{t("cmdStepsWarn")}</p>}
      </Box>
      {error && <p class="notice error">{error}</p>}
      <div class="cl-acts">
        <button type="button" class="wz-btn primary" onClick={() => void save(s)}>
          {t("save")}
        </button>
        {defaults && (
          <button type="button" class="wz-btn quiet" onClick={() => void save(defaults)}>
            {t("cmdDefaults")}
          </button>
        )}
        {saved && saved !== "undone" && (
          <span class="cl-saved">
            {t("cmdSaved")}{" "}
            <button type="button" class="wz-link inl" onClick={() => void undo()}>
              {t("cmdUndo")}
            </button>
          </span>
        )}
        {saved === "undone" && <span class="cl-saved">{t("cmdUndone")}</span>}
      </div>
    </WzPage>
  );
}
