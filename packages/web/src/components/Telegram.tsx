// Settings > Telegram, drawn as the wizard (2026-11-06): the wizard's own step (the three steps on
// a path beside a phone that shows what Telegram will show), then what only Settings had: every
// linked account, each with Unlink.
import { useEffect, useState } from "preact/hooks";
import type { SetupState } from "../api.js";
import { t } from "../i18n.js";
import { IconTelegram } from "../icons.js";
import { getApi } from "../state.js";
import { Box, Row, Sub } from "./SettingsKit-cornice.js";
import { PHONE, useMedia, type Wz, WzCtx } from "./SetupKit.js";
import { TelegramStep } from "./SetupTelegram.js";

type Link = { userId: number; username: string | null; linkedAt: string };

/** The accounts that talk to the bot, each with Unlink. */
function Accounts({ onUnlinked }: { onUnlinked: () => void }) {
  const [links, setLinks] = useState<Link[]>([]);
  const load = () =>
    void getApi()
      .telegramLinks()
      .then(setLinks, () => {});
  useEffect(() => {
    load();
    // An account linked from the steps above appears here too.
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, []);
  if (links.length === 0) return null;
  return (
    <>
      <Sub title={t("stTgAccounts")} lead={t("tgLinkedHint")} />
      <Box>
        {links.map((l) => (
          <Row
            key={l.userId}
            title={
              <span class="st-acct">
                <IconTelegram size={18} /> {l.username ? `@${l.username}` : String(l.userId)}
              </span>
            }
            help={t("tgLinked", { who: l.username ? `@${l.username}` : String(l.userId) })}
          >
            <button
              type="button"
              class="wz-btn small quiet"
              onClick={() =>
                void getApi()
                  .telegramUnlink(l.userId)
                  .then(() => {
                    load();
                    onUnlinked();
                  })
              }
            >
              {t("unlink")}
            </button>
          </Row>
        ))}
      </Box>
    </>
  );
}

/** Settings, Telegram: the same steps as the wizard, and the linked accounts. */
export function Telegram() {
  const [s, setS] = useState<SetupState | null>(null);
  // Unlinking starts the steps again from what the server says.
  const [round, setRound] = useState(0);
  const phone = useMedia(PHONE);
  const load = () =>
    void getApi()
      .setup()
      .then(setS, () => {});
  useEffect(load, []);
  if (!s) return null;
  const wz: Wz = {
    s,
    reload: load,
    phone,
    go: () => {},
    next: { current: undefined },
    finish: () => {},
  };
  return (
    <div class="settings-section wz-look st-page st-telegram">
      <p class="wz-eyebrow st-eyebrow">{t("telegram")}</p>
      <WzCtx.Provider value={wz}>
        <TelegramStep key={round} />
      </WzCtx.Provider>
      <section class="wz-inner">
        <Accounts onUnlinked={() => setRound((r) => r + 1)} />
      </section>
    </div>
  );
}
