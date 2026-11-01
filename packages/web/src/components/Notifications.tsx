import { useEffect, useState } from "preact/hooks";
import type { SetupState } from "../api.js";
import { t } from "../i18n.js";
import { attempt, getApi } from "../state.js";

/**
 * Push notifications through ntfy (G20.4): approvals and questions, long or failed turns,
 * budgets near their limit, proposals and automations. The phone needs the ntfy app
 * subscribed to the same topic.
 */
export function Notifications() {
  const [s, setS] = useState<SetupState | null>(null);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const load = () =>
    void attempt(() => getApi().setup()).then((x) => {
      if (!x) return;
      setS(x);
      setUrl(x.config.ntfyUrl ?? "");
    });
  useEffect(load, []);
  if (!s) return null;
  const locked = s.locked.notifications === true;
  const save = async (off = false) => {
    setNote(null);
    const ok = await attempt(() =>
      getApi().setupNotifications(
        off || !url.trim() ? null : { url: url.trim(), ...(token && { token }) },
      ),
    );
    if (ok !== undefined) {
      setToken("");
      setNote({ ok: true, text: t("saved") });
      load();
    }
  };
  const test = async () => {
    setNote(null);
    try {
      await getApi().testNotification();
      setNote({ ok: true, text: t("ntfySent") });
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    }
  };
  return (
    <div class="hierarchy">
      <p class="dim">{t("ntfyHint")}</p>
      <form
        class="form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label>
          {t("ntfyUrl")}
          <input
            placeholder="https://ntfy.sh/redgiant-…"
            value={url}
            disabled={locked}
            onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
          />
          {locked && <span class="chip muted">{t("wzLocked")}</span>}
        </label>
        <label>
          {t("ntfyToken")}
          {s.secretsSet.ntfy ? ` (${t("wzAlreadySet")})` : ""}
          <input
            type="password"
            autocomplete="off"
            value={token}
            disabled={locked}
            onInput={(e) => setToken((e.target as HTMLInputElement).value)}
          />
        </label>
        <div class="row wide">
          <button type="submit" class="primary" disabled={locked}>
            {t("save")}
          </button>
          {s.config.ntfyUrl && !locked && (
            <button type="button" onClick={() => void save(true)}>
              {t("turnOff")}
            </button>
          )}
          <button type="button" disabled={!s.config.ntfyUrl && !locked} onClick={() => void test()}>
            {t("ntfyTest")}
          </button>
        </div>
      </form>
      {note && <div class={`notice ${note.ok ? "ok" : "error"}`}>{note.text}</div>}
    </div>
  );
}
