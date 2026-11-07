// Magic automations (G33.3): the person writes what they want, a conversation with God starts and
// builds it. The conversation is a real one (the same chat as everywhere), with God's proposal on
// top as a preview in words: approve it, change it in the editor first, or say what is wrong.
// Nothing becomes an automation before the person's yes.
import type { Automation, MagicAutomation, MagicNeed, Recipe } from "@redgiant/protocol";
import { useEffect, useState } from "preact/hooks";
import { t } from "../i18n.js";
import { IconAlert, IconChat, IconKey, IconPuzzle, IconSend, IconSpark } from "../icons.js";
import { attempt, getApi, openTab } from "../state.js";
import { Editor, fromRecipe, PLATFORM_NAMES, sentence } from "./AutomationEditor.js";
import { explain } from "./Brain.js";
import { Chat } from "./Chat.js";
import { CredentialWindow } from "./Keychain.js";
import { Acts } from "./SettingsKit.js";
import { Field, Modal } from "./ui.js";

const EXAMPLES = ["axMagicEx1", "axMagicEx2", "axMagicEx3"] as const;

/** The window where the person says what the automation should do. */
export function MagicStart({
  onClose,
  onStarted,
}: {
  onClose: () => void;
  onStarted: (m: MagicAutomation) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const go = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onStarted(await getApi().startMagic(text.trim()));
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t("axMagic")}
      icon={
        <span class="mg-orb">
          <IconSpark size={20} />
        </span>
      }
      class="mg-window"
      onClose={onClose}
      foot={
        <Acts>
          <button type="button" class="wz-btn quiet" onClick={onClose}>
            {t("cancel")}
          </button>
          <button
            type="button"
            class="wz-btn primary mg-go"
            disabled={busy || !text.trim()}
            onClick={() => void go()}
          >
            <IconSpark size={18} /> {busy ? t("axMagicStarting") : t("axMagicGo")}
          </button>
        </Acts>
      }
    >
      <div class="wz-panel-in mg-start">
        <p class="wz-lead2">{t("axMagicLead")}</p>
        <Field label={t("axMagicAsk")}>
          <textarea
            class="wz-field mg-ask"
            rows={5}
            value={text}
            placeholder={t("axMagicPlaceholder")}
            onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          />
        </Field>
        <span class="wz-lb">{t("axMagicExamples")}</span>
        <div class="mg-examples">
          {EXAMPLES.map((k) => (
            <button key={k} type="button" class="mg-example" onClick={() => setText(t(k))}>
              {t(k)}
            </button>
          ))}
        </div>
        <ul class="mg-promises">
          <li>{t("axMagicPromise1")}</li>
          <li>{t("axMagicPromise2")}</li>
          <li>{t("axMagicPromise3")}</li>
        </ul>
        {error && <p class="notice error">{error}</p>}
      </div>
    </Modal>
  );
}

/** Where to make what is missing (a credential opens its window right here instead). */
function openNeed(n: MagicNeed) {
  const section =
    n.kind === "chat"
      ? n.what === "telegram"
        ? "telegram"
        : "chats"
      : n.kind === "email"
        ? "automations"
        : "extensions";
  openTab({ id: "settings", type: "settings", title: t("settings"), section });
}

const needIcon = (n: MagicNeed) =>
  n.kind === "chat" ? (
    <IconChat size={18} />
  ) : n.kind === "email" ? (
    <IconSend size={18} />
  ) : n.kind === "credential" ? (
    <IconKey size={18} />
  ) : (
    <IconPuzzle size={18} />
  );

/** One thing the automation needs: what, why, whether it is there, and the button to make it. */
function Need({ n, onFix }: { n: MagicNeed; onFix: () => void }) {
  return (
    <div class={`mg-need${n.ready ? " ok" : n.ready === false ? " need" : ""}`}>
      <span class="mg-need-ico">{needIcon(n)}</span>
      <span class="mg-need-text">
        <b>
          {t(`axNeed_${n.kind}` as never, {
            what: PLATFORM_NAMES[n.what.toLowerCase()] ?? n.service ?? n.what,
          })}
        </b>
        {n.why && <small>{n.why}</small>}
      </span>
      <span class="mg-need-state">
        {n.ready ? t("axNeedReady") : n.ready === false ? t("axNeedMissing") : ""}
      </span>
      {n.ready === false && (
        <button type="button" class="wz-btn small primary" onClick={onFix}>
          {n.kind === "credential" ? t("axNeedVault") : t("axNeedOpen")}
        </button>
      )}
    </div>
  );
}

/** God's proposal as a preview: the automation in words, what it still needs, and the choice. */
function Proposal({
  m,
  onChange,
  onEdit,
  onCreated,
}: {
  m: MagicAutomation;
  onChange: () => void;
  onEdit: () => void;
  onCreated: (a: Automation) => void;
}) {
  const p = m.proposal;
  const [why, setWhy] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [credential, setCredential] = useState<MagicNeed | null>(null);
  const missing = p?.needs.filter((n) => n.ready === false) ?? [];
  // While something is missing the proposal is read again now and then: what the person makes
  // elsewhere (a chat linked, a key added) lights up here by itself.
  useEffect(() => {
    if (missing.length === 0) return;
    const again = () => onChange();
    const timer = setInterval(again, 4000);
    window.addEventListener("focus", again);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", again);
    };
  }, [missing.length]);
  if (!p) return null;
  const recipe = p.recipe as Recipe;
  const said = sentence(fromRecipe(recipe));
  const approve = async () => {
    setError(undefined);
    try {
      onCreated((await getApi().approveMagic(m.id)).automation);
    } catch (err) {
      setError(explain(err));
    }
  };
  const fix = (n: MagicNeed) => (n.kind === "credential" ? setCredential(n) : openNeed(n));
  const others = p.needs.filter((n) => n.ready !== false);
  return (
    <section class="mg-proposal">
      <div class="mg-proposal-head">
        <span class="mg-orb small">
          <IconSpark size={16} />
        </span>
        <b>{t("axMagicProposal")}</b>
      </div>
      <h3>{recipe.description || recipe.name}</h3>
      {p.summary && <p class="mg-summary">{p.summary}</p>}
      {missing.length > 0 && (
        <div class="mg-missing" role="status">
          <p class="mg-missing-lead">
            <IconAlert size={18} /> {t("axMagicMissing")}
          </p>
          {missing.map((n) => (
            <Need key={`${n.kind}:${n.what}`} n={n} onFix={() => fix(n)} />
          ))}
        </div>
      )}
      <div class="ax-says">
        <div class="ax-says-lines">
          {said.map((line, i) => (
            <p key={String(i)} class={i === 0 ? "first" : ""}>
              {line}
            </p>
          ))}
        </div>
      </div>
      {others.length > 0 && (
        <div class="mg-needs">
          <span class="wz-lb">{t("axMagicNeeds")}</span>
          {others.map((n) => (
            <Need key={`${n.kind}:${n.what}`} n={n} onFix={() => fix(n)} />
          ))}
        </div>
      )}
      {p.needs.length > 0 && missing.length === 0 && <p class="mg-allset">{t("axMagicAllSet")}</p>}
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
              void attempt(() => getApi().rejectMagic(m.id, why.trim() || undefined)).then(() => {
                setWhy(null);
                onChange();
              })
            }
          >
            {t("axMagicSendNo")}
          </button>
        )}
        <button type="button" class="wz-btn" onClick={onEdit}>
          {t("axMagicEdit")}
        </button>
        <button
          type="button"
          class="wz-btn primary"
          disabled={missing.length > 0}
          title={missing.length > 0 ? t("axMagicMissing") : undefined}
          onClick={() => void approve()}
        >
          {t("axMagicApprove")}
        </button>
      </div>
      {credential && (
        <CredentialWindow
          draft={{
            service: credential.service ?? credential.what,
            name: credential.what,
            ...(credential.host && { hosts: [credential.host] }),
          }}
          onClose={(changed) => {
            setCredential(null);
            if (changed) onChange();
          }}
        />
      )}
    </section>
  );
}

/** Where the conversation stands, in three steps lit by border and background. */
function Steps({ status }: { status: MagicAutomation["status"] }) {
  const at = status === "building" ? 2 : status === "ready" ? 3 : 4;
  return (
    <ol class="mg-steps">
      {(["axMagicStep1", "axMagicStep2", "axMagicStep3"] as const).map((k, i) => (
        <li key={k} class={i + 1 === at ? "cur" : i + 1 < at ? "past" : ""}>
          <span class="mg-step-n">{i + 1}</span>
          <span>{t(k)}</span>
        </li>
      ))}
    </ol>
  );
}

/** A magic automation's window: God's proposal beside (on a phone above) the conversation. */
export function MagicChat({
  m,
  onClose,
  onChange,
  onCreated,
}: {
  m: MagicAutomation;
  onClose: () => void;
  onChange: () => void;
  onCreated: (a: Automation) => void;
}) {
  const [editing, setEditing] = useState(false);
  const recipe = m.proposal?.recipe as Recipe | undefined;
  if (editing && recipe)
    return (
      <Modal wide title={recipe.description || m.title} onClose={() => setEditing(false)}>
        <Editor
          current={undefined}
          seed={recipe}
          submitLabel={t("axMagicApprove")}
          submit={async (yaml) => getApi().approveMagic(m.id, yaml)}
          onSaved={(a) => onCreated(a)}
          onCancel={() => setEditing(false)}
        />
      </Modal>
    );
  return (
    <Modal
      wide
      title={`${t("axMagic")}: ${m.title}`}
      sub={t(`axMagicState_${m.status}` as never)}
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
          <Steps status={m.status} />
          {m.status === "ready" && (
            <Proposal
              m={m}
              onChange={onChange}
              onEdit={() => setEditing(true)}
              onCreated={onCreated}
            />
          )}
          {m.status === "done" && <p class="notice ok">{t("axMagicDone")}</p>}
          {m.status === "building" && (
            <div class="mg-hint">
              <span>{t("axMagicBuilding")}</span>
              <button
                type="button"
                class="wz-link inl"
                onClick={() =>
                  void attempt(() => getApi().dismissMagic(m.id)).then(() => {
                    onChange();
                    onClose();
                  })
                }
              >
                {t("axMagicDismiss")}
              </button>
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
