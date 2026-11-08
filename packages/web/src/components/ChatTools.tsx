// The chat's three tools of G36: replying to a passage (G36.22), going on in a new conversation
// (G36.23) and «Intanto», a side question that never enters the conversation (G36.24).
import { MAX_QUOTES, type MessageQuote } from "@redgiant/protocol";
import type { RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { usd } from "../format.js";
import { t } from "../i18n.js";
import { IconAside, IconBranch, IconClose, IconReply, IconSend, IconSpinner } from "../icons.js";
import { renderAnswer } from "../markdown.js";
import {
  asidesOf,
  attempt,
  getApi,
  openSession,
  refreshConversations,
  sessionRows,
  sessionView,
} from "../state.js";

export type QuoteDraft = MessageQuote & { key: string };

/** The model's message a DOM node is in: its bubble carries the event and its time. */
const bubbleOf = (n: Node | null): HTMLElement | null => {
  const el = n instanceof HTMLElement ? n : (n?.parentElement ?? null);
  return el?.closest<HTMLElement>(".bubble.assistant[data-seq]") ?? null;
};

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * A selection inside one of the model's messages offers «Rispondi a questo» (G36.22): the button
 * floats over the selection, inside the chat's body; picking it hands the passage over.
 */
export function QuotePicker({
  scroller,
  body,
  onPick,
}: {
  scroller: RefObject<HTMLDivElement | null>;
  body: RefObject<HTMLDivElement | null>;
  onPick: (q: MessageQuote) => void;
}) {
  const [pop, setPop] = useState<{ x: number; y: number; quote: MessageQuote } | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      const sel = window.getSelection();
      const box = body.current;
      const area = scroller.current;
      if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !box || !area) return setPop(null);
      const range = sel.getRangeAt(0);
      const bubble = bubbleOf(range.commonAncestorContainer);
      if (!bubble || !area.contains(bubble)) return setPop(null);
      const text = sel.toString().trim();
      if (!text) return setPop(null);
      // Where it is in the message's text, for finding it again exactly.
      const before = document.createRange();
      before.selectNodeContents(bubble);
      before.setEnd(range.startContainer, range.startOffset);
      const start = before.toString().length;
      const r = range.getBoundingClientRect();
      const b = box.getBoundingClientRect();
      const width = 168;
      const x = Math.min(
        Math.max(8, r.left - b.left + r.width / 2 - width / 2),
        b.width - width - 8,
      );
      const above = r.top - b.top - 40;
      setPop({
        x,
        y: above > 4 ? above : r.bottom - b.top + 8,
        quote: {
          seq: Number(bubble.dataset.seq),
          ...(bubble.dataset.at && { at: bubble.dataset.at }),
          start,
          end: start + range.toString().length,
          text: text.length > 4000 ? `${text.slice(0, 3999)}…` : text,
        },
      });
    };
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(check, 180);
    };
    const hide = () => setPop(null);
    document.addEventListener("selectionchange", later);
    const area = scroller.current;
    area?.addEventListener("scroll", hide, { passive: true });
    return () => {
      clearTimeout(timer);
      document.removeEventListener("selectionchange", later);
      area?.removeEventListener("scroll", hide);
    };
  }, []);
  if (!pop) return null;
  return (
    <button
      type="button"
      class="quote-pop"
      style={{ left: `${pop.x}px`, top: `${pop.y}px` }}
      // Pressing it must not drop the selection before the click.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        onPick(pop.quote);
        window.getSelection()?.removeAllRanges();
        setPop(null);
      }}
    >
      <IconReply size={14} />
      {t("quoteReply")}
    </button>
  );
}

/** The passages being answered, above the composer's box: each with its own reply (G36.22). */
export function QuoteDrafts({
  drafts,
  onChange,
}: {
  drafts: QuoteDraft[];
  onChange: (next: QuoteDraft[]) => void;
}) {
  if (drafts.length === 0) return null;
  return (
    <div class="quote-drafts">
      {drafts.map((d, i) => (
        <div class="quote-draft" key={d.key}>
          <div class="quote-draft-head">
            <IconReply size={13} />
            <span>{t("quoteReplyingTo")}</span>
            <button
              type="button"
              class="icon-button"
              title={t("quoteRemove")}
              aria-label={t("quoteRemove")}
              onClick={() => onChange(drafts.filter((x) => x.key !== d.key))}
            >
              <IconClose size={12} />
            </button>
          </div>
          <button
            type="button"
            class="quote-text"
            title={t("quoteJump")}
            onClick={() => jumpToQuote(d)}
          >
            {d.text}
          </button>
          <textarea
            rows={1}
            value={d.reply ?? ""}
            placeholder={
              drafts.length > 1 || i > 0 ? t("quoteReplyEach") : t("quoteReplyPlaceholder")
            }
            aria-label={t("quoteReplyPlaceholder")}
            onInput={(e) => {
              const reply = (e.target as HTMLTextAreaElement).value;
              const el = e.target as HTMLTextAreaElement;
              el.style.height = "auto";
              el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
              onChange(drafts.map((x) => (x.key === d.key ? { ...x, reply } : x)));
            }}
          />
        </div>
      ))}
    </div>
  );
}

/** Adds a passage to the drafts, unless it is already there or there are enough. */
export function addQuote(drafts: QuoteDraft[], q: MessageQuote): QuoteDraft[] {
  if (drafts.length >= MAX_QUOTES) return drafts;
  if (drafts.some((d) => d.seq === q.seq && squash(d.text) === squash(q.text))) return drafts;
  return [...drafts, { ...q, key: `q${Date.now().toString(36)}${drafts.length}` }];
}

/** The quotes of a sent message, in its bubble: each opens the passage where it was. */
export function QuoteRefs({ quotes }: { quotes: MessageQuote[] }) {
  return (
    <div class="quote-refs">
      {quotes.map((q, i) => (
        <div class="quote-block" key={i}>
          <button
            type="button"
            class="quote-ref"
            title={t("quoteJump")}
            disabled={q.seq === undefined}
            onClick={() => jumpToQuote(q)}
          >
            {q.text}
          </button>
          {q.reply?.trim() && <div class="quote-reply">{q.reply.trim()}</div>}
        </div>
      ))}
    </div>
  );
}

/** The text of a message as one string, and the text node each character is in. */
function textMap(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: { node: Text; at: number }[] = [];
  let all = "";
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    nodes.push({ node, at: all.length });
    all += node.data;
  }
  return { all, nodes };
}

/** Where a quoted passage is in its message now: by its place first, else by its words. */
export function findPassage(
  all: string,
  q: Pick<MessageQuote, "text" | "start" | "end">,
): { from: number; to: number } | null {
  if (q.start !== undefined && q.end !== undefined && q.end <= all.length)
    if (squash(all.slice(q.start, q.end)) === squash(q.text)) return { from: q.start, to: q.end };
  const exact = all.indexOf(q.text);
  if (exact >= 0) return { from: exact, to: exact + q.text.length };
  // The selection reads paragraphs with line breaks the text nodes do not have: the first line.
  const line =
    q.text
      .split("\n")
      .find((l) => l.trim())
      ?.trim() ?? "";
  const loose = line ? all.indexOf(line) : -1;
  return loose >= 0 ? { from: loose, to: loose + line.length } : null;
}

/**
 * Goes to a quoted passage (G36.22): the message scrolls into view and the passage lights up for a
 * moment (the CSS highlight where the browser has it, the whole message otherwise).
 */
export function jumpToQuote(q: MessageQuote): boolean {
  if (q.seq === undefined) return false;
  const bubble = document.querySelector<HTMLElement>(`.bubble.assistant[data-seq="${q.seq}"]`);
  if (!bubble) return false;
  bubble.scrollIntoView({ block: "center", behavior: "smooth" });
  bubble.classList.remove("quote-flash");
  void bubble.offsetWidth;
  bubble.classList.add("quote-flash");
  setTimeout(() => bubble.classList.remove("quote-flash"), 1800);
  const { all, nodes } = textMap(bubble);
  const found = findPassage(all, q);
  const css = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS;
  const Highlight = (globalThis as { Highlight?: new (r: Range) => unknown }).Highlight;
  if (!found || !css?.highlights || !Highlight) return true;
  const point = (off: number) => {
    const n = [...nodes].reverse().find((x) => x.at <= off) ?? nodes[0];
    return n ? { node: n.node, offset: Math.min(off - n.at, n.node.data.length) } : null;
  };
  const a = point(found.from);
  const b = point(found.to);
  if (!a || !b) return true;
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  css.highlights.set("rg-quote", new Highlight(range));
  setTimeout(() => css.highlights?.delete("rg-quote"), 3500);
  return true;
}

/** «Continua da qui» (G36.23): a new conversation from this message on; this one stays. */
export async function continueFrom(sessionId: string, agentId: string, seq: number) {
  const r = await attempt(() => getApi().forkSession(sessionId, { fromSeq: seq }));
  if (!r) return;
  await refreshConversations().catch(() => {});
  const row = sessionRows.value.find((x) => x.id === r.sessionId);
  openSession({ id: r.sessionId, agentId, title: row?.title ?? null });
}

export function ContinueHere({
  sessionId,
  agentId,
  seq,
}: {
  sessionId: string;
  agentId: string;
  seq: number;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      class="link msg-action"
      title={t("forkHereHint")}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void continueFrom(sessionId, agentId, seq).finally(() => setBusy(false));
      }}
    >
      <IconBranch size={13} />
      {t("forkHere")}
    </button>
  );
}

/** Where this conversation's own part starts, with the way back to the one it comes from. */
export function ForkMark({
  fromSessionId,
  fromTitle,
  how,
  agentId,
}: {
  fromSessionId: string;
  fromTitle?: string | undefined;
  how: "continue" | "edit";
  agentId: string;
}) {
  const title =
    sessionRows.value.find((r) => r.id === fromSessionId)?.title ?? fromTitle ?? t("forkOrigin");
  return (
    <div class="fork-mark">
      <span class="fork-line" />
      <IconBranch size={13} />
      <span>{t(how === "continue" ? "forkStartsHere" : "forkEdited")}</span>
      <button
        type="button"
        class="link"
        onClick={() => openSession({ id: fromSessionId, agentId, title })}
      >
        {t("forkBack", { title })}
      </button>
      <span class="fork-line" />
    </div>
  );
}

/**
 * «Intanto» (G36.24, Claude Code's /btw): a panel of its own for a quick question, also while the
 * agent works. The model knows the whole conversation; neither the question nor the answer enters
 * it, nor the memory. «Porta nella chat» makes one a normal message (between turns).
 */
export function AsidePanel({
  sessionId,
  running,
  onClose,
}: {
  sessionId: string;
  running: boolean;
  onClose: () => void;
}) {
  const view = sessionView(sessionId);
  const asides = asidesOf(view.value.events);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => area.current?.focus(), []);
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [asides.length, asking]);
  const ask = async () => {
    const q = question.trim();
    if (!q || asking) return;
    setAsking(q);
    setProblem(null);
    setQuestion("");
    const r = await attempt(() => getApi().aside(sessionId, q));
    setAsking(null);
    if (r?.aside.error) setProblem(t("asideFailed", { why: r.aside.error }));
  };
  return (
    <section class="aside-panel" aria-label={t("asideTitle")}>
      <header class="aside-head">
        <IconAside size={16} />
        <strong>{t("asideTitle")}</strong>
        <span class="dim aside-sub">{t("asideSub")}</span>
        <button
          type="button"
          class="icon-button"
          title={t("close")}
          aria-label={t("close")}
          onClick={onClose}
        >
          <IconClose size={14} />
        </button>
      </header>
      <div class="aside-list" ref={list}>
        {asides.length === 0 && !asking && <p class="dim aside-empty">{t("asideEmpty")}</p>}
        {asides.map((a) => (
          <article class="aside-item" key={a.id}>
            <div class="aside-q">{a.question}</div>
            {a.error ? (
              <div class="notice error">{t("asideFailed", { why: a.error })}</div>
            ) : (
              <div class="md" dangerouslySetInnerHTML={{ __html: renderAnswer(a.answer) }} />
            )}
            <div class="aside-foot">
              <span class="dim">
                {a.model} · {usd(a.costUsd)}
              </span>
              <div class="spacer" />
              {a.promoted ? (
                <span class="dim">{t("asideInChat")}</span>
              ) : (
                !a.error && (
                  <button
                    type="button"
                    class="link"
                    disabled={running}
                    title={running ? t("asideToChatLater") : t("asideToChatHint")}
                    onClick={() => void attempt(() => getApi().promoteAside(sessionId, a.id))}
                  >
                    {t("asideToChat")}
                  </button>
                )
              )}
            </div>
          </article>
        ))}
        {asking && (
          <article class="aside-item">
            <div class="aside-q">{asking}</div>
            <div class="dim aside-wait">
              <IconSpinner size={13} /> {t("asideThinking")}
            </div>
          </article>
        )}
      </div>
      {problem && <div class="composer-problem">{problem}</div>}
      <form
        class="aside-form"
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        <textarea
          ref={area}
          rows={2}
          value={question}
          placeholder={running ? t("asidePlaceholderBusy") : t("asidePlaceholder")}
          aria-label={t("asidePlaceholder")}
          onInput={(e) => setQuestion((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              void ask();
            }
            if (e.key === "Escape") onClose();
          }}
        />
        <button
          type="submit"
          class="send"
          title={t("asideAsk")}
          aria-label={t("asideAsk")}
          disabled={!question.trim() || asking !== null}
        >
          <IconSend size={15} />
        </button>
      </form>
    </section>
  );
}
