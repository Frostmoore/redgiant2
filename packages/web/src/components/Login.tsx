import { useState } from "preact/hooks";
import { t } from "../i18n.js";
import { signIn } from "../state.js";

export function Login() {
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
    <div class="login">
      <form onSubmit={(e) => void submit(e)}>
        <div class="logo">
          <span class="sun" /> RedGiant
        </div>
        <p class="dim">{t("loginHint")}</p>
        <input
          type="password"
          placeholder={t("token")}
          value={value}
          onInput={(e) => setValue((e.target as HTMLInputElement).value)}
        />
        {error && <div class="notice error">{error}</div>}
        <button type="submit" class="primary" disabled={!value.trim()}>
          {t("login")}
        </button>
      </form>
    </div>
  );
}
