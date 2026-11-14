// The keychain in the person's own browser (G36.21): which browsers are linked (with «Unlink»),
// and the window that links a new one: download the extension, load it, type the address and a
// code that works ten minutes for one browser.
import type { VaultBrowser, VaultBrowserCode } from "@redgiant/protocol";
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../i18n.js";
import { IconCopy, IconDownload, IconGlobe, IconKey, IconTrash } from "../icons.js";
import { getApi } from "../state.js";
import { explain } from "./Brain.js";
import { Acts, Seg, Sub } from "./SettingsKit.js";
import { Modal } from "./ui.js";

const RELEASES = "https://github.com/Frostmoore/redgiant2/releases/latest/download";
const ZIP = {
  chromium: "redgiant-keychain-chromium.zip",
  firefox: "redgiant-keychain-firefox.zip",
};
type Browser = "opera" | "chrome" | "edge" | "brave" | "firefox";
const PAGES: Record<Exclude<Browser, "firefox">, string> = {
  opera: "opera://extensions",
  chrome: "chrome://extensions",
  edge: "edge://extensions",
  brave: "brave://extensions",
};
const LABEL: Record<string, string> = {
  opera: "Opera",
  chrome: "Chrome",
  edge: "Edge",
  brave: "Brave",
  firefox: "Firefox",
  other: "Browser",
};

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** This browser, to open its instructions first (Opera when unsure: the person uses it). */
function thisBrowser(): Browser {
  const ua = navigator.userAgent;
  if (/\bOPR\//.test(ua)) return "opera";
  if (/\bEdg\//.test(ua)) return "edge";
  if ((navigator as { brave?: unknown }).brave) return "brave";
  if (/\bFirefox\//.test(ua)) return "firefox";
  if (/\bChrome\//.test(ua)) return "chrome";
  return "opera";
}

/** The zips this RedGiant serves (built with it), or the latest release's. */
function useDownloads() {
  const [local, setLocal] = useState<boolean>();
  useEffect(() => {
    void fetch(`/${ZIP.chromium}`, { method: "HEAD" })
      .then((r) => setLocal(r.ok && (r.headers.get("content-type") ?? "").includes("zip")))
      .catch(() => setLocal(false));
  }, []);
  const href = (z: string) => (local ? `/${z}` : `${RELEASES}/${z}`);
  return { chromium: href(ZIP.chromium), firefox: href(ZIP.firefox) };
}

function CopyField({ label, value, big }: { label: string; value: string; big?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div class="kcb-copy">
      <span class="kcb-copy-label">{label}</span>
      <div class="kcb-copy-row">
        <code class={big ? "kcb-code" : "kcb-addr"}>{value}</code>
        <button
          type="button"
          class="wz-btn small quiet"
          onClick={() => {
            void navigator.clipboard?.writeText(value).catch(() => {});
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          <IconCopy size={16} /> {copied ? t("kcBrCopied") : t("kcBrCopy")}
        </button>
      </div>
    </div>
  );
}

export function LinkBrowserWindow({ onClose }: { onClose: (changed: boolean) => void }) {
  const [browser, setBrowser] = useState<Browser>(thisBrowser);
  const [code, setCode] = useState<VaultBrowserCode>();
  const [linked, setLinked] = useState<VaultBrowser>();
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState<string>();
  const known = useRef<Set<string>>(new Set());
  const downloads = useDownloads();
  const address = location.origin;
  const away =
    location.protocol === "http:" &&
    !/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/.test(
      location.hostname,
    ) &&
    location.hostname.includes(".");

  const make = async () => {
    setError(undefined);
    setExpired(false);
    try {
      known.current = new Set((await getApi().vaultBrowsers()).map((b) => b.id));
      setCode(await getApi().vaultBrowserCode());
    } catch (err) {
      setError(explain(err));
    }
  };
  // While a code is shown: is a new browser there yet? (every three seconds, until it expires)
  useEffect(() => {
    if (!code || linked) return;
    const id = setInterval(async () => {
      if (Date.parse(code.expiresAt) < Date.now()) {
        setExpired(true);
        setCode(undefined);
        return;
      }
      const list = await getApi()
        .vaultBrowsers()
        .catch(() => []);
      const fresh = list.find((b) => !known.current.has(b.id));
      if (fresh) setLinked(fresh);
    }, 3000);
    return () => clearInterval(id);
  }, [code, linked]);

  const how =
    browser === "firefox"
      ? t("kcBrHowFirefox")
      : browser === "opera"
        ? t("kcBrHowOpera")
        : t("kcBrHowChromium", { page: PAGES[browser] });
  return (
    <Modal
      title={t("kcBrWinTitle")}
      icon={
        <span class="kc-ico big">
          <IconGlobe size={22} />
        </span>
      }
      onClose={() => onClose(Boolean(linked))}
      foot={
        <Acts>
          <button type="button" class="wz-btn" onClick={() => onClose(Boolean(linked))}>
            {t("close")}
          </button>
        </Acts>
      }
    >
      <div class="wz-panel-in kc-form kcb-win">
        <p class="wz-lead2">{t("kcBrWinLead")}</p>
        <h3 class="kcb-step">{t("kcBrStep1")}</h3>
        <Seg
          value={browser}
          label={t("kcBrWhich")}
          options={(["opera", "chrome", "edge", "brave", "firefox"] as const).map((b) => [
            b,
            LABEL[b] ?? b,
          ])}
          onChange={setBrowser}
        />
        <div class="kc-row-acts">
          <a
            class="wz-btn primary"
            href={browser === "firefox" ? downloads.firefox : downloads.chromium}
            download
          >
            <IconDownload size={18} />{" "}
            {browser === "firefox" ? t("kcBrDownloadFirefox") : t("kcBrDownload")}
          </a>
        </div>
        <p class="kc-note kcb-how">{how}</p>
        <p class="kc-note">{t("kcBrStore")}</p>
        <h3 class="kcb-step">{t("kcBrStep2")}</h3>
        {away && <p class="notice warn">{t("kcBrHttpNote")}</p>}
        {linked ? (
          <p class="notice ok">{t("kcBrDone", { name: linked.name })}</p>
        ) : code ? (
          <>
            <p class="kc-note">{t("kcBrCodeLead")}</p>
            <CopyField label={t("kcBrAddress")} value={address} />
            <CopyField label={t("kcBrCode")} value={code.code} big />
            <p class="kc-note">
              {t("kcBrExpires", {
                time: new Date(code.expiresAt).toLocaleTimeString(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                }),
              })}
            </p>
          </>
        ) : (
          <>
            {expired && <p class="notice warn">{t("kcBrExpired")}</p>}
            <div class="kc-row-acts">
              <button type="button" class="wz-btn primary" onClick={() => void make()}>
                <IconKey size={18} /> {t("kcBrMakeCode")}
              </button>
            </div>
          </>
        )}
        {error && <p class="notice error">{error}</p>}
      </div>
    </Modal>
  );
}

/** «In your browser»: the linked browsers and the button that links one more. */
export function KeychainBrowsers() {
  const [list, setList] = useState<VaultBrowser[]>();
  const [linking, setLinking] = useState(false);
  const [unlinking, setUnlinking] = useState<VaultBrowser>();
  const [error, setError] = useState<string>();
  const load = () =>
    getApi()
      .vaultBrowsers()
      .then(setList)
      .catch((err: unknown) => setError(explain(err)));
  useEffect(() => {
    void load();
  }, []);
  return (
    <>
      <Sub title={t("kcBrTitle")} lead={t("kcBrLead")} />
      {list && list.length > 0 ? (
        <div class="kc-list kcb-list">
          {list.map((b) => (
            <div key={b.id} class="kc-item kcb-item">
              <span class="kc-ico">
                <IconGlobe size={20} />
              </span>
              <span class="kc-item-text">
                <b>{b.name}</b>
                <small>
                  {LABEL[b.browser] ?? b.browser} · {t("kcBrLinked", { when: when(b.createdAt) })} ·{" "}
                  {b.lastSeenAt ? t("kcBrSeen", { when: when(b.lastSeenAt) }) : t("kcBrNever")}
                </small>
              </span>
              <button type="button" class="wz-btn small quiet" onClick={() => setUnlinking(b)}>
                <IconTrash size={16} /> {t("kcBrUnlink")}
              </button>
            </div>
          ))}
        </div>
      ) : (
        list && <p class="kc-note">{t("kcBrNone")}</p>
      )}
      <div class="st-acts kc-move">
        <button type="button" class="wz-btn" onClick={() => setLinking(true)}>
          <IconGlobe size={18} /> {t("kcBrLink")}
        </button>
      </div>
      {error && <p class="notice error">{error}</p>}
      {linking && (
        <LinkBrowserWindow
          onClose={(changed) => {
            setLinking(false);
            if (changed) void load();
          }}
        />
      )}
      {unlinking && (
        <Modal
          title={t("kcBrUnlinkQ", { name: unlinking.name })}
          onClose={() => setUnlinking(undefined)}
          foot={
            <Acts>
              <button type="button" class="wz-btn" onClick={() => setUnlinking(undefined)}>
                {t("cancel")}
              </button>
              <button
                type="button"
                class="wz-btn primary danger"
                onClick={async () => {
                  try {
                    await getApi().unlinkVaultBrowser(unlinking.id);
                  } catch (err) {
                    setError(explain(err));
                  }
                  setUnlinking(undefined);
                  void load();
                }}
              >
                <IconTrash size={18} /> {t("kcBrUnlink")}
              </button>
            </Acts>
          }
        >
          <div class="wz-panel-in">
            <p class="wz-lead2">{t("kcBrUnlinkText")}</p>
          </div>
        </Modal>
      )}
    </>
  );
}
