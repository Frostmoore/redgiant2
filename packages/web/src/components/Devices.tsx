import { useEffect, useState } from "preact/hooks";
import qrcode from "qrcode-generator";
import type { Device } from "../api.js";
import { t } from "../i18n.js";
import { IconPhone, IconTrash } from "../icons.js";
import { attempt, getApi } from "../state.js";

/** The QR code of an address, as SVG drawn here (no service sees the code). */
function Qr({ text }: { text: string }) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return (
    <div
      class="qr"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: SVG made here from our own address.
      dangerouslySetInnerHTML={{
        __html: qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true }),
      }}
    />
  );
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : t("never"));

/**
 * Pairing phones and other browsers (G20.9): a QR code opens RedGiant already signed in, with a
 * token of its own that can be revoked here without touching the others.
 */
export function Devices() {
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string } | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const reload = () => void attempt(() => getApi().devices()).then((d) => d && setDevices(d));
  useEffect(reload, []);
  // While the code is shown, the list follows: the new phone appears when it signs in.
  useEffect(() => {
    if (!pairing) return;
    const timer = setInterval(reload, 3000);
    const end = setTimeout(
      () => setPairing(null),
      new Date(pairing.expiresAt).getTime() - Date.now(),
    );
    return () => {
      clearInterval(timer);
      clearTimeout(end);
    };
  }, [pairing]);
  const link = pairing ? `${location.origin}/#pair=${pairing.code}` : "";
  return (
    <div class="hierarchy">
      <p class="dim">{t("devicesHint")}</p>
      {pairing ? (
        <div class="pairing">
          <Qr text={link} />
          <div>
            <p>{t("scanWithPhone")}</p>
            <code class="pairing-code">{pairing.code}</code>
            <p class="dim">
              {t("codeExpires", {
                time: new Date(pairing.expiresAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                }),
              })}
            </p>
            <button type="button" onClick={() => setPairing(null)}>
              {t("close")}
            </button>
          </div>
        </div>
      ) : (
        <div class="row">
          <button
            type="button"
            class="primary"
            onClick={() =>
              void attempt(() => getApi().pairDevice()).then((p) => p && setPairing(p))
            }
          >
            <IconPhone /> {t("pairDevice")}
          </button>
        </div>
      )}
      <h3>{t("pairedDevices")}</h3>
      {devices.length === 0 ? (
        <div class="dim">{t("noDevices")}</div>
      ) : (
        devices.map((d) => (
          <div class="node-row" key={d.id}>
            <IconPhone />
            <strong>{d.name}</strong>
            <span class="dim">
              {t("deviceSince", { date: when(d.createdAt) })} ·{" "}
              {t("lastSeen", { date: when(d.lastSeenAt) })}
            </span>
            <button
              type="button"
              class="icon-button"
              title={t("revoke")}
              onClick={() => {
                if (confirm(t("confirmRevoke", { name: d.name })))
                  void attempt(() => getApi().revokeDevice(d.id)).then(reload);
              }}
            >
              <IconTrash />
            </button>
          </div>
        ))
      )}
    </div>
  );
}
