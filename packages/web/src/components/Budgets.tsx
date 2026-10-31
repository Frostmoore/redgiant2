import { useEffect } from "preact/hooks";
import { kTokens, usd } from "../format.js";
import { t } from "../i18n.js";
import { agents, attempt, budgets, getApi, projects } from "../state.js";

/** Spend and limits per owner, project and agent. */
export function Budgets() {
  useEffect(() => {
    void attempt(() => getApi().budgets()).then((b) => {
      if (b) budgets.value = b;
    });
  }, []);
  const label = (scope: string, id: string) =>
    scope === "agent"
      ? (agents.value.find((a) => a.id === id)?.name ?? id)
      : scope === "project"
        ? (projects.value.find((p) => p.id === id)?.name ?? id)
        : t("platform");
  const setLimit = (scope: "agent" | "project" | "global", id: string) => {
    const value = prompt(`${t("limit")} (USD)`);
    const n = value ? Number(value) : Number.NaN;
    if (Number.isFinite(n) && n > 0)
      void attempt(() => getApi().setBudget({ scope, id, usd: n })).then(() =>
        attempt(() => getApi().budgets()).then((b) => {
          if (b) budgets.value = b;
        }),
      );
  };
  return (
    <div class="table-wrap">
      <table class="budgets">
        <thead>
          <tr>
            <th>{t("scope")}</th>
            <th />
            <th>{t("spent")}</th>
            <th>{t("limit")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {budgets.value.map((b) => {
            const over =
              (b.limit.usd !== undefined && b.used.usd >= b.limit.usd) ||
              (b.limit.tokens !== undefined && b.used.tokens >= b.limit.tokens);
            const pct = b.limit.usd
              ? Math.min(100, (b.used.usd / b.limit.usd) * 100)
              : b.limit.tokens
                ? Math.min(100, (b.used.tokens / b.limit.tokens) * 100)
                : 0;
            return (
              <tr key={`${b.scope}:${b.id}`} class={over ? "over" : ""}>
                <td>{b.scope}</td>
                <td>{label(b.scope, b.id)}</td>
                <td>
                  {usd(b.used.usd)} · {kTokens(b.used.tokens)} tok
                  <div class="meter">
                    <span style={{ width: `${pct}%` }} />
                  </div>
                </td>
                <td>
                  {b.limit.usd !== undefined
                    ? usd(b.limit.usd)
                    : b.limit.tokens !== undefined
                      ? `${kTokens(b.limit.tokens)} tok`
                      : t("none")}
                </td>
                <td>
                  <button type="button" onClick={() => setLimit(b.scope, b.id)}>
                    {t("setLimit")}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
