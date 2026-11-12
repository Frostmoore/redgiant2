// Email for the agents (G38.1) in the chat: a search shows its senders and subjects, a message read
// shows its headers, attachments and the start of its text, a draft or a send says to whom and
// about what. The request to send shows the email field by field, the text whole. Everything an
// email says is shown as plain text (never as HTML or Markdown).
import {
  mailRequestFields,
  mailSize,
  parseMailList,
  parseMailMessage,
  preparedMailOf,
} from "@redgiant/protocol";
import { useState } from "preact/hooks";
import { lang, t } from "../i18n.js";
import { IconMail, IconPaperclip } from "../icons.js";

const SHOWN = 8;

/** «2026-11-02 10:00 UTC» in the person's time and words; anything else as it is. */
export function mailDate(s: string): string {
  const m = s.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC$/);
  if (!m) return s;
  const d = new Date(`${m[1]}T${m[2]}:00Z`);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString(lang.value === "it" ? "it-IT" : "en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
const PREVIEW = 600;

/** A sender as people say it: the name, or the address. */
const who = (s: string) => s.replace(/\s*<[^>]*>\s*$/, "").replace(/^"|"$/g, "") || s;

const list = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : typeof v === "string"
      ? v.split(/[,;]/).map((x) => x.trim())
      : [];

/** The tool line's summary for a mail tool: what it looked for, which message, to whom. */
export function mailSummary(tool: string, input: unknown): string | undefined {
  if (!tool.startsWith("mail_") || !input || typeof input !== "object") return undefined;
  const i = input as Record<string, unknown>;
  if (tool === "mail_search")
    return (
      ["from", "to", "subject", "text", "since", "before", "folder"]
        .filter((k) => typeof i[k] === "string" && i[k])
        .map((k) => `${k}: ${i[k]}`)
        .join(" · ") || (i.unread === true ? t("mailCardUnread") : "")
    );
  if (tool === "mail_read" || tool === "mail_move")
    return [
      typeof i.id === "number" ? `#${i.id}` : "",
      Array.isArray(i.ids) ? i.ids.map((x) => `#${x}`).join(" ") : "",
      typeof i.action === "string" ? i.action : "",
      typeof i.folder === "string" ? i.folder : "",
    ]
      .filter(Boolean)
      .join(" · ");
  const m = preparedMailOf(i);
  const to = m ? [...m.to, ...m.cc] : list(i.to);
  const subject = m?.subject ?? (typeof i.subject === "string" ? i.subject : "");
  const ref =
    typeof i.draft_id === "number"
      ? `${t("mailCardDraft")} #${i.draft_id}`
      : typeof i.reply_to === "number"
        ? `Re #${i.reply_to}`
        : typeof i.forward === "number"
          ? `Fwd #${i.forward}`
          : "";
  return [ref, to.map(who).join(", "), subject].filter(Boolean).join(" · ");
}

function SearchCard({ output }: { output: string }) {
  const [all, setAll] = useState(false);
  const r = parseMailList(output);
  const shown = all ? r.mails : r.mails.slice(0, SHOWN);
  return (
    <div class="mail-card" data-mail="search">
      {r.mailbox && (
        <div class="mail-card-where">
          <IconMail size={13} />
          <span>{t("mailCardFolder", { mailbox: r.mailbox, folder: r.folder ?? "" })}</span>
        </div>
      )}
      {r.mails.length === 0 ? (
        <div class="dim mail-card-none">{t("mailCardNone")}</div>
      ) : (
        <ul class="mail-list">
          {shown.map((m) => (
            <li key={m.id} class={m.unread ? "unread" : undefined}>
              <span class="mail-dot" title={m.unread ? t("mailCardUnread") : undefined} />
              <span class="mail-from">{who(m.from)}</span>
              <span class="mail-subject">{m.subject || "—"}</span>
              {m.attachments > 0 && (
                <span
                  class="mail-clip"
                  title={
                    m.attachments === 1
                      ? t("mailCardAttachment")
                      : t("mailCardAttachments", { n: String(m.attachments) })
                  }
                >
                  <IconPaperclip size={12} />
                </span>
              )}
              <span class="mail-date">{mailDate(m.date)}</span>
            </li>
          ))}
        </ul>
      )}
      {r.mails.length > SHOWN && (
        <button type="button" class="link" onClick={() => setAll(!all)}>
          {all ? t("mailCardShowLess") : t("mailCardMore", { n: String(r.mails.length - SHOWN) })}
        </button>
      )}
    </div>
  );
}

function ReadCard({ output }: { output: string }) {
  const [all, setAll] = useState(false);
  const m = parseMailMessage(output);
  if (!m) return null;
  const long = m.body.length > PREVIEW;
  return (
    <div class="mail-card" data-mail="read">
      <div class="mail-head">
        <div class="mail-head-subject">{m.subject || "—"}</div>
        <div class="mail-head-line">
          <span class="mail-from">{m.from}</span>
          <span class="mail-date">{mailDate(m.date)}</span>
        </div>
        <div class="mail-head-line dim">
          {t("mailCardTo")}: {m.to}
          {m.cc ? ` · Cc: ${m.cc}` : ""}
        </div>
      </div>
      {m.attachments.length > 0 && (
        <div class="mail-files">
          {m.attachments.map((a) => (
            <span key={a.name} class="attachment" title={a.saved ?? a.type}>
              <IconPaperclip size={12} />
              <span>{a.name}</span>
              <span class="dim">{mailSize(a.size, lang.value)}</span>
              {a.saved && <span class="chip">{t("mailCardSaved")}</span>}
            </span>
          ))}
        </div>
      )}
      <div class={all ? "mail-body" : "mail-body clamp"}>
        {all || !long ? m.body : `${m.body.slice(0, PREVIEW)}…`}
      </div>
      {long && (
        <button type="button" class="link" onClick={() => setAll(!all)}>
          {all ? t("mailCardShowLess") : t("mailCardShowAll")}
        </button>
      )}
    </div>
  );
}

/** What a mail tool did, under its line: the list, the message, or nothing for the others. */
export function MailToolCard({ tool, output }: { tool: string; output: string }) {
  if (tool === "mail_search") return <SearchCard output={output} />;
  if (tool === "mail_read") return <ReadCard output={output} />;
  return null;
}

/** The email of a request to send, field by field, its text whole (G38.1). */
export function MailRequestPreview({ input }: { input: unknown }) {
  const fields = mailRequestFields(lang.value, input);
  if (fields.length === 0) return null;
  const text = fields.find((f) => f.key === "text");
  return (
    <div class="mail-request" data-mail="request">
      <div class="mail-request-title">
        <IconMail size={14} />
        <span>{t("mailPermTitle")}</span>
      </div>
      <dl>
        {fields
          .filter((f) => f.key !== "text")
          .map((f) => (
            <div key={f.key} class={`mail-request-row mail-request-${f.key}`}>
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
      </dl>
      {text && <div class="mail-body mail-request-body">{text.value}</div>}
    </div>
  );
}
