import { useEffect, useState } from "preact/hooks";
import { type LoginMethods, loginMethods, passwordLogin, setupCodeLogin } from "../api.js";
import { t } from "../i18n.js";
import { Logo } from "../icons.js";
import { signIn } from "../state.js";
import { explain } from "./Brain.js";
import { Advanced } from "./ui.js";

/** The installation's token. */
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

/** Signing in (G24.6): the password when there is one (and the app's code), else the token. */
export function Login() {
  const [methods, setMethods] = useState<LoginMethods | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needCode, setNeedCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void loginMethods().then(setMethods, () => setMethods({ password: false, code: false }));
  }, []);
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
        {methods?.setupCode && !methods.password ? (
          <>
            <SetupCodeForm />
            <Advanced label={t("loginWithToken")}>
              <TokenForm />
            </Advanced>
          </>
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
            </form>
            <Advanced label={t("loginWithToken")}>
              <TokenForm />
            </Advanced>
          </>
        ) : (
          methods && <TokenForm />
        )}
      </div>
    </div>
  );
}
