// RedGiant OS in Settings › System and the first boot (G39.1): Wi-Fi (the networks in reach,
// join with a password, forget), HTTPS in the local network (the machine's own certificate to
// download, short steps per system, the check that this device trusts it before http is sent to
// https), and the updates (RedGiant's signed stack applied by the machine, Debian's security
// updates, a restart asked in plain words). Every panel shows nothing where the installation is
// not RedGiant OS (no OS helper).
import type { LocalHttps, OsUpdates, WifiNetwork, WifiState } from "@redgiant/protocol";
import { useEffect, useRef, useState } from "preact/hooks";
import { type Key, t, tOptional } from "../i18n.js";
import {
  IconAlert,
  IconCheck,
  IconDownload,
  IconLock,
  IconRefresh,
  IconRestore,
  IconShield,
  IconTrash,
  IconWifi,
} from "../icons.js";
import { attempt, getApi } from "../state.js";
import { askConfirm } from "./dialogs.js";
import { Acts, Facts, SCard, Seg, Sub, SwitchRow } from "./SettingsKit.js";
import { refreshUpdateStatus, updateStatus } from "./UpdateGate.js";
import { Field, Qr } from "./ui.js";

const errorText = (code: string | undefined): string =>
  tOptional(`osErr_${code ?? "failed"}`) ?? t("osErr_failed");

/** Calls the API; on a refusal returns the error code instead of throwing. */
async function tryApi<T>(f: () => Promise<T>): Promise<{ ok: T } | { code: string }> {
  try {
    return { ok: await f() };
  } catch (err) {
    const e = err as { code?: unknown; body?: { code?: unknown } };
    const code =
      typeof e.code === "string"
        ? e.code
        : typeof e.body?.code === "string"
          ? e.body.code
          : "failed";
    return { code };
  }
}

// --- Wi-Fi -------------------------------------------------------------------------------------

function bars(signal: number): string {
  return signal >= 70 ? t("osWifiStrong") : signal >= 40 ? t("osWifiGood") : t("osWifiWeak");
}

/** Wi-Fi of the machine: the networks in reach, join, forget. */
export function WifiPanel({ initial }: { initial?: WifiState | undefined } = {}) {
  const [w, setW] = useState<WifiState | null>(initial ?? null);
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState<WifiNetwork | null>(null);
  const [hidden, setHidden] = useState(false);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [said, setSaid] = useState<{ ok: boolean; text: string }>();
  useEffect(() => {
    if (!initial) void attempt(() => getApi().setupWifi()).then((x) => x && setW(x));
  }, []);
  if (!w || (w.available !== true && (w.available !== false || w.why === "no_helper"))) return null;
  const scan = async () => {
    setBusy(true);
    const r = await attempt(() => getApi().setupWifiScan());
    setBusy(false);
    if (r) setW(r);
  };
  const join = async () => {
    const ssid = hidden ? name.trim() : (pick?.ssid ?? "");
    if (!ssid) return;
    setBusy(true);
    setSaid(undefined);
    const r = await tryApi(() => getApi().setupWifiConnect(ssid, password, hidden));
    setBusy(false);
    // The password leaves the page's memory at once, whatever happened.
    setPassword("");
    if ("ok" in r) {
      setW(r.ok.wifi);
      setPick(null);
      setHidden(false);
      setName("");
      setSaid({
        ok: true,
        text: t(r.ok.state === "saved" ? "osWifiSaved" : "osWifiJoined", { name: ssid }),
      });
    } else setSaid({ ok: false, text: errorText(r.code) });
  };
  const forget = async (ssid: string) => {
    if (
      !(await askConfirm(t("osWifiForgetQ", { name: ssid }), {
        text: t("osWifiForgetText"),
        yes: t("osWifiForget"),
      }))
    )
      return;
    const r = await attempt(() => getApi().setupWifiForget(ssid));
    if (r) setW(r);
  };
  const needsPassword = hidden || (pick !== null && pick.security !== "open");
  return (
    <SCard icon={<IconWifi size={22} />} title={t("osWifiTitle")} q={t("osWifiQ")}>
      {!w.available ? (
        <p class="dim">{t(`osWifiWhy_${w.why}` as Key)}</p>
      ) : (
        <>
          <Facts
            rows={[
              [
                t("osWifiNow"),
                w.connected
                  ? t("osWifiConnectedTo", { name: w.connected, ip: w.address ?? "…" })
                  : t("osWifiNotConnected"),
              ],
            ]}
          />
          {w.wired && (
            <div class="wz-note">
              <IconCheck size={18} />
              <span>{t("osWifiWired")}</span>
            </div>
          )}
          <Sub title={t("osWifiInReach")} />
          {w.networks.length === 0 ? (
            <p class="dim">{t("osWifiNone")}</p>
          ) : (
            <ul class="os-wifi-list">
              {w.networks.map((n) => (
                <li class="os-wifi-row" key={`${n.ssid}-${n.security}`}>
                  <button
                    type="button"
                    class={`wz-btn quiet os-wifi-pick${pick?.ssid === n.ssid ? " on" : ""}`}
                    disabled={n.connected || n.security === "8021x" || n.security === "wep"}
                    aria-pressed={pick?.ssid === n.ssid}
                    onClick={() => {
                      setPick(n);
                      setHidden(false);
                      setPassword("");
                      setSaid(undefined);
                    }}
                  >
                    {n.security !== "open" && <IconLock size={16} />}
                    <span class="os-wifi-name">{n.ssid}</span>
                    <span class="dim">
                      {bars(n.signal)}
                      {n.connected
                        ? ` · ${t("osWifiInUse")}`
                        : n.known
                          ? ` · ${t("osWifiKnown")}`
                          : n.security === "8021x"
                            ? ` · ${t("osWifi8021x")}`
                            : ""}
                    </span>
                  </button>
                  {n.known && (
                    <button
                      type="button"
                      class="wz-btn small quiet"
                      aria-label={t("osWifiForget")}
                      title={t("osWifiForget")}
                      onClick={() => void forget(n.ssid)}
                    >
                      <IconTrash size={16} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {w.known.filter((k) => !w.networks.some((n) => n.ssid === k)).length > 0 && (
            <p class="dim">
              {t("osWifiKnownAway", {
                names: w.known.filter((k) => !w.networks.some((n) => n.ssid === k)).join(", "),
              })}
            </p>
          )}
          {(pick || hidden) && (
            <div class="os-wifi-join">
              {hidden && (
                <Field label={t("osWifiHiddenName")}>
                  <input
                    class="wz-field"
                    value={name}
                    maxLength={32}
                    autocomplete="off"
                    onInput={(e) => setName((e.target as HTMLInputElement).value)}
                  />
                </Field>
              )}
              {needsPassword && (
                <Field
                  label={t("osWifiPassword", { name: hidden ? name || "…" : (pick?.ssid ?? "") })}
                  help={t("osWifiPasswordHelp")}
                >
                  <input
                    class="wz-field"
                    type="password"
                    value={password}
                    maxLength={64}
                    autocomplete="off"
                    onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
                  />
                </Field>
              )}
            </div>
          )}
          {said && <p class={`notice ${said.ok ? "ok" : "error"}`}>{said.text}</p>}
          <Acts>
            <button type="button" class="wz-btn" disabled={busy} onClick={() => void scan()}>
              <IconRefresh size={18} /> {busy ? t("osWifiLooking") : t("osWifiScan")}
            </button>
            {!pick && !hidden && (
              <button
                type="button"
                class="wz-btn quiet"
                onClick={() => {
                  setHidden(true);
                  setSaid(undefined);
                }}
              >
                {t("osWifiHidden")}
              </button>
            )}
            {(pick || hidden) && (
              <button
                type="button"
                class="wz-btn primary"
                disabled={
                  busy || (hidden && !name.trim()) || (needsPassword && password.length < 8)
                }
                onClick={() => void join()}
              >
                <IconWifi size={18} /> {busy ? t("osWifiJoining") : t("osWifiJoin")}
              </button>
            )}
          </Acts>
        </>
      )}
    </SCard>
  );
}

// --- HTTPS in the local network -----------------------------------------------------------------

type Device = "windows" | "mac" | "iphone" | "android" | "linux";

function guessDevice(): Device {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return "iphone";
  if (/Android/.test(ua)) return "android";
  if (/Macintosh|Mac OS X/.test(ua)) return "mac";
  if (/Windows/.test(ua)) return "windows";
  return "linux";
}

/** Reaches https on this same name: resolves only when the browser trusts the certificate. */
async function trustedHere(): Promise<boolean> {
  if (location.protocol === "https:") return true;
  try {
    await fetch(`https://${location.hostname}/api/health`, { mode: "no-cors", cache: "no-store" });
    return true;
  } catch {
    return false;
  }
}

/** HTTPS in the local network: the machine's certificate, how to trust it, then https only. */
export function HttpsPanel({ initial }: { initial?: LocalHttps | undefined } = {}) {
  const [h, setH] = useState<LocalHttps | null>(initial ?? null);
  const [device, setDevice] = useState<Device>(guessDevice());
  const [said, setSaid] = useState<{ ok: boolean; text: string }>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!initial) void attempt(() => getApi().setupHttps()).then((x) => x && setH(x));
  }, []);
  if (!h || !h.available) return null;
  const set = async (b: { local?: boolean; redirect?: boolean; trusted?: boolean }) => {
    setBusy(true);
    const r = await tryApi(() => getApi().setSetupHttps(b));
    setBusy(false);
    if ("ok" in r) setH(r.ok);
    else setSaid({ ok: false, text: errorText(r.code) });
    return "ok" in r;
  };
  const check = async () => {
    setSaid(undefined);
    setBusy(true);
    const ok = await trustedHere();
    setBusy(false);
    if (!ok) {
      setSaid({ ok: false, text: t("osHttpsNotYet") });
      return;
    }
    if (await set({ redirect: true, trusted: true }))
      setSaid({ ok: true, text: t("osHttpsNowOnly") });
  };
  const host = typeof location === "undefined" ? "redgiant.local" : location.hostname;
  const crtUrl =
    typeof location === "undefined" || location.protocol === "http:"
      ? `${typeof location === "undefined" ? "" : location.origin}/redgiant-ca.crt`
      : `http://${host}/redgiant-ca.crt`;
  const name = h.names.find((n) => n.endsWith(".local")) ?? "redgiant.local";
  return (
    <SCard icon={<IconShield size={22} />} title={t("osHttpsTitle")} q={t("osHttpsQ")}>
      {h.inFront && (
        <div class="wz-note">
          <IconCheck size={18} />
          <span>{t("osHttpsInFront", { name: h.inFront })}</span>
        </div>
      )}
      <SwitchRow
        title={t("osHttpsLocal")}
        help={h.on ? t("osHttpsLocalOn", { name }) : t("osHttpsLocalOff")}
        on={h.on}
        onChange={(on) => {
          void (async () => {
            if (!on && h.redirect) {
              const yes = await askConfirm(t("osHttpsOffQ"), {
                text: t("osHttpsOffText"),
                yes: t("osHttpsOffYes"),
              });
              if (!yes) return;
            }
            await set({ local: on });
          })();
        }}
      />
      {h.on && h.ca && (
        <>
          <Facts
            rows={[
              [t("osHttpsAddress"), <code key="a">{`https://${name}`}</code>],
              [
                t("osHttpsFingerprint"),
                <code key="f" class="os-fp">
                  {h.fingerprint ?? "…"}
                </code>,
              ],
              ...(h.until ? ([[t("osHttpsUntil"), h.until]] as [string, string][]) : []),
            ]}
          />
          <Sub title={t("osHttpsTrustTitle")} lead={t("osHttpsTrustLead")} />
          <div class="os-https-get">
            <Qr text={crtUrl} label={t("osHttpsQr")} />
            <div>
              <a class="wz-btn primary" href="/redgiant-ca.crt" download="RedGiant-CA.crt">
                <IconDownload size={18} /> {t("osHttpsDownload")}
              </a>
              <p class="dim">{t("osHttpsQrHelp")}</p>
            </div>
          </div>
          <Seg
            label={t("osHttpsDevice")}
            vertical
            value={device}
            options={[
              ["windows", "Windows"],
              ["mac", "macOS"],
              ["iphone", "iPhone / iPad"],
              ["android", "Android"],
              ["linux", "Linux"],
            ]}
            onChange={setDevice}
          />
          <p class="os-https-steps">{t(`osHttpsHow_${device}` as Key)}</p>
          <p class="dim">{t("osHttpsFirefox")}</p>
          {h.redirect ? (
            <SwitchRow
              title={t("osHttpsRedirect")}
              help={t("osHttpsRedirectOn")}
              on
              onChange={(on) => void (!on && set({ redirect: false }))}
            />
          ) : (
            !h.inFront && (
              <Acts>
                <button
                  type="button"
                  class="wz-btn primary"
                  disabled={busy}
                  onClick={() => void check()}
                >
                  <IconLock size={18} /> {t("osHttpsCheck")}
                </button>
              </Acts>
            )
          )}
        </>
      )}
      {said && <p class={`notice ${said.ok ? "ok" : "error"}`}>{said.text}</p>}
    </SCard>
  );
}

// --- updates ----------------------------------------------------------------------------------

/** Waits for the server to answer again (it restarts during an update or a restart). */
async function backUp(limitMs: number): Promise<boolean> {
  const until = Date.now() + limitMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      if (r.ok) return true;
    } catch {
      // Still restarting.
    }
  }
  return false;
}

/** RedGiant OS's updates: RedGiant's (applied by the machine) and the system's security ones. */
export function OsUpdatesPanel({ initial }: { initial?: OsUpdates | undefined } = {}) {
  const [u, setU] = useState<OsUpdates | null>(initial ?? null);
  const [busy, setBusy] = useState(false);
  const [following, setFollowing] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string }>();
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    if (!initial) void attempt(() => getApi().setupOsUpdates()).then((x) => x && setU(x));
    return () => {
      live.current = false;
    };
  }, []);
  if (!u || !u.available) return null;
  const look = async () => {
    setBusy(true);
    setSaid(undefined);
    const r = await attempt(() => getApi().setupOsUpdatesCheck());
    setBusy(false);
    if (r) setU(r);
    void refreshUpdateStatus();
  };
  /** Follows the update: the state every few seconds, through the server's own restart. */
  const follow = async () => {
    setFollowing(true);
    const until = Date.now() + 45 * 60_000;
    let lost = false;
    while (live.current && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 3000));
      const r = await getApi()
        .setupOsUpdates()
        .catch(() => null);
      if (!r) {
        lost = true;
        setSaid({ ok: true, text: t("osUpdRestarting") });
        continue;
      }
      setU(r);
      const st = r.update?.state;
      if (!r.running && st !== "applying") {
        setFollowing(false);
        if (st === "latest")
          setSaid({ ok: true, text: t("osUpdDone", { version: r.update?.installed ?? "" }) });
        else setSaid({ ok: false, text: r.update?.note ?? t("osUpdFailed") });
        if (lost && st === "latest") setTimeout(() => location.reload(), 4000);
        void refreshUpdateStatus();
        return;
      }
    }
    setFollowing(false);
  };
  const apply = async () => {
    const yes = await askConfirm(t("osUpdApplyQ", { version: u.update?.latest ?? "" }), {
      text: t("osUpdApplyText"),
      yes: t("osUpdApplyYes"),
    });
    if (!yes) return;
    setSaid(undefined);
    const r = await tryApi(() => getApi().updateAct("update"));
    if ("ok" in r) void follow();
    else setSaid({ ok: false, text: errorText(r.code) });
  };
  const restart = async () => {
    const yes = await askConfirm(t("osRebootQ"), {
      text: t("osRebootText"),
      yes: t("osRebootYes"),
      danger: true,
    });
    if (!yes) return;
    const r = await tryApi(() => getApi().setupReboot());
    if (!("ok" in r)) {
      setSaid({ ok: false, text: errorText(r.code) });
      return;
    }
    setSaid({ ok: true, text: t("osRebooting") });
    if (await backUp(15 * 60_000)) location.reload();
  };
  const up = u.update;
  const gate = updateStatus.value?.gate;
  const state: string = following ? "applying" : (up?.state ?? "unknown");
  const sec = u.security;
  return (
    <>
      <SCard icon={<IconDownload size={22} />} title={t("osUpdTitle")} q={t("osUpdQ")}>
        <Facts
          rows={[
            [t("osUpdInstalled"), up?.installed ?? updateStatus.value?.installed ?? "…"],
            [
              t("osUpdState"),
              t(`osUpd_${state}` as Key, {
                version: up?.latest ?? "",
                step: up?.step ? t(`osUpdStep_${up.step}` as Key) : "…",
              }),
            ],
            ...(up?.checkedAt
              ? ([[t("osUpdChecked"), new Date(up.checkedAt).toLocaleString()]] as [
                  string,
                  string,
                ][])
              : []),
          ]}
        />
        {(up?.gate === "breaking" || gate === "breaking") && (
          <div class="wz-note warn">
            <IconAlert size={18} />
            <span>{t("osUpdBreaking")}</span>
          </div>
        )}
        {said && <p class={`notice ${said.ok ? "ok" : "error"}`}>{said.text}</p>}
        <Acts>
          <button
            type="button"
            class="wz-btn"
            disabled={busy || following}
            onClick={() => void look()}
          >
            <IconRefresh size={18} /> {busy ? t("updLooking") : t("updLook")}
          </button>
          {up?.state === "available" && up.gate !== "breaking" && gate !== "breaking" && (
            <button
              type="button"
              class="wz-btn primary"
              disabled={following}
              onClick={() => void apply()}
            >
              <IconDownload size={18} /> {t("osUpdApply", { version: up.latest ?? "" })}
            </button>
          )}
        </Acts>
      </SCard>
      {sec && (
        <SCard icon={<IconShield size={22} />} title={t("osSecTitle")} q={t("osSecQ")}>
          <Facts
            rows={[
              [
                t("osSecLast"),
                sec.lastRun
                  ? t(sec.upgraded === null ? "osSecLastAt" : "osSecLastN", {
                      when: new Date(sec.lastRun).toLocaleString(),
                      n: String(sec.upgraded ?? 0),
                    })
                  : t("osSecNever"),
              ],
            ]}
          />
          {sec.rebootRequired ? (
            <div class="os-reboot">
              <div class="wz-note warn">
                <IconRestore size={18} />
                <span>
                  {t("osSecReboot")}
                  {sec.packages.length > 0 && ` (${sec.packages.slice(0, 6).join(", ")})`}
                </span>
              </div>
              <Acts>
                <button type="button" class="wz-btn primary" onClick={() => void restart()}>
                  <IconRestore size={18} /> {t("osRebootNow")}
                </button>
              </Acts>
            </div>
          ) : (
            <p class="dim">{t("osSecNoReboot")}</p>
          )}
        </SCard>
      )}
    </>
  );
}

// --- the sections of Settings › System (and the first boot) ------------------------------------

/** «Network»: Wi-Fi and HTTPS, with its heading; nothing at all where it is not RedGiant OS. */
export function OsNetworkSection({ wizard }: { wizard?: boolean } = {}) {
  const [got, setGot] = useState<{ w: WifiState | null; h: LocalHttps | null } | null>(null);
  useEffect(() => {
    void Promise.all([
      getApi()
        .setupWifi()
        .catch(() => null),
      getApi()
        .setupHttps()
        .catch(() => null),
    ]).then(([w, h]) => setGot({ w, h }));
  }, []);
  if (!got) return null;
  const wifi =
    got.w?.available === true || (got.w?.available === false && got.w.why !== "no_helper");
  const https = got.h?.available === true;
  if (!wifi && !https) return null;
  return (
    <>
      {!wizard && <Sub title={t("osNetSub")} lead={t("osNetSubLead")} />}
      {wifi && got.w && <WifiPanel initial={got.w} />}
      {https && got.h && <HttpsPanel initial={got.h} />}
    </>
  );
}

/** «Updates»: RedGiant's and the system's, with its heading; nothing where it is not RedGiant OS. */
export function OsUpdatesSection() {
  const [u, setU] = useState<OsUpdates | null>(null);
  useEffect(() => {
    void getApi()
      .setupOsUpdates()
      .then(setU, () => {});
  }, []);
  if (!u?.available) return null;
  return (
    <>
      <Sub title={t("osUpdSub")} lead={t("osUpdSubLead")} />
      <OsUpdatesPanel initial={u} />
    </>
  );
}
