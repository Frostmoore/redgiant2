// The notes an agent keeps between conversations (memory, 2026-11-05), shown and edited by the
// person: about the person (shared), an agent's own, a project's. Through the notes API, which
// keeps the agents' queue and size limit.
import { useEffect, useState } from "preact/hooks";
import { t } from "../i18n.js";
import { IconCheck } from "../icons.js";
import { attempt, getApi } from "../state.js";
import { Field } from "./ui.js";

export function NotesEditor({
  scope,
  agentId,
  projectId,
  label,
  help,
}: {
  scope: "user" | "self" | "project";
  agentId?: string;
  projectId?: string;
  label: string;
  help: string;
}) {
  const [text, setText] = useState<string>();
  const [saved, setSaved] = useState(false);
  const q = { scope, ...(agentId && { agentId }), ...(projectId && { projectId }) };
  useEffect(() => {
    void getApi()
      .notes(q)
      .then(
        (r) => setText(r.text),
        () => setText(""),
      );
  }, [scope, agentId, projectId]);
  if (text === undefined) return null;
  return (
    <Field label={label} help={help}>
      <textarea
        rows={5}
        value={text}
        onInput={(e) => {
          setSaved(false);
          setText((e.target as HTMLTextAreaElement).value);
        }}
      />
      <div class="row">
        <button
          type="button"
          class="tiny"
          onClick={() =>
            void attempt(() => getApi().setNotes(q, text)).then((r) => r && setSaved(true))
          }
        >
          {t("save")}
        </button>
        {saved && (
          <span class="chip ok">
            <IconCheck size={12} /> {t("saved")}
          </span>
        )}
      </div>
    </Field>
  );
}
