// A board ("tavola", G25.4), laid out as Officina's: the variants side by side, scaled down from
// a real screen width (computer, tablet, phone); each one chosen, opened full screen or commented
// on, and a comment on the whole board. What the person says goes to the agent as a message.
import type { Event } from "@redgiant/protocol";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { lang, t } from "../i18n.js";
import { getApi, sessionView } from "../state.js";

type Proposed = Extract<Event, { type: "variants.proposed" }>["payload"] & object;
type Answer = Extract<Event, { type: "variants.answered" }>["payload"] & object;
type Said = Answer & { ts: string };

/** Real widths the previews are scaled down from (as in Officina). */
export const SCREENS = {
  computer: { width: 1280, height: 800 },
  tablet: { width: 820, height: 1100 },
  phone: { width: 390, height: 780 },
} as const;
type Screen = keyof typeof SCREENS;
const COLUMN: Record<Screen, string> = { computer: "460px", tablet: "380px", phone: "280px" };

/** The board, when it was published, and what was said about it, from the conversation's events. */
export function boardOf(
  events: readonly Event[],
  proposalId: string,
): { proposed: Proposed; at: string; answers: Said[]; chosen: number | null } | undefined {
  let proposed: Proposed | undefined;
  let at = "";
  const answers: Said[] = [];
  for (const e of events) {
    if (e.type === "variants.proposed" && e.payload?.proposalId === proposalId) {
      proposed = e.payload;
      at = e.ts;
    }
    if (e.type === "variants.answered" && e.payload?.proposalId === proposalId)
      answers.push({ ...e.payload, ts: e.ts });
  }
  if (!proposed) return undefined;
  const chosen = [...answers].reverse().find((a) => a.choice)?.variant ?? null;
  return { proposed, at, answers, chosen };
}

const when = (iso: string) =>
  new Date(iso).toLocaleString(lang.value === "it" ? "it-IT" : "en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

function History({ answers }: { answers: Said[] }) {
  return (
    <ul class="tavola-history">
      {answers.map((a, i) => (
        <li key={i}>
          {when(a.ts)} · {a.choice ? t("boardChoiceWord") : t("boardCommentWord")}
          {a.comment ? `: ${a.comment}` : ""}
        </li>
      ))}
    </ul>
  );
}

type Status = { tone: "" | "ok" | "ko"; text: string };

/** A preview scaled from the chosen screen's real width to the column it is in. */
function Frame({ src, title, screen }: { src: string; title: string; screen: Screen }) {
  const box = useRef<HTMLDivElement>(null);
  const [k, setK] = useState(0.35);
  const s = SCREENS[screen];
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setK((el.clientWidth || 460) / s.width);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [screen]);
  return (
    <div class="tavola-frame" ref={box} style={{ height: `${Math.round(s.height * k)}px` }}>
      <iframe
        title={title}
        src={src}
        loading="lazy"
        sandbox="allow-scripts allow-forms allow-popups"
        style={{ width: `${s.width}px`, height: `${s.height}px`, transform: `scale(${k})` }}
      />
    </div>
  );
}

export function Variants({ sessionId, proposalId }: { sessionId: string; proposalId: string }) {
  const live = sessionView(sessionId).value.events;
  const [loaded, setLoaded] = useState<Event[]>([]);
  const [base, setBase] = useState<string>();
  const [screen, setScreen] = useState<Screen>("computer");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [full, setFull] = useState<number | null>(null);
  const load = () =>
    void getApi()
      .events(sessionId)
      .then(setLoaded, () => {});
  useEffect(() => {
    load();
    void getApi()
      .boardLink(sessionId, proposalId)
      .then(
        (r) => setBase(r.base),
        () => {},
      );
  }, [sessionId, proposalId]);
  useEffect(() => {
    if (full === null) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setFull(null);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [full]);
  // The live events when the conversation is followed here, what was loaded otherwise.
  const board = boardOf(live.length >= loaded.length ? live : loaded, proposalId);
  if (!board) return <div class="empty">{t("loading")}</div>;
  const { proposed, at, answers, chosen } = board;
  const key = (n: number | null) => (n === null ? "all" : String(n));
  const send = async (variant: number | null, choice: boolean) => {
    const k = key(variant);
    const comment = notes[k]?.trim() ?? "";
    if (!choice && !comment) {
      setStatus((s) => ({ ...s, [k]: { tone: "ko", text: t("boardWriteComment") } }));
      return;
    }
    setStatus((s) => ({ ...s, [k]: { tone: "", text: t("boardSending") } }));
    try {
      await getApi().answerVariants(sessionId, {
        proposalId,
        variant,
        ...(choice && { choice: true }),
        ...(comment && { comment }),
      });
      setNotes((x) => ({ ...x, [k]: "" }));
      setStatus((s) => ({ ...s, [k]: { tone: "ok", text: t("boardSent") } }));
      load();
    } catch (err) {
      setStatus((s) => ({ ...s, [k]: { tone: "ko", text: (err as Error).message } }));
    }
  };
  const n = proposed.variants.length;
  const page = (i: number) => (base ? `${base}${i}.html` : "");
  const shown = full === null ? undefined : proposed.variants[full - 1];
  return (
    <div class="tavola" style={{ "--tavola-col": COLUMN[screen] }}>
      <header class="tavola-head">
        <h1>{proposed.title}</h1>
        <div class="dim">
          {t(n === 1 ? "boardOneVariant" : "boardVariants", { n: String(n) })} · {when(at)}
        </div>
        {proposed.description && <p class="tavola-description">{proposed.description}</p>}
        <fieldset class="tavola-screens" aria-label={t("boardScreens")}>
          {(Object.keys(SCREENS) as Screen[]).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={screen === s}
              class={screen === s ? "on" : ""}
              onClick={() => setScreen(s)}
            >
              {t(`boardScreen_${s}`)}
            </button>
          ))}
        </fieldset>
      </header>
      <main class="tavola-grid">
        {proposed.variants.map((v, i) => {
          const no = i + 1;
          const isChosen = chosen === no;
          const st = status[key(no)];
          return (
            <article key={no} class={`tavola-variant ${isChosen ? "chosen" : ""}`}>
              <div class="tavola-variant-head">
                <span class="dim">{no}</span>
                <h2>{v.title}</h2>
                {isChosen && <span class="tavola-badge">{t("boardChosen")}</span>}
              </div>
              {v.note && <div class="tavola-note">{v.note}</div>}
              {base && <Frame src={page(no)} title={v.title} screen={screen} />}
              <div class="tavola-actions">
                <div class="row">
                  <button type="button" class="primary" onClick={() => void send(no, true)}>
                    {isChosen ? t("boardChosen") : t("boardChoose")}
                  </button>
                  <button type="button" onClick={() => setFull(no)}>
                    {t("boardFull")}
                  </button>
                </div>
                <textarea
                  placeholder={t("boardCommentHere")}
                  value={notes[key(no)] ?? ""}
                  onInput={(e) =>
                    setNotes((x) => ({ ...x, [key(no)]: (e.target as HTMLTextAreaElement).value }))
                  }
                />
                <div class="row">
                  <button type="button" onClick={() => void send(no, false)}>
                    {t("boardSendComment")}
                  </button>
                </div>
                <div class={`tavola-status ${st?.tone ?? ""}`} role="status">
                  {st?.text ?? ""}
                </div>
                <History answers={answers.filter((a) => a.variant === no)} />
              </div>
            </article>
          );
        })}
      </main>
      <section class="tavola-general">
        <div class="tavola-variant">
          <strong>{t("boardWhole")}</strong>
          <textarea
            placeholder={t("boardWholeHint")}
            value={notes.all ?? ""}
            onInput={(e) =>
              setNotes((x) => ({ ...x, all: (e.target as HTMLTextAreaElement).value }))
            }
          />
          <div class="row">
            <button type="button" onClick={() => void send(null, false)}>
              {t("boardSendToAgent")}
            </button>
          </div>
          <div class={`tavola-status ${status.all?.tone ?? ""}`} role="status">
            {status.all?.text ?? ""}
          </div>
          <History answers={answers.filter((a) => a.variant === null)} />
        </div>
      </section>
      {full !== null && shown && (
        <div class="tavola-full" role="dialog" aria-modal="true" aria-label={shown.title}>
          <div class="tavola-full-bar">
            <strong>
              {full}. {shown.title}
            </strong>
            <button
              type="button"
              class="primary"
              onClick={() => {
                const v = full;
                setFull(null);
                void send(v, true);
              }}
            >
              {t("boardChoose")}
            </button>
            <button type="button" onClick={() => setFull(null)}>
              {t("close")}
            </button>
          </div>
          <div class="tavola-full-body">
            <iframe
              title={shown.title}
              src={page(full)}
              sandbox="allow-scripts allow-forms allow-popups"
              style={{ width: screen === "computer" ? "100%" : `${SCREENS[screen].width}px` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
