import { useEffect, useState } from "preact/hooks";
import {
  firstAccessLogin,
  type LoginMethods,
  loginMethods,
  passwordLogin,
  setupCodeLogin,
} from "../api.js";
import { type Key, t } from "../i18n.js";
import { Logo } from "../icons.js";
import { signIn } from "../state.js";
import { explain } from "./Brain.js";
import { Advanced } from "./ui.js";

/** Why a password pair cannot be used, or undefined when it can. */
export function passwordProblem(value: string, again: string, needed: boolean): Key | undefined {
  if (!value && !again) return needed ? "fbPasswordNeeded" : undefined;
  if (value.length < 10 || /^(.)\1+$/.test(value)) return "fbPasswordWeak";
  if (value !== again) return "fbPasswordDiffer";
  return undefined;
}

/** The installation's token (for apps and the command line, never a step for people). */
function TokenForm() {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: Event) => {
    e.preventDefault();
    try {
      await signIn(value.trim());
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <form class="login-token" onSubmit={(e) => void submit(e)}>
      <p class="dim">{t("loginHint")}</p>
      <input
        type="password"
        aria-label={t("tokenOrCode")}
        placeholder={t("tokenOrCode")}
        value={value}
        onInput={(e) => setValue((e.target as HTMLInputElement).value)}
      />
      {error && <div class="notice error">{error}</div>}
      <button type="submit" class="primary" disabled={!value.trim()}>
        {t("login")}
      </button>
    </form>
  );
}

/**
 * The first start from another device (G39.3): the one-time code shown on the machine's
 * screen or in its log opens the wizard; nothing else is reachable without it.
 */
function SetupCodeForm() {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: Event) => {
    e.preventDefault();
    setError(null);
    try {
      await signIn(await setupCodeLogin(value.trim()));
    } catch (err) {
      const code = (err as { code?: string }).code;
      setError(
        code === "wrong"
          ? t("fbCodeWrong")
          : code === "too_many"
            ? t("fbCodeTooMany")
            : code === "none"
              ? t("fbCodeNone")
              : explain(err),
      );
    }
  };
  return (
    <form class="login-setup-code" onSubmit={(e) => void submit(e)}>
      <h1 class="login-title">{t("fbCodeTitle")}</h1>
      <p class="dim">{t("fbCodeHint")}</p>
      <input
        type="text"
        autocomplete="one-time-code"
        autocapitalize="characters"
        spellcheck={false}
        aria-label={t("fbCodeLabel")}
        placeholder="ABCDE-FGHJK"
        value={value}
        onInput={(e) => setValue((e.target as HTMLInputElement).value)}
      />
      {error && <div class="notice error">{error}</div>}
      <button type="submit" class="primary" disabled={!value.trim()}>
        {t("fbCodeGo")}
      </button>
    </form>
  );
}

/**
 * «Create your access» (G39.7): at a first start without a password, opened from the local
 * network, the page asks for the password and is in. No token, no console.
 */
function FirstAccessForm({ reload }: { reload: () => void }) {
  const [pw, setPw] = useState(["", ""] as [string, string]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    const problem = passwordProblem(pw[0], pw[1], true);
    if (problem) {
      setError(t(problem));
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await signIn(await firstAccessLogin(pw[0]));
    } catch (err) {
      const code = (err as { code?: string }).code;
      // Someone else created it a moment ago, or the rule changed: the page shows what now holds.
      if (code === "exists" || code === "closed" || code === "code" || code === "not_here")
        reload();
      setError(code === "weak" ? t("fbPasswordWeak") : explain(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="login-first" onSubmit={(e) => void submit(e)}>
      <h1 class="login-title">{t("faTitle")}</h1>
      <p class="dim">{t("faLead")}</p>
      <input
        type="password"
        autocomplete="new-password"
        aria-label={t("fbPassword")}
        placeholder={t("fbPassword")}
        value={pw[0]}
        onInput={(e) => {
          const v = (e.target as HTMLInputElement).value;
          setPw((p) => [v, p[1]]);
        }}
      />
      <input
        type="password"
        autocomplete="new-password"
        aria-label={t("fbPasswordAgain")}
        placeholder={t("fbPasswordAgain")}
        value={pw[1]}
        onInput={(e) => {
          const v = (e.target as HTMLInputElement).value;
          setPw((p) => [p[0], v]);
        }}
      />
      <p class="dim login-small">{t("fbPasswordHelp")}</p>
      {error && <div class="notice error">{error}</div>}
      <button type="submit" class="primary" disabled={busy || !pw[0]}>
        {t("faGo")}
      </button>
    </form>
  );
}

/** A first start opened from outside the local network (G39.7): nothing is created from here. */
function NotHere() {
  return (
    <div class="login-first">
      <h1 class="login-title">{t("faNotHereTitle")}</h1>
      <p class="dim">{t("faNotHere")}</p>
    </div>
  );
}

/**
 * Signing in (G24.6): the password when there is one (and the app's code); at a first start the
 * page that creates the access (G39.7). The installation's token is never a step for people:
 * only folded away, for apps and the command line.
 */
export function Login() {
  const [methods, setMethods] = useState<LoginMethods | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needCode, setNeedCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    void loginMethods().then(setMethods, () => setMethods({ password: false, code: false }));
  useEffect(load, []);
  const submit = async (e: Event) => {
    e.preventDefault();
    setError(null);
    try {
      await signIn(await passwordLogin(password, code.trim() || undefined));
    } catch (err) {
      if ((err as { code?: string }).code === "code_needed") setNeedCode(true);
      else setError(explain(err));
    }
  };
  return (
    <div class="login">
      <div class="login-box">
        <div class="logo">
          <Logo size={40} /> RedGiant
        </div>
        {methods?.firstAccess === "password" ? (
          <FirstAccessForm reload={load} />
        ) : methods?.firstAccess === "not_here" ? (
          <NotHere />
        ) : (methods?.firstAccess === "code" || methods?.setupCode) && !methods.password ? (
          <SetupCodeForm />
        ) : methods?.password ? (
          <>
            <form onSubmit={(e) => void submit(e)}>
              <input
                type="password"
                autocomplete="current-password"
                aria-label={t("loginPassword")}
                placeholder={t("loginPassword")}
                value={password}
                onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
              />
              {(needCode || methods.code) && (
                <input
                  inputMode="numeric"
                  autocomplete="one-time-code"
                  aria-label={t("loginCode")}
                  placeholder={t("loginCode")}
                  value={code}
                  onInput={(e) => setCode((e.target as HTMLInputElement).value)}
                />
              )}
              {error && <div class="notice error">{error}</div>}
              <button type="submit" class="primary" disabled={!password}>
                {t("login")}
              </button>
              <p class="dim login-small">{t("loginRemembered")}</p>
            </form>
            <Advanced label={t("loginWithToken")}>
              <TokenForm />
            </Advanced>
          </>
        ) : (
          methods && (
            <>
              <div class="login-first">
                <h1 class="login-title">{t("loginNoPasswordTitle")}</h1>
                <p class="dim">{t("loginNoPassword")}</p>
              </div>
              <Advanced label={t("loginWithToken")}>
                <TokenForm />
              </Advanced>
            </>
          )
        )}
      </div>
    </div>
  );
}
