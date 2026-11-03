// Spending in plain words (G24.10): this month day by day, then each project and agent with
// its limit, editable in its row. Limits count everything spent since they were set.
import { useEffect, useState } from "preact/hooks";
import type { Budget } from "../api.js";
import { kTokens, monthDays, usd } from "../format.js";
import { lang, t } from "../i18n.js";
import { agents, attempt, budgets, getApi, projects } from "../state.js";

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

function Row({
  row,
  name,
  month,
  onSaved,
}: {
  row: Budget;
  name: string;
  month: number;
  onSaved: () => void;
}) {
  const limit = row.limit.usd;
  const pct = limit ? Math.min(100, (row.used.usd / limit) * 100) : 0;
  const over = limit !== undefined && row.used.usd >= limit;
  return (
    <div class={`budget-row${over ? " over" : ""}`}>
      <div class="budget-name">
        <strong>{name}</strong>
        <span class="dim">
          {t("budgetMonth", { usd: usd(month) })} · {t("budgetEver", { usd: usd(row.used.usd) })}
        </span>
        {limit !== undefined && (
          <div class="meter" title={`${Math.round(pct)}%`}>
            <span style={{ width: `${pct}%` }} />
          </div>
        )}
        {over && <span class="chip danger">{t("budgetStopped")}</span>}
      </div>
      <LimitEditor row={row} onSaved={onSaved} />
    </div>
  );
}

/** Spend this month, by day; then every project and agent with its limit. */
export function Budgets() {
  const [daily, setDaily] = useState<Daily[]>([]);
  const [version, setVersion] = useState(0);
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
  return (
    <div class="budgets-page">
      <div class="budget-hero">
        <div>
          <div class="dim">{t("budgetThisMonth", { month: monthName })}</div>
          <div class="budget-total">{usd(month)}</div>
        </div>
        <div class="budget-chart" role="img" aria-label={t("budgetChart")}>
          {perDay.map((d) => (
            <span
              key={d.day}
              title={`${d.day.slice(8)}: ${usd(d.usd)}`}
              style={{ height: `${Math.max(2, (d.usd / top) * 100)}%` }}
              class={d.usd > 0 ? "" : "zero"}
            />
          ))}
        </div>
      </div>
      <p class="ui-help">{t("budgetHow")}</p>

      <h3>{t("budgetTotal")}</h3>
      {ownerId ? (
        <Row
          row={rowFor("global", ownerId)}
          name={t("budgetEverything")}
          month={month}
          onSaved={reload}
        />
      ) : (
        <p class="dim">{t("budgetNothingYet")}</p>
      )}

      {projectRows.length > 0 && (
        <>
          <h3>{t("budgetProjects")}</h3>
          {projectRows.sort(byMonth).map((p) => (
            <Row
              key={p.id}
              row={rowFor("project", p.id)}
              name={p.name}
              month={monthOf("project", p.id)}
              onSaved={reload}
            />
          ))}
        </>
      )}
      {agentRows.length > 0 && (
        <>
          <h3>{t("budgetAgents")}</h3>
          {agentRows.sort(byMonth).map((a) => (
            <Row
              key={a.id}
              row={rowFor("agent", a.id)}
              name={a.name}
              month={monthOf("agent", a.id)}
              onSaved={reload}
            />
          ))}
        </>
      )}
    </div>
  );
}
