// Spending in plain words (G24.10), drawn as the wizard (2026-11-06): this month's total big and
// centred with its days, then everything, each project and each agent as big boxes, lit when they
// have a limit; a box opens a window (a sheet from below on phones) with the wizard's amounts.
// Limits count everything spent since they were set. `LimitEditor` stays for the agents' page.
import { useEffect, useState } from "preact/hooks";
import type { Budget } from "../api.js";
import { kTokens, monthDays, usd } from "../format.js";
import { lang, t } from "../i18n.js";
import { agents, attempt, budgets, getApi, projects } from "../state.js";
import { num } from "../wizard.js";
import { Acts, BoxButton, Head, Sub, WzPage } from "./SettingsKit.js";
import { Modal } from "./ui.js";

type Daily = { day: string; scope: Budget["scope"]; id: string; usd: number; tokens: number };

export function LimitEditor({ row, onSaved }: { row: Budget; onSaved: () => void }) {
  const [value, setValue] = useState(row.limit.usd !== undefined ? String(row.limit.usd) : "");
  const [editing, setEditing] = useState(false);
  const save = async (usdLimit: number | undefined) => {
    const ok = await attempt(() =>
      getApi().setBudget({
        scope: row.scope,
        id: row.id,
        ...(usdLimit !== undefined && { usd: usdLimit }),
      }),
    );
    if (ok !== undefined) {
      setEditing(false);
      onSaved();
    }
  };
  if (!editing)
    return (
      <span class="budget-limit">
        <span>
          {row.limit.usd !== undefined
            ? usd(row.limit.usd)
            : row.limit.tokens !== undefined
              ? `${kTokens(row.limit.tokens)} token`
              : t("chgNoLimit")}
        </span>
        <button type="button" class="tiny" onClick={() => setEditing(true)}>
          {t("budgetChange")}
        </button>
      </span>
    );
  const n = Number(value.replace(",", "."));
  return (
    <form
      class="budget-limit"
      onSubmit={(e) => {
        e.preventDefault();
        if (Number.isFinite(n) && n > 0) void save(n);
      }}
    >
      <span class="budget-dollar">$</span>
      <input
        inputMode="decimal"
        aria-label={t("limit")}
        value={value}
        onInput={(e) => setValue((e.target as HTMLInputElement).value)}
      />
      <button type="submit" class="tiny primary" disabled={!(Number.isFinite(n) && n > 0)}>
        {t("save")}
      </button>
      {(row.limit.usd !== undefined || row.limit.tokens !== undefined) && (
        <button type="button" class="tiny" onClick={() => void save(undefined)}>
          {t("budgetRemoveLimit")}
        </button>
      )}
      <button type="button" class="tiny" onClick={() => setEditing(false)}>
        {t("cancel")}
      </button>
    </form>
  );
}

const limitText = (row: Budget) =>
  row.limit.usd !== undefined
    ? usd(row.limit.usd)
    : row.limit.tokens !== undefined
      ? `${kTokens(row.limit.tokens)} token`
      : t("chgNoLimit");

/** One box: what it spent this month and since the start, its limit and how far it got. */
function Row({
  row,
  name,
  month,
  onOpen,
}: {
  row: Budget;
  name: string;
  month: number;
  onOpen: () => void;
}) {
  const limit = row.limit.usd;
  const has = limit !== undefined || row.limit.tokens !== undefined;
  const pct = limit ? Math.min(100, (row.used.usd / limit) * 100) : 0;
  const over = limit !== undefined && row.used.usd >= limit;
  return (
    <BoxButton
      on={has}
      warn={over}
      title={name}
      pill={has ? t("sbLimitIs", { limit: limitText(row) }) : t("chgNoLimit")}
      onClick={onOpen}
    >
      <span class="sb-box-p">
        {t("budgetMonth", { usd: usd(month) })} · {t("budgetEver", { usd: usd(row.used.usd) })}
      </span>
      {limit !== undefined && (
        <span class="sb-meter" title={`${Math.round(pct)}%`}>
          <span style={{ width: `${pct}%` }} />
        </span>
      )}
      {over ? (
        <span class="sb-box-warn">{t("budgetStopped")}</span>
      ) : (
        <span class="wz-state">{t("mpChange")}</span>
      )}
    </BoxButton>
  );
}

const AMOUNTS = ["5", "20", "50", "100"] as const;

/** The window of one box: the wizard's amounts or another one, or no limit. */
function LimitWindow({
  row,
  name,
  onClose,
}: {
  row: Budget;
  name: string;
  onClose: (saved: boolean) => void;
}) {
  const [value, setValue] = useState(row.limit.usd !== undefined ? String(row.limit.usd) : "");
  const [busy, setBusy] = useState(false);
  const n = Number(value.replace(",", "."));
  const valid = value.trim() !== "" && Number.isFinite(n) && n > 0;
  const has = row.limit.usd !== undefined || row.limit.tokens !== undefined;
  const save = async (usdLimit: number | undefined) => {
    setBusy(true);
    const ok = await attempt(() =>
      getApi().setBudget({
        scope: row.scope,
        id: row.id,
        ...(usdLimit !== undefined && { usd: usdLimit }),
      }),
    );
    setBusy(false);
    if (ok !== undefined) onClose(true);
  };
  return (
    <Modal title={t("sbLimitFor", { name })} onClose={() => onClose(false)}>
      <div class="wz-panel-in">
        <p class="wz-lead2">
          {t("sbLimitNow", { limit: limitText(row) })} ·{" "}
          {t("budgetEver", { usd: usd(row.used.usd) })}
        </p>
        <form
          class="wz-money"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) void save(n);
          }}
        >
          {AMOUNTS.map((v) => (
            <button
              type="button"
              key={v}
              class={`wz-chip${valid && n === Number(v) ? " on" : ""}`}
              aria-pressed={valid && n === Number(v)}
              onClick={() => setValue(v)}
            >
              ${v}
            </button>
          ))}
          <input
            class="wz-field wz-money-in"
            inputMode="decimal"
            enterkeyhint="done"
            aria-label={t("limit")}
            placeholder={t("wzBudgetOther")}
            value={AMOUNTS.includes(value as never) ? "" : value}
            onInput={(e) => setValue((e.target as HTMLInputElement).value.replace(/[^\d.,]/g, ""))}
          />
        </form>
        <p class="wz-say">{valid ? t("sbLimitSay", { usd: num(n, 2) }) : t("sbLimitPick")}</p>
      </div>
      <Acts>
        {has && (
          <button
            type="button"
            class="wz-btn quiet"
            disabled={busy}
            onClick={() => void save(undefined)}
          >
            {t("budgetRemoveLimit")}
          </button>
        )}
        <button type="button" class="wz-btn" onClick={() => onClose(false)}>
          {t("cancel")}
        </button>
        <button
          type="button"
          class="wz-btn primary"
          disabled={busy || !valid}
          onClick={() => void save(n)}
        >
          {t("save")}
        </button>
      </Acts>
    </Modal>
  );
}

/** Spend this month, by day; then every project and agent with its limit. */
export function Budgets() {
  const [daily, setDaily] = useState<Daily[]>([]);
  const [version, setVersion] = useState(0);
  const [open, setOpen] = useState<{ scope: Budget["scope"]; id: string; name: string } | null>(
    null,
  );
  const [how, setHow] = useState(false);
  const days = monthDays();
  useEffect(() => {
    void attempt(() => getApi().budgets()).then((b) => {
      if (b) budgets.value = b;
    });
    void getApi()
      .spendDaily(days[0] ?? "")
      .then(setDaily, () => setDaily([]));
  }, [version]);
  const reload = () => setVersion((v) => v + 1);
  const rows = budgets.value;
  const global = rows.find((b) => b.scope === "global");
  const ownerId = global?.id ?? "";
  const monthOf = (scope: Budget["scope"], id: string) =>
    daily.filter((d) => d.scope === scope && d.id === id).reduce((s, d) => s + d.usd, 0);
  const perDay = days.map((day) => ({
    day,
    usd: daily.filter((d) => d.day === day && d.scope === "global").reduce((s, d) => s + d.usd, 0),
  }));
  const top = Math.max(...perDay.map((d) => d.usd), 0.000001);
  const month = perDay.reduce((s, d) => s + d.usd, 0);
  const rowFor = (scope: Budget["scope"], id: string): Budget =>
    rows.find((b) => b.scope === scope && b.id === id) ?? {
      scope,
      id,
      limit: {},
      used: { usd: 0, tokens: 0 },
    };
  const byMonth = (a: { scope: Budget["scope"]; id: string }, b: typeof a) =>
    monthOf(b.scope, b.id) - monthOf(a.scope, a.id);
  const projectRows = projects.value.map((p) => ({
    scope: "project" as const,
    id: p.id,
    name: p.name,
  }));
  // Agents that spent something or have a limit: the others would be a list of zeros.
  const agentRows = agents.value
    .map((a) => ({ scope: "agent" as const, id: a.id, name: a.name }))
    .filter((a) => {
      const r = rowFor("agent", a.id);
      return r.used.usd > 0 || r.limit.usd !== undefined || r.limit.tokens !== undefined;
    });
  const monthName = new Date().toLocaleDateString(lang.value === "it" ? "it-IT" : "en-US", {
    month: "long",
  });
  const group = (title: string, list: { scope: Budget["scope"]; id: string; name: string }[]) => (
    <>
      <Sub title={title} />
      <div class="sb-boxes">
        {list.sort(byMonth).map((x) => (
          <Row
            key={x.id}
            row={rowFor(x.scope, x.id)}
            name={x.name}
            month={x.scope === "global" ? month : monthOf(x.scope, x.id)}
            onOpen={() => setOpen(x)}
          />
        ))}
      </div>
    </>
  );
  return (
    <WzPage class="sb-budgets">
      <Head
        eyebrow={t("budgetThisMonth", { month: monthName })}
        q={usd(month)}
        lead={t("sbBudgetLead")}
      />
      <div class="wz-card sb-chart-card">
        <div class="sb-chart" role="img" aria-label={t("budgetChart")}>
          {perDay.map((d) => (
            <span
              key={d.day}
              title={`${d.day.slice(8)}: ${usd(d.usd)}`}
              style={{ height: `${Math.max(2, (d.usd / top) * 100)}%` }}
              class={d.usd > 0 ? "" : "zero"}
            />
          ))}
        </div>
        <div class="sb-chart-axis dim">
          <span>1</span>
          <span>{days.length}</span>
        </div>
      </div>
      <p class="wz-more">
        <button type="button" class="wz-link" onClick={() => setHow(true)}>
          {t("sbBudgetHowLink")}
        </button>
      </p>

      {ownerId ? (
        group(t("budgetTotal"), [{ scope: "global", id: ownerId, name: t("budgetEverything") }])
      ) : (
        <>
          <Sub title={t("budgetTotal")} lead={t("budgetNothingYet")} />
        </>
      )}
      {projectRows.length > 0 && group(t("budgetProjects"), projectRows)}
      {agentRows.length > 0 && group(t("budgetAgents"), agentRows)}

      {open && (
        <LimitWindow
          key={`${open.scope}:${open.id}`}
          row={rowFor(open.scope, open.id)}
          name={open.name}
          onClose={(saved) => {
            setOpen(null);
            if (saved) reload();
          }}
        />
      )}
      {how && (
        <Modal title={t("sbBudgetHowLink")} onClose={() => setHow(false)}>
          <p class="wz-lead2">{t("budgetHow")}</p>
          <Acts>
            <button type="button" class="wz-btn primary" onClick={() => setHow(false)}>
              {t("wzUnderstood")}
            </button>
          </Acts>
        </Modal>
      )}
    </WzPage>
  );
}
