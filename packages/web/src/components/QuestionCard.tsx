import { type Answers, PLAN_APPROVE, PLAN_REVISE, type Question } from "@redgiant/protocol";
import { useState } from "preact/hooks";
import { t } from "../i18n.js";
import { IconInfo } from "../icons.js";
import { renderMarkdown } from "../markdown.js";
import { getLive } from "../state.js";

/** The label a plan's fixed options show (the answer sent stays the protocol's constant). */
const planLabel = (label: string) =>
  label === PLAN_APPROVE ? t("planApprove") : label === PLAN_REVISE ? t("planRevise") : label;

function OneQuestion({
  q,
  picked,
  other,
  onPick,
  onOther,
  disabled,
}: {
  q: Question;
  picked: string[];
  other: string;
  onPick: (label: string) => void;
  onOther: (text: string) => void;
  disabled: boolean;
}) {
  return (
    <div class="question">
      <div class="question-text">
        {q.header && <span class="chip">{q.header}</span>}
        <span>{q.question}</span>
        {q.multiSelect && <span class="dim">({t("manyAnswers")})</span>}
      </div>
      <div class="options">
        {q.options.map((o) => (
          <button
            key={o.label}
            type="button"
            aria-pressed={picked.includes(o.label)}
            class={`option ${q.multiSelect ? "many" : "one"} ${picked.includes(o.label) ? "on" : ""}`}
            disabled={disabled}
            onClick={() => onPick(o.label)}
          >
            <span class="mark" />
            <span class="option-text">
              <span>{o.label}</span>
              {o.description && <span class="dim">{o.description}</span>}
            </span>
          </button>
        ))}
      </div>
      <input
        class="other"
        placeholder={t("otherAnswer")}
        value={other}
        disabled={disabled}
        onInput={(e) => onOther((e.target as HTMLInputElement).value)}
      />
    </div>
  );
}

/**
 * A question (ask_user) or a plan (propose_plan). While it waits, the human picks options or
 * writes another answer; afterwards it shows what was answered.
 */
export function QuestionCard({
  requestId,
  questions,
  plan,
  answers,
  open,
}: {
  requestId: string;
  questions: Question[];
  plan?: string | undefined;
  answers?: Answers | null | undefined;
  open: boolean;
}) {
  const [picked, setPicked] = useState<string[][]>(questions.map(() => []));
  const [other, setOther] = useState<string[]>(questions.map(() => ""));
  const [sent, setSent] = useState(false);
  const send = (a: Answers) => {
    getLive().send({ type: "question.answer", requestId, answers: a });
    setSent(true);
  };
  const collected = questions.map((_, i) => [
    ...(picked[i] ?? []),
    ...((other[i] ?? "").trim() ? [(other[i] ?? "").trim()] : []),
  ]);
  const complete = collected.every((a) => a.length > 0);

  if (!open) {
    return (
      <div class="question-card done">
        {plan !== undefined && (
          <details>
            <summary>{t("proposedPlan")}</summary>
            <div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(plan) }} />
          </details>
        )}
        {questions.map((q, i) => (
          <div key={q.question} class="question-done">
            <span class="dim">{plan !== undefined ? t("proposedPlan") : q.question}</span>
            <strong>
              {answers === undefined
                ? t("waitingAnswer")
                : answers === null
                  ? t("notAnswered")
                  : (answers[i] ?? []).map(planLabel).join("; ")}
            </strong>
          </div>
        ))}
      </div>
    );
  }

  if (plan !== undefined) {
    const feedback = other[0] ?? "";
    return (
      <div class="question-card plan">
        <div class="row">
          <IconInfo />
          <strong>{t("proposedPlan")}</strong>
        </div>
        <div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(plan) }} />
        <textarea
          rows={2}
          placeholder={t("planFeedback")}
          value={feedback}
          disabled={sent}
          onInput={(e) => setOther([(e.target as HTMLTextAreaElement).value])}
        />
        <div class="permission-actions">
          <button type="button" class="yes" disabled={sent} onClick={() => send([[PLAN_APPROVE]])}>
            {t("planApprove")}
          </button>
          <button
            type="button"
            class="always"
            disabled={sent}
            onClick={() => send([[feedback.trim() || PLAN_REVISE]])}
          >
            {feedback.trim() ? t("sendFeedback") : t("planRevise")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div class="question-card">
      {questions.map((q, i) => (
        <OneQuestion
          key={q.question}
          q={q}
          picked={picked[i] ?? []}
          other={other[i] ?? ""}
          disabled={sent}
          onPick={(label) =>
            setPicked(
              picked.map((p, j) =>
                j !== i
                  ? p
                  : q.multiSelect
                    ? p.includes(label)
                      ? p.filter((x) => x !== label)
                      : [...p, label]
                    : [label],
              ),
            )
          }
          onOther={(text) => setOther(other.map((o, j) => (j === i ? text : o)))}
        />
      ))}
      <div class="permission-actions">
        <button
          type="button"
          class="yes"
          disabled={!complete || sent}
          onClick={() => send(collected)}
        >
          {t("answer")}
        </button>
      </div>
    </div>
  );
}
