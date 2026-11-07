// Magic automations (G33.3): the person writes what they want, a conversation with God starts and
// builds it. The conversation is a real one (the same chat as everywhere), with God's proposal on
// top as a preview in words: approve it, change it in the editor first, or say what is wrong.
// Nothing becomes an automation before the person's yes.
import type { Automation, MagicAutomation, MagicNeed, Recipe } from "@redgiant/protocol";
import { useState } from "preact/hooks";
import { t } from "../i18n.js";
import { IconChat, IconKey, IconPuzzle, IconSend, IconSpark } from "../icons.js";
import { attempt, getApi, openTab } from "../state.js";
import { Editor, fromRecipe, PLATFORM_NAMES, sentence } from "./AutomationEditor.js";
import { explain } from "./Brain.js";
import { Chat } from "./Chat.js";
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

/** Where to make what is missing. */
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
    <IconChat size={16} />
  ) : n.kind === "email" ? (
    <IconSend size={16} />
  ) : n.kind === "credential" ? (
    <IconKey size={16} />
  ) : (
    <IconPuzzle size={16} />
  );

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
      <div class="ax-says">
        <div class="ax-says-lines">
          {said.map((line, i) => (
            <p key={String(i)} class={i === 0 ? "first" : ""}>
              {line}
            </p>
          ))}
        </div>
      </div>
      {p.needs.length > 0 && (
        <div class="mg-needs">
          <span class="wz-lb">{t("axMagicNeeds")}</span>
          {p.needs.map((n) => (
            <div key={`${n.kind}:${n.what}`} class={`mg-need${n.ready ? " ok" : " need"}`}>
              <span class="mg-need-ico">{needIcon(n)}</span>
              <span class="mg-need-text">
                <b>
                  {t(`axNeed_${n.kind}` as never, {
                    what: PLATFORM_NAMES[n.what.toLowerCase()] ?? n.what,
                  })}
                </b>
                {n.why && <small>{n.why}</small>}
              </span>
              <span class="mg-need-state">
                {n.ready ? t("axNeedReady") : n.ready === false ? t("axNeedMissing") : ""}
              </span>
              {!n.ready && (
                <button type="button" class="wz-btn small" onClick={() => openNeed(n)}>
                  {t("axNeedOpen")}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
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
        <button type="button" class="wz-btn primary" onClick={() => void approve()}>
          {t("axMagicApprove")}
        </button>
      </div>
    </section>
  );
}

/** A magic automation's window: God's proposal on top, the conversation with God below. */
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
        <div class="mg-chat-body">
          <Chat sessionId={m.sessionId} agentId={m.agentId} />
        </div>
      </div>
    </Modal>
  );
}
