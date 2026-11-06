// The mailbox for email routines (G24.14c): server, user and an app password, tested on save.
// Only new mail is looked at; nothing in the mailbox is marked or changed. It serves automations
// only, so it lives with them (2026-11-07, the person): a square in Settings > Automations and,
// in the editor, a line under the «On an email» trigger; both open the same window.
import { createPortal } from "preact/compat";
import { useEffect, useState } from "preact/hooks";
import { t } from "../i18n.js";
import { IconSend } from "../icons.js";
import { attempt, getApi } from "../state.js";
import { explain } from "./Brain.js";
import { Acts, Row, Switch } from "./SettingsKit.js";
import { Advanced, Field, Modal } from "./ui.js";

type Shown = { configured: boolean; host?: string; port?: number; secure?: boolean; user?: string };

/** The mailbox as the server knows it, and a way to ask again after the window changed it. */
export function useMailbox(): { box: Shown | undefined; reload: () => void } {
  const [box, setBox] = useState<Shown>();
  const reload = () =>
    void getApi()
      .emailSettings()
      .then(setBox, () => setBox({ configured: false }));
  useEffect(reload, []);
  return { box, reload };
}

/** The mailbox's window, above everything (outside any form, so Enter never saves a draft). */
export function MailboxWindow({ onClose }: { onClose: () => void }) {
  return createPortal(
    <div class="wz-look">
      <Modal title={t("emailTitle")} onClose={onClose}>
        <div class="wz-panel-in">
          <EmailSettings />
        </div>
      </Modal>
    </div>,
    document.body,
  );
}

/**
 * Under the «On an email» trigger in the editor: which mailbox it watches, or a clear line that
 * one must be connected first, with a button opening the same window; the draft stays as it is.
 */
export function MailboxNeed() {
  const { box, reload } = useMailbox();
  const [open, setOpen] = useState(false);
  if (!box) return null;
  return (
    <div class={`aw-mailbox${box.configured ? " ok" : " need"}`}>
      <span class="aw-mailbox-ico">
        <IconSend size={18} />
      </span>
      <span class="aw-mailbox-text">
        {box.configured
          ? t("emailWatching", { user: box.user ?? "", host: box.host ?? "" })
          : t("emailNeedFirst")}
      </span>
      <button
        type="button"
        class={`wz-btn small${box.configured ? " quiet" : " primary"}`}
        onClick={() => setOpen(true)}
      >
        {box.configured ? t("emailChange") : t("emailConnect")}
      </button>
      {open && (
        <MailboxWindow
          onClose={() => {
            setOpen(false);
            reload();
          }}
        />
      )}
    </div>
  );
}

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
