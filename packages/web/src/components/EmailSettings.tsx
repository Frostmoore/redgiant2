// The mailbox for email routines (G24.14c): server, user and an app password, tested on save.
// Only new mail is looked at; nothing in the mailbox is marked or changed. Shown in a window of
// Settings > General (2026-11-06), whose title names it.
import { useEffect, useState } from "preact/hooks";
import { t } from "../i18n.js";
import { attempt, getApi } from "../state.js";
import { explain } from "./Brain.js";
import { Acts, Row, Switch } from "./SettingsKit.js";
import { Advanced, Field } from "./ui.js";

type Shown = { configured: boolean; host?: string; port?: number; secure?: boolean; user?: string };

export function EmailSettings({ onChange }: { onChange?: () => void }) {
  const [shown, setShown] = useState<Shown>();
  const [host, setHost] = useState("");
  const [port, setPort] = useState(993);
  const [secure, setSecure] = useState(true);
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const load = () =>
    void getApi()
      .emailSettings()
      .then(
        (s) => {
          setShown(s);
          if (s.configured) {
            setHost(s.host ?? "");
            setPort(s.port ?? 993);
            setSecure(s.secure ?? true);
            setUser(s.user ?? "");
          }
        },
        () => setShown({ configured: false }),
      );
  useEffect(load, []);
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await getApi().setEmailSettings({
        host: host.trim(),
        port,
        secure,
        user: user.trim(),
        password,
      });
      setPassword("");
      load();
      onChange?.();
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusy(false);
    }
  };
  if (!shown) return null;
  return (
    <div class="email-settings">
      <p class="wz-lead2">{t("emailPurpose")}</p>
      {shown.configured && (
        <p class="notice ok">
          {t("emailConnected", { user: shown.user ?? "", host: shown.host ?? "" })}
        </p>
      )}
      <Field label={t("emailHost")} help={t("emailHostHelp")}>
        <input
          value={host}
          placeholder="imap.gmail.com"
          onInput={(e) => setHost((e.target as HTMLInputElement).value)}
        />
      </Field>
      <Field label={t("emailUser")}>
        <input
          value={user}
          autocomplete="off"
          onInput={(e) => setUser((e.target as HTMLInputElement).value)}
        />
      </Field>
      <Field label={t("emailPassword")} help={t("emailPasswordHelp")}>
        <input
          type="password"
          autocomplete="off"
          value={password}
          onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
        />
      </Field>
      <Advanced>
        <Field label={t("emailPort")}>
          <input
            type="number"
            value={port}
            onInput={(e) => setPort(Number((e.target as HTMLInputElement).value) || 993)}
          />
        </Field>
        <Row title={t("emailSecure")}>
          <Switch on={secure} onChange={setSecure} label={t("emailSecure")} small />
        </Row>
      </Advanced>
      {error && <p class="notice error">{error}</p>}
      <Acts>
        {shown.configured && (
          <button
            type="button"
            class="wz-btn quiet"
            onClick={() =>
              void attempt(() => getApi().removeEmailSettings()).then(() => {
                load();
                onChange?.();
              })
            }
          >
            {t("remove")}
          </button>
        )}
        <button
          type="button"
          class="wz-btn primary"
          disabled={busy || !host.trim() || !user.trim() || !password}
          onClick={() => void save()}
        >
          {busy ? t("emailTesting") : t("emailSave")}
        </button>
      </Acts>
    </div>
  );
}
