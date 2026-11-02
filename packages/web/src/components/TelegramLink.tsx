// Telegram, step by step (G24.4): make a bot with BotFather, paste its token, then open the bot
// and press Start (the link carries the pairing code: nothing to type). The page notices by
// itself when the account is linked. Used by the wizard and by Settings.
import { useEffect, useState } from "preact/hooks";
import type { SetupState } from "../api.js";
import { t } from "../i18n.js";
import { IconCheck, IconTelegram } from "../icons.js";
import { getApi } from "../state.js";
import { explain } from "./Brain.js";
import { Field, Qr } from "./ui.js";

type Link = { userId: number; username: string | null; linkedAt: string };

export function TelegramLink({ s, onChange }: { s: SetupState; onChange?: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [pairing, setPairing] = useState<{ bot: string; url: string } | null>(null);
  const [links, setLinks] = useState<Link[]>([]);
  const [changing, setChanging] = useState(false);
  // Set as soon as Telegram accepts the token, before the page reloads the settings.
  const [accepted, setAccepted] = useState(false);
  const hasBot = accepted || s.secretsSet.telegram || s.locked.telegram === true;
  const loadLinks = () =>
    void getApi()
      .telegramLinks()
      .then(setLinks, () => {});
  const pair = () =>
    void getApi()
      .telegramPair()
      .then(
        (p) => setPairing({ bot: p.bot, url: `${p.link}?start=${p.code}` }),
        (e: unknown) => setError(explain(e)),
      );
  useEffect(() => {
    loadLinks();
    if (hasBot) pair();
  }, []);
  // While the code waits, the account appears as soon as Start is pressed in Telegram.
  useEffect(() => {
    if (!pairing || links.length > 0) return;
    const timer = setInterval(loadLinks, 2500);
    return () => clearInterval(timer);
  }, [pairing, links.length]);
  const connect = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await getApi().setupTelegram(token.trim());
      setAccepted(true);
      setToken("");
      setChanging(false);
      pair();
      onChange?.();
    } catch (err) {
      setError(explain(err));
    }
    setBusy(false);
  };
  const tokenForm = (
    <ol class="brain-steps">
      <li>
        {t("tgStep1")}{" "}
        <a class="button" href="https://t.me/BotFather" target="_blank" rel="noreferrer">
          <IconTelegram size={14} /> {t("tgOpenBotFather")}
        </a>
      </li>
      <li>{t("tgStep2")}</li>
      <li>
        <form class="tg-token" onSubmit={(e) => void connect(e)}>
          <Field label={t("tgStep3")} help={t("tgTokenHelp")}>
            <input
              type="password"
              autocomplete="off"
              placeholder="123456789:AAH…"
              value={token}
              onInput={(e) => setToken((e.target as HTMLInputElement).value)}
            />
          </Field>
          <button type="submit" class="primary" disabled={busy || token.trim().length < 20}>
            {busy ? t("wzTrying") : t("wzConnect")}
          </button>
        </form>
      </li>
    </ol>
  );
  return (
    <div class="tg">
      {links.length > 0 ? (
        <div class="brain-panel">
          {links.map((l) => (
            <div class="row" key={l.userId}>
              <span class="notice ok">
                <IconCheck size={14} />{" "}
                {t("tgLinked", { who: l.username ? `@${l.username}` : String(l.userId) })}
              </span>
              <div class="spacer" />
              <button
                type="button"
                class="link"
                onClick={() => void getApi().telegramUnlink(l.userId).then(loadLinks)}
              >
                {t("unlink")}
              </button>
            </div>
          ))}
          <p class="ui-help">{t("tgLinkedHint")}</p>
        </div>
      ) : hasBot && pairing && !changing ? (
        <div class="brain-panel">
          <h3>{t("tgLastStep", { bot: pairing.bot })}</h3>
          <div class="tg-pair">
            <div>
              <p>{t("tgPressStart")}</p>
              <a class="button primary" href={pairing.url} target="_blank" rel="noreferrer">
                <IconTelegram size={14} /> {t("tgOpenBot", { bot: pairing.bot })}
              </a>
              <p class="ui-help">{t("tgWaiting")}</p>
            </div>
            <div class="tg-qr">
              <Qr text={pairing.url} label={t("tgQr")} />
              <span class="ui-help">{t("tgQr")}</span>
            </div>
          </div>
          {!s.locked.telegram && (
            <button type="button" class="link" onClick={() => setChanging(true)}>
              {t("tgChangeBot")}
            </button>
          )}
        </div>
      ) : s.locked.telegram ? (
        <p class="notice">{t("wzLocked")}</p>
      ) : (
        <div class="brain-panel">{tokenForm}</div>
      )}
      {error && <p class="notice error">{error}</p>}
    </div>
  );
}
