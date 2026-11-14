// «You already have your own infrastructure» (G39.8), in Settings › Access from outside home and
// in the first start: for people who already reach their machines through a reverse proxy
// (Caddy, Traefik, Nginx Proxy Manager; with or without forward auth), a VPN (Tailscale on the
// machine or as a subnet router, WireGuard, ZeroTier) and a home DNS (Pi-hole, AdGuard, the
// router). The blocks to copy are filled with RedGiant's data; when RedGiant sees the page come
// through a proxy or with a name it says «You are reachable as <host>»; «Skip: I am reachable
// already» stops the invitations to set up RedGiant's own ways.
import type { NetDetected } from "@redgiant/protocol";
import { useEffect, useState } from "preact/hooks";
import type { SetupState } from "../api.js";
import { t } from "../i18n.js";
import { IconCheck, IconCopy, IconGlobe, IconInfo, IconServer, IconShield } from "../icons.js";
import {
  caddyBlock,
  caddyForwardAuthBypass,
  caddyWildcardBlock,
  dnsmasqWildcard,
  healthCheck,
  infraData,
  parentDomain,
  reachUrl,
  subnetOf,
  tailscaleServe,
  tailscaleSubnet,
  traefikBlock,
} from "../own-infra.js";
import { attempt, getApi } from "../state.js";
import { explain } from "./Brain.js";
import { Acts, Box, Seg } from "./SettingsKit.js";
import { Field } from "./ui.js";

type Part = "proxy" | "vpn" | "dns";
type Proxy = "caddy" | "traefik" | "npm";

/** A block to copy, with its button. */
export function CopyBlock({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div class="oi-block">
      {label && <span class="oi-block-label">{label}</span>}
      <pre class="oi-code">
        <code>{text}</code>
      </pre>
      <button
        type="button"
        class="wz-btn small quiet"
        onClick={() =>
          void navigator.clipboard
            ?.writeText(text)
            .then(() => setCopied(true))
            .catch(() => {})
        }
      >
        {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
        <span>{copied ? t("oiCopied") : t("oiCopy")}</span>
      </button>
    </div>
  );
}

/** Whether the address answers as RedGiant: from this page itself, or at least reachable. */
async function checkReach(url: string): Promise<"redgiant" | "answers" | "no"> {
  const health = `${url.replace(/\/$/, "")}/api/health`;
  try {
    if (new URL(health).origin === location.origin) {
      const r = await fetch(health);
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean };
      return j.ok ? "redgiant" : "no";
    }
    // Another origin: the browser does not let the page read the answer, only see that one came.
    await fetch(health, { mode: "no-cors", cache: "no-store" });
    return "answers";
  } catch {
    return "no";
  }
}

export function OwnInfra({
  s,
  onChange,
  net: given,
}: {
  s: SetupState;
  onChange: () => void;
  /** What was found already (the first start's step has it); otherwise asked here. */
  net?: NetDetected | null | undefined;
}) {
  const [net, setNet] = useState<NetDetected | null>(given ?? null);
  useEffect(() => {
    if (given !== undefined) return setNet(given);
    void attempt(() => getApi().setupNet()).then((x) => x && setNet(x));
  }, [given]);
  const reached = net?.reachedAs ?? null;
  const said = s.config.reachable;
  const [open, setOpen] = useState(false);
  const [part, setPart] = useState<Part>("proxy");
  const [proxy, setProxy] = useState<Proxy>("caddy");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [check, setCheck] = useState<"redgiant" | "answers" | "no" | "busy">();
  const [error, setError] = useState<string>();
  // The fields start from what RedGiant saw; the person can change them.
  useEffect(() => {
    if (!net) return;
    setName((n) => n || reached?.host || net.hostName || "");
    setAddress((a) => a || net.lan?.address || "");
  }, [net]);
  const d = infraData(name, address, net?.lan?.port);
  const https = reached ? reached.https : true;
  const url = said?.url ?? reachUrl(d.name, https);
  const shown = open || Boolean(reached) || Boolean(said);
  const skip = async (on: boolean) => {
    setError(undefined);
    try {
      await getApi().setReachable(on, on && name.trim() ? reachUrl(d.name, https) : undefined);
      onChange();
    } catch (err) {
      setError(explain(err));
    }
  };

  return (
    <div class="oi">
      {reached && (
        <div class="wz-note ok oi-found" role="status">
          <IconCheck size={20} />
          <span>
            <strong>{t("oiReachedAs", { host: reached.host })}</strong>{" "}
            {t(reached.through === "proxy" ? "oiReachedProxy" : "oiReachedName")}
          </span>
        </div>
      )}
      {said && (
        <div class="wz-note ok oi-said">
          <IconShield size={20} />
          <span>{said.url ? t("oiSaidUrl", { url: said.url }) : t("oiSaid")}</span>
          <button type="button" class="link" onClick={() => void skip(false)}>
            {t("oiSaidUndo")}
          </button>
        </div>
      )}
      {!shown ? (
        <Acts>
          <button type="button" class="wz-btn quiet" onClick={() => setOpen(true)}>
            <IconServer size={18} />
            <span>{t("oiOpen")}</span>
          </button>
        </Acts>
      ) : (
        <>
          <div class="oi-fields">
            <Field label={t("oiName")} help={t("oiNameHelp")}>
              <input
                type="text"
                spellcheck={false}
                autocapitalize="off"
                placeholder="redgiant.example.com"
                value={name}
                onInput={(e) => setName((e.target as HTMLInputElement).value)}
              />
            </Field>
            <Field label={t("oiAddress")} help={t("oiAddressHelp", { port: String(d.port) })}>
              <input
                type="text"
                spellcheck={false}
                inputMode="decimal"
                placeholder="192.168.1.50"
                value={address}
                onInput={(e) => setAddress((e.target as HTMLInputElement).value)}
              />
            </Field>
          </div>
          <Seg<Part>
            value={part}
            onChange={setPart}
            label={t("oiPart")}
            options={[
              ["proxy", t("oiPartProxy")],
              ["vpn", t("oiPartVpn")],
              ["dns", t("oiPartDns")],
            ]}
          />
          {part === "proxy" && (
            <Box class="oi-part">
              <p class="dim">{t("oiProxyLead")}</p>
              <Seg<Proxy>
                value={proxy}
                onChange={setProxy}
                label={t("oiPartProxy")}
                options={[
                  ["caddy", "Caddy"],
                  ["traefik", "Traefik"],
                  ["npm", "Nginx Proxy Manager"],
                ]}
              />
              {proxy === "caddy" && (
                <>
                  <CopyBlock label={t("oiCaddy")} text={caddyBlock(d)} />
                  <CopyBlock
                    label={t("oiCaddyWildcard", { domain: parentDomain(d.name) })}
                    text={caddyWildcardBlock(d)}
                  />
                  <p class="dim">{t("oiCaddyReload")}</p>
                </>
              )}
              {proxy === "traefik" && (
                <>
                  <CopyBlock label={t("oiTraefik")} text={traefikBlock(d)} />
                  <p class="dim">{t("oiTraefikNote")}</p>
                </>
              )}
              {proxy === "npm" && (
                <ol class="oi-steps">
                  <li>{t("oiNpm1", { name: d.name })}</li>
                  <li>{t("oiNpm2", { address: d.address, port: String(d.port) })}</li>
                  <li>{t("oiNpm3")}</li>
                  <li>{t("oiNpm4")}</li>
                </ol>
              )}
              <div class="wz-note info">
                <IconInfo size={20} />
                <span>{t("oiWs")}</span>
              </div>
              <h3 class="oi-h">{t("oiAuthTitle")}</h3>
              <p>{t("oiAuthWhy")}</p>
              <p class="dim">{t("oiAuthIf")}</p>
              {proxy === "caddy" && (
                <CopyBlock label={t("oiAuthCaddy")} text={caddyForwardAuthBypass(d)} />
              )}
            </Box>
          )}
          {part === "vpn" && (
            <Box class="oi-part">
              <h3 class="oi-h">{t("oiTsHere")}</h3>
              <p class="dim">
                {net?.tailscale.state === "running"
                  ? t("oiTsRunning", { name: net.tailscale.name ?? net.tailscale.ip ?? "" })
                  : t("oiTsHereLead")}
              </p>
              <CopyBlock label={t("oiTsServe")} text={tailscaleServe(d)} />
              <h3 class="oi-h">{t("oiTsSubnet")}</h3>
              <p class="dim">{t("oiTsSubnetLead", { subnet: subnetOf(d.address) })}</p>
              <CopyBlock text={tailscaleSubnet(d)} />
              <p class="dim">{t("oiTsSubnetThen", { address: d.address, port: String(d.port) })}</p>
              <h3 class="oi-h">{t("oiOtherVpn")}</h3>
              <p class="dim">{t("oiOtherVpnLead", { subnet: subnetOf(d.address) })}</p>
            </Box>
          )}
          {part === "dns" && (
            <Box class="oi-part">
              <p class="dim">{t("oiDnsLead")}</p>
              <ul class="oi-steps">
                <li>{t("oiDnsPihole", { name: d.name, address: d.address })}</li>
                <li>{t("oiDnsAdguard", { domain: parentDomain(d.name), address: d.address })}</li>
                <li>{t("oiDnsRouter")}</li>
              </ul>
              <CopyBlock
                label={t("oiDnsWildcard", { domain: parentDomain(d.name) })}
                text={dnsmasqWildcard(d)}
              />
              <p class="dim">{t("oiDnsTs")}</p>
            </Box>
          )}
          <h3 class="oi-h">{t("oiCheck")}</h3>
          <p class="dim">{t("oiCheckLead")}</p>
          <CopyBlock text={healthCheck(url)} />
          <Acts>
            <button
              type="button"
              class="wz-btn quiet"
              disabled={check === "busy"}
              onClick={() => {
                setCheck("busy");
                void checkReach(url).then(setCheck);
              }}
            >
              <IconGlobe size={18} />
              <span>{t("oiCheckGo", { url })}</span>
            </button>
          </Acts>
          {check && check !== "busy" && (
            <p class={`notice ${check === "no" ? "warn" : "ok"}`} role="status">
              {t(
                check === "redgiant"
                  ? "oiCheckRedgiant"
                  : check === "answers"
                    ? "oiCheckAnswers"
                    : "oiCheckNo",
              )}
            </p>
          )}
          {!said && (
            <Acts>
              <button type="button" class="wz-btn" onClick={() => void skip(true)}>
                <IconCheck size={18} />
                <span>{t("oiSkip")}</span>
              </button>
            </Acts>
          )}
          {!said && <p class="dim oi-skip-note">{t("oiSkipNote")}</p>}
          {error && <p class="notice error">{error}</p>}
        </>
      )}
    </div>
  );
}
