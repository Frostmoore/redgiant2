import { useEffect, useState } from "preact/hooks";
import { t } from "../i18n.js";
import { attempt, getApi } from "../state.js";

/** Pairing Demi-God's bot with the user's Telegram account. */
export function Telegram() {
  const [pairing, setPairing] = useState<{
    code: string;
    bot: string;
    link: string;
    expiresAt: string;
  } | null>(null);
  const [links, setLinks] = useState<
    { userId: number; username: string | null; linkedAt: string }[]
  >([]);
  const [error, setError] = useState<string | null>(null);
  const reload = () => void attempt(() => getApi().telegramLinks()).then((l) => l && setLinks(l));
  useEffect(reload, []);
  useEffect(() => {
    if (!pairing) return;
    const timer = setInterval(reload, 3000);
    return () => clearInterval(timer);
  }, [pairing]);
  const pair = async () => {
    try {
      setError(null);
      setPairing(await getApi().telegramPair());
    } catch (err) {
      setError(
        (err as Error).message === "Telegram is not configured"
          ? t("telegramOff")
          : (err as Error).message,
      );
    }
  };
  return (
    <div class="hierarchy">
      <h3>{t("pair")}</h3>
      {error && <div class="notice error">{error}</div>}
      {pairing ? (
        <div class="approval">
          <div>{t("pairHint")}</div>
          <pre class="pairing-code">/start {pairing.code}</pre>
          <a href={`${pairing.link}?start=${pairing.code}`} target="_blank" rel="noreferrer">
            @{pairing.bot}
          </a>
        </div>
      ) : (
        <div class="row">
          <button type="button" class="primary" onClick={() => void pair()}>
            {t("pair")}
          </button>
        </div>
      )}
      <h3>{t("linkedAccounts")}</h3>
      {links.length === 0 ? (
        <div class="dim">{t("noLinks")}</div>
      ) : (
        links.map((l) => (
          <div class="node-row" key={l.userId}>
            <strong>{l.username ? `@${l.username}` : l.userId}</strong>
            <span class="dim">{new Date(l.linkedAt).toLocaleString()}</span>
            <button
              type="button"
              class="danger"
              onClick={() => void attempt(() => getApi().telegramUnlink(l.userId)).then(reload)}
            >
              {t("unlink")}
            </button>
          </div>
        ))
      )}
    </div>
  );
}
