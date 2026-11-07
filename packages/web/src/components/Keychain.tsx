// The keychain (G33.4, the person: «Creiamo una repo sicura per le credenziali… un po' come un
// password manager/portachiavi… un bel pezzettino di software che dia un vero vantaggio
// all'utente»): every key and password in one place, sealed on this computer. Agents use a
// credential by its name and never see it; the person decides where it may go, who may use it and
// whether to be asked. The page never holds a value unless the person asks to see or copy it.
import type {
  Automation,
  VaultAsk,
  VaultCategory,
  VaultEntry,
  VaultImportPreview,
  VaultInput,
  VaultSystemEntry,
  VaultUse,
  VaultView,
} from "@redgiant/protocol";
import { VAULT_NAME_RE } from "@redgiant/protocol";
import type { JSX } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { Installed } from "../api.js";
import { brandFor, brandOr } from "../brands.js";
import { lang, t } from "../i18n.js";
import {
  IconAlert,
  IconCopy,
  IconDownload,
  IconEye,
  IconKey,
  IconLock,
  IconPencil,
  IconPlus,
  IconSearch,
  IconSend,
  IconServer,
  IconShield,
  IconSpark,
  IconTrash,
  IconUpload,
  IconUser,
  IconWallet,
} from "../icons.js";
import { agents, getApi, openTab, type SettingsSection, vaultDraft } from "../state.js";
import { explain } from "./Brain.js";
import { Acts, Box, Chips, Head, Seg, Slider, Sub, SwitchRow, WzPage } from "./SettingsKit.js";
import { Advanced, Field, Modal } from "./ui.js";

const CATEGORIES: VaultCategory[] = ["api", "login", "bank", "email", "server", "other"];
const CLIPBOARD_MS = 30_000;
const DAY = 86_400_000;

const catIcon = (c: VaultCategory, size = 22): JSX.Element =>
  c === "api" ? (
    <IconKey size={size} />
  ) : c === "login" ? (
    <IconUser size={size} />
  ) : c === "bank" ? (
    <IconWallet size={size} />
  ) : c === "email" ? (
    <IconSend size={size} />
  ) : c === "server" ? (
    <IconServer size={size} />
  ) : (
    <IconLock size={size} />
  );

const iconOf = (e: { brand?: string | undefined; category: VaultCategory; service: string }) => {
  const id = e.brand ?? brandFor(e.service);
  return id ? brandOr(id, catIcon(e.category)) : catIcon(e.category);
};

const when = (iso: string) => {
  const d = new Date(iso);
  const loc = lang.value === "it" ? "it-IT" : "en-US";
  return `${d.toLocaleDateString(loc, { day: "numeric", month: "short" })} ${d.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" })}`;
};

/** Days until it stops working (negative: already), or null without a date. */
const daysLeft = (expires: string | null): number | null => {
  if (!expires) return null;
  const at = new Date(expires).getTime();
  return Number.isNaN(at) ? null : Math.ceil((at - Date.now()) / DAY);
};

const expiryText = (n: number | null): string | null =>
  n === null
    ? null
    : n < 0
      ? t("kcExpired")
      : n === 0
        ? t("kcExpiresToday")
        : n <= 30
          ? t("kcExpiresIn", { n: String(n) })
          : null;

/** A credential's name from its service: lower case, underscores. */
export const vaultName = (service: string) =>
  service
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);

// ---------------------------------------------------------------------------------------------
// The password generator

const SETS = {
  letters: "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789",
  symbols: "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!#$%&*+-=?@_~",
  digits: "0123456789",
} as const;
type Kind = keyof typeof SETS;

/** A random password from the browser's own cryptography (no bias: rejection sampling). */
export function generatePassword(length: number, kind: Kind): string {
  const chars = SETS[kind];
  const limit = 256 - (256 % chars.length);
  let out = "";
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const b of bytes) if (b < limit && out.length < length) out += chars[b % chars.length];
  }
  return out;
}

function Generator({ onUse }: { onUse: (v: string) => void }) {
  const [length, setLength] = useState(24);
  const [kind, setKind] = useState<Kind>("symbols");
  const [made, setMade] = useState(() => generatePassword(24, "symbols"));
  const again = (l = length, k = kind) => setMade(generatePassword(l, k));
  return (
    <div class="kc-gen">
      <Seg
        value={kind}
        label={t("kcGenKind")}
        options={[
          ["symbols", t("kcGenSymbols")],
          ["letters", t("kcGenLetters")],
          ["digits", t("kcGenDigits")],
        ]}
        onChange={(k) => {
          setKind(k);
          const l = k === "digits" ? Math.min(length, 12) : length;
          setLength(l);
          again(l, k);
        }}
      />
      <Slider
        label={t("kcGenLength")}
        value={length}
        min={kind === "digits" ? 4 : 8}
        max={kind === "digits" ? 12 : 64}
        step={kind === "digits" ? 1 : 4}
        format={(v) => t("kcGenChars", { n: String(v) })}
        onChange={(v) => {
          setLength(v);
          again(v);
        }}
      />
      <code class="kc-gen-out">{made}</code>
      <div class="kc-row-acts">
        <button type="button" class="wz-btn small quiet" onClick={() => again()}>
          {t("kcGenAgain")}
        </button>
        <button type="button" class="wz-btn small primary" onClick={() => onUse(made)}>
          {t("kcGenUse")}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Showing and copying a value (the person's own request, confirmed)

function useReveal(id: string | undefined) {
  const [value, setValue] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => () => setValue(null), [id]);
  const get = async () => {
    if (!id) return null;
    try {
      return (await getApi().revealVault(id)).value;
    } catch (err) {
      setError(explain(err));
      return null;
    }
  };
  const copy = async () => {
    const v = value ?? (await get());
    if (v === null) return;
    await navigator.clipboard?.writeText(v).catch(() => {});
    setCopied(true);
    // The clipboard is emptied after 30 s, unless something else was copied since.
    setTimeout(() => {
      setCopied(false);
      void navigator.clipboard
        ?.readText?.()
        .then((now) => (now === v ? navigator.clipboard.writeText("") : undefined))
        .catch(() => navigator.clipboard?.writeText("").catch(() => {}));
    }, CLIPBOARD_MS);
  };
  return {
    value,
    copied,
    error,
    asking,
    ask: () => setAsking(true),
    hide: () => setValue(null),
    cancel: () => setAsking(false),
    show: async () => {
      setAsking(false);
      setValue(await get());
    },
    copy,
  };
}

// ---------------------------------------------------------------------------------------------
// The window of one credential: what it is, its value, where it may go, who may use it

interface Form {
  service: string;
  name: string;
  nameTouched: boolean;
  category: VaultCategory;
  tags: string;
  username: string;
  value: string;
  url: string;
  hosts: string;
  notes: string;
  expires: string;
  ask: VaultAsk;
  allAgents: boolean;
  agents: string[];
  tools: string[];
  automations: string[];
  header: string;
  format: string;
}

const hostsOf = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((h) =>
      h
        .trim()
        .replace(/^https?:\/\//, "")
        .replace(/\/.*$/, "")
        .toLowerCase(),
    )
    .filter(Boolean);

const formOf = (e?: VaultEntry, draft?: typeof vaultDraft.value): Form => ({
  service: e?.service ?? draft?.service ?? "",
  name: e?.name ?? draft?.name ?? (draft?.service ? vaultName(draft.service) : ""),
  nameTouched: Boolean(e || draft?.name),
  category: e?.category ?? "api",
  tags: e?.tags.join(", ") ?? "",
  username: e?.username ?? "",
  value: draft?.value ?? "",
  url: e?.url ?? "",
  hosts: e?.hosts.join(", ") ?? draft?.hosts?.join(", ") ?? "",
  notes: e?.notes ?? "",
  expires: e?.expires?.slice(0, 10) ?? "",
  ask: e?.ask ?? "session",
  allAgents: e?.allow.allAgents ?? true,
  agents: e?.allow.agents ?? [],
  tools: e?.allow.tools ?? [],
  automations: e?.allow.automations ?? [],
  header: e?.inject.header ?? "Authorization",
  format: e?.inject.format ?? "Bearer {value}",
});

/** One credential's window: a new one (filled in from a draft), or one to see and change. */
export function CredentialWindow({
  entry,
  draft,
  uses,
  onClose,
}: {
  entry?: VaultEntry | undefined;
  draft?: typeof vaultDraft.value;
  uses?: VaultUse[];
  onClose: (changed: boolean) => void;
}) {
  const [f, setF] = useState<Form>(() => formOf(entry, draft));
  const [changing, setChanging] = useState(!entry);
  const [gen, setGen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [removing, setRemoving] = useState(false);
  const [tools, setTools] = useState<Installed[]>([]);
  const [autos, setAutos] = useState<Automation[]>([]);
  const r = useReveal(entry?.id);
  useEffect(() => {
    void getApi()
      .installed()
      .then((l) => setTools(l.filter((x) => x.kind === "tool")))
      .catch(() => {});
    void getApi()
      .automations()
      .then(setAutos)
      .catch(() => {});
  }, []);
  const set = (p: Partial<Form>) => setF((x) => ({ ...x, ...p }));
  const nameOk = VAULT_NAME_RE.test(f.name);
  const hosts = hostsOf(f.hosts);
  const valueOk = !changing || f.value.length > 0;
  const save = async () => {
    setBusy(true);
    setError(undefined);
    const brand = brandFor(f.service, f.url);
    const body: VaultInput = {
      name: f.name,
      service: f.service.trim(),
      ...(brand && { brand }),
      category: f.category,
      tags: f.tags
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 12),
      username: f.username,
      ...(changing && f.value && { value: f.value }),
      url: f.url.trim(),
      hosts,
      notes: f.notes,
      expires: f.expires ? new Date(`${f.expires}T12:00:00`).toISOString() : null,
      ask: f.ask,
      allow: {
        allAgents: f.allAgents,
        agents: f.agents,
        tools: f.tools,
        automations: f.automations,
      },
      inject: { header: f.header.trim(), format: f.format.trim() || "{value}" },
    };
    try {
      if (entry) await getApi().editVault(entry.id, body);
      else await getApi().addVault(body);
      onClose(true);
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusy(false);
    }
  };
  const mine = (uses ?? []).filter((u) => entry && u.entryId === entry.id).slice(0, 8);
  const workers = agents.value.filter((a) => a.kind !== "demigod" && a.kind !== "inspector");
  return (
    <Modal
      wide
      title={entry ? entry.service : t("kcAddTitle")}
      sub={entry ? t("kcUseAs", { name: entry.name }) : t("kcAddSub")}
      icon={<span class="kc-ico big">{iconOf({ category: f.category, service: f.service })}</span>}
      class="kc-window"
      onClose={() => onClose(false)}
      foot={
        <Acts>
          {entry && (
            <button type="button" class="wz-btn quiet kc-del" onClick={() => setRemoving(true)}>
              <IconTrash size={16} /> {t("kcRemove")}
            </button>
          )}
          <button type="button" class="wz-btn" onClick={() => onClose(false)}>
            {t("cancel")}
          </button>
          <button
            type="button"
            class="wz-btn primary"
            disabled={busy || !f.service.trim() || !nameOk || !valueOk}
            onClick={() => void save()}
          >
            {t("save")}
          </button>
        </Acts>
      }
    >
      <div class="wz-panel-in kc-form">
        <div class="kc-grid">
          <Field label={t("kcService")} help={t("kcServiceHelp")}>
            <input
              class="wz-field"
              value={f.service}
              placeholder="Revolut Business"
              onInput={(e) => {
                const v = (e.target as HTMLInputElement).value;
                set({ service: v, ...(!f.nameTouched && { name: vaultName(v) }) });
              }}
            />
          </Field>
          <Field
            label={t("kcName")}
            help={t("kcNameHelp")}
            error={f.name && !nameOk ? t("kcNameBad") : undefined}
          >
            <input
              class="wz-field kc-mono"
              value={f.name}
              placeholder="revolut_api"
              onInput={(e) =>
                set({ name: (e.target as HTMLInputElement).value.toLowerCase(), nameTouched: true })
              }
            />
          </Field>
        </div>
        <span class="wz-lb">{t("kcCategory")}</span>
        <Chips
          options={CATEGORIES.map((c) => ({ id: c, label: t(`kcCat_${c}`) }))}
          value={[f.category]}
          onChange={([c]) => c && set({ category: c })}
        />
        <div class="kc-grid">
          <Field label={t("kcUser")}>
            <input
              class="wz-field"
              value={f.username}
              autocomplete="off"
              onInput={(e) => set({ username: (e.target as HTMLInputElement).value })}
            />
          </Field>
          <Field label={t("kcUrl")}>
            <input
              class="wz-field"
              value={f.url}
              placeholder="https://b2b.revolut.com/api/1.0"
              onInput={(e) => {
                const url = (e.target as HTMLInputElement).value;
                const h = hostsOf(url)[0];
                set({ url, ...(!f.hosts.trim() && h && { hosts: h }) });
              }}
            />
          </Field>
        </div>

        <Sub title={t("kcSecret")} lead={t("kcSecretLead")} />
        {!changing && entry ? (
          <div class="kc-secret">
            <code class={`kc-secret-val${r.value !== null ? " shown" : ""}`}>
              {r.value ?? "•".repeat(Math.min(16, Math.max(8, entry.length)))}
            </code>
            <div class="kc-row-acts">
              {r.value === null ? (
                <button type="button" class="wz-btn small quiet" onClick={r.ask}>
                  <IconEye size={16} /> {t("kcShow")}
                </button>
              ) : (
                <button type="button" class="wz-btn small quiet" onClick={r.hide}>
                  {t("kcHide")}
                </button>
              )}
              <button type="button" class="wz-btn small quiet" onClick={() => void r.copy()}>
                <IconCopy size={16} /> {r.copied ? t("kcCopied") : t("kcCopy")}
              </button>
              <button
                type="button"
                class="wz-btn small quiet"
                onClick={() => {
                  r.hide();
                  setChanging(true);
                }}
              >
                <IconPencil size={16} /> {t("kcChange")}
              </button>
            </div>
            {r.copied && <p class="kc-note">{t("kcCopiedNote")}</p>}
            {r.error && <p class="notice error">{r.error}</p>}
          </div>
        ) : (
          <div class="kc-secret">
            <div class="kc-secret-in">
              {gen || draft?.value ? (
                <input
                  class="wz-field kc-mono"
                  value={f.value}
                  autocomplete="off"
                  aria-label={t("kcSecret")}
                  placeholder={t("kcSecretPlaceholder")}
                  onInput={(e) => set({ value: (e.target as HTMLInputElement).value })}
                />
              ) : (
                <input
                  class="wz-field kc-mono"
                  type="password"
                  value={f.value}
                  autocomplete="new-password"
                  aria-label={t("kcSecret")}
                  placeholder={t("kcSecretPlaceholder")}
                  onInput={(e) => set({ value: (e.target as HTMLInputElement).value })}
                />
              )}
              <button type="button" class="wz-btn small quiet" onClick={() => setGen(!gen)}>
                <IconSpark size={16} /> {t("kcGenerate")}
              </button>
            </div>
            {gen && (
              <Generator
                onUse={(v) => {
                  set({ value: v });
                  setGen(false);
                }}
              />
            )}
          </div>
        )}

        <Sub title={t("kcWhere")} lead={t("kcWhereLead")} />
        <Field label={t("kcHosts")} help={t("kcHostsHelp")}>
          <input
            class="wz-field kc-mono"
            value={f.hosts}
            placeholder="b2b.revolut.com"
            onInput={(e) => set({ hosts: (e.target as HTMLInputElement).value })}
          />
        </Field>
        {hosts.length === 0 && <p class="kc-note">{t("kcNoHosts")}</p>}

        <Sub title={t("kcWho")} lead={t("kcWhoLead")} />
        <SwitchRow
          title={t("kcAllAgents")}
          help={t("kcAllAgentsHelp")}
          on={f.allAgents}
          onChange={(on) => set({ allAgents: on })}
        />
        {!f.allAgents && workers.length > 0 && (
          <>
            <span class="wz-lb">{t("kcSomeAgents")}</span>
            <Chips
              multiple
              options={workers.map((a) => ({ id: a.id, label: a.name }))}
              value={f.agents}
              onChange={(v) => set({ agents: v })}
            />
          </>
        )}
        {tools.length > 0 && (
          <>
            <span class="wz-lb">{t("kcTools")}</span>
            <p class="kc-note">{t("kcToolsHelp")}</p>
            <Chips
              multiple
              options={tools.map((x) => ({ id: x.name, label: x.name }))}
              value={f.tools}
              onChange={(v) => set({ tools: v })}
            />
          </>
        )}
        {autos.length > 0 && (
          <>
            <span class="wz-lb">{t("kcAutos")}</span>
            <Chips
              multiple
              options={autos.map((a) => ({ id: a.id, label: a.recipe.description || a.name }))}
              value={f.automations}
              onChange={(v) => set({ automations: v })}
            />
          </>
        )}
        <span class="wz-lb">{t("kcAsk")}</span>
        <Seg
          vertical
          value={f.ask}
          label={t("kcAsk")}
          options={[
            ["session", t("kcAsk_session")],
            ["always", t("kcAsk_always")],
            ["never", t("kcAsk_never")],
          ]}
          onChange={(ask) => set({ ask })}
        />

        <Sub title={t("kcMore")} />
        <div class="kc-grid">
          <Field label={t("kcExpires")} help={t("kcExpiresHelp")}>
            <input
              class="wz-field"
              type="date"
              value={f.expires}
              onInput={(e) => set({ expires: (e.target as HTMLInputElement).value })}
            />
          </Field>
          <Field label={t("kcTags")} help={t("kcTagsHelp")}>
            <input
              class="wz-field"
              value={f.tags}
              onInput={(e) => set({ tags: (e.target as HTMLInputElement).value })}
            />
          </Field>
        </div>
        <Field label={t("kcNotes")}>
          <textarea
            class="wz-field"
            rows={3}
            value={f.notes}
            onInput={(e) => set({ notes: (e.target as HTMLTextAreaElement).value })}
          />
        </Field>
        <Advanced label={t("kcHow")}>
          <p class="kc-note">{t("kcHowHelp")}</p>
          <div class="kc-grid">
            <Field label={t("kcHeader")}>
              <input
                class="wz-field kc-mono"
                value={f.header}
                onInput={(e) => set({ header: (e.target as HTMLInputElement).value })}
              />
            </Field>
            <Field label={t("kcFormat")}>
              <input
                class="wz-field kc-mono"
                value={f.format}
                onInput={(e) => set({ format: (e.target as HTMLInputElement).value })}
              />
            </Field>
          </div>
        </Advanced>

        {entry && (
          <>
            <Sub title={t("kcUsesOne")} />
            {mine.length === 0 ? (
              <p class="kc-note">{t("kcNeverUsed")}</p>
            ) : (
              <ul class="kc-uses">
                {mine.map((u) => (
                  <UseRow key={u.id} u={u} />
                ))}
              </ul>
            )}
          </>
        )}
        {error && <p class="notice error">{error}</p>}
      </div>
      {r.asking && (
        <Modal title={t("kcShowQ")} onClose={r.cancel}>
          <div class="wz-panel-in">
            <p class="wz-lead2">{t("kcShowText")}</p>
          </div>
          <Acts>
            <button type="button" class="wz-btn" onClick={r.cancel}>
              {t("cancel")}
            </button>
            <button type="button" class="wz-btn primary" onClick={() => void r.show()}>
              <IconEye size={16} /> {t("kcShow")}
            </button>
          </Acts>
        </Modal>
      )}
      {removing && entry && (
        <Modal title={t("kcRemoveQ", { name: entry.service })} onClose={() => setRemoving(false)}>
          <div class="wz-panel-in">
            <p class="wz-lead2">{t("kcRemoveText")}</p>
          </div>
          <Acts>
            <button type="button" class="wz-btn" onClick={() => setRemoving(false)}>
              {t("cancel")}
            </button>
            <button
              type="button"
              class="wz-btn primary danger"
              onClick={() =>
                void getApi()
                  .removeVault(entry.id)
                  .then(() => onClose(true))
                  .catch((err: unknown) => {
                    setRemoving(false);
                    setError(explain(err));
                  })
              }
            >
              {t("kcRemove")}
            </button>
          </Acts>
        </Modal>
      )}
    </Modal>
  );
}

function UseRow({ u }: { u: VaultUse }) {
  return (
    <li class={`kc-use ${u.outcome}`}>
      <span class="kc-use-what">
        <b>{u.agentName ?? t("kcSomeone")}</b>{" "}
        {t(`kcUse_${u.outcome}`, { name: u.name, host: u.host })}
        {u.reason && u.outcome !== "used" && <small>{u.reason}</small>}
      </span>
      <span class="kc-use-when">{when(u.at)}</span>
    </li>
  );
}

// ---------------------------------------------------------------------------------------------
// Importing (a password manager's CSV, or a keychain file) and exporting (sealed)

function ImportWindow({ onClose }: { onClose: (changed: boolean) => void }) {
  const [preview, setPreview] = useState<VaultImportPreview>();
  const [keep, setKeep] = useState<number[]>([]);
  const [sealed, setSealed] = useState<string>();
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<number>();
  const read = async (file: File) => {
    setError(undefined);
    const text = await file.text();
    if (text.startsWith("REDGIANT-KEYCHAIN")) {
      setSealed(text);
      return;
    }
    try {
      const p = await getApi().previewVaultImport(text);
      setPreview(p);
      setKeep(p.rows.map((_, i) => i));
    } catch (err) {
      setError(explain(err));
    }
  };
  const go = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const r = sealed
        ? await getApi().importVaultFile(sealed, pass)
        : preview
          ? await getApi().confirmVaultImport(preview.id, keep)
          : { added: 0 };
      setDone(r.added);
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      wide
      title={t("kcImportTitle")}
      onClose={() => onClose(done !== undefined)}
      foot={
        <Acts>
          {done !== undefined ? (
            <button type="button" class="wz-btn primary" onClick={() => onClose(true)}>
              {t("close")}
            </button>
          ) : (
            <>
              <button type="button" class="wz-btn" onClick={() => onClose(false)}>
                {t("cancel")}
              </button>
              {(preview || sealed) && (
                <button
                  type="button"
                  class="wz-btn primary"
                  disabled={
                    busy || (!sealed && keep.length === 0) || (sealed !== undefined && !pass)
                  }
                  onClick={() => void go()}
                >
                  {sealed
                    ? t("kcImportSealedGo")
                    : t("kcImportGo", { n: String(preview ? keep.length : 0) })}
                </button>
              )}
            </>
          )}
        </Acts>
      }
    >
      <div class="wz-panel-in kc-form">
        {done !== undefined ? (
          <p class="notice ok">{t("kcImported", { n: String(done) })}</p>
        ) : !preview && !sealed ? (
          <>
            <p class="wz-lead2">{t("kcImportLead")}</p>
            <ul class="kc-import-how">
              <li>{t("kcImportBitwarden")}</li>
              <li>{t("kcImport1password")}</li>
              <li>{t("kcImportChrome")}</li>
              <li>{t("kcImportFirefox")}</li>
            </ul>
            <label class="wz-btn primary kc-file">
              <IconUpload size={18} /> {t("kcImportPick")}
              <input
                type="file"
                accept=".csv,.rgkeychain,text/csv"
                onChange={(e) => {
                  const file = (e.target as HTMLInputElement).files?.[0];
                  if (file) void read(file);
                }}
              />
            </label>
            <p class="kc-note">{t("kcImportSafe")}</p>
          </>
        ) : sealed ? (
          <Field label={t("kcPassphrase")} help={t("kcImportSealedHelp")}>
            <input
              class="wz-field"
              type="password"
              value={pass}
              onInput={(e) => setPass((e.target as HTMLInputElement).value)}
            />
          </Field>
        ) : (
          preview && (
            <>
              <p class="wz-lead2">
                {t("kcImportFound", {
                  n: String(preview.rows.length),
                  from: t(`kcFormat_${preview.format}`),
                })}
                {preview.skipped > 0 && ` ${t("kcImportSkipped", { n: String(preview.skipped) })}`}
              </p>
              <p class="kc-note">{t("kcImportLogins")}</p>
              <div class="kc-row-acts">
                <button
                  type="button"
                  class="wz-btn small quiet"
                  onClick={() => setKeep(preview.rows.map((_, i) => i))}
                >
                  {t("kcAll")}
                </button>
                <button type="button" class="wz-btn small quiet" onClick={() => setKeep([])}>
                  {t("kcNone")}
                </button>
              </div>
              <div class="kc-import-list">
                {preview.rows.map((row, i) => {
                  const on = keep.includes(i);
                  return (
                    <button
                      type="button"
                      key={`${row.name}-${String(i)}`}
                      class={`kc-pick${on ? " on" : ""}`}
                      aria-pressed={on}
                      onClick={() => setKeep(on ? keep.filter((k) => k !== i) : [...keep, i])}
                    >
                      <span class="kc-ico">
                        {iconOf({ category: "login", service: `${row.service} ${row.url}` })}
                      </span>
                      <span class="kc-item-text">
                        <b>{row.service}</b>
                        <small>{row.username || row.url}</small>
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          )
        )}
        {error && <p class="notice error">{error}</p>}
      </div>
    </Modal>
  );
}

function ExportWindow({ onClose }: { onClose: () => void }) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);
  const go = async () => {
    setError(undefined);
    try {
      const { file } = await getApi().exportVault(a);
      const url = URL.createObjectURL(new Blob([file], { type: "application/octet-stream" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `redgiant-keychain-${new Date().toISOString().slice(0, 10)}.rgkeychain`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setDone(true);
    } catch (err) {
      setError(explain(err));
    }
  };
  return (
    <Modal
      title={t("kcExportTitle")}
      onClose={onClose}
      foot={
        <Acts>
          <button type="button" class="wz-btn" onClick={onClose}>
            {done ? t("close") : t("cancel")}
          </button>
          {!done && (
            <button
              type="button"
              class="wz-btn primary"
              disabled={a.length < 8 || a !== b}
              onClick={() => void go()}
            >
              <IconDownload size={18} /> {t("kcExportGo")}
            </button>
          )}
        </Acts>
      }
    >
      <div class="wz-panel-in kc-form">
        {done ? (
          <p class="notice ok">{t("kcExported")}</p>
        ) : (
          <>
            <p class="wz-lead2">{t("kcExportLead")}</p>
            <Field label={t("kcPassphrase")} help={t("kcPassphraseHelp")}>
              <input
                class="wz-field"
                type="password"
                autocomplete="new-password"
                value={a}
                onInput={(e) => setA((e.target as HTMLInputElement).value)}
              />
            </Field>
            <Field
              label={t("kcPassphraseAgain")}
              error={b && a !== b ? t("kcPassphraseDiffer") : undefined}
            >
              <input
                class="wz-field"
                type="password"
                autocomplete="new-password"
                value={b}
                onInput={(e) => setB((e.target as HTMLInputElement).value)}
              />
            </Field>
          </>
        )}
        {error && <p class="notice error">{error}</p>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// The page

function Item({ e, onOpen }: { e: VaultEntry; onOpen: () => void }) {
  const left = expiryText(daysLeft(e.expires));
  return (
    <button type="button" class={`kc-item${left ? " warn" : ""}`} onClick={onOpen}>
      <span class="kc-ico">{iconOf(e)}</span>
      <span class="kc-item-text">
        <b>{e.service}</b>
        <small>
          <code>{e.name}</code>
          {e.username && ` · ${e.username}`}
        </small>
        {e.tags.length > 0 && (
          <span class="kc-tags">
            {e.tags.map((x) => (
              <span key={x} class="kc-tag">
                {x}
              </span>
            ))}
          </span>
        )}
      </span>
      <span class="kc-item-state">
        {left ? (
          <span class="kc-warn">{left}</span>
        ) : e.lastUsedAt ? (
          t("kcUsedTimes", { n: String(e.uses), when: when(e.lastUsedAt) })
        ) : (
          t("kcNeverUsed")
        )}
      </span>
    </button>
  );
}

function SystemItem({ e }: { e: VaultSystemEntry }) {
  return (
    <div class="kc-item kc-system">
      <span class="kc-ico">{iconOf({ ...e, service: e.service })}</span>
      <span class="kc-item-text">
        <b>{e.service}</b>
        <small>{t(`kcSys_${e.kind}`, { what: e.what })}</small>
      </span>
      <button
        type="button"
        class="wz-btn small quiet"
        onClick={() =>
          openTab({
            id: "settings",
            type: "settings",
            title: t("settings"),
            section: e.section as SettingsSection,
          })
        }
      >
        {t("kcManage")}
      </button>
    </div>
  );
}

type Filter = VaultCategory | "all" | "system";

export function Keychain() {
  const [view, setView] = useState<VaultView>();
  const [error, setError] = useState<string>();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<{ entry?: VaultEntry; draft?: typeof vaultDraft.value }>();
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const load = () =>
    getApi()
      .vault()
      .then(setView)
      .catch((err: unknown) => setError(explain(err)));
  useEffect(() => {
    void load();
  }, []);
  // A credential to add from elsewhere (a magic automation, a secret held back from a chat).
  const draft = vaultDraft.value;
  useEffect(() => {
    if (!draft) return;
    setOpen({ draft });
    vaultDraft.value = null;
  }, [draft]);
  const words = q.trim().toLowerCase();
  const match = (s: string) => !words || s.toLowerCase().includes(words);
  const entries = useMemo(
    () =>
      (view?.entries ?? []).filter(
        (e) =>
          (filter === "all" || filter === e.category) &&
          match(`${e.service} ${e.name} ${e.username} ${e.url} ${e.tags.join(" ")} ${e.notes}`),
      ),
    [view, filter, words],
  );
  const system = (view?.system ?? []).filter(
    (e) =>
      (filter === "all" || filter === "system" || filter === e.category) &&
      match(`${e.service} ${e.what}`),
  );
  const expiring = (view?.entries ?? []).filter((e) => expiryText(daysLeft(e.expires)) !== null);
  const counts = (c: Filter) =>
    c === "all"
      ? (view?.entries.length ?? 0)
      : c === "system"
        ? (view?.system.length ?? 0)
        : (view?.entries.filter((e) => e.category === c).length ?? 0);
  const filters: Filter[] = ["all", ...CATEGORIES.filter((c) => counts(c) > 0), "system"];
  const closed = view && !view.ready;
  return (
    <WzPage
      class="kc-page"
      after={
        <>
          {open && (
            <CredentialWindow
              entry={open.entry}
              draft={open.draft}
              uses={view?.uses ?? []}
              onClose={(changed) => {
                setOpen(undefined);
                if (changed) void load();
              }}
            />
          )}
          {importing && (
            <ImportWindow
              onClose={(changed) => {
                setImporting(false);
                if (changed) void load();
              }}
            />
          )}
          {exporting && <ExportWindow onClose={() => setExporting(false)} />}
        </>
      }
    >
      <Head eyebrow={t("kcEyebrow")} q={t("kcQ")} lead={t("kcLead")} />
      {error && <p class="notice error">{error}</p>}
      {closed ? (
        <Box class="kc-closed">
          <p class="kc-closed-title">
            <IconAlert size={20} /> {t("kcClosed")}
          </p>
          <p class="kc-note">{view.reason}</p>
        </Box>
      ) : (
        view && (
          <>
            <div class="kc-safe">
              <span class="kc-safe-ico">
                <IconShield size={22} />
              </span>
              <span>
                <b>{t(`kcProt_${view.protection ?? "file"}`)}</b>
                <small>{t("kcSafeText")}</small>
              </span>
            </div>
            {expiring.length > 0 && (
              <div class="kc-expiring">
                <IconAlert size={18} />
                <span>
                  {t("kcExpiringLead")}{" "}
                  {expiring.map((e, i) => (
                    <span key={e.id}>
                      {i > 0 && ", "}
                      <button
                        type="button"
                        class="wz-link inl"
                        onClick={() => setOpen({ entry: e })}
                      >
                        {e.service}
                      </button>{" "}
                      ({expiryText(daysLeft(e.expires))})
                    </span>
                  ))}
                </span>
              </div>
            )}
            <div class="kc-bar">
              <label class="kc-search">
                <IconSearch size={18} />
                <input
                  value={q}
                  placeholder={t("kcSearch")}
                  aria-label={t("kcSearch")}
                  onInput={(e) => setQ((e.target as HTMLInputElement).value)}
                />
              </label>
              <button type="button" class="wz-btn primary" onClick={() => setOpen({})}>
                <IconPlus size={18} /> {t("kcAdd")}
              </button>
            </div>
            <div class="kc-filters">
              <Chips
                options={filters.map((c) => ({
                  id: c,
                  label: `${c === "all" ? t("kcAllCats") : c === "system" ? t("kcSystem") : t(`kcCat_${c}`)} ${counts(c)}`,
                }))}
                value={[filter]}
                onChange={([c]) => c && setFilter(c)}
              />
            </div>
            {filter !== "system" &&
              (entries.length === 0 ? (
                <div class="kc-empty">
                  <span class="kc-ico big">
                    <IconKey size={26} />
                  </span>
                  <p>{view.entries.length === 0 ? t("kcEmpty") : t("kcNoMatch")}</p>
                </div>
              ) : (
                <div class="kc-list">
                  {entries.map((e) => (
                    <Item key={e.id} e={e} onOpen={() => setOpen({ entry: e })} />
                  ))}
                </div>
              ))}
            {system.length > 0 && (
              <>
                <Sub title={t("kcSystemTitle")} lead={t("kcSystemLead")} />
                <div class="kc-list">
                  {system.map((e) => (
                    <SystemItem key={e.id} e={e} />
                  ))}
                </div>
              </>
            )}
            <Sub title={t("kcUsesTitle")} lead={t("kcUsesLead")} />
            {view.uses.length === 0 ? (
              <p class="kc-note">{t("kcNoUses")}</p>
            ) : (
              <ul class="kc-uses">
                {view.uses.slice(0, 12).map((u) => (
                  <UseRow key={u.id} u={u} />
                ))}
              </ul>
            )}
            <Sub title={t("kcMoveTitle")} lead={t("kcMoveLead")} />
            <div class="kc-row-acts kc-move">
              <button type="button" class="wz-btn" onClick={() => setImporting(true)}>
                <IconUpload size={18} /> {t("kcImport")}
              </button>
              <button
                type="button"
                class="wz-btn"
                disabled={view.entries.length === 0}
                onClick={() => setExporting(true)}
              >
                <IconDownload size={18} /> {t("kcExport")}
              </button>
            </div>
            <p class="kc-note">{t(view.proxy ? "kcAgentsHow" : "kcAgentsHowNoProxy")}</p>
          </>
        )
      )}
    </WzPage>
  );
}
