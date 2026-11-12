// Settings > Machines (G38.2): the person's other computers, reached by the agents over SSH. Each
// machine has a name the agents use, where it is, who logs in and how (a key RedGiant makes, a
// key the person pastes, or a password: all of them kept only in the keychain), a working folder
// and who may use it. «Test the connection» shows the machine's own key the first time, with its
// fingerprint, and the person trusts it; afterwards a different key is refused, in red.
import type { MachineAccess, MachineAuth, MachineTest, MachineView } from "@redgiant/protocol";
import { createPortal } from "preact/compat";
import { useEffect, useState } from "preact/hooks";
import { t } from "../i18n.js";
import { IconAlert, IconCopy, IconKey, IconPlus, IconServer, IconShield } from "../icons.js";
import { agents, attempt, getApi, projects } from "../state.js";
import { explain } from "./Brain.js";
import { askConfirm } from "./dialogs.js";
import { Acts, Box, Chips, Head, Seg, Sub, SwitchRow, WzPage } from "./SettingsKit.js";
import { Advanced, Field, Modal } from "./ui.js";

/** What a test found, in the person's words. */
function testText(r: MachineTest): string {
  switch (r.code) {
    case "ok":
      return t("mcTestOk", { system: r.system ?? "" });
    case "auth":
      return t("mcTestAuth");
    case "unreachable":
      return t("mcTestUnreachable");
    case "timeout":
      return t("mcTestTimeout");
    case "no-secret":
      return t("mcTestNoSecret");
    default:
      return t("mcTestError", { message: r.message });
  }
}

function CopyLine({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div class="mc-copy">
      <code class="mc-code">{text}</code>
      <button
        type="button"
        class="wz-btn small quiet"
        aria-label={label}
        onClick={() =>
          void navigator.clipboard
            ?.writeText(text)
            .then(() => setCopied(true))
            .catch(() => {})
        }
      >
        <IconCopy size={14} /> {copied ? t("mcCopied") : t("mcCopy")}
      </button>
    </div>
  );
}

/** One machine: its facts, its public key, the test and what it found. */
function MachineCard({
  m,
  onEdit,
  reload,
}: {
  m: MachineView;
  onEdit: () => void;
  reload: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MachineTest>();
  const test = async () => {
    setBusy(true);
    setResult(undefined);
    const r = await attempt(() => getApi().testMachine(m.id));
    setBusy(false);
    if (r) setResult(r);
    reload();
  };
  const trust = async (fingerprint: string, replace: boolean) => {
    if (
      replace &&
      !(await askConfirm(t("mcReplaceQ", { name: m.name }), {
        text: t("mcReplaceText"),
        yes: t("mcReplaceYes"),
        danger: true,
      }))
    )
      return;
    const ok = await attempt(() => getApi().trustMachine(m.id, fingerprint));
    if (ok) await test();
  };
  const remove = async () => {
    if (
      !(await askConfirm(t("mcRemoveQ", { name: m.name }), {
        text: t("mcRemoveText"),
        yes: t("remove"),
        danger: true,
      }))
    )
      return;
    await attempt(() => getApi().removeMachine(m.id));
    reload();
  };
  const who = m.access.everyone
    ? t("mcWhoEveryone")
    : [
        ...m.access.agents.map((id) => agents.value.find((a) => a.id === id)?.name ?? id),
        ...m.access.projects.map(
          (id) => `${t("mcProject")} ${projects.value.find((p) => p.id === id)?.name ?? id}`,
        ),
      ].join(", ") || t("mcWhoNobody");
  const state = !m.hostKey
    ? t("mcStateNew")
    : m.lastTest && !m.lastTest.ok
      ? t("mcStateFailed")
      : t("mcStateTrusted");
  return (
    <Box class="mc-card">
      <div class="mc-head">
        <span class="mc-ico">
          <IconServer size={22} />
        </span>
        <div class="mc-title">
          <b>{m.name}</b>
          <span class="dim">
            {m.user}@{m.host}
            {m.port === 22 ? "" : `:${m.port}`}
          </span>
        </div>
        <span class={`mc-state${!m.hostKey ? " new" : m.lastTest?.ok === false ? " bad" : " ok"}`}>
          {state}
        </span>
      </div>
      <dl class="st-facts">
        <div>
          <dt>{t("mcFolder")}</dt>
          <dd>{m.folder || t("mcFolderNone")}</dd>
        </div>
        <div>
          <dt>{t("mcLogin")}</dt>
          <dd>
            {m.auth === "password"
              ? t("mcLoginPassword")
              : m.keySource === "imported"
                ? t("mcLoginImported")
                : t("mcLoginGenerated")}
          </dd>
        </div>
        <div>
          <dt>{t("mcWho")}</dt>
          <dd>{who}</dd>
        </div>
        {m.hostKey && (
          <div>
            <dt>{t("mcHostKey")}</dt>
            <dd>
              <code class="mc-fp">
                {m.hostKey.type} {m.hostKey.fingerprint}
              </code>
            </dd>
          </div>
        )}
      </dl>
      {m.auth === "key" && m.publicKey && (
        <div class="mc-pub">
          <span class="wz-lb">{t("mcPublicKey")}</span>
          <small class="dim">{t("mcPublicKeyHelp")}</small>
          <CopyLine text={m.publicKey} label={t("mcCopyKey")} />
        </div>
      )}
      {result?.code === "host-key-new" && result.hostKey && (
        <div class="notice mc-tofu" role="status">
          <IconShield size={16} />
          <div>
            <b>{t("mcTofuTitle")}</b>
            <p>{t("mcTofuText")}</p>
            <code class="mc-fp">
              {result.hostKey.type} {result.hostKey.fingerprint}
            </code>
            <p class="dim">{t("mcTofuHow")}</p>
            <Acts>
              <button type="button" class="wz-btn quiet" onClick={() => setResult(undefined)}>
                {t("cancel")}
              </button>
              <button
                type="button"
                class="wz-btn primary"
                onClick={() => void trust(result.hostKey?.fingerprint ?? "", false)}
              >
                {t("mcTrust")}
              </button>
            </Acts>
          </div>
        </div>
      )}
      {result?.code === "host-key-changed" && (
        <div class="notice error mc-changed" role="alert">
          <IconAlert size={16} />
          <div>
            <b>{t("mcChangedTitle")}</b>
            <p>{t("mcChangedText", { name: m.name })}</p>
            <Facts2
              rows={[
                [t("mcChangedWas"), result.expected ?? ""],
                [t("mcChangedNow"), result.hostKey?.fingerprint ?? ""],
              ]}
            />
            <Acts>
              <button
                type="button"
                class="wz-btn primary danger"
                onClick={() => void trust(result.hostKey?.fingerprint ?? "", true)}
              >
                {t("mcReplaceYes")}
              </button>
            </Acts>
          </div>
        </div>
      )}
      {result && result.code !== "host-key-new" && result.code !== "host-key-changed" && (
        <p class={`notice${result.ok ? " ok" : " error"}`} role="status">
          {testText(result)}
        </p>
      )}
      <Acts>
        <button type="button" class="wz-btn quiet" onClick={() => void remove()}>
          {t("remove")}
        </button>
        <button type="button" class="wz-btn quiet" onClick={onEdit}>
          {t("mcEdit")}
        </button>
        <button type="button" class="wz-btn primary" disabled={busy} onClick={() => void test()}>
          {busy ? t("mcTesting") : t("mcTest")}
        </button>
      </Acts>
    </Box>
  );
}

const Facts2 = ({ rows }: { rows: [string, string][] }) => (
  <dl class="st-facts">
    {rows.map(([k, v]) => (
      <div key={k}>
        <dt>{k}</dt>
        <dd>
          <code class="mc-fp">{v}</code>
        </dd>
      </div>
    ))}
  </dl>
);

/** Adding a machine, or changing one (its secrets stay unless new ones are written). */
export function MachineEditor({ m, onClose }: { m: MachineView | undefined; onClose: () => void }) {
  const [name, setName] = useState(m?.name ?? "");
  const [host, setHost] = useState(m?.host ?? "");
  const [port, setPort] = useState(m?.port ?? 22);
  const [user, setUser] = useState(m?.user ?? "");
  const [folder, setFolder] = useState(m?.folder ?? "");
  const [auth, setAuth] = useState<MachineAuth>(m?.auth ?? "key");
  const [keyWay, setKeyWay] = useState<"generate" | "paste">(
    m?.keySource === "imported" ? "paste" : "generate",
  );
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [password, setPassword] = useState("");
  const [access, setAccess] = useState<MachineAccess>(
    m?.access ?? { everyone: false, agents: [], projects: [] },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const v = (e: Event) => (e.target as HTMLInputElement).value;
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (m)
        await getApi().updateMachine(m.id, {
          name: name.trim(),
          host: host.trim(),
          port,
          user: user.trim(),
          folder: folder.trim() || null,
          access,
          ...(auth === "password" && password && { password }),
          ...(auth === "key" &&
            keyWay === "paste" &&
            privateKey.trim() && { privateKey, passphrase: passphrase || null }),
          ...(auth === "key" && keyWay === "generate" && m.auth === "password" && { newKey: true }),
        });
      else
        await getApi().addMachine({
          name: name.trim(),
          host: host.trim(),
          port,
          user: user.trim(),
          auth,
          ...(folder.trim() && { folder: folder.trim() }),
          ...(auth === "key" &&
            keyWay === "paste" && { privateKey, ...(passphrase && { passphrase }) }),
          ...(auth === "password" && { password }),
          access,
        });
      onClose();
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusy(false);
    }
  };
  const newKey = async () => {
    if (!m) return;
    if (
      !(await askConfirm(t("mcNewKeyQ"), {
        text: t("mcNewKeyText"),
        yes: t("mcNewKey"),
      }))
    )
      return;
    await attempt(() => getApi().updateMachine(m.id, { newKey: true }));
    onClose();
  };
  const ready =
    /^[a-z0-9][a-z0-9_.-]{0,39}$/i.test(name.trim()) &&
    host.trim() &&
    user.trim() &&
    (auth === "key"
      ? keyWay === "generate" || privateKey.trim() || m?.auth === "key"
      : password || m?.hasPassword);
  const workers = agents.value.filter((a) => a.kind !== "demigod" && a.kind !== "inspector");
  return createPortal(
    <div class="wz-look">
      <Modal title={m ? m.name : t("mcNew")} onClose={onClose}>
        <div class="wz-panel-in mc-editor">
          <p class="wz-lead2">{t("mcEditorLead")}</p>
          <Field label={t("mcName")} help={t("mcNameHelp")}>
            <input value={name} placeholder="web" onInput={(e) => setName(v(e))} />
          </Field>
          <Field label={t("mcHost")} help={t("mcHostHelp")}>
            <input value={host} placeholder="server.example.com" onInput={(e) => setHost(v(e))} />
          </Field>
          <Field label={t("mcUser")}>
            <input
              value={user}
              autocomplete="off"
              placeholder="deploy"
              onInput={(e) => setUser(v(e))}
            />
          </Field>
          <Field label={t("mcFolder")} help={t("mcFolderHelp")}>
            <input value={folder} placeholder="/srv/app" onInput={(e) => setFolder(v(e))} />
          </Field>
          <span class="wz-lb">{t("mcLogin")}</span>
          <Seg<MachineAuth>
            label={t("mcLogin")}
            value={auth}
            onChange={setAuth}
            options={[
              ["key", t("mcAuthKey")],
              ["password", t("mcAuthPassword")],
            ]}
          />
          {auth === "key" && (
            <>
              <Seg<"generate" | "paste">
                label={t("mcAuthKey")}
                value={keyWay}
                onChange={setKeyWay}
                options={[
                  ["generate", m?.auth === "key" ? t("mcKeyKeep") : t("mcKeyGenerate")],
                  ["paste", t("mcKeyPaste")],
                ]}
              />
              {keyWay === "generate" && (
                <p class="dim mc-hint">
                  {m?.auth === "key" ? t("mcKeyKeepHelp") : t("mcKeyGenerateHelp")}
                </p>
              )}
              {keyWay === "paste" && (
                <>
                  <Field label={t("mcPrivateKey")} help={t("mcPrivateKeyHelp")}>
                    <textarea
                      rows={5}
                      class="mc-key"
                      spellcheck={false}
                      autocomplete="off"
                      value={privateKey}
                      placeholder={t("mcPrivateKeyPlaceholder")}
                      onInput={(e) => setPrivateKey((e.target as HTMLTextAreaElement).value)}
                    />
                  </Field>
                  <Field label={t("mcPassphrase")}>
                    <input
                      type="password"
                      autocomplete="off"
                      value={passphrase}
                      onInput={(e) => setPassphrase(v(e))}
                    />
                  </Field>
                </>
              )}
            </>
          )}
          {auth === "password" && (
            <Field
              label={t("mcPassword")}
              help={m?.hasPassword ? t("mcPasswordKept") : t("mcPasswordHelp")}
            >
              <input
                type="password"
                autocomplete="off"
                value={password}
                onInput={(e) => setPassword(v(e))}
              />
            </Field>
          )}
          <Sub title={t("mcWho")} lead={t("mcWhoLead")} />
          <SwitchRow
            title={t("mcWhoEveryone")}
            help={t("mcWhoEveryoneHelp")}
            on={access.everyone}
            onChange={(everyone) => setAccess({ ...access, everyone })}
          />
          {!access.everyone && (
            <>
              <span class="wz-lb">{t("mcWhoAgents")}</span>
              {workers.length ? (
                <Chips<string>
                  multiple
                  options={workers.map((a) => ({ id: a.id, label: a.name }))}
                  value={access.agents}
                  onChange={(ids) => setAccess({ ...access, agents: ids })}
                />
              ) : (
                <p class="dim">{t("mcWhoNoAgents")}</p>
              )}
              {projects.value.length > 0 && (
                <>
                  <span class="wz-lb">{t("mcWhoProjects")}</span>
                  <Chips<string>
                    multiple
                    options={projects.value.map((p) => ({ id: p.id, label: p.name }))}
                    value={access.projects}
                    onChange={(ids) => setAccess({ ...access, projects: ids })}
                  />
                </>
              )}
            </>
          )}
          <Advanced>
            <Field label={t("mcPort")}>
              <input
                type="number"
                min={1}
                max={65535}
                value={port}
                onInput={(e) => setPort(Number(v(e)) || 22)}
              />
            </Field>
            {m?.auth === "key" && (
              <button type="button" class="wz-btn quiet" onClick={() => void newKey()}>
                <IconKey size={14} /> {t("mcNewKey")}
              </button>
            )}
          </Advanced>
          {error && <p class="notice error">{error}</p>}
          <Acts>
            <button type="button" class="wz-btn quiet" onClick={onClose}>
              {t("cancel")}
            </button>
            <button
              type="button"
              class="wz-btn primary"
              disabled={busy || !ready}
              onClick={() => void save()}
            >
              {m ? t("mcSave") : t("mcAdd")}
            </button>
          </Acts>
        </div>
      </Modal>
    </div>,
    document.body,
  );
}

/** The page. */
export function Machines() {
  const [list, setList] = useState<MachineView[]>();
  const [editing, setEditing] = useState<MachineView | "new">();
  const reload = () =>
    void getApi()
      .machines()
      .then(
        (r) => setList(Array.isArray(r?.machines) ? r.machines : []),
        () => setList([]),
      );
  useEffect(reload, []);
  return (
    <WzPage
      class="mc-page"
      after={
        editing && (
          <MachineEditor
            m={editing === "new" ? undefined : editing}
            onClose={() => {
              setEditing(undefined);
              reload();
            }}
          />
        )
      }
    >
      <Head q={t("mcTitle")} lead={t("mcLead")} />
      {list?.length === 0 && <p class="dim mc-empty">{t("mcEmpty")}</p>}
      {list?.map((m) => (
        <MachineCard key={m.id} m={m} onEdit={() => setEditing(m)} reload={reload} />
      ))}
      <Acts>
        <button type="button" class="wz-btn primary" onClick={() => setEditing("new")}>
          <IconPlus size={14} /> {t("mcNew")}
        </button>
      </Acts>
      <p class="dim mc-safety">{t("mcSafety")}</p>
    </WzPage>
  );
}
