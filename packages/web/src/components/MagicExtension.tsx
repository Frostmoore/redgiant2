// Magic integrations and extensions (G38.3): the same button and window as the magic automations.
// The person writes what they want, God asks in a real conversation and proposes one package; the
// window shows what it is (its tools with their arguments, the hosts it reaches, the keys it needs),
// how its tests went in the throwaway sandbox and what is still missing. «Approve and install» stays
// off until nothing is; the keys are added right here (into the keychain, never in the chat).
import type { MagicCheck, MagicExtension, MagicExtKind, MagicPart } from "@redgiant/protocol";
import { useEffect, useState } from "preact/hooks";
import { type Key, t } from "../i18n.js";
import {
  IconAlert,
  IconBook,
  IconCheck,
  IconGlobe,
  IconKey,
  IconRefresh,
  IconSpark,
  IconTool,
  IconX,
} from "../icons.js";
import { attempt, getApi } from "../state.js";
import { explain } from "./Brain.js";
import { Chat } from "./Chat.js";
import { askConfirm, askText } from "./dialogs.js";
import { MagicStart, type MagicWords, Steps } from "./MagicAutomation.js";
import { Acts } from "./SettingsKit.js";
import { Field, Modal } from "./ui.js";

/** The words of the two entry points. */
export const MAGIC_EXT_WORDS: Record<MagicExtKind, MagicWords> = {
  integration: {
    title: "mxIntegration",
    lead: "mxIntegrationLead",
    ask: "mxIntegrationAsk",
    placeholder: "mxIntegrationPlaceholder",
    examples: ["mxIntegrationEx1", "mxIntegrationEx2", "mxIntegrationEx3"],
    promises: ["mxPromise1", "mxPromise2", "mxPromise3"],
  },
  extension: {
    title: "mxExtension",
    lead: "mxExtensionLead",
    ask: "mxExtensionAsk",
    placeholder: "mxExtensionPlaceholder",
    examples: ["mxExtensionEx1", "mxExtensionEx2", "mxExtensionEx3"],
    promises: ["mxPromise1", "mxPromise2", "mxPromise3"],
  },
};

const STEPS: Key[] = ["mxStep1", "mxStep2", "mxStep3"];

/** The window where the person says what the integration or extension should do. */
export function MagicExtStart({
  kind,
  onClose,
  onStarted,
}: {
  kind: MagicExtKind;
  onClose: () => void;
  onStarted: (m: MagicExtension) => void;
}) {
  return (
    <MagicStart<MagicExtension>
      words={MAGIC_EXT_WORDS[kind]}
      start={(text) => getApi().startMagicExt(kind, text)}
      onClose={onClose}
      onStarted={onStarted}
    />
  );
}

/** A tool's arguments, by name, from its JSON schema. */
function args(schema: Record<string, unknown> | undefined): string[] {
  const props = (schema?.properties ?? {}) as Record<string, unknown>;
  const required = new Set((schema?.required ?? []) as string[]);
  return Object.keys(props).map((k) => (required.has(k) ? k : `${k}?`));
}

/** One part of the package: what it does, its arguments, its tests, its files. */
function Part({ p }: { p: MagicPart }) {
  const failed = p.tests.filter((x) => !x.passed);
  const list = args(p.inputSchema);
  return (
    <div class={`mx-part${failed.length || p.status === "failed" ? " bad" : ""}`}>
      <div class="mx-part-head">
        <span class="mx-part-ico">
          {p.kind === "tool" ? <IconTool size={18} /> : <IconBook size={18} />}
        </span>
        <b>{p.name}</b>
        <span class="mx-part-kind">{t(p.kind === "tool" ? "extKindTool" : "extKindSkill")}</span>
      </div>
      <p class="mx-part-desc">{p.description}</p>
      {list.length > 0 && (
        <p class="mx-args">
          <span>{t("mxArgs")}</span>
          {list.map((a) => (
            <code key={a}>{a}</code>
          ))}
        </p>
      )}
      <ul class="mx-tests">
        {p.tests.map((x) => (
          <li key={x.name} class={x.passed ? "ok" : "bad"}>
            {x.passed ? <IconCheck size={16} /> : <IconX size={16} />}
            <span>
              {x.name}
              {!x.passed && (
                <small>{x.detail.split("\n").filter(Boolean).slice(0, 3).join(" · ")}</small>
              )}
            </span>
          </li>
        ))}
      </ul>
      {Object.keys(p.files).length > 0 && (
        <details class="xw-file">
          <summary>{t("mxCode")}</summary>
          {p.command && <code class="xw-cmd">{p.command}</code>}
          {Object.entries(p.files).map(([path, content]) => (
            <div key={path}>
              <code>{path}</code>
              <pre>{content}</pre>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

/** The key's window: the value goes into the keychain, used by this package only. */
function KeyWindow({
  m,
  c,
  onClose,
}: {
  m: MagicExtension;
  c: MagicCheck;
  onClose: (changed: boolean) => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const cred = m.proposal?.credentials.find((x) => x.name === c.what);
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await getApi().addMagicExtCredential(m.id, c.what, value);
      setValue("");
      onClose(true);
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t("mxKeyTitle", { service: c.service ?? c.what })}
      icon={<IconKey size={20} />}
      onClose={() => onClose(false)}
      foot={
        <Acts>
          <button type="button" class="wz-btn quiet" onClick={() => onClose(false)}>
            {t("cancel")}
          </button>
          <button
            type="button"
            class="wz-btn primary"
            disabled={busy || !value.trim()}
            onClick={() => void save()}
          >
            <IconKey size={18} /> {t("mxKeySave")}
          </button>
        </Acts>
      }
    >
      <div class="wz-panel-in mx-key">
        <p class="wz-lead2">{t("mxKeyLead")}</p>
        {cred?.why && <p class="ui-help">{cred.why}</p>}
        {cred?.help && <p class="ui-help">{cred.help}</p>}
        <Field label={t("mxKeyValue")}>
          <input
            class="wz-field"
            type="password"
            autocomplete="off"
            value={value}
            onInput={(e) => setValue((e.target as HTMLInputElement).value)}
          />
        </Field>
        <ul class="mx-key-facts">
          <li>
            {t("mxKeyName")} <code>{c.what}</code>
          </li>
          <li>
            {t("mxKeyHosts")}{" "}
            {(c.hosts ?? []).map((h) => (
              <code key={h}>{h}</code>
            ))}
          </li>
          <li>{t("mxKeyOnly")}</li>
        </ul>
        {error && <p class="notice error">{error}</p>}
      </div>
    </Modal>
  );
}

/** One thing still missing (or there), with the person's way to make it. */
function Check({ c, onKey, onBind }: { c: MagicCheck; onKey: () => void; onBind: () => void }) {
  const words =
    c.kind === "credential"
      ? c.detail === "undeclared"
        ? t("mxCheckKeyUndeclared", { what: c.what })
        : t("mxCheckKey", { what: c.service ?? c.what })
      : c.kind === "host"
        ? t("mxCheckHost", { what: c.what })
        : t("mxCheckTest", { what: c.what });
  const why = c.ok
    ? ""
    : c.kind === "credential"
      ? c.detail === "undeclared"
        ? t("mxWhyGod")
        : c.exists
          ? t("mxWhyNotGiven")
          : t("mxWhyMissing")
      : c.kind === "host"
        ? t("mxWhyHost")
        : t("mxWhyTest");
  return (
    <div class={`mg-need${c.ok ? " ok" : " need"}`}>
      <span class="mg-need-ico">
        {c.kind === "credential" ? (
          <IconKey size={18} />
        ) : c.kind === "host" ? (
          <IconGlobe size={18} />
        ) : (
          <IconTool size={18} />
        )}
      </span>
      <span class="mg-need-text">
        <b>{words}</b>
        {why && <small>{why}</small>}
      </span>
      <span class="mg-need-state">{c.ok ? t("axNeedReady") : t("axNeedMissing")}</span>
      {!c.ok && c.kind === "credential" && c.detail !== "undeclared" && (
        <button type="button" class="wz-btn small primary" onClick={c.exists ? onBind : onKey}>
          {c.exists ? t("mxGiveKey") : t("axNeedVault")}
        </button>
      )}
    </div>
  );
}

/** God's package as a preview: what it is, its tests, what is missing, and the choice. */
function Package({ m, onChange }: { m: MagicExtension; onChange: () => void }) {
  const p = m.proposal;
  const [why, setWhy] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [key, setKey] = useState<MagicCheck | null>(null);
  if (!p) return null;
  const missing = m.checks.filter((c) => !c.ok);
  const there = m.checks.filter((c) => c.ok && c.kind === "credential");
  const testing = m.status === "testing";
  const approve = async () => {
    setError(undefined);
    try {
      await getApi().approveMagicExt(m.id);
      onChange();
    } catch (err) {
      setError(explain(err));
    }
  };
  const bind = async (c: MagicCheck) => {
    const yes = await askConfirm(t("mxGiveKeyTitle", { what: c.what }), {
      text: t("mxGiveKeyText", {
        tools: p.parts
          .filter((x) => x.kind === "tool")
          .map((x) => x.name)
          .join(", "),
        hosts: (c.hosts ?? []).join(", "),
      }),
      yes: t("mxGiveKey"),
    });
    if (yes) void attempt(() => getApi().bindMagicExtCredential(m.id, c.what)).then(onChange);
  };
  return (
    <section class="mg-proposal mx-package">
      <div class="mg-proposal-head">
        <span class="mg-orb small">
          <IconSpark size={16} />
        </span>
        <b>{t("mxProposal")}</b>
      </div>
      <h3>{p.title}</h3>
      <p class="mg-summary">{p.summary}</p>
      {testing && (
        <p class="notice mx-testing" role="status">
          <IconRefresh size={16} /> {t("mxTesting")}
        </p>
      )}
      {!testing && missing.length > 0 && (
        <div class="mg-missing" role="status">
          <p class="mg-missing-lead">
            <IconAlert size={18} /> {t("mxMissing")}
          </p>
          {missing.map((c) => (
            <Check
              key={`${c.kind}:${c.what}`}
              c={c}
              onKey={() => setKey(c)}
              onBind={() => void bind(c)}
            />
          ))}
        </div>
      )}
      <div class="mx-reach">
        <span class="wz-lb">{t("mxReaches")}</span>
        <p>
          {p.hosts.length === 0
            ? t("mxReachesNothing")
            : p.hosts.map((h) => <code key={h}>{h}</code>)}
        </p>
      </div>
      {there.length > 0 && (
        <div class="mg-needs">
          <span class="wz-lb">{t("mxKeys")}</span>
          {there.map((c) => (
            <Check key={c.what} c={c} onKey={() => {}} onBind={() => {}} />
          ))}
        </div>
      )}
      <span class="wz-lb">{t("mxParts")}</span>
      <div class="mx-parts">
        {p.parts.map((x) => (
          <Part key={x.proposalId} p={x} />
        ))}
      </div>
      {why !== null && (
        <Field label={t("axMagicWhy")}>
          <textarea
            class="wz-field"
            rows={2}
            value={why}
            onInput={(e) => setWhy((e.target as HTMLTextAreaElement).value)}
          />
        </Field>
      )}
      {error && <p class="notice error">{error}</p>}
      <div class="mg-acts">
        {why === null ? (
          <button type="button" class="wz-btn quiet" onClick={() => setWhy("")}>
            {t("axMagicReject")}
          </button>
        ) : (
          <button
            type="button"
            class="wz-btn quiet"
            onClick={() =>
              void attempt(() => getApi().rejectMagicExt(m.id, why.trim() || undefined)).then(
                () => {
                  setWhy(null);
                  onChange();
                },
              )
            }
          >
            {t("axMagicSendNo")}
          </button>
        )}
        <button
          type="button"
          class="wz-btn"
          disabled={testing}
          onClick={() => void attempt(() => getApi().retestMagicExt(m.id)).then(onChange)}
        >
          <IconRefresh size={18} /> {t("mxRetest")}
        </button>
        <button
          type="button"
          class="wz-btn primary mx-approve"
          disabled={!m.canApprove}
          title={m.canApprove ? undefined : t("mxMissing")}
          onClick={() => void approve()}
        >
          {t("mxApprove")}
        </button>
      </div>
      {key && (
        <KeyWindow
          m={m}
          c={key}
          onClose={(changed) => {
            setKey(null);
            if (changed) onChange();
          }}
        />
      )}
    </section>
  );
}

/** An installed package: what it gave, a change through the same conversation, uninstall. */
function Installed({
  m,
  onChange,
  onClose,
}: {
  m: MagicExtension;
  onChange: () => void;
  onClose: () => void;
}) {
  const change = async () => {
    const text = await askText(t("mxChange"), "", {
      label: t("mxChangeLabel"),
      yes: t("mxChangeGo"),
    });
    if (text?.trim()) void attempt(() => getApi().updateMagicExt(m.id, text.trim())).then(onChange);
  };
  const remove = async () => {
    const yes = await askConfirm(t("mxUninstallTitle", { what: m.title }), {
      text: t("mxUninstallText", { what: m.installed.join(", ") }),
      yes: t("mxUninstall"),
      danger: true,
    });
    if (yes)
      void attempt(() => getApi().uninstallMagicExt(m.id)).then(() => {
        onChange();
        onClose();
      });
  };
  return (
    <section class="mg-proposal mx-package">
      <p class="notice ok">{t("mxDone")}</p>
      <div class="mx-installed">
        {m.installed.map((n) => (
          <code key={n}>{n}</code>
        ))}
      </div>
      <div class="mg-acts">
        <button type="button" class="wz-btn quiet xw-danger" onClick={() => void remove()}>
          {t("mxUninstall")}
        </button>
        <button type="button" class="wz-btn primary" onClick={() => void change()}>
          {t("mxChange")}
        </button>
      </div>
    </section>
  );
}

/** A magic integration's window: the package beside (on a phone above) the conversation. */
export function MagicExtChat({
  m,
  onClose,
  onChange,
}: {
  m: MagicExtension;
  onClose: () => void;
  onChange: () => void;
}) {
  // While God works, the tests run or something is missing, the window reads it again now and
  // then: what the person adds (a key) or God proposes lights up by itself.
  const waiting =
    m.status === "building" || m.status === "testing" || (m.status === "ready" && !m.canApprove);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(onChange, 3000);
    window.addEventListener("focus", onChange);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onChange);
    };
  }, [waiting]);
  return (
    <Modal
      wide
      title={`${t(m.kind === "integration" ? "mxIntegration" : "mxExtension")}: ${m.title}`}
      sub={t(`mxState_${m.status}` as Key)}
      icon={
        <span class="mg-orb">
          <IconSpark size={20} />
        </span>
      }
      class="mg-window mg-chat-window"
      onClose={onClose}
    >
      <div class="mg-chat">
        <aside class="mg-side">
          <Steps status={m.status} labels={STEPS} />
          {(m.status === "ready" || m.status === "testing") && (
            <Package m={m} onChange={onChange} />
          )}
          {m.status === "done" && <Installed m={m} onChange={onChange} onClose={onClose} />}
          {m.status === "building" && (
            <div class="mg-hint">
              <span>{t(m.installed.length ? "mxChanging" : "mxBuilding")}</span>
              {m.installed.length === 0 && (
                <button
                  type="button"
                  class="wz-link inl"
                  onClick={() =>
                    void attempt(() => getApi().dismissMagicExt(m.id)).then(() => {
                      onChange();
                      onClose();
                    })
                  }
                >
                  {t("axMagicDismiss")}
                </button>
              )}
            </div>
          )}
        </aside>
        <div class="mg-chat-body">
          <Chat sessionId={m.sessionId} agentId={m.agentId} />
        </div>
      </div>
    </Modal>
  );
}
