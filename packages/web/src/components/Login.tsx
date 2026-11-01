import { useState } from "preact/hooks";
import { claimDevice, deviceName } from "../api.js";
import { t } from "../i18n.js";
import { Logo } from "../icons.js";
import { signIn } from "../state.js";

export function Login() {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: Event) => {
    e.preventDefault();
    try {
      const v = value.trim();
      // Tokens are long; a pairing code is ten letters and digits.
      await signIn(v.length <= 12 ? await claimDevice(v, deviceName()) : v);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div class="login">
      <form onSubmit={(e) => void submit(e)}>
        <div class="logo">
          <Logo size={40} /> RedGiant
        </div>
        <p class="dim">{t("loginHint")}</p>
        <input
          type="password"
          placeholder={t("tokenOrCode")}
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
