// The mailbox for email routines (G24.14c): server, user and an app password, tested on save.
// Only new mail is looked at; nothing in the mailbox is marked or changed. It serves automations
// only, so it lives with them (2026-11-07, the person): a square in Settings > Automations and,
// in the editor, a line under the «On an email» trigger; both open the same window.
//
// Many mailboxes (G33.3): each with a name and a category (work, personal, social, other or the
// person's own), shown as squares grouped by category, plus «Add a mailbox». The first one is
// still the one the single-mailbox window above shows.
import type { Mailbox as MailboxInfo } from "@redgiant/protocol";
import { createPortal } from "preact/compat";
import { useEffect, useState } from "preact/hooks";
import { t } from "../i18n.js";
import { IconPlus, IconSend } from "../icons.js";
import { attempt, getApi } from "../state.js";
import { explain } from "./Brain.js";
import { Acts, Chips, Row, Sub, Switch, SwitchRow, Tile } from "./SettingsKit.js";
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
  const many = useMailboxes();
  const [open, setOpen] = useState(false);
  if (!box) return null;
  // Many mailboxes: which ones there are; each is chosen above, by category or by name.
  if (many.boxes.length > 1)
    return (
      <div class="aw-mailbox ok">
        <span class="aw-mailbox-ico">
          <IconSend size={18} />
        </span>
        <span class="aw-mailbox-text">
          {t("axMailboxesWatching", {
            n: String(many.boxes.length),
            names: many.boxes.map((b) => b.name).join(", "),
          })}
        </span>
      </div>
    );
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

const DEFAULT_CATEGORIES = ["work", "personal", "social", "other"];
const catLabel = (c: string) => (DEFAULT_CATEGORIES.includes(c) ? t(`axCat_${c}` as never) : c);

/** Every mailbox of the person and the categories in use (empty while unknown). */
export function useMailboxes(): {
  boxes: MailboxInfo[];
  categories: string[];
  reload: () => void;
} {
  const [state, setState] = useState<{ boxes: MailboxInfo[]; categories: string[] }>({
    boxes: [],
    categories: DEFAULT_CATEGORIES,
  });
  const reload = () =>
    void getApi()
      .mailboxes()
      .then(
        (r) =>
          setState({
            boxes: Array.isArray(r?.boxes) ? r.boxes : [],
            categories: Array.isArray(r?.categories) ? r.categories : DEFAULT_CATEGORIES,
          }),
        () => {},
      );
  useEffect(reload, []);
  return { ...state, reload };
}

/**
 * One mailbox's window (G33.3): its name, its category (the usual ones or a new one), the server,
 * the user and the password for apps; port, encryption and the sending server under "Advanced".
 * A new mailbox is tried before it is kept; the password of one already there stays unless a new
 * one is written.
 */
export function MailboxEditor({
  box,
  categories,
  onClose,
}: {
  box: MailboxInfo | undefined;
  categories: string[];
  onClose: () => void;
}) {
  const [name, setName] = useState(box?.name ?? "");
  const [category, setCategory] = useState(box?.category ?? "personal");
  const [custom, setCustom] = useState("");
  const [host, setHost] = useState(box?.host ?? "");
  const [port, setPort] = useState(box?.port ?? 993);
  const [secure, setSecure] = useState(box?.secure ?? true);
  const [user, setUser] = useState(box?.user ?? "");
  const [password, setPassword] = useState("");
  const [smtpHost, setSmtpHost] = useState(box?.smtp?.host ?? "");
  const [smtpPort, setSmtpPort] = useState(box?.smtp?.port ?? 465);
  // Open to the agents' mail tools (G38.1): off until the person says so.
  const [agents, setAgents] = useState(box?.agents === true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const cats = [...new Set([...DEFAULT_CATEGORIES, ...categories, category])];
  const v = (e: Event) => (e.target as HTMLInputElement).value;
  const save = async () => {
    setBusy(true);
    setError(undefined);
    const smtp = smtpHost.trim()
      ? { host: smtpHost.trim(), port: smtpPort, secure: smtpPort === 465 }
      : undefined;
    const cat = custom.trim() || category;
    try {
      if (box)
        await getApi().updateMailbox(box.id, {
          name: name.trim(),
          category: cat,
          host: host.trim(),
          port,
          secure,
          user: user.trim(),
          ...(password && { password }),
          smtp: smtp ?? null,
          agents,
        });
      else
        await getApi().addMailbox({
          name: name.trim(),
          category: cat,
          host: host.trim(),
          port,
          secure,
          user: user.trim(),
          password,
          ...(smtp && { smtp }),
          agents,
        });
      onClose();
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusy(false);
    }
  };
  return createPortal(
    <div class="wz-look">
      <Modal title={box ? box.name : t("axMailboxNew")} onClose={onClose}>
        <div class="wz-panel-in email-settings mb-editor">
          <p class="wz-lead2">{t("axMailboxPurpose")}</p>
          <Field label={t("axMailboxName")} help={t("axMailboxNameHelp")}>
            <input value={name} onInput={(e) => setName(v(e))} />
          </Field>
          <span class="wz-lb">{t("axMailboxCategory")}</span>
          <Chips<string>
            options={cats.map((c) => ({ id: c, label: catLabel(c) }))}
            value={custom.trim() ? [] : [category]}
            onChange={([c]) => {
              if (c) setCategory(c);
              setCustom("");
            }}
          />
          <Field label={t("axMailboxNewCategory")}>
            <input
              value={custom}
              placeholder={t("axMailboxNewCategoryPlaceholder")}
              onInput={(e) => setCustom(v(e))}
            />
          </Field>
          <Field label={t("emailHost")} help={t("emailHostHelp")}>
            <input value={host} placeholder="imap.gmail.com" onInput={(e) => setHost(v(e))} />
          </Field>
          <Field label={t("emailUser")}>
            <input value={user} autocomplete="off" onInput={(e) => setUser(v(e))} />
          </Field>
          <Field
            label={t("emailPassword")}
            help={box ? t("axMailboxPasswordKept") : t("emailPasswordHelp")}
          >
            <input
              type="password"
              autocomplete="off"
              value={password}
              onInput={(e) => setPassword(v(e))}
            />
          </Field>
          <SwitchRow
            title={t("axMailboxAgents")}
            help={t("axMailboxAgentsHelp")}
            on={agents}
            onChange={setAgents}
          />
          <Advanced>
            <Field label={t("emailPort")}>
              <input type="number" value={port} onInput={(e) => setPort(Number(v(e)) || 993)} />
            </Field>
            <Row title={t("emailSecure")}>
              <Switch on={secure} onChange={setSecure} label={t("emailSecure")} small />
            </Row>
            <Field label={t("axSmtpHost")} help={t("axSmtpHostHelp")}>
              <input
                value={smtpHost}
                placeholder={host ? host.replace(/^imap\./i, "smtp.") : "smtp.gmail.com"}
                onInput={(e) => setSmtpHost(v(e))}
              />
            </Field>
            <Field label={t("axSmtpPort")}>
              <input
                type="number"
                value={smtpPort}
                onInput={(e) => setSmtpPort(Number(v(e)) || 465)}
              />
            </Field>
          </Advanced>
          {error && <p class="notice error">{error}</p>}
          <Acts>
            {box && (
              <button
                type="button"
                class="wz-btn quiet"
                onClick={() =>
                  void attempt(() => getApi().removeMailbox(box.id)).then(() => onClose())
                }
              >
                {t("remove")}
              </button>
            )}
            <button
              type="button"
              class="wz-btn primary"
              disabled={busy || !host.trim() || !user.trim() || (!box && !password)}
              onClick={() => void save()}
            >
              {busy ? t("emailTesting") : box ? t("save") : t("emailSave")}
            </button>
          </Acts>
        </div>
      </Modal>
    </div>,
    document.body,
  );
}

/**
 * The mailboxes on the Automations page (G33.3): one square per mailbox, grouped by category,
 * and «Add a mailbox». With none yet, the single square of before («Mailbox, not connected»).
 */
export function Mailboxes({ onChange }: { onChange?: () => void }) {
  const many = useMailboxes();
  const one = useMailbox();
  const [open, setOpen] = useState<"one" | "new" | MailboxInfo | null>(null);
  const closed = () => {
    setOpen(null);
    many.reload();
    one.reload();
    onChange?.();
  };
  const groups = [...new Set(many.boxes.map((b) => b.category))].sort(
    (a, b) =>
      (DEFAULT_CATEGORIES.indexOf(a) + 1 || 99) - (DEFAULT_CATEGORIES.indexOf(b) + 1 || 99) ||
      a.localeCompare(b),
  );
  return (
    <>
      {many.boxes.length === 0 ? (
        <div class="wz-brain aw-make aw-sources">
          <Tile
            on={!!one.box?.configured}
            icon={<IconSend />}
            title={t("emailTitle")}
            text={t("emailTileText")}
            state={one.box?.configured ? one.box.user : t("emailNotConnected")}
            onClick={() => setOpen("one")}
          />
        </div>
      ) : (
        <div class="mb-groups">
          {groups.map((g) => (
            <div key={g} class="mb-group">
              <Sub title={catLabel(g)} />
              <div class="wz-brain aw-make aw-sources">
                {many.boxes
                  .filter((b) => b.category === g)
                  .map((b) => (
                    <Tile
                      key={b.id}
                      on
                      icon={<IconSend />}
                      title={b.name}
                      text={b.user}
                      state={`${catLabel(b.category)} · ${b.host}`}
                      onClick={() => setOpen(b)}
                    />
                  ))}
              </div>
            </div>
          ))}
          <div class="wz-brain aw-make aw-sources">
            <Tile
              on={false}
              icon={<IconPlus />}
              title={t("axMailboxAdd")}
              text={t("axMailboxAddText")}
              onClick={() => setOpen("new")}
            />
          </div>
        </div>
      )}
      {open === "one" && <MailboxWindow onClose={closed} />}
      {open === "new" && (
        <MailboxEditor box={undefined} categories={many.categories} onClose={closed} />
      )}
      {open && typeof open === "object" && (
        <MailboxEditor box={open} categories={many.categories} onClose={closed} />
      )}
    </>
  );
}
