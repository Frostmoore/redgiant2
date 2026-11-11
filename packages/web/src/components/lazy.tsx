// Views loaded the first time they are shown, not with the page (3.5.11): the canvas and its
// editors, the terminal, Settings. Until the code is here a small «Loading…»; if it cannot come
// (an update replaced the files, the connection dropped) a line with «Reload».
import { type FunctionComponent, h } from "preact";
import { useEffect, useState } from "preact/hooks";
import { t } from "../i18n.js";

export function lazy<P extends object>(load: () => Promise<FunctionComponent<P>>) {
  let loaded: FunctionComponent<P> | undefined;
  let pending: Promise<FunctionComponent<P>> | undefined;
  const get = () => {
    pending ??= load().then(
      (v) => {
        loaded = v;
        return v;
      },
      (e: unknown) => {
        // The next try loads again (the files may be back).
        pending = undefined;
        throw e;
      },
    );
    return pending;
  };
  function Lazy(props: P) {
    const [view, setView] = useState(() => loaded);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
      if (view) return;
      let live = true;
      void get().then(
        (v) => live && setView(() => v),
        () => live && setFailed(true),
      );
      return () => {
        live = false;
      };
    }, [view]);
    if (view) return h(view, props);
    if (failed)
      return (
        <div class="empty lazy-failed" role="alert">
          <span>{t("lazyFailed")}</span>{" "}
          <button type="button" class="link" onClick={() => location.reload()}>
            {t("connReload")}
          </button>
        </div>
      );
    return (
      <div class="empty dim lazy-loading" role="status" aria-live="polite">
        {t("loading")}
      </div>
    );
  }
  /** Starts loading ahead (on hover, or when the view is about to open). */
  Lazy.preload = () => void get().catch(() => {});
  return Lazy;
}
