import { useEffect, useState } from "preact/hooks";
import { kTokens, usd } from "../format.js";
import { lang, setLang, t } from "../i18n.js";
import {
  approvals,
  attempt,
  budgets,
  getApi,
  lastError,
  openTab,
  refresh,
  signIn,
  signOut,
  status,
  token,
} from "../state.js";
import { Login } from "./Login.js";
import { Panes } from "./Panes.js";
import { Sidebar } from "./Sidebar.js";

export function App() {
  const [ready, setReady] = useState(false);
  const [drawer, setDrawer] = useState(false);

  useEffect(() => {
    if (token.value)
      void signIn(token.value)
        .catch(() => signOut())
        .finally(() => setReady(true));
    else setReady(true);
  }, []);

  useEffect(() => {
    if (!token.value) return;
    const timer = setInterval(() => void attempt(refresh), 15_000);
    return () => clearInterval(timer);
  }, [token.value]);

  if (!ready) return null;
  if (!token.value) return <Login />;

  const global = budgets.value.find((b) => b.scope === "global");
  return (
    <div class={`app${drawer ? " drawer-open" : ""}`}>
      <header class="header">
        <button
          type="button"
          class="hamburger"
          onClick={() => setDrawer(!drawer)}
          aria-label="menu"
        >
          ☰
        </button>
        <div class="logo">
          <span class="sun" /> RedGiant
        </div>
        <span class={`status ${status.value}`}>
          {t(
            status.value === "online"
              ? "online"
              : status.value === "connecting"
                ? "connecting"
                : "offline",
          )}
        </span>
        {lastError.value && (
          <button
            type="button"
            class="header-error"
            onClick={() => {
              lastError.value = null;
            }}
          >
            {lastError.value}
          </button>
        )}
        <div class="spacer" />
        {global && (
          <button
            type="button"
            class="pill budget"
            onClick={() => openTab({ id: "budgets", type: "budgets", title: t("budgets") })}
            title={t("budgets")}
          >
            {usd(global.used.usd)} · {kTokens(global.used.tokens)} tok
          </button>
        )}
        <button
          type="button"
          class={`pill bell${approvals.value.length ? " alert" : ""}`}
          onClick={() => openTab({ id: "approvals", type: "approvals", title: t("approvals") })}
        >
          🔔 {approvals.value.length}
        </button>
        <button
          type="button"
          class="pill"
          onClick={() =>
            void attempt(() => getApi().verify()).then(
              (r) =>
                r &&
                alert(
                  r.ok
                    ? `${t("logIntact")} (${r.checked})`
                    : `${t("logBroken")} #${r.seq}: ${r.reason}`,
                ),
            )
          }
          title="verify"
        >
          ⛓
        </button>
        <select
          value={lang.value}
          onChange={(e) => setLang((e.target as HTMLSelectElement).value as "it" | "en")}
          aria-label={t("language")}
        >
          <option value="it">IT</option>
          <option value="en">EN</option>
        </select>
        <button type="button" class="pill" onClick={signOut}>
          {t("logout")}
        </button>
      </header>
      <div class="body">
        <Sidebar onNavigate={() => setDrawer(false)} />
        <button
          type="button"
          class="veil"
          aria-label="close menu"
          onClick={() => setDrawer(false)}
        />
        <Panes />
      </div>
    </div>
  );
}
