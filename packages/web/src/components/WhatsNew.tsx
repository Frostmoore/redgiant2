// What a big update brings (the user's rule, 2026-10-26): shown once, at the first opening after
// updating, never to whoever installs RedGiant now (they get the introduction). "Updated" means
// this browser already had conversations before.
import { useEffect, useState } from "preact/hooks";
import { type Key, t } from "../i18n.js";
import { getApi } from "../state.js";
import { Modal } from "./ui.js";

/** Bump with every big update, and write its items below. */
const NEWS_VERSION = "3.0.0";
const SEEN = "rg.newsSeen";

const ITEMS: { title: Key; text: Key }[] = [
  { title: "news3Windows", text: "news3WindowsText" },
  { title: "news3Downloads", text: "news3DownloadsText" },
  { title: "news3Chat", text: "news3ChatText" },
  { title: "news3Voice", text: "news3VoiceText" },
  { title: "news3Skills", text: "news3SkillsText" },
  { title: "news3Automations", text: "news3AutomationsText" },
  { title: "news3Browser", text: "news3BrowserText" },
];

export function WhatsNew() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (localStorage.getItem(SEEN) === NEWS_VERSION) return;
    void getApi()
      .sessions()
      .then(
        (rows) => {
          // A new installation: nothing to tell, only remember it was seen.
          if (rows.length > 0) setOpen(true);
          else localStorage.setItem(SEEN, NEWS_VERSION);
        },
        () => {},
      );
  }, []);
  if (!open) return null;
  const close = () => {
    localStorage.setItem(SEEN, NEWS_VERSION);
    setOpen(false);
  };
  return (
    <Modal title={t("newsTitle", { version: NEWS_VERSION })} onClose={close}>
      <div class="whats-new">
        {ITEMS.map((i) => (
          <section key={i.title}>
            <h3>{t(i.title)}</h3>
            <p>{t(i.text)}</p>
          </section>
        ))}
        <div class="row">
          <div class="spacer" />
          <button type="button" class="primary" onClick={close}>
            {t("newsOk")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
