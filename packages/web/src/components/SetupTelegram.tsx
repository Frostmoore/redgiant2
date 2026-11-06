// "RedGiant on your phone" (2026-11-06, the person's prototype): three steps on a path, each
// lit when it is its turn and ticked when done; next to them, on a computer, a phone that shows
// what Telegram will show; on a phone the same chat, flat, inside the step. Make the bot with
// BotFather, paste its token, open the bot and press Start (the link carries the pairing code).
import { useEffect, useState } from "preact/hooks";
import { t } from "../i18n.js";
import { IconCheck, IconSend, IconSpark } from "../icons.js";
import { getApi } from "../state.js";
import { explain } from "./Brain.js";
import { Head, useWz } from "./SetupKit.js";
import { Qr } from "./ui.js";

type Link = { userId: number; username: string | null; linkedAt: string };
type Stage = "done" | "now" | "later";
const BOTFATHER = "https://t.me/BotFather";

/** A chat as Telegram shows it: who, the messages, what is at the bottom. */
function Chat({
  cap,
  rg,
  name,
  sub,
  msgs,
  bottom,
}: {
  cap?: string;
  rg?: boolean;
  name: string;
  sub: string;
  msgs: [boolean, string][];
  bottom?: "start" | "input";
}) {
  return (
    <div class="wz-chat">
      {cap && <div class="wz-chat-cap">{cap}</div>}
      <div class="wz-chat-hd">
        <span class={`wz-chat-av${rg ? " rg" : ""}`}>
          {rg ? <IconSpark size={17} /> : <IconSend size={17} />}
        </span>
        <div>
          <b>{name}</b>
          <small>{sub}</small>
        </div>
      </div>
      <div class="wz-msgs">
        {msgs.map(([me, text], i) => (
          <div key={`${i}-${text}`} class={`wz-bub${me ? " me" : ""}`}>
            {text}
          </div>
        ))}
      </div>
      {bottom === "start" && <div class="wz-startbar">{t("wzTgStart")}</div>}
      {bottom === "input" && <div class="wz-inbar">{t("wzTgMessage")}</div>}
    </div>
  );
}

export function TelegramStep() {
  const { s, reload, phone } = useWz();
  const [opened, setOpened] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [pairing, setPairing] = useState<{ bot: string; url: string; code: string } | null>(null);
  const [links, setLinks] = useState<Link[]>([]);
  const [changing, setChanging] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const hasBot = (accepted || s.secretsSet.telegram || s.locked.telegram === true) && !changing;
  const loadLinks = () =>
    void getApi()
      .telegramLinks()
      .then(setLinks, () => {});
  const pair = () =>
    void getApi()
      .telegramPair()
      .then(
        (p) => setPairing({ bot: p.bot, url: `${p.link}?start=${p.code}`, code: p.code }),
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
  const check = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await getApi().setupTelegram(token.trim());
      setAccepted(true);
      setToken("");
      setChanging(false);
      pair();
      reload();
    } catch (err) {
      setError(explain(err));
    }
    setBusy(false);
  };
  const linked = changing ? undefined : links[0];
  const demigod = s.names.demigod ?? "Demi-God";
  const god = s.names.god ?? "God";
  const bot = pairing?.bot ?? t("wzTgExampleBot");
  const s1: Stage = opened || hasBot ? "done" : "now";
  const s2: Stage = hasBot ? "done" : opened ? "now" : "later";
  const s3: Stage = linked ? "done" : hasBot ? "now" : "later";
  const word = { done: t("wzTgDone"), now: t("wzTgNow"), later: t("wzTgLater") };
  const dot = (n: number, st: Stage) => (
    <span class="wz-dot">{st === "done" ? <IconCheck size={20} /> : n}</span>
  );
  const botFather = (
    <Chat
      cap={phone ? t("wzTgYouWillSee") : undefined}
      name="BotFather"
      sub={t("wzTgOfficial")}
      msgs={[
        [true, "/newbot"],
        [false, t("wzTgBf1")],
        [true, t("wzTgBfName")],
        [false, t("wzTgBf2")],
        [true, t("wzTgExampleBot")],
        ...(opened || !phone ? ([[false, t("wzTgBf3")]] as [boolean, string][]) : []),
      ]}
      bottom={phone ? undefined : "input"}
    />
  );
  const botChat = (
    <Chat
      cap={phone ? t("wzTgYouWillSee") : undefined}
      rg
      name={`@${bot}`}
      sub="bot"
      msgs={[[false, t("wzTgPressStart")]]}
      bottom="start"
    />
  );
  const greeting = (
    <Chat
      cap={phone ? t("wzTgYourBot") : undefined}
      rg
      name={demigod}
      sub={t("wzTgOnline")}
      msgs={[
        [true, "/start"],
        [false, t("wzTgHello", { demigod, god })],
        [false, t("wzTgAsks")],
      ]}
      bottom={phone ? undefined : "input"}
    />
  );
  const shown = linked ? greeting : hasBot ? botChat : botFather;
  return (
    <div class="wz-inner">
      <Head q={t("wzTgQ")} lead={t("wzTgLead", { demigod })} />
      <div class="wz-tg">
        {!phone && (
          <div class="wz-phone" aria-hidden="true">
            <div class="wz-notch" />
            <div class="wz-scr">{shown}</div>
          </div>
        )}
        <ol class="wz-path">
          <li class={s1}>
            {dot(1, s1)}
            <div>
              <h3>
                {t("wzTgStep1")} <span class="wz-st">{word[s1]}</span>
              </h3>
              <p>{t("wzTgStep1Text")}</p>
              <div class="wz-path-body">
                <a
                  class={`wz-btn small${phone ? " primary block" : ""}`}
                  href={BOTFATHER}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => setOpened(true)}
                >
                  <IconSend size={18} />
                  {t("wzTgOpenBf")}
                </a>
                <button type="button" class="wz-link inl" onClick={() => setOpened(true)}>
                  {t("wzTgHaveToken")}
                </button>
                {phone && botFather}
              </div>
            </div>
          </li>
          <li class={s2}>
            {dot(2, s2)}
            <div>
              <h3>
                {t("wzTgStep2")} <span class="wz-st">{word[s2]}</span>
              </h3>
              <p>{t("wzTgStep2Text")}</p>
              <form class="wz-path-body" onSubmit={(e) => void check(e)}>
                <input
                  class="wz-field mono"
                  type="password"
                  autocomplete="off"
                  autocapitalize="off"
                  spellcheck={false}
                  enterkeyhint="go"
                  aria-label={t("wzTgToken")}
                  placeholder="123456789:AAH…"
                  value={token}
                  onInput={(e) => setToken((e.target as HTMLInputElement).value)}
                />
                <button
                  type="submit"
                  class={`wz-btn small${phone ? " primary block" : ""}`}
                  disabled={busy || token.trim().length < 20}
                >
                  {busy ? t("wzTgChecking") : t("wzTgCheck")}
                </button>
              </form>
              {error && <p class="notice error">{error}</p>}
            </div>
          </li>
          <li class={s3}>
            {dot(3, s3)}
            <div>
              <h3>
                {t("wzTgStep3")} <span class="wz-st">{word[s3]}</span>
              </h3>
              {linked ? (
                <p>{t("wzTgLinkedShort")}</p>
              ) : (
                <>
                  <p>
                    {t("wzTgStep3Text", {
                      bot: pairing ? `@${pairing.bot}` : t("wzTgYourBotName"),
                    })}
                  </p>
                  {pairing && (
                    <div class="wz-path-body">
                      <span class="wz-code">{pairing.code}</span>
                      {phone && botChat}
                      <a
                        class={`wz-btn small${phone ? " primary block" : ""}`}
                        href={pairing.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <IconSend size={18} />
                        {t("tgOpenBot", { bot: pairing.bot })}
                      </a>
                      {!phone && (
                        <div class="wz-tg-qr">
                          <Qr text={pairing.url} label={t("tgQr")} />
                          <span>{t("tgQr")}</span>
                        </div>
                      )}
                      <span class="ui-help">{t("tgWaiting")}</span>
                    </div>
                  )}
                </>
              )}
            </div>
          </li>
        </ol>
      </div>
      {linked && (
        <div class="wz-linked">
          <div class="wz-note">
            <IconSend size={22} />
            <span>
              {t("wzTgLinked", {
                who: linked.username ? `@${linked.username}` : String(linked.userId),
                demigod,
              })}
            </span>
          </div>
          {phone && greeting}
          {!s.locked.telegram && (
            <p class="wz-more">
              <button
                type="button"
                class="wz-link"
                onClick={() => {
                  setChanging(true);
                  setAccepted(false);
                  setPairing(null);
                  setOpened(true);
                }}
              >
                {t("tgChangeBot")}
              </button>
            </p>
          )}
        </div>
      )}
      {s.locked.telegram && <p class="notice">{t("wzLocked")}</p>}
    </div>
  );
}
