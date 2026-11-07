// The agents' language (G33.5, the person: «poi sotto mi deve chiedere che lingua devono parlare
// gli agenti, e lì ci vorrei più o meno tutte le lingue più utilizzate del mondo»): a big box
// with the chosen language in its own name (and in the interface's beside it) that opens a
// window, a sheet from below on a phone, with a search box, the most common languages first and
// then all the others in the interface's alphabetical order. Lit by border and background, never
// a check mark; no flags, only names.
import { AGENT_LANGUAGES, type AgentLanguage, agentLanguage } from "@redgiant/protocol";
import { useEffect, useRef, useState } from "preact/hooks";
import { lang, t } from "../i18n.js";
import { IconChat, IconChevronDown, IconSearch } from "../icons.js";
import { PHONE, useMedia } from "./SetupKit.js";
import { Modal } from "./ui.js";

/** The name in the interface's language. */
export const languageName = (l: AgentLanguage): string => (lang.value === "it" ? l.it : l.en);

/** Lower case, without accents: «Française» finds «francais». */
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** The languages that match a search (native name, both translations, code), in list order. */
export function matchLanguages(query: string, list = AGENT_LANGUAGES): AgentLanguage[] {
  const q = fold(query.trim());
  if (!q) return [...list];
  return list.filter((l) => [l.native, l.en, l.it, l.code].some((n) => fold(n).includes(q)));
}

function Option({ l, on, pick }: { l: AgentLanguage; on: boolean; pick: (c: string) => void }) {
  const other = languageName(l);
  return (
    <button
      type="button"
      class={`wz-alang-opt${on ? " on" : ""}`}
      aria-pressed={on}
      lang={l.code}
      onClick={() => pick(l.code)}
    >
      <b dir="auto">{l.native}</b>
      {other !== l.native && <small lang={lang.value}>{other}</small>}
    </button>
  );
}

function Choose({
  value,
  onPick,
  onClose,
}: {
  value: string;
  onPick: (code: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const box = useRef<HTMLInputElement>(null);
  const phone = useMedia(PHONE);
  useEffect(() => {
    // On a phone the keyboard would cover the list: the search waits for a tap there.
    if (!phone) box.current?.focus();
  }, []);
  const found = matchLanguages(q);
  const common = AGENT_LANGUAGES.filter((l) => l.common);
  const others = [...AGENT_LANGUAGES]
    .filter((l) => !l.common)
    .sort((a, b) => languageName(a).localeCompare(languageName(b), lang.value));
  const pick = (code: string) => {
    onPick(code);
    onClose();
  };
  const grid = (list: AgentLanguage[]) => (
    <div class="wz-alang-grid">
      {list.map((l) => (
        <Option key={l.code} l={l} on={l.code === value} pick={pick} />
      ))}
    </div>
  );
  return (
    <Modal
      title={t("agentLangTitle")}
      sub={t("agentLangSub")}
      onClose={onClose}
      class="wz-alang-win"
    >
      <label class="wz-alang-search">
        <IconSearch size={18} />
        <input
          ref={box}
          class="wz-field"
          type="search"
          value={q}
          placeholder={t("agentLangSearch")}
          aria-label={t("agentLangSearch")}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && found[0]) {
              e.preventDefault();
              pick(found[0].code);
            }
          }}
        />
      </label>
      {q.trim() ? (
        found.length ? (
          grid(found)
        ) : (
          <p class="wz-lead2">{t("agentLangNone", { q: q.trim() })}</p>
        )
      ) : (
        <>
          <h4>{t("agentLangCommon")}</h4>
          {grid(common)}
          <h4>{t("agentLangAll")}</h4>
          {grid(others)}
        </>
      )}
    </Modal>
  );
}

/** The box with the chosen language; it opens the window to change it. */
export function AgentLanguagePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (code: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const l = agentLanguage(value) ?? (AGENT_LANGUAGES[1] as AgentLanguage);
  const other = languageName(l);
  return (
    <>
      <button
        type="button"
        class="wz-alang"
        aria-haspopup="dialog"
        aria-label={`${t("agentLangTitle")}: ${l.native}`}
        onClick={() => setOpen(true)}
      >
        <span class="wz-ico">
          <IconChat size={24} />
        </span>
        <span class="wz-alang-text">
          <b dir="auto" lang={l.code}>
            {l.native}
          </b>
          <small>
            {other !== l.native ? `${other} · ` : ""}
            {t("agentLangChange")}
          </small>
        </span>
        <IconChevronDown size={20} />
      </button>
      {open && <Choose value={l.code} onPick={onChange} onClose={() => setOpen(false)} />}
    </>
  );
}
